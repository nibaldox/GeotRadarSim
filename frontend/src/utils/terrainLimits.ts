export const MAX_TERRAIN_GRID_DIMENSION = 16_384;
export const MAX_TERRAIN_GRID_CELLS = 1_000_000;

const ENDPOINT_RELATIVE_TOLERANCE = 1e-9;

/** Count nodes, admitting the next lattice point only for a tightly near-divisible span. */
export function gridNodeCountForSpan(span: number, resolution: number, label = "Terrain"): number {
  if (!Number.isFinite(span) || span <= 0) {
    throw new RangeError(`${label} span must be finite and positive`);
  }
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new RangeError(`${label} resolution must be finite and positive`);
  }

  const intervals = span / resolution;
  if (!Number.isFinite(intervals)) {
    throw new RangeError(`${label} span and resolution do not produce a finite grid dimension`);
  }
  if (intervals >= MAX_TERRAIN_GRID_DIMENSION) {
    throw new RangeError(
      `${label} grid dimension exceeds the maximum of ${MAX_TERRAIN_GRID_DIMENSION.toLocaleString("en-US")} nodes`,
    );
  }

  const completeIntervals = Math.floor(intervals);
  const nextIndex = completeIntervals + 1;
  let intervalCount = completeIntervals;

  // Compare only local distances, never the absolute world-coordinate magnitude.
  // This bounded tolerance absorbs subtraction noise from shifted origins while
  // keeping endpoint inclusion within one billionth of a resolution.
  const nextNodeOffset = nextIndex * resolution;
  const endpointDistance = nextNodeOffset - span;
  const endpointTolerance = resolution * ENDPOINT_RELATIVE_TOLERANCE;
  if (Number.isFinite(nextNodeOffset) && Number.isFinite(endpointDistance)
    && Math.abs(endpointDistance) <= endpointTolerance) {
    intervalCount = nextIndex;
  }

  if (intervalCount < 1) {
    throw new RangeError(`${label} must span at least one resolution in both axes (minimum 2 nodes per axis)`);
  }

  return intervalCount + 1;
}

/** Validate a grid shape before constructing rows, result buffers, or worker state. */
export function validateTerrainGridDimensions(
  rows: number,
  cols: number,
  label = "Terrain",
): number {
  if (!Number.isSafeInteger(rows) || rows <= 0 || !Number.isSafeInteger(cols) || cols <= 0) {
    throw new RangeError(`${label} grid dimensions must be positive safe integers`);
  }
  if (rows > MAX_TERRAIN_GRID_DIMENSION || cols > MAX_TERRAIN_GRID_DIMENSION) {
    throw new RangeError(
      `${label} grid dimension exceeds the maximum of ${MAX_TERRAIN_GRID_DIMENSION.toLocaleString("en-US")} nodes`,
    );
  }

  const cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells > MAX_TERRAIN_GRID_CELLS) {
    throw new RangeError(
      `${label} grid exceeds the maximum size of ${MAX_TERRAIN_GRID_CELLS.toLocaleString("en-US")} cells`,
    );
  }
  return cells;
}

/** Shared resolution guard: area must remain representable by a finite non-zero number. */
export function validateTerrainResolution(resolution: number, label = "Terrain"): number {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new RangeError(`${label} resolution must be finite and positive`);
  }
  const cellArea = resolution * resolution;
  if (!Number.isFinite(cellArea) || cellArea <= 0) {
    throw new RangeError(`${label} resolution squared must be finite and non-zero to represent cell area`);
  }
  return cellArea;
}

/** Validate that finite per-cell area stays representable across the whole grid. */
export function validateTerrainTotalArea(cellArea: number, cellCount: number, label = "Terrain"): number {
  if (!Number.isFinite(cellArea) || cellArea <= 0 || !Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new RangeError(`${label} total grid area inputs must be finite and positive`);
  }
  const totalArea = cellArea * cellCount;
  if (!Number.isFinite(totalArea)) {
    throw new RangeError(`${label} total grid area must be finite`);
  }
  return totalArea;
}
