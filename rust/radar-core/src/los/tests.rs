use super::cell_state::*;
use super::*;

fn open_radar(max_range_m: f64) -> LosRadarParams {
    LosRadarParams {
        min_range_m: 0.0,
        max_range_m,
        elevation_min_deg: -90.0,
        elevation_max_deg: 90.0,
        azimuth_range_deg: None,
    }
}

fn view(values: &[f64], rows: u32, cols: u32) -> GridView<'_> {
    GridView {
        values,
        rows,
        cols,
        min_x: 0.0,
        min_y: 0.0,
        resolution: 1.0,
    }
}

fn run(grid: &GridView<'_>, pos: [f64; 3], radar: &LosRadarParams) -> Result<LosBuffers, LosError> {
    compute_los(grid, pos, radar, &mut || false)
}

fn at(buffers: &LosBuffers, cols: usize, row: usize, col: usize) -> u8 {
    buffers.cell_states[row * cols + col]
}

#[test]
fn every_validation_error_has_its_code_and_ts_message() {
    let radar = open_radar(100.0);
    let four = [0.0; 4];
    let cases: Vec<(GridView<'_>, [f64; 3], LosRadarParams, LosError)> = vec![
        (view(&[], 0, 2), [0.0; 3], radar, LosError::EmptyGrid),
        (view(&[], 2, 0), [0.0; 3], radar, LosError::EmptyGrid),
        (
            view(&[], 16_385, 2),
            [0.0; 3],
            radar,
            LosError::GridDimensionLimit,
        ),
        (
            view(&[], 2, 16_385),
            [0.0; 3],
            radar,
            LosError::GridDimensionLimit,
        ),
        (
            view(&[], u32::MAX, u32::MAX),
            [0.0; 3],
            radar,
            LosError::GridDimensionLimit,
        ),
        (
            view(&[], 1_001, 1_000),
            [0.0; 3],
            radar,
            LosError::GridCellLimit,
        ),
        (
            view(&[0.0; 3], 2, 2),
            [0.0; 3],
            radar,
            LosError::GridNotRectangular,
        ),
        (
            view(&[0.0; 5], 2, 2),
            [0.0; 3],
            radar,
            LosError::GridNotRectangular,
        ),
        (
            GridView {
                resolution: f64::NAN,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::InvalidResolution,
        ),
        (
            GridView {
                resolution: 0.0,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::InvalidResolution,
        ),
        (
            GridView {
                resolution: -1.0,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::InvalidResolution,
        ),
        (
            GridView {
                resolution: f64::INFINITY,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::InvalidResolution,
        ),
        (
            GridView {
                resolution: 1e-200,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::ResolutionAreaUnrepresentable,
        ),
        (
            GridView {
                resolution: 1e200,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::ResolutionAreaUnrepresentable,
        ),
        (
            GridView {
                resolution: 1e154,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::TotalAreaNotFinite,
        ),
        (
            GridView {
                min_x: f64::NAN,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::NonFinitePosition,
        ),
        (
            GridView {
                min_y: f64::INFINITY,
                ..view(&four, 2, 2)
            },
            [0.0; 3],
            radar,
            LosError::NonFinitePosition,
        ),
        (
            view(&four, 2, 2),
            [f64::NAN, 0.0, 0.0],
            radar,
            LosError::NonFinitePosition,
        ),
        (
            view(&four, 2, 2),
            [0.0, f64::INFINITY, 0.0],
            radar,
            LosError::NonFinitePosition,
        ),
        (
            view(&four, 2, 2),
            [0.0, 0.0, f64::NEG_INFINITY],
            radar,
            LosError::NonFinitePosition,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                min_range_m: f64::NAN,
                ..radar
            },
            LosError::InvalidRangeLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                min_range_m: -1.0,
                ..radar
            },
            LosError::InvalidRangeLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                min_range_m: 101.0,
                ..radar
            },
            LosError::InvalidRangeLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                max_range_m: f64::INFINITY,
                ..radar
            },
            LosError::InvalidRangeLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                elevation_min_deg: -90.5,
                ..radar
            },
            LosError::InvalidElevationLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                elevation_max_deg: 90.5,
                ..radar
            },
            LosError::InvalidElevationLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                elevation_min_deg: 10.0,
                elevation_max_deg: 5.0,
                ..radar
            },
            LosError::InvalidElevationLimits,
        ),
        (
            view(&four, 2, 2),
            [0.0; 3],
            LosRadarParams {
                elevation_max_deg: f64::NAN,
                ..radar
            },
            LosError::InvalidElevationLimits,
        ),
    ];
    for (grid, pos, radar, expected) in cases {
        assert_eq!(
            run(&grid, pos, &radar),
            Err(expected),
            "{grid:?} {pos:?} {radar:?}"
        );
        assert_eq!(validate_los_input(&grid, pos, &radar), Err(expected));
    }
    // Equal min/max range and exact elevation bounds are valid.
    let valid = LosRadarParams {
        min_range_m: 5.0,
        max_range_m: 5.0,
        elevation_min_deg: -90.0,
        elevation_max_deg: 90.0,
        azimuth_range_deg: None,
    };
    assert_eq!(
        validate_los_input(&view(&four, 2, 2), [0.0; 3], &valid),
        Ok(4)
    );
    // Limits at exactly 16,384 nodes per axis and 1,000,000 cells are accepted by shape.
    assert_eq!(
        validate_los_input(&view(&[], 16_384, 61), [0.0; 3], &valid),
        Err(LosError::GridNotRectangular)
    );
    assert_eq!(
        validate_los_input(&view(&[], 1_000, 1_000), [0.0; 3], &valid),
        Err(LosError::GridNotRectangular)
    );
}

#[test]
fn error_codes_and_messages_are_stable() {
    let expected = [
        (
            LosError::EmptyGrid,
            "LOS_EMPTY_GRID",
            "LOS grid must be non-empty and rectangular",
            false,
        ),
        (
            LosError::GridDimensionLimit,
            "LOS_GRID_DIMENSION_LIMIT",
            "LOS grid dimension exceeds the maximum of 16,384 nodes",
            true,
        ),
        (
            LosError::GridCellLimit,
            "LOS_GRID_CELL_LIMIT",
            "LOS grid exceeds the maximum size of 1,000,000 cells",
            true,
        ),
        (
            LosError::GridNotRectangular,
            "LOS_GRID_NOT_RECTANGULAR",
            "LOS grid must be rectangular",
            false,
        ),
        (
            LosError::InvalidResolution,
            "LOS_INVALID_RESOLUTION",
            "LOS resolution must be finite and positive",
            true,
        ),
        (
            LosError::ResolutionAreaUnrepresentable,
            "LOS_RESOLUTION_AREA_UNREPRESENTABLE",
            "LOS resolution squared must be finite and non-zero to represent cell area",
            true,
        ),
        (
            LosError::TotalAreaNotFinite,
            "LOS_TOTAL_AREA_NOT_FINITE",
            "LOS total grid area must be finite",
            true,
        ),
        (
            LosError::NonFinitePosition,
            "LOS_NON_FINITE_POSITION",
            "LOS bounds and radar position must be finite",
            true,
        ),
        (
            LosError::InvalidRangeLimits,
            "LOS_INVALID_RANGE_LIMITS",
            "LOS range limits must be finite, non-negative, and ordered",
            true,
        ),
        (
            LosError::InvalidElevationLimits,
            "LOS_INVALID_ELEVATION_LIMITS",
            "LOS elevation limits must be finite, within [-90, 90], and ordered",
            true,
        ),
        (
            LosError::DeadlineExceeded,
            "LOS_DEADLINE_EXCEEDED",
            "El cálculo de visibilidad LOS excedió el tiempo máximo de ejecución (120 segundos). \
             Reduzca el área del terreno, aumente la resolución o disminuya el alcance del radar \
             y vuelva a intentarlo.",
            true,
        ),
        (
            LosError::RayNonFiniteCoordinate,
            "LOS_RAY_NON_FINITE_COORDINATE",
            "LOS ray traversal left finite grid coordinates",
            true,
        ),
        (
            LosError::RayPrecisionStall,
            "LOS_RAY_PRECISION_STALL",
            "LOS ray traversal cannot advance at floating-point precision",
            true,
        ),
        (
            LosError::RayDidNotAdvance,
            "LOS_RAY_DID_NOT_ADVANCE",
            "LOS ray traversal did not advance to the next grid intersection",
            true,
        ),
    ];
    for (error, code, message, range_error) in expected {
        assert_eq!(error.code(), code);
        assert_eq!(error.ts_message(), message);
        assert_eq!(error.is_range_error(), range_error, "{code}");
    }
    assert!(deadline_exceeded_message(1_499.0).contains("(1 segundos)"));
    assert!(deadline_exceeded_message(1_500.0).contains("(2 segundos)"));
    assert!(deadline_exceeded_message(0.0).contains("(0 segundos)"));
    assert!(deadline_exceeded_message(-0.0).contains("(0 segundos)"));
    assert!(deadline_exceeded_message(MAX_DEADLINE_MS).contains("(9007199254741 segundos)"));
}

#[test]
fn flat_plane_is_visible_with_exact_incidence_and_vertical_projection() {
    let values = [0.0; 25];
    let grid = view(&values, 5, 5);
    let out = run(&grid, [2.0, 2.0, 10.0], &open_radar(100.0)).unwrap();
    assert!(out.cell_states.iter().all(|&s| s == VISIBLE));
    for r in 0..5 {
        for c in 0..5 {
            let (dx, dy, dz) = (c as f64 - 2.0, r as f64 - 2.0, -10.0_f64);
            let d = (dx * dx + dy * dy + dz * dz).sqrt();
            let idx = r * 5 + c;
            assert_eq!(
                out.quality[idx].to_bits(),
                ((10.0 / d) as f32).to_bits(),
                "q {r},{c}"
            );
            // Flat terrain: downward-vertical fallback, |uz * -1|.
            assert_eq!(
                out.projection[idx].to_bits(),
                ((10.0 / d) as f32).to_bits(),
                "p {r},{c}"
            );
        }
    }
    // Radar directly above a node: vertical ray, incidence 1.
    assert_eq!(out.quality[12], 1.0);
    assert_eq!(out.projection[12], 1.0);
}

#[test]
fn ridge_casts_shadow_on_grid_line_rays_and_beyond() {
    let (rows, cols) = (3, 7);
    let mut values = vec![0.0; rows * cols];
    for r in 0..rows {
        values[r * cols + 3] = 50.0;
    }
    let grid = view(&values, rows as u32, cols as u32);
    let out = run(&grid, [0.0, 1.0, 5.0], &open_radar(100.0)).unwrap();
    for r in 0..rows {
        for c in 4..cols {
            assert_eq!(at(&out, cols, r, c), SHADOW, "{r},{c}");
            assert_eq!(out.quality[r * cols + c], -1.0);
            assert!(out.projection[r * cols + c].is_nan());
        }
    }
    // Along the y = 1 grid line, before the ridge.
    assert_eq!(at(&out, cols, 1, 1), VISIBLE);
    assert_eq!(at(&out, cols, 1, 2), VISIBLE);
}

#[test]
fn nan_holes_follow_unknown_ray_and_nodata_rules() {
    let (rows, cols) = (3, 6);
    let mut values = vec![0.0; rows * cols];
    values[cols + 2] = f64::NAN;
    let grid = view(&values, rows as u32, cols as u32);
    let out = run(&grid, [0.0, 1.0, 5.0], &open_radar(100.0)).unwrap();
    assert_eq!(at(&out, cols, 1, 2), NODATA);
    assert_eq!(at(&out, cols, 1, 5), UNKNOWN_RAY);
    assert_eq!(at(&out, cols, 0, 5), UNKNOWN_RAY);
    assert_eq!(out.quality[cols + 5], -1.0);
    assert!(out.projection[cols + 5].is_nan());
    // A hole beyond the target does not matter; one-sided gradient keeps an index.
    assert_eq!(at(&out, cols, 1, 1), VISIBLE);
    assert!(out.quality[cols + 1].is_finite());
}

#[test]
fn visible_cell_without_finite_gradient_has_nan_quality() {
    // Central difference overflows to Infinity, so terrainGradientAt returns null.
    let values = [0.0, 0.0, 0.0, -1e308, 0.0, 1e308, 0.0, 0.0, 0.0];
    let grid = view(&values, 3, 3);
    let out = run(&grid, [1.0, 1.0, 10.0], &open_radar(0.5)).unwrap();
    assert_eq!(out.cell_states[4], VISIBLE);
    assert!(out.quality[4].is_nan());
    assert!(out.projection[4].is_nan());
    assert!(
        out.cell_states
            .iter()
            .enumerate()
            .all(|(i, &s)| i == 4 || s == OUT_OF_RANGE)
    );
}

#[test]
fn rays_on_the_mesh_diagonal_and_through_vertices() {
    // Anti-diagonal x + y = 2 lies exactly on shared triangle edges.
    let flat = [0.0; 9];
    let radar = open_radar(100.0);
    let out = run(&view(&flat, 3, 3), [0.0, 2.0, 1.0], &radar).unwrap();
    assert_eq!(out.cell_states[2], VISIBLE); // (row 0, col 2)
    let mut bump = flat;
    bump[4] = 5.0; // node (1, 1) on the diagonal
    let out = run(&view(&bump, 3, 3), [0.0, 2.0, 1.0], &radar).unwrap();
    assert_eq!(out.cell_states[2], SHADOW);
    // Main diagonal through vertices (1,1) and (2,2): x, y and x+y crossings coincide.
    let flat16 = [0.0; 16];
    let out = run(&view(&flat16, 4, 4), [0.0, 0.0, 1.0], &radar).unwrap();
    assert_eq!(out.cell_states[15], VISIBLE);
    let mut bump16 = flat16;
    bump16[5] = 5.0;
    let out = run(&view(&bump16, 4, 4), [0.0, 0.0, 1.0], &radar).unwrap();
    assert_eq!(out.cell_states[15], SHADOW);
}

#[test]
fn radar_on_border_and_outside_the_grid() {
    let flat = [0.0; 25];
    let radar = open_radar(100.0);
    let edge = run(&view(&flat, 5, 5), [0.0, 2.0, 3.0], &radar).unwrap();
    assert!(edge.cell_states.iter().all(|&s| s == VISIBLE));
    let outside = run(&view(&flat, 5, 5), [-5.0, 2.0, 3.0], &radar).unwrap();
    assert!(outside.cell_states.iter().all(|&s| s == VISIBLE));
    // Radar below the surface outside the grid: the clipped ray enters under the terrain,
    // except at column 0 where the clip degenerates to the target point itself.
    let raised = [10.0; 25];
    let below = run(&view(&raised, 5, 5), [-5.0, 2.0, 0.0], &radar).unwrap();
    for (idx, &state) in below.cell_states.iter().enumerate() {
        let expected = if idx % 5 == 0 { VISIBLE } else { SHADOW };
        assert_eq!(state, expected, "cell {idx}");
    }
}

#[test]
fn range_azimuth_and_elevation_limits_are_inclusive() {
    // 1×N grids validate but every ray is UNKNOWN_RAY (rows < 2), exposing the filters.
    let values: Vec<f64> = (0..11).map(f64::from).collect();
    let grid = view(&values, 1, 11);
    let radar = LosRadarParams {
        min_range_m: 2.0,
        max_range_m: 5.0,
        ..open_radar(5.0)
    };
    let out = run(&grid, [0.0, 0.0, 0.0], &radar).unwrap();
    assert_eq!(
        &out.cell_states[..7],
        &[
            OUT_OF_RANGE,
            OUT_OF_RANGE,
            UNKNOWN_RAY,
            UNKNOWN_RAY,
            UNKNOWN_RAY,
            UNKNOWN_RAY,
            OUT_OF_RANGE
        ]
    );

    let degrees = 180.0 / std::f64::consts::PI;
    let forty_five = crate::jsmath::fdlibm_atan2(1.0, 1.0) * degrees;
    let exact = LosRadarParams {
        elevation_min_deg: forty_five,
        elevation_max_deg: forty_five,
        ..open_radar(100.0)
    };
    let out = run(&grid, [0.0, 0.0, 0.0], &exact).unwrap();
    assert_eq!(out.cell_states[0], OUTSIDE_FOV); // atan2(0, 0) = 0°
    assert!(out.cell_states[1..].iter().all(|&s| s == UNKNOWN_RAY));
    let above = LosRadarParams {
        elevation_min_deg: next_up(forty_five),
        elevation_max_deg: 90.0,
        ..exact
    };
    let out = run(&grid, [0.0, 0.0, 0.0], &above).unwrap();
    assert!(out.cell_states.iter().all(|&s| s == OUTSIDE_FOV));

    // Azimuth atan2(dx, dy) in degrees: [az, az] admits exactly one cell, wrap-around admits others.
    let flat = vec![0.0; 3 * 3];
    let grid = view(&flat, 3, 3);
    let az = crate::jsmath::fdlibm_atan2(2.0, 1.0) * degrees;
    let sector = LosRadarParams {
        azimuth_range_deg: Some([az, az]),
        ..open_radar(100.0)
    };
    let out = run(&grid, [0.0, 0.0, 1.0], &sector).unwrap();
    let admitted: Vec<usize> = (0..9)
        .filter(|&i| out.cell_states[i] != OUTSIDE_FOV)
        .collect();
    assert_eq!(admitted, vec![5]); // (row 1, col 2)
    let wrap = LosRadarParams {
        azimuth_range_deg: Some([next_up(az), az]),
        ..sector
    };
    let out = run(&grid, [0.0, 0.0, 1.0], &wrap).unwrap();
    assert!((0..9).all(|i| out.cell_states[i] != OUTSIDE_FOV));
    let nan = LosRadarParams {
        azimuth_range_deg: Some([f64::NAN, f64::NAN]),
        ..sector
    };
    let out = run(&grid, [0.0, 0.0, 1.0], &nan).unwrap();
    assert!(out.cell_states.iter().all(|&s| s == OUTSIDE_FOV));
}

fn next_up(x: f64) -> f64 {
    f64::from_bits(x.to_bits() + 1)
}

#[test]
fn deadline_is_polled_per_row_and_every_1024_intervals() {
    // One finite node at the end of a 2000-node row: a single ~2000-interval ray.
    let cols = 2_000usize;
    let mut values = vec![f64::NAN; 2 * cols];
    values[cols - 1] = 0.0;
    let grid = view(&values, 2, cols as u32);
    let radar = open_radar(5_000.0);
    let mut calls = 0;
    let out = compute_los(&grid, [0.0, 0.0, 10.0], &radar, &mut || {
        calls += 1;
        false
    });
    assert!(out.is_ok());
    assert_eq!(calls, 3, "two rows plus one interval check");
    for abort_at in 1..=3 {
        let mut calls = 0;
        let out = compute_los(&grid, [0.0, 0.0, 10.0], &radar, &mut || {
            calls += 1;
            calls == abort_at
        });
        assert_eq!(out, Err(LosError::DeadlineExceeded), "abort at {abort_at}");
    }
}

#[test]
fn far_radar_hits_the_precision_stall_guard() {
    let cols = 16_384usize;
    let values = vec![0.0; 2 * cols];
    let grid = view(&values, 2, cols as u32);
    let radar = open_radar(1e300);
    let out = run(&grid, [2f64.powi(60), 0.5, 1e6], &radar);
    assert_eq!(out, Err(LosError::RayPrecisionStall));
}

#[test]
fn single_row_and_two_by_two_grids() {
    let values = [1.0, 2.0];
    let out = run(&view(&values, 1, 2), [0.0, 0.0, 5.0], &open_radar(10.0)).unwrap();
    assert_eq!(out.cell_states, vec![UNKNOWN_RAY, UNKNOWN_RAY]);
    let values = [0.0, 1.0, 2.0, 3.0];
    let out = run(&view(&values, 2, 2), [0.5, 0.5, 10.0], &open_radar(10.0)).unwrap();
    assert!(out.cell_states.iter().all(|&s| s == VISIBLE));
    assert!(
        out.quality
            .iter()
            .all(|q| q.is_finite() && *q >= 0.0 && *q <= 1.0)
    );
}

#[test]
fn snap_grid_coordinate_uses_number_epsilon_scaled_tolerance() {
    assert_eq!(
        snap_grid_coordinate(3.0 + 4.0 * f64::EPSILON),
        3.0 + 4.0 * f64::EPSILON
    );
    assert_eq!(snap_grid_coordinate(1.0 + f64::EPSILON), 1.0);
    assert_eq!(snap_grid_coordinate(1.0 - f64::EPSILON / 2.0), 1.0);
    assert!(snap_grid_coordinate(-1e-17).to_bits() == (-0.0f64).to_bits());
    assert!(snap_grid_coordinate(f64::NAN).is_nan());
}

// The ray endpoint is the target node, which lies on the surface: it can never occlude itself.
// Before the exact endpoint, `start_z + 1 * delta_z` (20 + 1 * -27.05 = -7.050000000000001) and
// `grid_start + 1 * delta - col` missed the node by an ulp, and the target became a false SHADOW.

fn counts(states: &[u8]) -> (usize, usize, usize) {
    let n = |s: u8| states.iter().filter(|&&v| v == s).count();
    (n(VISIBLE), n(SHADOW), n(UNKNOWN_RAY))
}

#[test]
fn target_endpoint_rounding_premise() {
    let delta_z: f64 = -7.05 - 20.0;
    assert_eq!(20.0 + 1.0 * delta_z, -7.050000000000001);
}

#[test]
fn target_endpoint_flat_surface_at_minus_7_05_is_visible() {
    let values = vec![-7.05; 9 * 11];
    let grid = view(&values, 9, 11);
    for pos in [[4.0, 4.0, 20.0], [4.3, 3.7, 20.0]] {
        let out = run(&grid, pos, &open_radar(1e6)).unwrap();
        assert_eq!(counts(&out.cell_states), (99, 0, 0), "radar {pos:?}");
    }
}

#[test]
fn target_endpoint_simple_slope_is_visible() {
    let (rows, cols) = (9usize, 11usize);
    let values: Vec<f64> = (0..rows * cols)
        .map(|i| -7.05 + 0.35 * (i % cols) as f64 - 0.15 * (i / cols) as f64)
        .collect();
    let grid = view(&values, rows as u32, cols as u32);
    let out = run(&grid, [4.3, 3.7, 20.0], &open_radar(1e6)).unwrap();
    assert_eq!(counts(&out.cell_states), (99, 0, 0));
}

#[test]
fn target_endpoint_shifted_origin_is_visible() {
    let values = vec![-7.05; 9 * 11];
    let grid = GridView {
        min_x: 1000.1,
        min_y: 2000.3,
        ..view(&values, 9, 11)
    };
    let out = run(&grid, [1000.1 + 4.3, 2000.3 + 3.7, 20.0], &open_radar(1e6)).unwrap();
    assert_eq!(counts(&out.cell_states), (99, 0, 0));
}

#[test]
fn target_endpoint_keeps_real_wall_shadow() {
    let (rows, cols) = (5usize, 9usize);
    let values: Vec<f64> = (0..rows * cols)
        .map(|i| if i % cols == 4 { 30.0 } else { -7.05 })
        .collect();
    let grid = view(&values, rows as u32, cols as u32);
    let out = run(&grid, [0.5, 2.2, 20.0], &open_radar(1e6)).unwrap();
    for r in 0..rows {
        for c in 0..cols {
            if c >= 5 {
                assert_eq!(at(&out, cols, r, c), SHADOW, "{r},{c}");
            }
            if c <= 3 {
                assert_eq!(at(&out, cols, r, c), VISIBLE, "{r},{c}");
            }
        }
    }
}

#[test]
fn target_endpoint_keeps_crest_shadow_at_entry_of_the_incident_triangle() {
    // Quads (row 1, col 1..2) are not renderable, so only the last interval, in triangle 1 of
    // quad (row 1, col 3) = (1,3), (1,4) = target, (2,3), sees the 10 m crest at its entry.
    let (rows, cols) = (4usize, 6usize);
    let mut values = vec![0.0; rows * cols];
    values[2 * cols + 2] = f64::NAN;
    values[cols + 3] = 10.0;
    values[2 * cols + 3] = 10.0;
    let grid = view(&values, rows as u32, cols as u32);
    let out = run(&grid, [0.5, 1.4, 5.0], &open_radar(1e6)).unwrap();
    assert_eq!(at(&out, cols, 1, 4), SHADOW);
    assert_eq!(at(&out, cols, 1, 3), UNKNOWN_RAY);
}
