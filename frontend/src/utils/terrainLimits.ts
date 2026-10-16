export const MAX_TERRAIN_GRID_DIMENSION = 16_384;
export const MAX_TERRAIN_GRID_CELLS = 1_000_000;

/**
 * Coarse-friendly resolution steps the UI uses when snapping a computed
 * suggestion to a value users can pick from a dropdown/slider. Kept in
 * ascending order so {@link suggestResolutionForSpan} can stop at the first
 * step that fits within the cell budget.
 */
export const NICE_RESOLUTION_STEPS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
] as const;

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

/**
 * Pick a resolution that fits a span into the given cell budget.
 *
 * The candidate steps (in ascending order) come from {@link NICE_RESOLUTION_STEPS}.
 * For each step, the resulting cell count is the exact product `(spanX / r + 1) * (spanY / r + 1)`,
 * which is what {@link gridNodeCountForSpan} actually allocates per axis.
 *
 * `safetyFactor` reserves a fraction of the budget for sparse rows that the IDW step might
 * densify, so we never sit right on the limit. Defaults to 0.85 (15% headroom).
 *
 * Returns the largest {@link NICE_RESOLUTION_STEPS} entry when even that step cannot keep the
 * grid under budget — callers should treat that as "the terrain is genuinely too large at any
 * supported resolution" and surface the underlying {@link validateTerrainGridDimensions} error.
 */
export function suggestResolutionForSpan(
  spanX: number,
  spanY: number,
  maxCells: number = MAX_TERRAIN_GRID_CELLS,
  safetyFactor: number = 0.85,
): number {
  if (!Number.isFinite(spanX) || spanX <= 0 || !Number.isFinite(spanY) || spanY <= 0) {
    throw new RangeError("Span values must be finite and positive");
  }
  if (!Number.isFinite(maxCells) || maxCells <= 0) {
    throw new RangeError("maxCells must be finite and positive");
  }
  if (!Number.isFinite(safetyFactor) || safetyFactor <= 0 || safetyFactor > 1) {
    throw new RangeError("safetyFactor must lie in the (0, 1] interval");
  }

  const budget = maxCells * safetyFactor;
  for (const step of NICE_RESOLUTION_STEPS) {
    const cells = (spanX / step + 1) * (spanY / step + 1);
    if (cells <= budget) {
      return step;
    }
  }
  return NICE_RESOLUTION_STEPS[NICE_RESOLUTION_STEPS.length - 1]!;
}
