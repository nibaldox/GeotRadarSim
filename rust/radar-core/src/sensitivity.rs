//! Geometric sensitivity. Error codes are stable across the WASM boundary.
#[derive(Debug, PartialEq, Eq)]
pub enum SensitivityError {
    InvalidDimensions,
    LimitExceeded,
    InvalidObservations,
    LengthMismatch,
    InvalidGeometry,
    InvalidPosition,
    InvalidState,
}
impl SensitivityError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidDimensions => "INVALID_DIMENSIONS",
            Self::LimitExceeded => "LIMIT_EXCEEDED",
            Self::InvalidObservations => "INVALID_OBSERVATIONS",
            Self::LengthMismatch => "LENGTH_MISMATCH",
            Self::InvalidGeometry => "INVALID_GEOMETRY",
            Self::InvalidPosition => "INVALID_POSITION",
            Self::InvalidState => "INVALID_STATE",
        }
    }
}
#[derive(Debug, PartialEq)]
pub struct SensitivityResult {
    pub flat_sensitivity_grid: Vec<f32>,
    pub observer_count: Vec<u16>,
}
fn difference(
    before: Option<f64>,
    current: f64,
    after: Option<f64>,
    resolution: f64,
) -> Option<f64> {
    let before = before.filter(|v| v.is_finite());
    let after = after.filter(|v| v.is_finite());
    let d = match (before, after) {
        (Some(b), Some(a)) => (a - b) / (2.0 * resolution),
        (_, Some(a)) => (a - current) / resolution,
        (Some(b), _) => (current - b) / resolution,
        _ => return None,
    };
    d.is_finite().then_some(d)
}
fn tangent(gx: f64, gy: f64) -> (f64, f64, f64) {
    let mut x = -gx;
    let mut y = -gy;
    let mut z = -(gx * gx + gy * gy);
    let norm = (x * x + y * y + z * z).sqrt();
    if norm > 1e-4 {
        x /= norm;
        y /= norm;
        z /= norm;
    } else {
        x = 0.0;
        y = 0.0;
        z = -1.0;
    }
    (x, y, z)
}
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
) -> Result<SensitivityResult, SensitivityError> {
    use SensitivityError::*;
    if rows == 0 || cols == 0 {
        return Err(InvalidDimensions);
    }
    let cells = rows.checked_mul(cols).ok_or(LimitExceeded)? as usize;
    if rows > 16384 || cols > 16384 || cells > 1_000_000 {
        return Err(LimitExceeded);
    }
    if !positions.len().is_multiple_of(3) {
        return Err(LengthMismatch);
    }
    let n = positions.len() / 3;
    if n == 0 || n > 65535 {
        return Err(InvalidObservations);
    }
    if n.checked_mul(3).ok_or(LimitExceeded)? != positions.len() {
        return Err(LengthMismatch);
    }
    let state_len = n.checked_mul(cells).ok_or(LimitExceeded)?;
    if grid.len() != cells || states.len() != state_len {
        return Err(LengthMismatch);
    }
    if !min_x.is_finite() || !min_y.is_finite() || !resolution.is_finite() || resolution <= 0.0 {
        return Err(InvalidGeometry);
    }
    if positions.iter().any(|x| !x.is_finite()) {
        return Err(InvalidPosition);
    }
    if states.iter().any(|s| *s > 5) {
        return Err(InvalidState);
    }
    let (rows, cols) = (rows as usize, cols as usize);
    let mut out = SensitivityResult {
        flat_sensitivity_grid: vec![f32::NAN; cells],
        observer_count: vec![0; cells],
    };
    for row in 0..rows {
        let cy = min_y + row as f64 * resolution;
        for col in 0..cols {
            let i = row * cols + col;
            let z = grid[i];
            if !z.is_finite() {
                continue;
            }
            let cx = min_x + col as f64 * resolution;
            let gx = difference(
                (col > 0).then(|| grid[i - 1]),
                z,
                (col + 1 < cols).then(|| grid[i + 1]),
                resolution,
            );
            let gy = difference(
                (row > 0).then(|| grid[i - cols]),
                z,
                (row + 1 < rows).then(|| grid[i + cols]),
                resolution,
            );
            let (gx, gy) = match (gx, gy) {
                (Some(x), Some(y)) => (x, y),
                _ => continue,
            };
            let (ux, uy, uz) = tangent(gx, gy);
            let mut sum = 0.0;
            let mut count = 0u16;
            for observer in 0..n {
                if states[observer * cells + i] != 5 {
                    continue;
                }
                let dx = cx - positions[observer * 3];
                let dy = cy - positions[observer * 3 + 1];
                let dz = z - positions[observer * 3 + 2];
                let distance = (dx * dx + dy * dy + dz * dz).sqrt();
                let distance = if distance == 0.0 || distance.is_nan() {
                    0.1
                } else {
                    distance
                };
                let dot = (dx / distance) * ux + (dy / distance) * uy + (dz / distance) * uz;
                sum += dot * dot;
                count += 1;
            }
            out.observer_count[i] = count;
            if count > 0 {
                out.flat_sensitivity_grid[i] = (sum / f64::from(count)).sqrt() as f32;
            }
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_every_error() {
        let call = |grid: &[f64], rows, cols, x, y, r, pos: &[f64], states: &[u8]| {
            sensitivity(grid, rows, cols, x, y, r, pos, states)
                .unwrap_err()
                .code()
        };
        let p = [0.0, 0.0, 1.0];
        let s = [5; 4];
        let g = [0.0; 4];
        assert_eq!(call(&g, 0, 2, 0.0, 0.0, 1.0, &p, &s), "INVALID_DIMENSIONS");
        assert_eq!(
            call(&g, u32::MAX, u32::MAX, 0.0, 0.0, 1.0, &p, &s),
            "LIMIT_EXCEEDED"
        );
        assert_eq!(call(&g, 16385, 2, 0.0, 0.0, 1.0, &p, &s), "LIMIT_EXCEEDED");
        assert_eq!(
            call(&g, 1001, 1000, 0.0, 0.0, 1.0, &p, &s),
            "LIMIT_EXCEEDED"
        );
        assert_eq!(
            call(&g, 2, 2, 0.0, 0.0, 1.0, &[], &[]),
            "INVALID_OBSERVATIONS"
        );
        assert_eq!(
            call(&g, 2, 2, 0.0, 0.0, 1.0, &vec![0.0; 65536 * 3], &[]),
            "INVALID_OBSERVATIONS"
        );
        assert_eq!(call(&g, 2, 2, 0.0, 0.0, 1.0, &[0.0], &s), "LENGTH_MISMATCH");
        assert_eq!(
            call(&g[..3], 2, 2, 0.0, 0.0, 1.0, &p, &s),
            "LENGTH_MISMATCH"
        );
        assert_eq!(
            call(&g, 2, 2, 0.0, 0.0, 1.0, &p, &s[..3]),
            "LENGTH_MISMATCH"
        );
        assert_eq!(call(&g, 2, 2, 0.0, 0.0, 0.0, &p, &s), "INVALID_GEOMETRY");
        assert_eq!(
            call(&g, 2, 2, f64::NAN, 0.0, 1.0, &p, &s),
            "INVALID_GEOMETRY"
        );
        assert_eq!(
            call(&g, 2, 2, 0.0, 0.0, 1.0, &[0.0, f64::INFINITY, 1.0], &s),
            "INVALID_POSITION"
        );
        assert_eq!(
            call(&g, 2, 2, 0.0, 0.0, 1.0, &p, &[5, 5, 5, 6]),
            "INVALID_STATE"
        );
    }
    #[test]
    fn tangent_threshold_is_strict() {
        let x = 9.999999950000001e-5_f64;
        assert_eq!((x * x + (x * x) * (x * x)).sqrt(), 1e-4);
        assert_eq!(tangent(x, 0.0), (0.0, 0.0, -1.0));
        let above = f64::from_bits(x.to_bits() + 1);
        assert!((above * above + (above * above) * (above * above)).sqrt() > 1e-4);
        assert_ne!(tangent(above, 0.0), (0.0, 0.0, -1.0));
    }
    #[test]
    fn edge_corner_and_missing_neighbours() {
        let g = [0.0, 2.0, 4.0, 1.0, 3.0, 5.0, 2.0, 4.0, 6.0];
        for row in 0..3 {
            for col in 0..3 {
                let i = row * 3 + col;
                assert_eq!(
                    difference(
                        (col > 0).then(|| g[i - 1]),
                        g[i],
                        (col < 2).then(|| g[i + 1]),
                        1.0
                    ),
                    Some(2.0)
                );
                assert_eq!(
                    difference(
                        (row > 0).then(|| g[i - 3]),
                        g[i],
                        (row < 2).then(|| g[i + 3]),
                        1.0
                    ),
                    Some(1.0)
                );
            }
        }
        assert_eq!(difference(Some(f64::NAN), 3.0, Some(5.0), 1.0), Some(2.0));
        assert_eq!(difference(None, 3.0, Some(f64::INFINITY), 1.0), None);
    }
    #[test]
    fn multiple_observers_use_ordered_rms() {
        let g = [0.0; 4];
        let mask = [5; 8];
        let one = sensitivity(&g, 2, 2, 0.0, 0.0, 1.0, &[0.0, 0.0, 1.0], &mask[..4]).unwrap();
        let two = sensitivity(
            &g,
            2,
            2,
            0.0,
            0.0,
            1.0,
            &[0.0, 0.0, 1.0, 1.0, 0.0, 0.0],
            &mask,
        )
        .unwrap();
        assert_eq!(one.observer_count[0], 1);
        assert_eq!(one.flat_sensitivity_grid[0], 1.0);
        assert_eq!(two.observer_count[0], 2);
        assert_eq!(two.flat_sensitivity_grid[0], (0.5_f64.sqrt()) as f32);
    }
    #[test]
    fn measured_zero_and_no_contributors_are_distinct() {
        let result = sensitivity(
            &[5.0; 4],
            2,
            2,
            0.0,
            0.0,
            1.0,
            &[1.0, 0.0, 5.0],
            &[5, 0, 0, 0],
        )
        .unwrap();
        assert_eq!(result.observer_count, [1, 0, 0, 0]);
        assert_eq!(result.flat_sensitivity_grid[0], 0.0);
        assert!(result.flat_sensitivity_grid[1].is_nan());
    }
}
