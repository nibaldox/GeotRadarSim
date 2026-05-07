/**
 * Terrain visualization utilities — pure functions for Three.js mesh data.
 *
 * These transform grid data into vertex arrays, color gradients,
 * and triangle indices suitable for R3F BufferGeometry rendering.
 */

/**
 * Map an elevation value to an RGB color in [0,1] range.
 * Gradient: blue (low) → green (mid) → red (high).
 */
export function elevationToColor(
  elevation: number,
  minElevation: number,
  maxElevation: number,
): [number, number, number] {
  if (minElevation >= maxElevation) {
    throw new Error(
      `Invalid elevation range: min (${minElevation}) >= max (${maxElevation})`,
    );
  }

  const t = (elevation - minElevation) / (maxElevation - minElevation);

  // Blue (low) → Green (mid) → Red (high)
  if (t < 0.5) {
    const s = t * 2;
    return [0, s, 1 - s];
  }
  const s = (t - 0.5) * 2;
  return [s, 1 - s, 0];
}

/**
 * Get the minimum elevation from a grid.
 */
export function getMinElevation(grid: number[][]): number {
  let min = Infinity;
  for (const row of grid) {
    for (const val of row) {
      if (val < min) min = val;
    }
  }
  return min;
}

/**
 * Get the maximum elevation from a grid.
 */
export function getMaxElevation(grid: number[][]): number {
  let max = -Infinity;
  for (const row of grid) {
    for (const val of row) {
      if (val > max) max = val;
    }
  }
  return max;
}

/**
 * Build a flat Float32Array of vertex positions from a grid.
 * Each vertex is (col * resolution, elevation, row * resolution).
 */
export function normalizeGrid(
  grid: number[][],
  offsetX: number,
  offsetZ: number,
  resolution: number,
): Float32Array {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const positions = new Float32Array(rows * cols * 3);

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      positions[idx++] = offsetX + c * resolution;
      positions[idx++] = grid[r]![c]!;
      positions[idx++] = offsetZ + r * resolution;
    }
  }

  return positions;
}

/**
 * Build complete vertex data (positions, colors, indices) for a terrain mesh.
 *
 * Elevations are normalized relative to the grid's minimum so the mesh
 * starts near Y=0 regardless of real-world coordinate systems.
 */
export function buildVertexData(
  grid: number[][],
  offsetX: number,
  offsetZ: number,
  resolution: number,
): {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
} {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const vertexCount = rows * cols;

  const minElev = getMinElevation(grid);
  const maxElev = getMaxElevation(grid);

  // Normalize elevations: shift so min elevation is at Y=0
  const positions = new Float32Array(vertexCount * 3);
  let posIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      positions[posIdx++] = offsetX + c * resolution;
      positions[posIdx++] = grid[r]![c]! - minElev; // normalized Y
      positions[posIdx++] = offsetZ + r * resolution;
    }
  }

  const colors = new Float32Array(vertexCount * 3);
  let colorIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [cr, cg, cb] = elevationToColor(grid[r]![c]!, minElev, maxElev);
      colors[colorIdx++] = cr;
      colors[colorIdx++] = cg;
      colors[colorIdx++] = cb;
    }
  }

  // Build triangle indices for the grid
  const quadCount = (rows - 1) * (cols - 1);
  const indices = new Uint32Array(quadCount * 6);
  let iIdx = 0;

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const topLeft = r * cols + c;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + cols;
      const bottomRight = bottomLeft + 1;

      // Triangle 1: topLeft → bottomLeft → topRight
      indices[iIdx++] = topLeft;
      indices[iIdx++] = bottomLeft;
      indices[iIdx++] = topRight;

      // Triangle 2: topRight → bottomLeft → bottomRight
      indices[iIdx++] = topRight;
      indices[iIdx++] = bottomLeft;
      indices[iIdx++] = bottomRight;
    }
  }

  return { positions, colors, indices };
}

/**
 * Compute terrain extent in world coordinates after normalization.
 * Used for auto-fitting the camera.
 */
export function getTerrainExtent(
  grid: number[][],
  resolution: number,
): { width: number; depth: number; height: number; centerX: number; centerZ: number } {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const minElev = getMinElevation(grid);
  const maxElev = getMaxElevation(grid);

  return {
    width: cols * resolution,
    depth: rows * resolution,
    height: maxElev - minElev,
    centerX: (cols * resolution) / 2,
    centerZ: (rows * resolution) / 2,
  };
}
