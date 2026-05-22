/// <reference lib="webworker" />

import type { Point3D } from "../types/api";

self.onmessage = (e: MessageEvent<any>) => {
  const data = e.data;
  
  try {
    if (data.type === "RECONSTRUCT") {
      const result = computeVectorReconstruction(data);
      self.postMessage(result);
    } else if (data.type === "SENSITIVITY") {
      const result = computeSensitivityMap(data);
      self.postMessage(result);
    } else {
      throw new Error(`Unknown job type '${data.type}'`);
    }
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};

interface ReconstructionInput {
  radarPositions: Point3D[];
  radarObservations: number[];
  cellPosition: Point3D;
  trueVector: [number, number, number];
  selectedRadarIndex: number;
}

function computeVectorReconstruction(input: ReconstructionInput) {
  const { radarPositions, radarObservations, cellPosition, trueVector, selectedRadarIndex } = input;
  const N = radarPositions.length;
  
  if (N === 0) {
    throw new Error("No radars deployed for vector reconstruction");
  }

  const cx = cellPosition.x;
  const cy = cellPosition.y;
  const cz = cellPosition.z;

  // 1. Build direction matrix A (N x 3)
  const A: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i++) {
    const rad = radarPositions[i]!;
    const dx = cx - rad.x;
    const dy = cy - rad.y;
    const dz = cz - rad.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
    
    // Unit vector pointing from radar to cell
    A.push([dx / dist, dy / dist, dz / dist]);
  }

  // 2. Compute C = A^T * A (3 x 3 symmetric matrix)
  let c11 = 0, c12 = 0, c13 = 0;
  let c22 = 0, c23 = 0, c33 = 0;
  
  for (let i = 0; i < N; i++) {
    const ux = A[i]![0];
    const uy = A[i]![1];
    const uz = A[i]![2];
    
    c11 += ux * ux;
    c12 += ux * uy;
    c13 += ux * uz;
    c22 += uy * uy;
    c23 += uy * uz;
    c33 += uz * uz;
  }

  // 3. Compute Determinant of C
  const det = c11 * (c22 * c33 - c23 * c23) -
              c12 * (c12 * c33 - c13 * c23) +
              c13 * (c12 * c23 - c13 * c22);

  let reconstructedVector: [number, number, number] | null = null;
  
  // 4. Invert C if non-singular (using adjugate matrix)
  if (Math.abs(det) >= 1e-5) {
    const invDet = 1.0 / det;
    const inv11 = (c22 * c33 - c23 * c23) * invDet;
    const inv12 = -(c12 * c33 - c13 * c23) * invDet;
    const inv13 = (c12 * c23 - c13 * c22) * invDet;
    
    const inv21 = inv12;
    const inv22 = (c11 * c33 - c13 * c13) * invDet;
    const inv23 = -(c11 * c23 - c12 * c13) * invDet;
    
    const inv31 = inv13;
    const inv32 = inv23;
    const inv33 = (c11 * c22 - c12 * c12) * invDet;

    // 5. Compute b = A^T * d_LOS (size 3)
    let b1 = 0, b2 = 0, b3 = 0;
    for (let i = 0; i < N; i++) {
      const obs = radarObservations[i]!;
      b1 += A[i]![0] * obs;
      b2 += A[i]![1] * obs;
      b3 += A[i]![2] * obs;
    }

    // 6. Multiply C^-1 * b to get reconstructed vector
    const rx = inv11 * b1 + inv12 * b2 + inv13 * b3;
    const ry = inv21 * b1 + inv22 * b2 + inv23 * b3;
    const rz = inv31 * b1 + inv32 * b2 + inv33 * b3;
    reconstructedVector = [rx, ry, rz];
  }

  // 7. Calculate single active radar apparent vector projection
  const selectedIdx = Math.max(0, Math.min(N - 1, selectedRadarIndex));
  const activeU = A[selectedIdx]!;
  const activeObs = radarObservations[selectedIdx]!;
  const apparentSingleVector: [number, number, number] = [
    activeObs * activeU[0],
    activeObs * activeU[1],
    activeObs * activeU[2]
  ];

  // 8. Geometric sensitivity index against failure direction
  const tx = trueVector[0];
  const ty = trueVector[1];
  const tz = trueVector[2];
  const tNorm = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1.0;
  const uFailure = [tx / tNorm, ty / tNorm, tz / tNorm];

  let sumSquares = 0;
  for (let i = 0; i < N; i++) {
    const dot = A[i]![0] * uFailure[0] + A[i]![1] * uFailure[1] + A[i]![2] * uFailure[2];
    sumSquares += dot * dot;
  }
  const sensitivity = Math.sqrt(sumSquares / N);

  return {
    trueVector,
    reconstructedVector,
    apparentSingleVector,
    determinant: det,
    sensitivity
  };
}

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

  if (N === 0) {
    return { sensitivityGrid };
  }

  for (let r = 0; r < rows; r++) {
    const cy = bounds.min_y + resolution / 2 + r * resolution;
    
    for (let c = 0; c < cols; c++) {
      const cx = bounds.min_x + resolution / 2 + c * resolution;
      const cz = grid[r]![c]!;

      if (isNaN(cz)) {
        sensitivityGrid[r]![c] = 0;
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
      sensitivityGrid[r]![c] = Math.sqrt(sumSquares / N);
    }
  }

  return { sensitivityGrid };
}
