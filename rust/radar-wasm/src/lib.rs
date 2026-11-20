use js_sys::{Error, Object, Reflect};
use wasm_bindgen::prelude::*;

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
