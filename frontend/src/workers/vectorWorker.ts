/// <reference lib="webworker" />

import type { Point3D } from "../types/api";

self.onmessage = (e: MessageEvent<any>) => {
  const data = e.data;
  
  try {
    if (data.type === "SENSITIVITY") {
      const result = computeSensitivityMap(data);
      if (result.flat_sensitivity_grid) {
        const { sensitivityGrid, ...optimizedResult } = result;
        self.postMessage(optimizedResult, [result.flat_sensitivity_grid.buffer]);
      } else {
        self.postMessage(result);
      }
    } else {
      throw new Error(`Unknown job type '${data.type}'`);
    }
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};

interface SensitivityInput {
  grid: number[][];
  resolution: number;
  bounds: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
  radarPositions: Point3D[];
}

function computeSensitivityMap(input: SensitivityInput) {
  const { grid, resolution, bounds, radarPositions } = input;
  const rows = grid.length;
  const cols = grid[0]!.length;
  const N = radarPositions.length;

  const sensitivityGrid: number[][] = Array(rows).fill(null).map(() => Array(cols).fill(0));
  const flatSensitivityGrid = new Float32Array(rows * cols);

  if (N === 0) {
    return { sensitivityGrid, flat_sensitivity_grid: flatSensitivityGrid };
  }

  for (let r = 0; r < rows; r++) {
    const cy = bounds.min_y + resolution / 2 + r * resolution;
    
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const cx = bounds.min_x + resolution / 2 + c * resolution;
      const cz = grid[r]![c]!;

      if (isNaN(cz)) {
        sensitivityGrid[r]![c] = 0;
        flatSensitivityGrid[idx] = 0;
        continue;
      }

      // 1. Compute terrain normal gradient (central differences)
      let gradX = 0;
      let gradY = 0;
      if (c > 0 && c < cols - 1) {
        gradX = (grid[r]![c + 1]! - grid[r]![c - 1]!) / (2 * resolution);
      }
      if (r > 0 && r < rows - 1) {
        gradY = (grid[r + 1]![c]! - grid[r - 1]![c]!) / (2 * resolution);
      }

      // 2. Failure direction (steepest descent)
      let ux_f = -gradX;
      let uy_f = -gradY;
      let uz_f = -(gradX * gradX + gradY * gradY);
      
      const fNorm = Math.sqrt(ux_f * ux_f + uy_f * uy_f + uz_f * uz_f);
      if (fNorm > 1e-4) {
        ux_f /= fNorm;
        uy_f /= fNorm;
        uz_f /= fNorm;
      } else {
        ux_f = 0;
        uy_f = 0;
        uz_f = -1.0; // Gravity downward default
      }

      // 3. Compute sensitivity against deployed radars
      let sumSquares = 0;
      for (let i = 0; i < N; i++) {
        const rad = radarPositions[i]!;
        const dx = cx - rad.x;
        const dy = cy - rad.y;
        const dz = cz - rad.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;

        const ux_los = dx / dist;
        const uy_los = dy / dist;
        const uz_los = dz / dist;

        const dot = ux_los * ux_f + uy_los * uy_f + uz_los * uz_f;
        sumSquares += dot * dot;
      }

      // Root-mean-square sensitivity (always claps between 0.0 and 1.0)
      const sensVal = Math.sqrt(sumSquares / N);
      sensitivityGrid[r]![c] = sensVal;
      flatSensitivityGrid[idx] = sensVal;
    }
  }

  return { sensitivityGrid, flat_sensitivity_grid: flatSensitivityGrid };
}
