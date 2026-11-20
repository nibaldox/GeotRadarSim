use js_sys::{Error, Float32Array, Object, Reflect, Uint16Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn sensitivity(
    grid: &[f64],
    rows: u32,
    cols: u32,
    min_x: f64,
    min_y: f64,
    resolution: f64,
    positions: &[f64],
    states: &[u8],
) -> Result<JsValue, JsValue> {
    let result = radar_core::sensitivity::sensitivity(
        grid, rows, cols, min_x, min_y, resolution, positions, states,
    )
    .map_err(|error| {
        let code = error.code();
        let err = Error::new(code);
        let _ = Reflect::set(&err, &JsValue::from_str("code"), &JsValue::from_str(code));
        JsValue::from(err)
    })?;
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("flat_sensitivity_grid"),
        &Float32Array::from(result.flat_sensitivity_grid.as_slice()),
    )?;
    Reflect::set(
        &object,
        &JsValue::from_str("observer_count"),
        &Uint16Array::from(result.observer_count.as_slice()),
    )?;
    Ok(object.into())
}
