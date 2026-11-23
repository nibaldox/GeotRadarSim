/**
 * Integer decimation of a DEM for the coarse optimizer pass.
 *
 * Keeps the nodes whose row and column indices are multiples of f, so coarse
 * nodes stay at `min + index × (f·res)` (raster-node extent contract) and the
 * last effective node is the last multiple, not the source maximum. NaN stays
 * NODATA. Pure: never mutates the source grid.
 */

import type { OptimizerGrid } from "./types";

/** Coarse-pass ceiling on nodes (rows × cols) from the optimizer design. */
export const MAX_COARSE_NODES = 40_000;

export interface CoarseGrid extends OptimizerGrid {
  readonly grid: number[][];
  readonly bounds: Readonly<{ min_x: number; min_y: number; max_x: number; max_y: number }>;
  readonly factor: number;
  readonly rows: number;
  readonly cols: number;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
}

/** Nodes per axis after decimating n nodes by f: ⌊(n − 1)/f⌋ + 1. */
export function coarseNodeCount(nodes: number, factor: number): number {
  assertPositiveInteger(nodes, "Node count");
  assertPositiveInteger(factor, "Coarsening factor");
  return Math.floor((nodes - 1) / factor) + 1;
}

/** Smallest integer f ≥ 1 whose coarse grid has at most `maxNodes` nodes. */
export function chooseCoarsenFactor(rows: number, cols: number, maxNodes: number = MAX_COARSE_NODES): number {
  assertPositiveInteger(rows, "Grid rows");
  assertPositiveInteger(cols, "Grid cols");
  assertPositiveInteger(maxNodes, "Maximum coarse nodes");
  let factor = 1;
  while (coarseNodeCount(rows, factor) * coarseNodeCount(cols, factor) > maxNodes) factor++;
  return factor;
}

/** Validate a rectangular, non-empty DEM with a finite origin and positive resolution; returns [rows, cols]. */
export function validateOptimizerGrid(source: OptimizerGrid, label = "Optimizer grid"): [number, number] {
  const { grid, bounds, resolution } = source;
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0) {
    throw new RangeError(`${label} must be a non-empty row-major grid`);
  }
  const cols = grid[0].length;
  if (grid.some((row) => !Array.isArray(row) || row.length !== cols)) {
    throw new RangeError(`${label} rows must all have the same length`);
  }
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new RangeError(`${label} resolution must be finite and positive`);
  }
  // Same condition as the LOS engine (`compute_los`: cell area finite and > 0). Otherwise
  // res² underflows to 0 (e.g. 1e-170) or overflows, and every distance test degenerates.
  const cellArea = resolution * resolution;
  if (!Number.isFinite(cellArea) || cellArea <= 0) {
    throw new RangeError(`${label} resolution must have a finite, positive cell area (res² = ${cellArea})`);
  }
  if (!bounds || !Number.isFinite(bounds.min_x) || !Number.isFinite(bounds.min_y)) {
    throw new RangeError(`${label} origin must be finite`);
  }
  return [grid.length, cols];
}

/** Decimate by an integer factor (f = 1 returns an independent copy). */
export function coarsenGrid(source: OptimizerGrid, factor: number): CoarseGrid {
  const [rows, cols] = validateOptimizerGrid(source);
  assertPositiveInteger(factor, "Coarsening factor");
  const coarseRows = coarseNodeCount(rows, factor);
  const coarseCols = coarseNodeCount(cols, factor);
  const grid: number[][] = [];
  for (let r = 0; r < coarseRows; r++) {
    const sourceRow = source.grid[r * factor]!;
    const row = new Array<number>(coarseCols);
    for (let c = 0; c < coarseCols; c++) row[c] = sourceRow[c * factor]!;
    grid.push(row);
  }
  const resolution = factor * source.resolution;
  const { min_x, min_y } = source.bounds;
  return {
    grid,
    bounds: {
      min_x,
      min_y,
      max_x: min_x + (coarseCols - 1) * resolution,
      max_y: min_y + (coarseRows - 1) * resolution,
    },
    resolution,
    factor,
    rows: coarseRows,
    cols: coarseCols,
  };
}

/**
 * Radar height for the coarse pass. The coarse triangulated surface at (x, y)
 * can sit above the fine node, which would bury the radar; this pass uses
 * max(fine ground, coarse surface) + h and flags the adjustment as an
 * approximation of that pass only. `coarseSurfaceZ = null` means "not sampled".
 */
export function coarseRadarZ(
  groundZ: number,
  coarseSurfaceZ: number | null,
  heightAboveGroundM: number,
): { z: number; adjusted: boolean } {
  if (!Number.isFinite(groundZ)) throw new RangeError("Ground elevation must be finite");
  if (!Number.isFinite(heightAboveGroundM) || heightAboveGroundM < 0) {
    throw new RangeError("Height above ground must be finite and non-negative");
  }
  const adjusted = coarseSurfaceZ !== null && Number.isFinite(coarseSurfaceZ) && coarseSurfaceZ > groundZ;
  return { z: (adjusted ? coarseSurfaceZ! : groundZ) + heightAboveGroundM, adjusted };
}
