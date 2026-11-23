/**
 * AOI mask over a DEM: one byte per node, row-major, in the same index convention as the
 * LOS `cell_states` (`idx = row·cols + col`). 1 = the node is inside the closed polygon
 * and its elevation is finite; 0 otherwise (outside, or NODATA).
 *
 * "Cell centre" = the DEM node: LOS targets are the nodes themselves, at
 * (min_x + col·res, min_y + row·res), with no half-cell offset (see `aoiPolygon.ts`).
 * Deterministic: the same grid and polygon give the same bytes.
 */

import { AoiError, pointInAoiPolygon, validateAoiPolygon } from "./aoiPolygon";
import type { AoiPolygon } from "./aoiPolygon";

/** Structural DEM view (compatible with `OptimizerGrid` and the terrain store data). */
export interface AoiGrid {
  readonly grid: readonly (readonly number[])[];
  readonly bounds: Readonly<{ min_x: number; min_y: number }>;
  readonly resolution: number;
}

function gridShape(source: AoiGrid): [number, number] {
  const { grid, bounds, resolution } = source;
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0) {
    throw new AoiError("AOI_GRID_INVALID", "AOI grid must be a non-empty row-major grid");
  }
  const cols = grid[0].length;
  if (grid.some((row) => !Array.isArray(row) || row.length !== cols)) {
    throw new AoiError("AOI_GRID_INVALID", "AOI grid rows must all have the same length");
  }
  const cellArea = resolution * resolution;
  if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(cellArea) || cellArea <= 0) {
    throw new AoiError("AOI_GRID_INVALID", "AOI grid resolution must be finite and positive");
  }
  if (!bounds || !Number.isFinite(bounds.min_x) || !Number.isFinite(bounds.min_y)) {
    throw new AoiError("AOI_GRID_INVALID", "AOI grid origin must be finite");
  }
  return [grid.length, cols];
}

/**
 * Mask of the nodes inside `polygon` with finite elevation.
 * Throws {@link AoiError}: polygon errors from `validateAoiPolygon`, `AOI_OUTSIDE_TERRAIN`
 * when the polygon does not reach the node extent, `AOI_NO_VALID_CELLS` when it contains
 * no finite node.
 */
export function aoiMaskForGrid(source: AoiGrid, polygon: AoiPolygon): Uint8Array {
  const validated = validateAoiPolygon(polygon);
  const [rows, cols] = gridShape(source);
  const { grid, bounds, resolution } = source;
  const maxX = bounds.min_x + (cols - 1) * resolution;
  const maxY = bounds.min_y + (rows - 1) * resolution;
  const { bbox } = validated;
  if (bbox.max_x < bounds.min_x || bbox.min_x > maxX || bbox.max_y < bounds.min_y || bbox.min_y > maxY) {
    throw new AoiError("AOI_OUTSIDE_TERRAIN", "AOI does not overlap the terrain extent");
  }
  const mask = new Uint8Array(rows * cols);
  // Index window that can hold nodes of the bbox (widened by one node against rounding;
  // every node in it is still tested with the exact node coordinate).
  const c0 = Math.max(0, Math.floor((bbox.min_x - bounds.min_x) / resolution) - 1);
  const c1 = Math.min(cols - 1, Math.ceil((bbox.max_x - bounds.min_x) / resolution) + 1);
  const r0 = Math.max(0, Math.floor((bbox.min_y - bounds.min_y) / resolution) - 1);
  const r1 = Math.min(rows - 1, Math.ceil((bbox.max_y - bounds.min_y) / resolution) + 1);
  let count = 0;
  for (let r = r0; r <= r1; r++) {
    const y = bounds.min_y + r * resolution;
    const row = grid[r]!;
    for (let c = c0; c <= c1; c++) {
      if (!Number.isFinite(row[c]!)) continue;
      const x = bounds.min_x + c * resolution;
      if (pointInAoiPolygon(validated, x, y)) {
        mask[r * cols + c] = 1;
        count++;
      }
    }
  }
  if (count === 0) throw new AoiError("AOI_NO_VALID_CELLS", "AOI contains no node with valid terrain");
  return mask;
}

/** Number of AOI cells (bytes equal to 1). Throws if the mask is not a 0/1 Uint8Array. */
export function aoiMaskCellCount(mask: Uint8Array): number {
  if (!(mask instanceof Uint8Array)) throw new RangeError("AOI mask must be a Uint8Array");
  let count = 0;
  for (let idx = 0; idx < mask.length; idx++) {
    const value = mask[idx]!;
    if (value === 1) count++;
    else if (value !== 0) throw new RangeError(`AOI mask value ${value} at cell ${idx} is not 0 or 1`);
  }
  return count;
}

/**
 * Stable identity of a mask's content: `size:count:fnv1a`. Scores and unions compare it so
 * values computed with different AOIs are never mixed.
 */
export function aoiMaskFingerprint(mask: Uint8Array): string {
  const count = aoiMaskCellCount(mask);
  let hash = 0x811c9dc5;
  for (let idx = 0; idx < mask.length; idx++) {
    if (mask[idx] === 1) {
      hash = Math.imul(hash ^ (idx & 0xffff), 0x01000193) >>> 0;
      hash = Math.imul(hash ^ (idx >>> 16), 0x01000193) >>> 0;
    }
  }
  return `${mask.length}:${count}:${hash.toString(16)}`;
}
