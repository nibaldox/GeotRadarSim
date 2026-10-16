export interface TerrainGradient {
  gradX: number;
  gradY: number;
}

function terrainDifference(
  before: number | undefined,
  current: number,
  after: number | undefined,
  resolution: number,
): number | null {
  let difference: number | null = null;
  if (before !== undefined && Number.isFinite(before) && after !== undefined && Number.isFinite(after)) {
    difference = (after - before) / (2 * resolution);
  } else if (after !== undefined && Number.isFinite(after)) {
    difference = (after - current) / resolution;
  } else if (before !== undefined && Number.isFinite(before)) {
    difference = (current - before) / resolution;
  }
  return difference !== null && Number.isFinite(difference) ? difference : null;
}

/** Return the central or available one-sided DEM gradient, or null if either axis is unknown. */
export function terrainGradientAt(
  grid: readonly (readonly number[])[],
  row: number,
  col: number,
  resolution: number,
): TerrainGradient | null {
  const current = grid[row]?.[col];
  if (current === undefined || !Number.isFinite(current) || !Number.isFinite(resolution) || resolution <= 0) {
    return null;
  }

  const gradX = terrainDifference(
    col > 0 ? grid[row]?.[col - 1] : undefined,
    current,
    grid[row]?.[col + 1],
    resolution,
  );
  const gradY = terrainDifference(
    row > 0 ? grid[row - 1]?.[col] : undefined,
    current,
    grid[row + 1]?.[col],
    resolution,
  );
  if (gradX === null || gradY === null) return null;
  return { gradX, gradY };
}
