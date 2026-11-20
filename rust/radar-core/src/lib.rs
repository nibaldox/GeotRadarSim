#![forbid(unsafe_code)]

pub mod jsmath;
pub mod los;

#[derive(Debug, PartialEq, Eq)]
pub enum GridError {
    InvalidDimensions,
    LimitExceeded,
    LengthMismatch,
}

impl GridError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidDimensions => "INVALID_DIMENSIONS",
            Self::LimitExceeded => "LIMIT_EXCEEDED",
            Self::LengthMismatch => "LENGTH_MISMATCH",
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct GridSummary {
    pub finite_count: u32,
    pub nan_count: u32,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
}

pub fn core_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn grid_summary(values: &[f64], rows: u32, cols: u32) -> Result<GridSummary, GridError> {
    if rows < 2 || cols < 2 {
        return Err(GridError::InvalidDimensions);
    }
    let cells = rows.checked_mul(cols).ok_or(GridError::LimitExceeded)?;
    if rows > 16_384 || cols > 16_384 || cells > 1_000_000 {
        return Err(GridError::LimitExceeded);
    }
    if values.len() != cells as usize {
        return Err(GridError::LengthMismatch);
    }
    let mut result = GridSummary {
        finite_count: 0,
        nan_count: 0,
        min: None,
        max: None,
        mean: None,
    };
    let mut sum = 0.0;
    for &value in values {
        if value.is_finite() {
            result.finite_count += 1;
            sum += value;
            result.min = Some(result.min.map_or(value, |min| min.min(value)));
            result.max = Some(result.max.map_or(value, |max| max.max(value)));
        } else {
            result.nan_count += 1;
        }
    }
    if result.finite_count > 0 {
        result.mean = Some(sum / f64::from(result.finite_count));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_small_dimensions() {
        assert_eq!(grid_summary(&[], 1, 2), Err(GridError::InvalidDimensions));
    }
    #[test]
    fn rejects_limits() {
        assert_eq!(grid_summary(&[], 16_385, 2), Err(GridError::LimitExceeded));
        assert_eq!(grid_summary(&[], 1001, 1000), Err(GridError::LimitExceeded));
        assert_eq!(
            grid_summary(&[], u32::MAX, u32::MAX),
            Err(GridError::LimitExceeded)
        );
    }
    #[test]
    fn rejects_length() {
        assert_eq!(grid_summary(&[1.0], 2, 2), Err(GridError::LengthMismatch));
    }
    #[test]
    fn summarizes_finite_values_in_order() {
        let s = grid_summary(
            &[1.0, f64::NAN, -2.0, f64::INFINITY, 4.0, f64::NEG_INFINITY],
            2,
            3,
        )
        .unwrap();
        assert_eq!(
            (s.finite_count, s.nan_count, s.min, s.max, s.mean),
            (3, 3, Some(-2.0), Some(4.0), Some(1.0))
        );
    }
    #[test]
    fn all_nonfinite_produces_null_statistics() {
        let s = grid_summary(
            &[f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::NAN],
            2,
            2,
        )
        .unwrap();
        assert_eq!(
            (s.finite_count, s.nan_count, s.min, s.max, s.mean),
            (0, 4, None, None, None)
        );
    }
}
