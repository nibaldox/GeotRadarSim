import type { DTMMetadata } from "../types/api";

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
  const gridCols = Math.max(1, Math.round(sizeX / resolution));
  const gridRows = Math.max(1, Math.round(sizeY / resolution));

  const grid: number[][] = [];

  for (let r = 0; r < gridRows; r++) {
    const row: number[] = [];
    const y = -sizeY / 2 + (r / (gridRows - 1 || 1)) * sizeY;
    const rY = y / (sizeY / 2);

    for (let c = 0; c < gridCols; c++) {
      const x = -sizeX / 2 + (c / (gridCols - 1 || 1)) * sizeX;
      const rX = x / (sizeX / 2);

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
      min_z: -depth,
      max_x: sizeX,
      max_y: sizeY,
      max_z: 0.0,
    },
    resolution: resolution,
    grid_rows: gridRows,
    grid_cols: gridCols,
  };

  return { grid, metadata, warnings: [] };
}
