//! Cell-state reductions of `computeLOS` in `frontend/src/workers/losWorker.ts`.
//!
//! These depend only on `cell_states` (plus the node coordinates for coverage points):
//! - the VISIBLE / SHADOW / UNKNOWN_RAY counts;
//! - `coverage_polygon`: the first [`MAX_COVERAGE_POINTS`] VISIBLE nodes in row-major order,
//!   as `[min_x + col * resolution, min_y + row * resolution]`, the TS expressions;
//! - `shadow_zones`: 4-connected SHADOW components, discovered in row-major order of their
//!   first cell (so zone `i` has `zone_id = i + 1`), each with its cell count.
//!
//! The BFS polls `should_abort` at exactly the TS `deadline.check()` points of that phase:
//! once at the start of every row and, inside each zone, before dequeuing every element whose
//! queue position `head` satisfies `head & 1023 == 1023`. The counts and coverage points are
//! computed inside the TS per-cell loop without extra checks, so they poll nothing here.

use crate::los::{
    LOS_RUNTIME_CHECK_INTERVAL, LosError, MAX_GRID_CELLS, MAX_GRID_DIMENSION, cell_state,
};

/// `coverage_polygon` keeps at most this many points (`coverage_polygon.length < 100`).
pub const MAX_COVERAGE_POINTS: usize = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct LosSummary {
    pub visible_count: u32,
    pub shadow_count: u32,
    pub unknown_ray_count: u32,
    /// First VISIBLE nodes in row-major order as `[x, y]`, at most [`MAX_COVERAGE_POINTS`].
    pub coverage_points: Vec<[f64; 2]>,
    /// Cell count of each shadow zone, in discovery order (`zone_id = index + 1`).
    pub shadow_zone_cell_counts: Vec<u32>,
}

/// Reduce a row-major `cell_states` buffer exactly like the tail of `computeLOS`.
///
/// Revalidates its own boundary: `rows`/`cols` in `1..=16_384`, at most 1,000,000 cells,
/// `cell_states.len() == rows * cols`, finite `min_x`/`min_y` and a finite positive
/// `resolution`, with the same error variants as [`crate::los::validate_los_input`].
pub fn summarize_los(
    cell_states: &[u8],
    rows: u32,
    cols: u32,
    min_x: f64,
    min_y: f64,
    resolution: f64,
    should_abort: &mut dyn FnMut() -> bool,
) -> Result<LosSummary, LosError> {
    if rows == 0 || cols == 0 {
        return Err(LosError::EmptyGrid);
    }
    if rows > MAX_GRID_DIMENSION || cols > MAX_GRID_DIMENSION {
        return Err(LosError::GridDimensionLimit);
    }
    let cells = u64::from(rows)
        .checked_mul(u64::from(cols))
        .ok_or(LosError::GridCellLimit)?;
    if cells > MAX_GRID_CELLS {
        return Err(LosError::GridCellLimit);
    }
    let cells = usize::try_from(cells).map_err(|_| LosError::GridCellLimit)?;
    if cell_states.len() != cells {
        return Err(LosError::GridNotRectangular);
    }
    if !resolution.is_finite() || resolution <= 0.0 {
        return Err(LosError::InvalidResolution);
    }
    if !min_x.is_finite() || !min_y.is_finite() {
        return Err(LosError::NonFinitePosition);
    }
    let rows = rows as usize;
    let cols = cols as usize;

    let mut summary = LosSummary {
        visible_count: 0,
        shadow_count: 0,
        unknown_ray_count: 0,
        coverage_points: Vec::new(),
        shadow_zone_cell_counts: Vec::new(),
    };
    for r in 0..rows {
        let cy = min_y + r as f64 * resolution;
        for c in 0..cols {
            match cell_states[r * cols + c] {
                cell_state::VISIBLE => {
                    summary.visible_count += 1;
                    if summary.coverage_points.len() < MAX_COVERAGE_POINTS {
                        summary
                            .coverage_points
                            .push([min_x + c as f64 * resolution, cy]);
                    }
                }
                cell_state::SHADOW => summary.shadow_count += 1,
                cell_state::UNKNOWN_RAY => summary.unknown_ray_count += 1,
                _ => {}
            }
        }
    }

    let check_mask = (LOS_RUNTIME_CHECK_INTERVAL - 1) as usize;
    let mut visited = vec![false; cells];
    let mut queue: Vec<usize> = Vec::new();
    for r in 0..rows {
        if should_abort() {
            return Err(LosError::DeadlineExceeded);
        }
        for c in 0..cols {
            let start_index = r * cols + c;
            if cell_states[start_index] != cell_state::SHADOW || visited[start_index] {
                continue;
            }
            queue.clear();
            queue.push(start_index);
            visited[start_index] = true;
            let mut head = 0;
            while head < queue.len() {
                if head & check_mask == check_mask && should_abort() {
                    return Err(LosError::DeadlineExceeded);
                }
                let index = queue[head];
                let row = index / cols;
                let col = index % cols;
                // Same neighbour order as the TS: up, down, left, right.
                let mut visit = |next: usize| {
                    if !visited[next] && cell_states[next] == cell_state::SHADOW {
                        visited[next] = true;
                        queue.push(next);
                    }
                };
                if row > 0 {
                    visit(index - cols);
                }
                if row + 1 < rows {
                    visit(index + cols);
                }
                if col > 0 {
                    visit(index - 1);
                }
                if col + 1 < cols {
                    visit(index + 1);
                }
                head += 1;
            }
            // At most 1,000,000 cells, so the count fits in u32.
            summary.shadow_zone_cell_counts.push(queue.len() as u32);
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::cell_state::*;
    use super::*;
    use crate::los::{GridView, LosRadarParams, compute_los, compute_los_analysis};

    fn never() -> impl FnMut() -> bool {
        || false
    }

    fn summarize(states: &[u8], rows: u32, cols: u32) -> Result<LosSummary, LosError> {
        summarize_los(states, rows, cols, 0.0, 0.0, 1.0, &mut never())
    }

    /// Straightforward reference: flood fill with an explicit stack, zones in row-major
    /// order of their first cell.
    fn reference_zones(states: &[u8], rows: usize, cols: usize) -> Vec<u32> {
        let mut seen = vec![false; states.len()];
        let mut zones = Vec::new();
        for start in 0..states.len() {
            if states[start] != SHADOW || seen[start] {
                continue;
            }
            let mut stack = vec![start];
            seen[start] = true;
            let mut count = 0;
            while let Some(index) = stack.pop() {
                count += 1;
                let (row, col) = (index / cols, index % cols);
                let mut neighbours = Vec::new();
                if row > 0 {
                    neighbours.push(index - cols);
                }
                if row + 1 < rows {
                    neighbours.push(index + cols);
                }
                if col > 0 {
                    neighbours.push(index - 1);
                }
                if col + 1 < cols {
                    neighbours.push(index + 1);
                }
                for next in neighbours {
                    if !seen[next] && states[next] == SHADOW {
                        seen[next] = true;
                        stack.push(next);
                    }
                }
            }
            zones.push(count);
        }
        zones
    }

    #[test]
    fn validates_its_boundary() {
        let four = [0u8; 4];
        assert_eq!(summarize(&[], 0, 2), Err(LosError::EmptyGrid));
        assert_eq!(summarize(&[], 2, 0), Err(LosError::EmptyGrid));
        assert_eq!(summarize(&[], 16_385, 1), Err(LosError::GridDimensionLimit));
        assert_eq!(
            summarize(&[], u32::MAX, u32::MAX),
            Err(LosError::GridDimensionLimit)
        );
        assert_eq!(summarize(&[], 1_001, 1_000), Err(LosError::GridCellLimit));
        assert_eq!(summarize(&four, 2, 3), Err(LosError::GridNotRectangular));
        assert_eq!(
            summarize(&four[..3], 2, 2),
            Err(LosError::GridNotRectangular)
        );
        for resolution in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                summarize_los(&four, 2, 2, 0.0, 0.0, resolution, &mut never()),
                Err(LosError::InvalidResolution)
            );
        }
        for (min_x, min_y) in [(f64::NAN, 0.0), (0.0, f64::INFINITY)] {
            assert_eq!(
                summarize_los(&four, 2, 2, min_x, min_y, 1.0, &mut never()),
                Err(LosError::NonFinitePosition)
            );
        }
    }

    #[test]
    fn counts_states_and_keeps_the_first_hundred_visible_nodes() {
        let rows = 25;
        let cols = 30;
        let states: Vec<u8> = (0..rows * cols).map(|i| (i % 6) as u8).collect();
        let summary = summarize_los(
            &states,
            rows as u32,
            cols as u32,
            92_008.875,
            -3_000.3,
            2.5,
            &mut never(),
        )
        .unwrap();
        let count = |s| states.iter().filter(|&&v| v == s).count() as u32;
        assert_eq!(summary.visible_count, count(VISIBLE));
        assert_eq!(summary.shadow_count, count(SHADOW));
        assert_eq!(summary.unknown_ray_count, count(UNKNOWN_RAY));
        let expected: Vec<[f64; 2]> = (0..rows * cols)
            .filter(|&i| states[i] == VISIBLE)
            .take(100)
            .map(|i| {
                let (r, c) = (i / cols, i % cols);
                [92_008.875 + c as f64 * 2.5, -3_000.3 + r as f64 * 2.5]
            })
            .collect();
        assert!(count(VISIBLE) > 100);
        assert_eq!(expected.len(), MAX_COVERAGE_POINTS);
        assert_eq!(summary.coverage_points, expected);
    }

    #[test]
    fn shadow_zones_are_four_connected_and_in_row_major_discovery_order() {
        #[rustfmt::skip]
        let states = [
            4, 4, 5, 4,
            5, 4, 5, 4,
            4, 5, 4, 4,
            4, 4, 0, 5,
        ];
        let summary = summarize(&states, 4, 4).unwrap();
        // Diagonal contact (row 1 col 1 with row 2 col 0) does not join zones.
        assert_eq!(summary.shadow_zone_cell_counts, vec![3, 4, 3]);
        assert_eq!(summary.shadow_count, 10);

        let mut seed = 0x1234_5678_u32;
        for case in 0..60 {
            let rows = 1 + (case % 9);
            let cols = 1 + (case * 7 % 13);
            let states: Vec<u8> = (0..rows * cols)
                .map(|_| {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    if seed >> 30 == 0 {
                        VISIBLE
                    } else {
                        [SHADOW, SHADOW, NODATA, UNKNOWN_RAY][(seed >> 24) as usize % 4]
                    }
                })
                .collect();
            let summary = summarize(&states, rows as u32, cols as u32).unwrap();
            assert_eq!(
                summary.shadow_zone_cell_counts,
                reference_zones(&states, rows, cols),
                "case {case} {rows}x{cols}"
            );
        }
    }

    #[test]
    fn polls_once_per_row_and_once_per_1024_dequeued_cells_of_each_zone() {
        // One 2x1500 zone (3000 cells: polls at head 1023 and 2047) and a 1-cell zone.
        let rows = 3;
        let cols = 1_500;
        let mut states = vec![SHADOW; rows * cols];
        for (c, state) in states[2 * cols..].iter_mut().enumerate() {
            *state = if c == 7 { SHADOW } else { VISIBLE };
        }
        let mut reads = 0;
        let summary = summarize_los(
            &states,
            rows as u32,
            cols as u32,
            0.0,
            0.0,
            1.0,
            &mut || {
                reads += 1;
                false
            },
        )
        .unwrap();
        // Cell (2, 7) touches the big zone from below, so it is one zone of 3001 cells.
        assert_eq!(summary.shadow_zone_cell_counts, vec![3_001]);
        assert_eq!(reads, rows + 3_001 / 1_024);

        // Abort at every poll: each yields the deadline error.
        for allowed in 0..reads {
            let mut seen = 0;
            let result = summarize_los(
                &states,
                rows as u32,
                cols as u32,
                0.0,
                0.0,
                1.0,
                &mut || {
                    seen += 1;
                    seen > allowed
                },
            );
            assert_eq!(result, Err(LosError::DeadlineExceeded), "allowed {allowed}");
        }
    }

    #[test]
    fn analysis_matches_compute_los_and_shares_one_poll_sequence() {
        let rows = 9;
        let cols = 14;
        let mut values: Vec<f64> = (0..rows * cols)
            .map(|i| {
                let (r, c) = ((i / cols) as f64, (i % cols) as f64);
                4.0 * (c / 2.0).sin() + 3.0 * (r / 3.0).cos()
            })
            .collect();
        values[4 * cols + 6] = 30.0;
        values[2 * cols + 9] = f64::NAN;
        let grid = GridView {
            values: &values,
            rows: rows as u32,
            cols: cols as u32,
            min_x: 10.0,
            min_y: -20.0,
            resolution: 2.0,
        };
        let radar = LosRadarParams {
            min_range_m: 0.0,
            max_range_m: 1e6,
            elevation_min_deg: -90.0,
            elevation_max_deg: 90.0,
            azimuth_range_deg: None,
        };
        let position = [12.0, -18.0, 9.0];

        let mut cell_reads = 0;
        let buffers = compute_los(&grid, position, &radar, &mut || {
            cell_reads += 1;
            false
        })
        .unwrap();
        let mut total_reads = 0;
        let analysis = compute_los_analysis(&grid, position, &radar, &mut || {
            total_reads += 1;
            false
        })
        .unwrap();
        // Bitwise: `PartialEq` on f32 would reject the (identical) NaN entries.
        let bits = |values: &[f32]| values.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
        assert_eq!(analysis.buffers.cell_states, buffers.cell_states);
        assert_eq!(bits(&analysis.buffers.quality), bits(&buffers.quality));
        assert_eq!(
            bits(&analysis.buffers.projection),
            bits(&buffers.projection)
        );
        assert!(buffers.cell_states.contains(&SHADOW));
        assert_eq!(total_reads, cell_reads + rows);
        let summary = summarize_los(
            &buffers.cell_states,
            rows as u32,
            cols as u32,
            10.0,
            -20.0,
            2.0,
            &mut never(),
        )
        .unwrap();
        assert_eq!(analysis.summary, summary);

        // f64 incidence: 0 off VISIBLE, NaN where quality is NaN, else it rounds to quality.
        for i in 0..rows * cols {
            let incidence = analysis.incidence[i];
            let quality = buffers.quality[i];
            if buffers.cell_states[i] != VISIBLE {
                assert_eq!(incidence.to_bits(), 0.0_f64.to_bits(), "cell {i}");
            } else if quality.is_nan() {
                assert!(incidence.is_nan(), "cell {i}");
            } else {
                assert_eq!((incidence as f32).to_bits(), quality.to_bits(), "cell {i}");
            }
        }

        // One window: aborting at the first BFS poll still fails the whole analysis.
        let mut reads = 0;
        let result = compute_los_analysis(&grid, position, &radar, &mut || {
            reads += 1;
            reads > cell_reads
        });
        assert_eq!(result, Err(LosError::DeadlineExceeded));
    }
}
