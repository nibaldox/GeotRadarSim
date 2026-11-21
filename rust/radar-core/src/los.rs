//! Per-cell LOS classification, incidence and slope projection.
//!
//! This is a line-by-line port of `computeLOS` in `frontend/src/workers/losWorker.ts`
//! restricted to the three flat buffers (`cell_states`, `flat_quality_grid`,
//! `flat_projection_grid`). Expression order, `Math.*` semantics (see [`crate::jsmath`]),
//! the `Number.EPSILON` snapping tolerance and the `Float32Array` store points are kept
//! identical so the output is bit-for-bit equal to the TypeScript worker.
//! [`compute_los_analysis`] adds the f64 incidence grid and the cell-state reductions of
//! [`crate::los_summary`] (shadow-zone BFS, counts, coverage points) under the same deadline.
//! Percentage formatting (`toFixed(2)`), area and the nested `boolean[][]`/`number[][]` grids
//! stay in TypeScript.

// Comparisons are written in the literal TS form so NaN behaves identically.
#![allow(clippy::manual_range_contains)]

use crate::jsmath::{fdlibm_atan2, js_hypot2, js_hypot3, js_max, js_min, js_min_n, js_round};

/// Maximum nodes per grid axis (`MAX_TERRAIN_GRID_DIMENSION`).
pub const MAX_GRID_DIMENSION: u32 = 16_384;
/// Maximum total cells (`MAX_TERRAIN_GRID_CELLS`).
pub const MAX_GRID_CELLS: u64 = 1_000_000;
/// `LOS_RUNTIME_DEADLINE_MS` in `losWorker.ts`.
pub const LOS_RUNTIME_DEADLINE_MS: f64 = 120_000.0;
/// `LOS_RUNTIME_CHECK_INTERVAL` in `losWorker.ts` (power of two).
pub const LOS_RUNTIME_CHECK_INTERVAL: u64 = 1_024;

/// Stable cell-state codes (`LOSCellState`).
pub mod cell_state {
    pub const NODATA: u8 = 0;
    pub const OUT_OF_RANGE: u8 = 1;
    pub const OUTSIDE_FOV: u8 = 2;
    pub const UNKNOWN_RAY: u8 = 3;
    pub const SHADOW: u8 = 4;
    pub const VISIBLE: u8 = 5;
}

/// Row-major DEM view: node `(row, col)` is `values[row * cols + col]` at
/// `(min_x + col * resolution, min_y + row * resolution)`. Non-finite values are no-data.
#[derive(Debug, Clone, Copy)]
pub struct GridView<'a> {
    pub values: &'a [f64],
    pub rows: u32,
    pub cols: u32,
    pub min_x: f64,
    pub min_y: f64,
    pub resolution: f64,
}

/// The `RadarConfig` fields that `computeLOS` actually reads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LosRadarParams {
    /// `radar_config.min_range_m ?? 0`.
    pub min_range_m: f64,
    pub max_range_m: f64,
    pub elevation_min_deg: f64,
    pub elevation_max_deg: f64,
    /// `None` when `scan_pattern === "SAR360"` or `azimuth_range_deg` is null (full circle);
    /// otherwise `[start, end]`, unvalidated exactly like the TS (NaN never matches).
    pub azimuth_range_deg: Option<[f64; 2]>,
}

/// The three flat LOS buffers, `rows * cols` entries each.
#[derive(Debug, Clone, PartialEq)]
pub struct LosBuffers {
    pub cell_states: Vec<u8>,
    /// Incidence: `-1` when not visible, `NaN` when visible without a gradient.
    pub quality: Vec<f32>,
    /// Slope-motion projection: `NaN` when unavailable.
    pub projection: Vec<f32>,
}

/// LOS failures with stable codes; [`LosError::ts_message`] is the exact TS message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LosError {
    EmptyGrid,
    GridDimensionLimit,
    GridCellLimit,
    GridNotRectangular,
    InvalidResolution,
    ResolutionAreaUnrepresentable,
    TotalAreaNotFinite,
    NonFinitePosition,
    InvalidRangeLimits,
    InvalidElevationLimits,
    DeadlineExceeded,
    RayNonFiniteCoordinate,
    RayPrecisionStall,
    RayDidNotAdvance,
}

impl LosError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyGrid => "LOS_EMPTY_GRID",
            Self::GridDimensionLimit => "LOS_GRID_DIMENSION_LIMIT",
            Self::GridCellLimit => "LOS_GRID_CELL_LIMIT",
            Self::GridNotRectangular => "LOS_GRID_NOT_RECTANGULAR",
            Self::InvalidResolution => "LOS_INVALID_RESOLUTION",
            Self::ResolutionAreaUnrepresentable => "LOS_RESOLUTION_AREA_UNREPRESENTABLE",
            Self::TotalAreaNotFinite => "LOS_TOTAL_AREA_NOT_FINITE",
            Self::NonFinitePosition => "LOS_NON_FINITE_POSITION",
            Self::InvalidRangeLimits => "LOS_INVALID_RANGE_LIMITS",
            Self::InvalidElevationLimits => "LOS_INVALID_ELEVATION_LIMITS",
            Self::DeadlineExceeded => "LOS_DEADLINE_EXCEEDED",
            Self::RayNonFiniteCoordinate => "LOS_RAY_NON_FINITE_COORDINATE",
            Self::RayPrecisionStall => "LOS_RAY_PRECISION_STALL",
            Self::RayDidNotAdvance => "LOS_RAY_DID_NOT_ADVANCE",
        }
    }

    /// `true` when the TS worker throws `RangeError` (vs. plain `Error`).
    pub fn is_range_error(&self) -> bool {
        !matches!(self, Self::EmptyGrid | Self::GridNotRectangular)
    }

    /// Exact message thrown by `losWorker.ts`. The deadline message embeds
    /// `LOS_RUNTIME_DEADLINE_MS`; use [`deadline_exceeded_message`] for another budget.
    pub fn ts_message(&self) -> String {
        match self {
            Self::EmptyGrid => "LOS grid must be non-empty and rectangular".into(),
            Self::GridDimensionLimit => {
                "LOS grid dimension exceeds the maximum of 16,384 nodes".into()
            }
            Self::GridCellLimit => "LOS grid exceeds the maximum size of 1,000,000 cells".into(),
            Self::GridNotRectangular => "LOS grid must be rectangular".into(),
            Self::InvalidResolution => "LOS resolution must be finite and positive".into(),
            Self::ResolutionAreaUnrepresentable => {
                "LOS resolution squared must be finite and non-zero to represent cell area".into()
            }
            Self::TotalAreaNotFinite => "LOS total grid area must be finite".into(),
            Self::NonFinitePosition => "LOS bounds and radar position must be finite".into(),
            Self::InvalidRangeLimits => {
                "LOS range limits must be finite, non-negative, and ordered".into()
            }
            Self::InvalidElevationLimits => {
                "LOS elevation limits must be finite, within [-90, 90], and ordered".into()
            }
            Self::DeadlineExceeded => deadline_exceeded_message(LOS_RUNTIME_DEADLINE_MS),
            Self::RayNonFiniteCoordinate => "LOS ray traversal left finite grid coordinates".into(),
            Self::RayPrecisionStall => {
                "LOS ray traversal cannot advance at floating-point precision".into()
            }
            Self::RayDidNotAdvance => {
                "LOS ray traversal did not advance to the next grid intersection".into()
            }
        }
    }
}

/// Largest deadline whose `Math.round(ms / 1000)` prints identically in JS and here.
pub const MAX_DEADLINE_MS: f64 = 9_007_199_254_740_991.0;

/// The TS deadline message for `deadline_ms` in `[0, MAX_DEADLINE_MS]`:
/// `` `(${Math.round(deadline_ms / 1000)} segundos)` `` with JS integer formatting.
pub fn deadline_exceeded_message(deadline_ms: f64) -> String {
    let seconds = js_round(deadline_ms / 1000.0);
    let seconds_text = if seconds.is_finite() && seconds.abs() <= MAX_DEADLINE_MS {
        // Integral and below 2^53: JS prints the exact digits; `+ 0.0` turns -0 into "0".
        format!("{:.0}", seconds + 0.0)
    } else if seconds.is_nan() {
        "NaN".into()
    } else if seconds == f64::INFINITY {
        "Infinity".into()
    } else if seconds == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        format!("{seconds:e}")
    };
    format!(
        "El cálculo de visibilidad LOS excedió el tiempo máximo de ejecución ({seconds_text} segundos). \
         Reduzca el área del terreno, aumente la resolución o disminuya el alcance del radar \
         y vuelva a intentarlo."
    )
}

/// Validate exactly like `computeLOS` before its deadline starts. Returns the cell count.
pub fn validate_los_input(
    grid: &GridView<'_>,
    radar_position: [f64; 3],
    radar: &LosRadarParams,
) -> Result<usize, LosError> {
    if grid.rows == 0 || grid.cols == 0 {
        return Err(LosError::EmptyGrid);
    }
    if grid.rows > MAX_GRID_DIMENSION || grid.cols > MAX_GRID_DIMENSION {
        return Err(LosError::GridDimensionLimit);
    }
    let cells = u64::from(grid.rows)
        .checked_mul(u64::from(grid.cols))
        .ok_or(LosError::GridCellLimit)?;
    if cells > MAX_GRID_CELLS {
        return Err(LosError::GridCellLimit);
    }
    let cells = usize::try_from(cells).map_err(|_| LosError::GridCellLimit)?;
    if grid.values.len() != cells {
        return Err(LosError::GridNotRectangular);
    }
    let resolution = grid.resolution;
    if !resolution.is_finite() || resolution <= 0.0 {
        return Err(LosError::InvalidResolution);
    }
    let cell_area = resolution * resolution;
    if !cell_area.is_finite() || cell_area <= 0.0 {
        return Err(LosError::ResolutionAreaUnrepresentable);
    }
    // `cells` is at most 1e6, exactly representable.
    let total_area = cell_area * cells as f64;
    if !total_area.is_finite() {
        return Err(LosError::TotalAreaNotFinite);
    }
    let [rx, ry, rz] = radar_position;
    if ![grid.min_x, grid.min_y, rx, ry, rz]
        .iter()
        .all(|v| v.is_finite())
    {
        return Err(LosError::NonFinitePosition);
    }
    let min_range = radar.min_range_m;
    let max_range = radar.max_range_m;
    if !min_range.is_finite() || !max_range.is_finite() || min_range < 0.0 || min_range > max_range
    {
        return Err(LosError::InvalidRangeLimits);
    }
    let min_elevation = radar.elevation_min_deg;
    let max_elevation = radar.elevation_max_deg;
    if !min_elevation.is_finite()
        || !max_elevation.is_finite()
        || min_elevation < -90.0
        || max_elevation > 90.0
        || min_elevation > max_elevation
    {
        return Err(LosError::InvalidElevationLimits);
    }
    Ok(cells)
}

#[derive(Clone, Copy)]
struct Dem<'a> {
    values: &'a [f64],
    rows: usize,
    cols: usize,
}

impl Dem<'_> {
    #[inline]
    fn at(&self, row: usize, col: usize) -> f64 {
        self.values[row * self.cols + col]
    }
}

fn snap_grid_coordinate(coordinate: f64) -> f64 {
    let nearest_integer = js_round(coordinate);
    let rounding_tolerance = f64::EPSILON * js_max(1.0, nearest_integer.abs());
    if (coordinate - nearest_integer).abs() <= rounding_tolerance {
        nearest_integer
    } else {
        coordinate
    }
}

/// Triangle visitor arguments: `(row, col, tl, tr, bl, br, second_triangle)`.
fn for_each_incident_triangle<F>(dem: Dem<'_>, x: f64, y: f64, mut visit: F) -> bool
where
    F: FnMut(usize, usize, f64, f64, f64, f64, bool),
{
    let rows_f = dem.rows as f64;
    let cols_f = dem.cols as f64;
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || x > cols_f - 1.0
        || y < 0.0
        || y > rows_f - 1.0
    {
        return false;
    }
    let nearest_col = js_round(x);
    let col_on_grid_line = x == nearest_col;
    let first_col = js_max(
        0.0,
        if col_on_grid_line {
            nearest_col - 1.0
        } else {
            x.floor()
        },
    );
    let last_col = js_min(
        cols_f - 2.0,
        if col_on_grid_line {
            nearest_col
        } else {
            first_col
        },
    );
    let nearest_row = js_round(y);
    let row_on_grid_line = y == nearest_row;
    let first_row = js_max(
        0.0,
        if row_on_grid_line {
            nearest_row - 1.0
        } else {
            y.floor()
        },
    );
    let last_row = js_min(
        rows_f - 2.0,
        if row_on_grid_line {
            nearest_row
        } else {
            first_row
        },
    );
    if first_col > last_col || first_row > last_row {
        return false;
    }

    // All four bounds are integral and within [0, axis - 2] here.
    let (first_row, last_row) = (first_row as usize, last_row as usize);
    let (first_col, last_col) = (first_col as usize, last_col as usize);
    let mut found = false;
    for row in first_row..=last_row {
        let local_y = y - row as f64;
        for col in first_col..=last_col {
            let local_x = x - col as f64;
            // Literal TS form (NaN would *not* skip), not `!contains`.
            if local_x < 0.0 || local_x > 1.0 || local_y < 0.0 || local_y > 1.0 {
                continue;
            }
            let top_left = dem.at(row, col);
            let top_right = dem.at(row, col + 1);
            let bottom_left = dem.at(row + 1, col);
            let bottom_right = dem.at(row + 1, col + 1);
            if !top_left.is_finite()
                || !top_right.is_finite()
                || !bottom_left.is_finite()
                || !bottom_right.is_finite()
            {
                continue;
            }
            let diagonal_coordinate = snap_grid_coordinate(local_x + local_y);
            if diagonal_coordinate <= 1.0 {
                found = true;
                visit(
                    row,
                    col,
                    top_left,
                    top_right,
                    bottom_left,
                    bottom_right,
                    false,
                );
            }
            if diagonal_coordinate >= 1.0 {
                found = true;
                visit(
                    row,
                    col,
                    top_left,
                    top_right,
                    bottom_left,
                    bottom_right,
                    true,
                );
            }
        }
    }
    found
}

#[allow(clippy::too_many_arguments)]
fn height_on_triangle(
    top_left: f64,
    top_right: f64,
    bottom_left: f64,
    bottom_right: f64,
    local_x: f64,
    local_y: f64,
    second_triangle: bool,
) -> f64 {
    let in_unit = |v: f64| (0.0..=1.0).contains(&v);
    if second_triangle {
        let weight0 = 1.0 - local_y;
        let weight1 = local_x + local_y - 1.0;
        let weight2 = 1.0 - local_x;
        if in_unit(local_x)
            && in_unit(local_y)
            && weight0 >= 0.0
            && weight1 >= 0.0
            && weight2 >= 0.0
        {
            return top_right * weight0 + bottom_right * weight1 + bottom_left * weight2;
        }
    } else {
        let weight0 = 1.0 - local_x - local_y;
        if in_unit(local_x) && in_unit(local_y) && weight0 >= 0.0 {
            return top_left * weight0 + top_right * local_x + bottom_left * local_y;
        }
    }

    let x = js_max(0.0, js_min(1.0, local_x));
    let y = js_max(0.0, js_min(1.0, local_y));
    let (weight0, weight1, weight2) = if second_triangle {
        (
            js_max(0.0, 1.0 - y),
            js_max(0.0, x + y - 1.0),
            js_max(0.0, 1.0 - x),
        )
    } else {
        (js_max(0.0, 1.0 - x - y), x, y)
    };
    let total_weight = weight0 + weight1 + weight2;
    if total_weight == 0.0 {
        return f64::NAN;
    }
    if second_triangle {
        (top_right * weight0 + bottom_right * weight1 + bottom_left * weight2) / total_weight
    } else {
        (top_left * weight0 + top_right * weight1 + bottom_left * weight2) / total_weight
    }
}

/// `clipSegmentToGrid`: parametric `[start, end]` of the segment inside the grid, or `None`.
fn clip_segment_to_grid(
    start_x: f64,
    start_y: f64,
    delta_x: f64,
    delta_y: f64,
    cols: f64,
    rows: f64,
) -> Option<(f64, f64)> {
    let mut range = (0.0_f64, 1.0_f64);
    let mut clip_axis = |origin: f64, delta: f64, maximum: f64| -> bool {
        if delta == 0.0 {
            return origin >= 0.0 && origin <= maximum;
        }
        let first = -origin / delta;
        let second = (maximum - origin) / delta;
        range.0 = js_max(range.0, js_min(first, second));
        range.1 = js_min(range.1, js_max(first, second));
        range.0 <= range.1
    };
    if !clip_axis(start_x, delta_x, cols - 1.0) || !clip_axis(start_y, delta_y, rows - 1.0) {
        return None;
    }
    if !range.0.is_finite() || !range.1.is_finite() {
        return None;
    }
    Some(range)
}

/// `nextCrossingParameter`: next strict crossing of the integer-line family.
fn next_crossing_parameter(
    start_coordinate: f64,
    delta: f64,
    after_parameter: f64,
) -> Result<f64, LosError> {
    if delta == 0.0 {
        return Ok(f64::INFINITY);
    }
    let coordinate = start_coordinate + after_parameter * delta;
    if !coordinate.is_finite() {
        return Err(LosError::RayNonFiniteCoordinate);
    }
    let step = if delta > 0.0 { 1.0 } else { -1.0 };
    let mut line = if delta > 0.0 {
        coordinate.floor() + 1.0
    } else {
        coordinate.ceil() - 1.0
    };
    for _attempt in 0..8 {
        let parameter = (line - start_coordinate) / delta;
        if parameter > after_parameter {
            return Ok(parameter);
        }
        line += step;
    }
    Err(LosError::RayPrecisionStall)
}

#[allow(clippy::too_many_arguments)]
fn trace_vertical_ray_at_point(
    dem: Dem<'_>,
    x: f64,
    y: f64,
    start_parameter: f64,
    end_parameter: f64,
    start_z: f64,
    end_z: f64,
    delta_z: f64,
) -> u8 {
    let x = snap_grid_coordinate(x);
    let y = snap_grid_coordinate(y);
    let mut shadowed = false;
    let has_surface = for_each_incident_triangle(dem, x, y, |row, col, tl, tr, bl, br, second| {
        let height = height_on_triangle(tl, tr, bl, br, x - col as f64, y - row as f64, second);
        // Parameter 1 is the target node itself: its ray height is end_z exactly.
        let ray_at_start = if start_parameter == 1.0 {
            end_z
        } else {
            start_z + start_parameter * delta_z
        };
        let ray_at_end = if end_parameter == 1.0 {
            end_z
        } else {
            start_z + end_parameter * delta_z
        };
        if height.is_finite() && (height > ray_at_start || height > ray_at_end) {
            shadowed = true;
        }
    });
    if shadowed {
        cell_state::SHADOW
    } else if has_surface {
        cell_state::VISIBLE
    } else {
        cell_state::UNKNOWN_RAY
    }
}

/// `traceTerrainRay`: returns VISIBLE, SHADOW or UNKNOWN_RAY.
///
/// The ray ends exactly at the target node `(target_row, target_col)`, whose elevation is
/// `end_z`: the endpoint (t = 1) uses the integer node coordinates and `end_z`, never
/// `start + 1 * delta`, so the target cannot occlude itself by rounding. Each triangle's entry
/// is still compared.
#[allow(clippy::too_many_arguments)]
fn trace_terrain_ray(
    dem: Dem<'_>,
    min_x: f64,
    min_y: f64,
    resolution: f64,
    start: [f64; 3],
    target_row: usize,
    target_col: usize,
    end_z: f64,
    should_abort: &mut dyn FnMut() -> bool,
) -> Result<u8, LosError> {
    let [start_x, start_y, start_z] = start;
    if dem.rows < 2 || dem.cols < 2 {
        return Ok(cell_state::UNKNOWN_RAY);
    }
    let rows_f = dem.rows as f64;
    let cols_f = dem.cols as f64;
    let target_row_f = target_row as f64;
    let target_col_f = target_col as f64;

    let grid_start_x = snap_grid_coordinate((start_x - min_x) / resolution);
    let grid_start_y = snap_grid_coordinate((start_y - min_y) / resolution);
    let grid_end_x = target_col_f;
    let grid_end_y = target_row_f;
    let grid_start_diagonal = snap_grid_coordinate(grid_start_x + grid_start_y);
    let grid_end_diagonal = target_col_f + target_row_f;
    let delta_x = grid_end_x - grid_start_x;
    let delta_y = grid_end_y - grid_start_y;
    let delta_diagonal = grid_end_diagonal - grid_start_diagonal;
    let delta_z = end_z - start_z;
    if ![
        grid_start_x,
        grid_start_y,
        grid_end_x,
        grid_end_y,
        delta_x,
        delta_y,
        delta_diagonal,
        delta_z,
    ]
    .iter()
    .all(|v| v.is_finite())
    {
        return Ok(cell_state::UNKNOWN_RAY);
    }

    let Some((clip_start, clip_end)) =
        clip_segment_to_grid(grid_start_x, grid_start_y, delta_x, delta_y, cols_f, rows_f)
    else {
        return Ok(cell_state::UNKNOWN_RAY);
    };
    if delta_x == 0.0 && delta_y == 0.0 {
        return Ok(trace_vertical_ray_at_point(
            dem,
            grid_start_x,
            grid_start_y,
            clip_start,
            clip_end,
            start_z,
            end_z,
            delta_z,
        ));
    }
    if clip_start == clip_end {
        let x = if clip_start == 1.0 {
            target_col_f
        } else {
            grid_start_x + clip_start * delta_x
        };
        let y = if clip_start == 1.0 {
            target_row_f
        } else {
            grid_start_y + clip_start * delta_y
        };
        return Ok(trace_vertical_ray_at_point(
            dem, x, y, clip_start, clip_end, start_z, end_z, delta_z,
        ));
    }

    let mut ray_unknown = false;
    let mut interval_start = clip_start;
    let mut interval_index: u64 = 0;
    while interval_start < clip_end {
        interval_index = interval_index.wrapping_add(1);
        if interval_index & (LOS_RUNTIME_CHECK_INTERVAL - 1) == 0 && should_abort() {
            return Err(LosError::DeadlineExceeded);
        }
        let crossing_x = next_crossing_parameter(grid_start_x, delta_x, interval_start)?;
        let crossing_y = next_crossing_parameter(grid_start_y, delta_y, interval_start)?;
        let crossing_diagonal =
            next_crossing_parameter(grid_start_diagonal, delta_diagonal, interval_start)?;
        let interval_end = js_min_n(&[clip_end, crossing_x, crossing_y, crossing_diagonal]);
        // Written negated like the TS so NaN also fails.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(interval_end > interval_start) {
            return Err(LosError::RayDidNotAdvance);
        }

        let midpoint = interval_start + (interval_end - interval_start) / 2.0;
        let midpoint_x = grid_start_x + midpoint * delta_x;
        let midpoint_y = grid_start_y + midpoint * delta_y;
        // The node's integer crossings make the last interval_end exactly 1: the target node.
        let ends_at_target = interval_end == 1.0;
        let mut interval_shadowed = false;
        let interval_has_surface = for_each_incident_triangle(
            dem,
            midpoint_x,
            midpoint_y,
            |row, col, tl, tr, bl, br, second| {
                let col_f = col as f64;
                let row_f = row as f64;
                let start_local_x = grid_start_x + interval_start * delta_x - col_f;
                let start_local_y = grid_start_y + interval_start * delta_y - row_f;
                let (end_local_x, end_local_y) = if ends_at_target {
                    (target_col_f - col_f, target_row_f - row_f)
                } else {
                    (
                        grid_start_x + interval_end * delta_x - col_f,
                        grid_start_y + interval_end * delta_y - row_f,
                    )
                };
                let terrain_at_start =
                    height_on_triangle(tl, tr, bl, br, start_local_x, start_local_y, second);
                let terrain_at_end =
                    height_on_triangle(tl, tr, bl, br, end_local_x, end_local_y, second);
                let ray_at_start = start_z + interval_start * delta_z;
                let ray_at_end = if ends_at_target {
                    end_z
                } else {
                    start_z + interval_end * delta_z
                };
                if terrain_at_start > ray_at_start || terrain_at_end > ray_at_end {
                    interval_shadowed = true;
                }
            },
        );
        if interval_shadowed {
            return Ok(cell_state::SHADOW);
        }
        if !interval_has_surface {
            ray_unknown = true;
        }
        interval_start = interval_end;
    }

    Ok(if ray_unknown {
        cell_state::UNKNOWN_RAY
    } else {
        cell_state::VISIBLE
    })
}

/// `terrainDifference` in `utils/sensitivity.ts`.
fn terrain_difference(
    before: Option<f64>,
    current: f64,
    after: Option<f64>,
    resolution: f64,
) -> Option<f64> {
    let before = before.filter(|v| v.is_finite());
    let after = after.filter(|v| v.is_finite());
    let difference = match (before, after) {
        (Some(before), Some(after)) => (after - before) / (2.0 * resolution),
        (None, Some(after)) => (after - current) / resolution,
        (Some(before), None) => (current - before) / resolution,
        (None, None) => return None,
    };
    difference.is_finite().then_some(difference)
}

/// `terrainGradientAt` in `utils/sensitivity.ts` for an in-bounds finite node.
fn terrain_gradient_at(
    dem: Dem<'_>,
    row: usize,
    col: usize,
    resolution: f64,
) -> Option<(f64, f64)> {
    let current = dem.at(row, col);
    if !current.is_finite() || !resolution.is_finite() || resolution <= 0.0 {
        return None;
    }
    let grad_x = terrain_difference(
        (col > 0).then(|| dem.at(row, col - 1)),
        current,
        (col + 1 < dem.cols).then(|| dem.at(row, col + 1)),
        resolution,
    );
    let grad_y = terrain_difference(
        (row > 0).then(|| dem.at(row - 1, col)),
        current,
        (row + 1 < dem.rows).then(|| dem.at(row + 1, col)),
        resolution,
    );
    Some((grad_x?, grad_y?))
}

fn is_inside_azimuth(radar: &LosRadarParams, dx: f64, dy: f64) -> bool {
    let Some([start, end]) = radar.azimuth_range_deg else {
        return true;
    };
    let azimuth = fdlibm_atan2(dx, dy) * (180.0 / std::f64::consts::PI);
    if start <= end {
        azimuth >= start && azimuth <= end
    } else {
        azimuth >= start || azimuth <= end
    }
}

/// Port of the per-cell part of `computeLOS`.
///
/// `should_abort` is polled at exactly the TS `deadline.check()` points of this phase:
/// once at the start of every row and once every [`LOS_RUNTIME_CHECK_INTERVAL`] intervals of
/// each traversed ray. Returning `true` yields [`LosError::DeadlineExceeded`].
pub fn compute_los(
    grid: &GridView<'_>,
    radar_position: [f64; 3],
    radar: &LosRadarParams,
    should_abort: &mut dyn FnMut() -> bool,
) -> Result<LosBuffers, LosError> {
    compute_cells(grid, radar_position, radar, should_abort, None)
}

/// Everything `computeLOS` derives from the DEM, under one deadline window.
#[derive(Debug, Clone, PartialEq)]
pub struct LosAnalysis {
    pub buffers: LosBuffers,
    /// Row-major f64 `quality_grid` of the TS worker: `0` when not VISIBLE, `NaN` when
    /// VISIBLE without a gradient, otherwise the f64 incidence before its f32 store.
    pub incidence: Vec<f64>,
    pub summary: crate::los_summary::LosSummary,
}

/// The whole `computeLOS` loop structure: the per-cell phase of [`compute_los`] followed by
/// the cell-state reductions of [`crate::los_summary::summarize_los`] (counts, coverage
/// points and the shadow-zone BFS), all polling the **same** `should_abort` at exactly the
/// TS `deadline.check()` points of both phases, in the same order. The caller reads the
/// clock once before calling, so there is a single deadline window, as in the TS worker.
pub fn compute_los_analysis(
    grid: &GridView<'_>,
    radar_position: [f64; 3],
    radar: &LosRadarParams,
    should_abort: &mut dyn FnMut() -> bool,
) -> Result<LosAnalysis, LosError> {
    let mut incidence = Vec::new();
    let buffers = compute_cells(
        grid,
        radar_position,
        radar,
        should_abort,
        Some(&mut incidence),
    )?;
    let summary = crate::los_summary::summarize_los(
        &buffers.cell_states,
        grid.rows,
        grid.cols,
        grid.min_x,
        grid.min_y,
        grid.resolution,
        should_abort,
    )?;
    Ok(LosAnalysis {
        buffers,
        incidence,
        summary,
    })
}

/// Shared per-cell loop. When `incidence_out` is given it receives the f64 `quality_grid`.
fn compute_cells(
    grid: &GridView<'_>,
    radar_position: [f64; 3],
    radar: &LosRadarParams,
    should_abort: &mut dyn FnMut() -> bool,
    mut incidence_out: Option<&mut Vec<f64>>,
) -> Result<LosBuffers, LosError> {
    let cell_count = validate_los_input(grid, radar_position, radar)?;
    if let Some(incidence) = incidence_out.as_deref_mut() {
        incidence.clear();
        incidence.resize(cell_count, 0.0);
    }
    let [rx, ry, rz] = radar_position;
    let rows = grid.rows as usize;
    let cols = grid.cols as usize;
    let resolution = grid.resolution;
    let dem = Dem {
        values: grid.values,
        rows,
        cols,
    };
    let min_range = radar.min_range_m;
    let max_range = radar.max_range_m;
    let min_elevation = radar.elevation_min_deg;
    let max_elevation = radar.elevation_max_deg;
    let degrees_per_radian = 180.0 / std::f64::consts::PI;

    let mut cell_states = vec![cell_state::NODATA; cell_count];
    let mut quality = vec![-1.0_f32; cell_count];
    let mut projection = vec![f32::NAN; cell_count];

    for r in 0..rows {
        if should_abort() {
            return Err(LosError::DeadlineExceeded);
        }
        let cy = grid.min_y + r as f64 * resolution;
        for c in 0..cols {
            let idx = r * cols + c;
            let target_z = dem.at(r, c);
            if !target_z.is_finite() {
                cell_states[idx] = cell_state::NODATA;
                continue;
            }

            let cx = grid.min_x + c as f64 * resolution;
            let dx = cx - rx;
            let dy = cy - ry;
            let distance = js_hypot2(dx, dy);
            if distance < min_range || distance > max_range || !distance.is_finite() {
                cell_states[idx] = cell_state::OUT_OF_RANGE;
                continue;
            }

            let elevation = fdlibm_atan2(target_z - rz, distance) * degrees_per_radian;
            if elevation < min_elevation || elevation > max_elevation || !elevation.is_finite() {
                cell_states[idx] = cell_state::OUTSIDE_FOV;
                continue;
            }
            if !is_inside_azimuth(radar, dx, dy) {
                cell_states[idx] = cell_state::OUTSIDE_FOV;
                continue;
            }

            let ray_state = trace_terrain_ray(
                dem,
                grid.min_x,
                grid.min_y,
                resolution,
                [rx, ry, rz],
                r,
                c,
                target_z,
                should_abort,
            )?;
            if ray_state == cell_state::SHADOW || ray_state == cell_state::UNKNOWN_RAY {
                cell_states[idx] = ray_state;
                continue;
            }

            cell_states[idx] = cell_state::VISIBLE;
            let Some((grad_x, grad_y)) = terrain_gradient_at(dem, r, c, resolution) else {
                quality[idx] = f32::NAN;
                if let Some(incidence) = incidence_out.as_deref_mut() {
                    incidence[idx] = f64::NAN;
                }
                continue;
            };
            let normal_length = js_hypot3(grad_x, grad_y, 1.0);
            let nx = -grad_x / normal_length;
            let ny = -grad_y / normal_length;
            let nz = 1.0 / normal_length;
            let dz = target_z - rz;
            let distance3d_raw = (dx * dx + dy * dy + dz * dz).sqrt();
            // `|| 0.1`: 0, -0 and NaN are falsy.
            let distance3d = if distance3d_raw == 0.0 || distance3d_raw.is_nan() {
                0.1
            } else {
                distance3d_raw
            };
            let ux = dx / distance3d;
            let uy = dy / distance3d;
            let uz = dz / distance3d;
            let incidence = js_max(0.0, js_min(1.0, -(ux * nx + uy * ny + uz * nz)));
            quality[idx] = incidence as f32;
            if let Some(incidence_grid) = incidence_out.as_deref_mut() {
                incidence_grid[idx] = incidence;
            }

            let mut tx = -grad_x;
            let mut ty = -grad_y;
            let mut tz = -(grad_x * grad_x + grad_y * grad_y);
            let tangent_norm = (tx * tx + ty * ty + tz * tz).sqrt();
            if tangent_norm > 1e-4 {
                tx /= tangent_norm;
                ty /= tangent_norm;
                tz /= tangent_norm;
            } else {
                tx = 0.0;
                ty = 0.0;
                tz = -1.0;
            }
            projection[idx] = (ux * tx + uy * ty + uz * tz).abs() as f32;
        }
    }

    Ok(LosBuffers {
        cell_states,
        quality,
        projection,
    })
}

#[cfg(test)]
mod tests;
