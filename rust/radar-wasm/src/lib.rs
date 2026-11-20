use js_sys::{Error, Float32Array, Float64Array, Object, RangeError, Reflect, Uint8Array};
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
    let position = [rx, ry, rz];
    los::validate_los_input(&grid, position, &radar).map_err(|e| los_error(e, deadline_ms))?;
    if !(0.0..=los::MAX_DEADLINE_MS).contains(&deadline_ms) {
        return Err(coded_error(
            "LOS_INVALID_DEADLINE",
            "LOS runtime deadline must be a finite number of milliseconds within [0, 2^53)",
            true,
        ));
    }

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
