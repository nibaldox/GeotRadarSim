mod sensitivity;

use js_sys::{
    Error, Float32Array, Float64Array, Object, RangeError, Reflect, Uint8Array, Uint32Array,
};
use radar_core::los::{self, GridView, LosError, LosRadarParams};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// Resolved through the global `performance` at call time, exactly like `losWorker.ts`.
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

#[wasm_bindgen]
pub fn core_version() -> String {
    radar_core::core_version().to_owned()
}

#[wasm_bindgen]
pub fn grid_summary(values: &[f64], rows: u32, cols: u32) -> Result<JsValue, JsValue> {
    let summary = radar_core::grid_summary(values, rows, cols).map_err(|error| {
        let code = error.code();
        let js_error = Error::new(code);
        let _ = Reflect::set(
            &js_error,
            &JsValue::from_str("code"),
            &JsValue::from_str(code),
        );
        JsValue::from(js_error)
    })?;
    let object = Object::new();
    for (key, value) in [
        (
            "finite_count",
            JsValue::from_f64(f64::from(summary.finite_count)),
        ),
        ("nan_count", JsValue::from_f64(f64::from(summary.nan_count))),
        ("min", summary.min.map_or(JsValue::NULL, JsValue::from_f64)),
        ("max", summary.max.map_or(JsValue::NULL, JsValue::from_f64)),
        (
            "mean",
            summary.mean.map_or(JsValue::NULL, JsValue::from_f64),
        ),
    ] {
        Reflect::set(&object, &JsValue::from_str(key), &value)?;
    }
    Ok(object.into())
}

fn coded_error(code: &str, message: &str, range_error: bool) -> JsValue {
    let error: Error = if range_error {
        RangeError::new(message).into()
    } else {
        Error::new(message)
    };
    let _ = Reflect::set(&error, &JsValue::from_str("code"), &JsValue::from_str(code));
    error.into()
}

fn los_error(error: LosError, deadline_ms: f64) -> JsValue {
    let message = match error {
        LosError::DeadlineExceeded => los::deadline_exceeded_message(deadline_ms),
        other => other.ts_message(),
    };
    coded_error(error.code(), &message, error.is_range_error())
}

/// Builds the core LOS request from the frozen WASM argument list.
#[allow(clippy::too_many_arguments)]
fn los_request<'a>(
    values: &'a [f64],
    rows: u32,
    cols: u32,
    min_x: f64,
    min_y: f64,
    resolution: f64,
    min_range_m: f64,
    max_range_m: f64,
    elevation_min_deg: f64,
    elevation_max_deg: f64,
    azimuth_limited: bool,
    azimuth_start_deg: f64,
    azimuth_end_deg: f64,
) -> (GridView<'a>, LosRadarParams) {
    let grid = GridView {
        values,
        rows,
        cols,
        min_x,
        min_y,
        resolution,
    };
    let radar = LosRadarParams {
        min_range_m,
        max_range_m,
        elevation_min_deg,
        elevation_max_deg,
        azimuth_range_deg: azimuth_limited.then_some([azimuth_start_deg, azimuth_end_deg]),
    };
    (grid, radar)
}

/// Validates like `computeLOS`, then the deadline budget.
fn validate_los_request(
    grid: &GridView<'_>,
    position: [f64; 3],
    radar: &LosRadarParams,
    deadline_ms: f64,
) -> Result<(), JsValue> {
    los::validate_los_input(grid, position, radar).map_err(|e| los_error(e, deadline_ms))?;
    if !(0.0..=los::MAX_DEADLINE_MS).contains(&deadline_ms) {
        return Err(coded_error(
            "LOS_INVALID_DEADLINE",
            "LOS runtime deadline must be a finite number of milliseconds within [0, 2^53)",
            true,
        ));
    }
    Ok(())
}

/// Per-cell LOS (`cell_states`, incidence `quality`, slope `projection`) of `losWorker.ts`.
///
/// `values` is the row-major DEM (`rows * cols`). `min_range_m` is `radar_config.min_range_m ?? 0`.
/// `azimuth_limited` is `scan_pattern !== "SAR360" && !!azimuth_range_deg`, with
/// `azimuth_start_deg`/`azimuth_end_deg` its two entries. `deadline_ms` is the runtime budget
/// (`LOS_RUNTIME_DEADLINE_MS`); the clock is `performance.now()`, read once after validation and
/// at every TS check point. Errors are `Error`/`RangeError` with the exact TS `message` and a
/// stable `code`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn compute_los(
    values: &[f64],
    rows: u32,
    cols: u32,
    min_x: f64,
    min_y: f64,
    resolution: f64,
    rx: f64,
    ry: f64,
    rz: f64,
    min_range_m: f64,
    max_range_m: f64,
    elevation_min_deg: f64,
    elevation_max_deg: f64,
    azimuth_limited: bool,
    azimuth_start_deg: f64,
    azimuth_end_deg: f64,
    deadline_ms: f64,
) -> Result<JsValue, JsValue> {
    let (grid, radar) = los_request(
        values,
        rows,
        cols,
        min_x,
        min_y,
        resolution,
        min_range_m,
        max_range_m,
        elevation_min_deg,
        elevation_max_deg,
        azimuth_limited,
        azimuth_start_deg,
        azimuth_end_deg,
    );
    let position = [rx, ry, rz];
    validate_los_request(&grid, position, &radar, deadline_ms)?;

    // Same clock reads as createLOSRuntimeDeadline(): start after validation, then one read
    // per check point.
    let started_at = performance_now();
    let mut should_abort = || performance_now() - started_at > deadline_ms;
    let buffers = los::compute_los(&grid, position, &radar, &mut should_abort)
        .map_err(|e| los_error(e, deadline_ms))?;

    let object = Object::new();
    let cell_states = Uint8Array::from(buffers.cell_states.as_slice());
    let quality = Float32Array::from(buffers.quality.as_slice());
    let projection = Float32Array::from(buffers.projection.as_slice());
    Reflect::set(&object, &JsValue::from_str("cell_states"), &cell_states)?;
    Reflect::set(&object, &JsValue::from_str("quality"), &quality)?;
    Reflect::set(&object, &JsValue::from_str("projection"), &projection)?;
    Ok(object.into())
}

/// The whole `computeLOS` of `losWorker.ts` under **one** deadline window: the per-cell phase
/// of [`compute_los`] plus the cell-state reductions (counts, coverage points and the
/// shadow-zone BFS) of `radar_core::los_summary`. Same arguments and errors as
/// [`compute_los`]. The clock is read once after validation (the window start) and then at
/// every TS `deadline.check()` point of both phases, in the TS order.
///
/// Returns an object with:
/// - `cell_states: Uint8Array`, `quality: Float32Array`, `projection: Float32Array` (as
///   [`compute_los`]);
/// - `incidence: Float64Array`: the row-major f64 `quality_grid` (`0` off VISIBLE, `NaN` for
///   VISIBLE without gradient, else the incidence before its f32 store);
/// - `visible_count`, `shadow_count`, `unknown_ray_count`: numbers;
/// - `coverage_points: Float64Array`: `[x0, y0, x1, y1, …]`, at most 100 points;
/// - `shadow_zone_cell_counts: Uint32Array`: zone `i` has `zone_id = i + 1`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn compute_los_analysis(
    values: &[f64],
    rows: u32,
    cols: u32,
    min_x: f64,
    min_y: f64,
    resolution: f64,
    rx: f64,
    ry: f64,
    rz: f64,
    min_range_m: f64,
    max_range_m: f64,
    elevation_min_deg: f64,
    elevation_max_deg: f64,
    azimuth_limited: bool,
    azimuth_start_deg: f64,
    azimuth_end_deg: f64,
    deadline_ms: f64,
) -> Result<JsValue, JsValue> {
    let (grid, radar) = los_request(
        values,
        rows,
        cols,
        min_x,
        min_y,
        resolution,
        min_range_m,
        max_range_m,
        elevation_min_deg,
        elevation_max_deg,
        azimuth_limited,
        azimuth_start_deg,
        azimuth_end_deg,
    );
    let position = [rx, ry, rz];
    validate_los_request(&grid, position, &radar, deadline_ms)?;

    // One window for both phases: a single start read, shared by every check point.
    let started_at = performance_now();
    let mut should_abort = || performance_now() - started_at > deadline_ms;
    let analysis = los::compute_los_analysis(&grid, position, &radar, &mut should_abort)
        .map_err(|e| los_error(e, deadline_ms))?;

    let summary = &analysis.summary;
    let coverage: Vec<f64> = summary.coverage_points.iter().flatten().copied().collect();
    let object = Object::new();
    for (key, value) in [
        (
            "cell_states",
            JsValue::from(Uint8Array::from(analysis.buffers.cell_states.as_slice())),
        ),
        (
            "quality",
            JsValue::from(Float32Array::from(analysis.buffers.quality.as_slice())),
        ),
        (
            "projection",
            JsValue::from(Float32Array::from(analysis.buffers.projection.as_slice())),
        ),
        (
            "incidence",
            JsValue::from(Float64Array::from(analysis.incidence.as_slice())),
        ),
        (
            "visible_count",
            JsValue::from_f64(f64::from(summary.visible_count)),
        ),
        (
            "shadow_count",
            JsValue::from_f64(f64::from(summary.shadow_count)),
        ),
        (
            "unknown_ray_count",
            JsValue::from_f64(f64::from(summary.unknown_ray_count)),
        ),
        (
            "coverage_points",
            JsValue::from(Float64Array::from(coverage.as_slice())),
        ),
        (
            "shadow_zone_cell_counts",
            JsValue::from(Uint32Array::from(
                summary.shadow_zone_cell_counts.as_slice(),
            )),
        ),
    ] {
        Reflect::set(&object, &JsValue::from_str(key), &value)?;
    }
    Ok(object.into())
}

/// Test-only probe of the JS `Math.*` ports (not part of the frozen API).
/// `op`: 0 `atan2(a, b)`, 1 `hypot(a, b)`, 2 `hypot(a, b, 1)`, 3 `round(a)`, 4 `min(a, b)`,
/// 5 `max(a, b)`. `a` and `b` must have equal length.
#[wasm_bindgen]
pub fn los_math_probe(op: u32, a: &[f64], b: &[f64]) -> Result<Float64Array, JsValue> {
    use radar_core::jsmath::{fdlibm_atan2, js_hypot2, js_hypot3, js_max, js_min, js_round};
    if a.len() != b.len() {
        return Err(coded_error("LENGTH_MISMATCH", "LENGTH_MISMATCH", false));
    }
    let f: fn(f64, f64) -> f64 = match op {
        0 => fdlibm_atan2,
        1 => js_hypot2,
        2 => |x, y| js_hypot3(x, y, 1.0),
        3 => |x, _| js_round(x),
        4 => js_min,
        5 => js_max,
        _ => return Err(coded_error("INVALID_OP", "INVALID_OP", false)),
    };
    let out: Vec<f64> = a.iter().zip(b).map(|(&x, &y)| f(x, y)).collect();
    Ok(Float64Array::from(out.as_slice()))
}
