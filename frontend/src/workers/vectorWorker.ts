/// <reference lib="webworker" />

import type { BoundingBox, Point3D, SensitivityMapResponse, SensitivityObservation } from "../types/api";
import { LOSCellState } from "../types/api";
import { terrainGradientAt } from "../utils/sensitivity";

interface SensitivityTerrainKey {
  terrain_id: string;
  epoch: number;
}

export interface SensitivityWorkerInput {
  type: "SENSITIVITY";
  terrainKey: SensitivityTerrainKey;
  grid: number[][];
  grid_rows: number;
  grid_cols: number;
  resolution: number;
  bounds: BoundingBox;
  observations: readonly SensitivityObservation[];
}

export interface SensitivityWorkerOutput extends SensitivityMapResponse {
  error?: string;
}

self.onmessage = (event: MessageEvent<SensitivityWorkerInput>) => {
  try {
    if (event.data.type !== "SENSITIVITY") {
      throw new Error(`Unknown job type '${(event.data as { type?: unknown }).type}'`);
    }
    const result = computeSensitivityMap(event.data);
    self.postMessage(result, [result.flat_sensitivity_grid.buffer, result.observer_count.buffer]);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

function sameTerrainKey(left: SensitivityTerrainKey, right: SensitivityTerrainKey): boolean {
  return left.terrain_id === right.terrain_id && left.epoch === right.epoch;
}

function validateSnapshot(observation: SensitivityObservation, terrainKey: SensitivityTerrainKey): Point3D {
  const { analysisId, snapshot } = observation;
  if (!analysisId || !snapshot || snapshot.analysisId !== analysisId ||
      snapshot.sourceAnalysisIds.length !== 1 || snapshot.sourceAnalysisIds[0] !== analysisId) {
    throw new RangeError("Sensitivity observations require one stable analysis ID");
  }
  if (!sameTerrainKey(snapshot.terrainKey, terrainKey)) {
    throw new RangeError("Sensitivity observation terrain key does not match the active terrain");
  }
  if (!Array.isArray(snapshot.radars) || snapshot.radars.length !== 1) {
    throw new RangeError("Sensitivity observations require exactly one radar snapshot");
  }
  const radar = snapshot.radars[0]!;
  if (!radar.radarId || !radar.radarModelId || !radar.position ||
      !Number.isFinite(radar.position.x) || !Number.isFinite(radar.position.y) || !Number.isFinite(radar.position.z)) {
    throw new RangeError("Sensitivity radar snapshot must have stable identity and finite position");
  }
  return radar.position;
}

function validateInput(input: SensitivityWorkerInput): { rows: number; cols: number; size: number; positions: Point3D[] } {
  const { grid, grid_rows: rows, grid_cols: cols, resolution, bounds, terrainKey, observations } = input;
  if (!terrainKey || !terrainKey.terrain_id || !Number.isSafeInteger(terrainKey.epoch) || terrainKey.epoch < 0) {
    throw new RangeError("Sensitivity terrain key is invalid");
  }
  if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(cols) || cols <= 0 ||
      !Number.isSafeInteger(rows * cols) || !Array.isArray(grid) || grid.length !== rows ||
      grid.some((row) => !Array.isArray(row) || row.length !== cols)) {
    throw new RangeError("Sensitivity terrain grid dimensions are invalid");
  }
  if (!Number.isFinite(resolution) || resolution <= 0 ||
      !Number.isFinite(bounds?.min_x) || !Number.isFinite(bounds?.min_y)) {
    throw new RangeError("Sensitivity terrain resolution or origin is invalid");
  }
  if (!Array.isArray(observations)) throw new RangeError("Sensitivity observations must be an array");

  const size = rows * cols;
  const analysisIds = new Set<string>();
  const positions = observations.map((observation) => {
    if (!observation || !observation.snapshot) throw new RangeError("Sensitivity observation is incomplete");
    if (analysisIds.has(observation.analysisId)) throw new RangeError("Sensitivity analysis IDs must be unique");
    analysisIds.add(observation.analysisId);
    const position = validateSnapshot(observation, terrainKey);
    if (observation.grid_rows !== rows || observation.grid_cols !== cols ||
        !Number.isFinite(observation.resolution) || observation.resolution !== resolution ||
        !(observation.cell_states instanceof Uint8Array) || observation.cell_states.length !== size) {
      throw new RangeError("Sensitivity observation dimensions, resolution, or cell-state length do not match the active grid");
    }
    return position;
  });
  return { rows, cols, size, positions };
}

function computeSensitivityMap(input: SensitivityWorkerInput): SensitivityWorkerOutput {
  const { rows, cols, size, positions } = validateInput(input);
  const flat_sensitivity_grid = new Float32Array(size);
  flat_sensitivity_grid.fill(Number.NaN);
  const observer_count = new Uint16Array(size);

  for (let row = 0; row < rows; row++) {
    const cy = input.bounds.min_y + row * input.resolution;
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const cellZ = input.grid[row]![col]!;
      if (!Number.isFinite(cellZ)) continue;
      const cx = input.bounds.min_x + col * input.resolution;

      const gradient = terrainGradientAt(input.grid, row, col, input.resolution);
      if (gradient === null) continue;

      let ux_f = -gradient.gradX;
      let uy_f = -gradient.gradY;
      let uz_f = -(gradient.gradX * gradient.gradX + gradient.gradY * gradient.gradY);
      const failureNorm = Math.sqrt(ux_f * ux_f + uy_f * uy_f + uz_f * uz_f);
      if (failureNorm > 1e-4) {
        ux_f /= failureNorm;
        uy_f /= failureNorm;
        uz_f /= failureNorm;
      } else {
        ux_f = 0;
        uy_f = 0;
        uz_f = -1;
      }

      let sumSquares = 0;
      let observerCount = 0;
      for (let observer = 0; observer < input.observations.length; observer++) {
        const observation = input.observations[observer]!;
        if (observation.cell_states[index] !== LOSCellState.VISIBLE) continue;

        const radar = positions[observer]!;
        const dx = cx - radar.x;
        const dy = cy - radar.y;
        const dz = cellZ - radar.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
        const dot = (dx / distance) * ux_f + (dy / distance) * uy_f + (dz / distance) * uz_f;
        sumSquares += dot * dot;
        observerCount++;
      }

      observer_count[index] = observerCount;
      if (observerCount > 0) {
        flat_sensitivity_grid[index] = Math.sqrt(sumSquares / observerCount);
      }
    }
  }

  return {
    terrainKey: { ...input.terrainKey },
    sourceAnalysisIds: input.observations.map((observation) => observation.analysisId),
    grid_rows: rows,
    grid_cols: cols,
    resolution: input.resolution,
    flat_sensitivity_grid,
    observer_count,
  };
}
