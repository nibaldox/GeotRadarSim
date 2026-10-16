import type { DTMMetadata } from "../types/api";
import { gridNodeCountForSpan, validateTerrainGridDimensions, validateTerrainResolution } from "../utils/terrainLimits";

export interface DTMResult {
  metadata: DTMMetadata;
  grid: number[][];
  warnings: string[];
}

/**
 * Generate a synthetic bowl-shaped open pit terrain.
 *
 * The bowl is centered in the bounding box with edges at z=0 and
 * the center at z=-depth. Uses a quadratic profile for natural shape.
 */
export function generateSyntheticTerrain(
  sizeX: number,
  sizeY: number,
  depth: number,
  resolution: number = 2.0
): DTMResult {
  validateTerrainResolution(resolution, "Synthetic terrain");
  if (!Number.isFinite(sizeX) || sizeX <= 0 || !Number.isFinite(sizeY) || sizeY <= 0) {
    throw new RangeError("Synthetic terrain sizes must be finite and positive");
  }
  if (!Number.isFinite(depth) || depth < 0) {
    throw new RangeError("Synthetic terrain depth must be finite and non-negative");
  }

  const gridCols = gridNodeCountForSpan(sizeX, resolution, "Synthetic terrain width");
  const gridRows = gridNodeCountForSpan(sizeY, resolution, "Synthetic terrain height");
  validateTerrainGridDimensions(gridRows, gridCols, "Synthetic terrain");
  const terrainExtentX = (gridCols - 1) * resolution;
  const terrainExtentY = (gridRows - 1) * resolution;

  const grid: number[][] = [];

  for (let r = 0; r < gridRows; r++) {
    const row: number[] = [];
    const y = -terrainExtentY / 2 + r * resolution;
    const rY = terrainExtentY > 0 ? y / (terrainExtentY / 2) : 0;

    for (let c = 0; c < gridCols; c++) {
      const x = -terrainExtentX / 2 + c * resolution;
      const rX = terrainExtentX > 0 ? x / (terrainExtentX / 2) : 0;

      const rSquared = rX * rX + rY * rY;
      let gridZ = -depth * (1.0 - rSquared);
      if (gridZ > 0.0) gridZ = 0.0;

      row.push(gridZ);
    }
    grid.push(row);
  }

  const terrainId = `synthetic-${Math.random().toString(16).substring(2, 10)}`;

  const metadata: DTMMetadata = {
    terrain_id: terrainId,
    bounds: {
      min_x: 0.0,
      min_y: 0.0,
      min_z: depth === 0 ? 0 : -depth,
      max_x: terrainExtentX,
      max_y: terrainExtentY,
      max_z: 0.0,
    },
    resolution: resolution,
    grid_rows: gridRows,
    grid_cols: gridCols,
  };

  return { grid, metadata, warnings: [] };
}
