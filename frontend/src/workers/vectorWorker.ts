/// <reference lib="webworker" />

import type { BoundingBox, Point3D, SensitivityMapResponse, SensitivityObservation } from "../types/api";
import { LOSCellState } from "../types/api";
import { resolveWorkerComputeEngine, type ComputeEngine } from "../services/computeEngine";
import { flattenGridForWasm, loadRadarWasm } from "../wasm/loader";
import { terrainGradientAt } from "../utils/sensitivity";
import { WASM_SENSITIVITY_MASK_BUDGET_BYTES } from "../utils/terrainLimits";

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
  /** Compute engine; missing means "ts". Any other value is rejected. */
  engine?: ComputeEngine;
  engine_explicit?: boolean;
}

export interface SensitivityWorkerOutput extends SensitivityMapResponse {
  error?: string;
}

function postSensitivityResult(result: SensitivityWorkerOutput): void {
  // Same Transferables for both engines, so an A/B measures only the engine.
  self.postMessage(result, [result.flat_sensitivity_grid.buffer, result.observer_count.buffer]);
}

function postSensitivityError(error: unknown, engine?: ComputeEngine): void {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage(engine === undefined ? { error: message } : { error: message, engine_used: engine });
}

function assertSensitivityJob(input: SensitivityWorkerInput): void {
  if (input.type !== "SENSITIVITY") {
    throw new Error(`Unknown job type '${(input as { type?: unknown }).type}'`);
  }
}

/**
 * The "ts" engine posts synchronously, exactly as before. The "wasm" engine returns the
 * promise of its asynchronous run, which resolves once the result or the error was posted.
 */
self.onmessage = (event: MessageEvent<SensitivityWorkerInput>): void | Promise<void> => {
  let engine: ComputeEngine;
  try {
    engine = resolveWorkerComputeEngine(
      (event.data as { engine?: unknown } | null | undefined)?.engine, "sensitivity",
    );
  } catch (error) {
    postSensitivityError(error);
    return;
  }
  if (engine === "wasm") {
    // Like the "ts" try/catch, a failure while posting the result is also reported as an error.
    return computeSensitivityMapWithWasm(event.data)
      .then(postSensitivityResult)
      .catch((error: unknown) => {
        if (event.data.engine_explicit === true || !(error instanceof WasmInitError || error instanceof MaskBudgetError)) return postSensitivityError(error, "wasm");
        if (error instanceof WasmInitError && !warnedWasmFallback) { warnedWasmFallback = true; console.warn(error.message); }
        try { postSensitivityResult({ ...computeSensitivityMap(event.data), engine_fallback: error instanceof MaskBudgetError ? "mask-budget" : error.message }); }
        catch (fallbackError) { postSensitivityError(fallbackError, "ts"); }
      });
  }
  try {
    assertSensitivityJob(event.data);
    postSensitivityResult(computeSensitivityMap(event.data));
  } catch (error) {
    postSensitivityError(error, "ts");
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
    engine_used: "ts",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// "wasm" engine: radar_core::sensitivity through rust/radar-wasm.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Messages for the Rust boundary codes. After validateInput only inputs outside the API
 * domain reach them: cell states other than the LOSCellState codes 0-5, more than 65535
 * observations, or a grid beyond the global terrain limits (the API rejects the last two).
 */
const SENSITIVITY_WASM_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_STATE: "Sensitivity observation cell states must be LOS cell-state codes 0-5",
  INVALID_OBSERVATIONS: "Sensitivity requires between 1 and 65535 individual radar observations",
  LIMIT_EXCEEDED: "Sensitivity terrain grid exceeds the 16,384-node axis or 1,000,000-cell limit",
};

function sensitivityWasmError(error: unknown): Error {
  if (error instanceof WebAssembly.RuntimeError) {
    return new Error("El motor WebAssembly se quedó sin memoria o falló internamente. Vuelva a intentarlo con un terreno más pequeño.");
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return error instanceof Error ? error : new Error(String(error));
  return new RangeError(SENSITIVITY_WASM_ERROR_MESSAGES[code] ?? `Sensitivity WASM engine rejected the input (${code})`);
}

/** Loader failures and oversized masks are eligible for an implicit-engine fallback. */
class WasmInitError extends Error {}
class MaskBudgetError extends RangeError {}
let warnedWasmFallback = false;

async function loadSensitivityWasm(): Promise<Awaited<ReturnType<typeof loadRadarWasm>>> {
  try {
    return await loadRadarWasm();
  } catch (error) {
    throw new WasmInitError(`Sensitivity WASM engine failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function computeSensitivityMapWithWasm(input: SensitivityWorkerInput): Promise<SensitivityWorkerOutput> {
  assertSensitivityJob(input);
  const { rows, cols, size, positions } = validateInput(input);
  const maskBytes = input.observations.length * size;
  if (!Number.isSafeInteger(maskBytes) || maskBytes > WASM_SENSITIVITY_MASK_BUDGET_BYTES) {
    throw new MaskBudgetError(`Las máscaras de sensibilidad requieren ${maskBytes} bytes; el límite es ${WASM_SENSITIVITY_MASK_BUDGET_BYTES} bytes.`);
  }
  const wasm = await loadSensitivityWasm();

  const observations = input.observations;
  let flat_sensitivity_grid: Float32Array;
  let observer_count: Uint16Array;
  if (observations.length === 0) {
    // The handler accepts an empty list (the API does not); the Rust boundary requires at least
    // one observation, and the TS result is fully determined: no contributors anywhere.
    flat_sensitivity_grid = new Float32Array(size);
    flat_sensitivity_grid.fill(Number.NaN);
    observer_count = new Uint16Array(size);
  } else {
    // W3 API: positions [x0, y0, z0, x1, …] and the masks concatenated in observation order.
    const flatPositions = new Float64Array(positions.length * 3);
    positions.forEach((position, index) => {
      flatPositions[index * 3] = position.x;
      flatPositions[index * 3 + 1] = position.y;
      flatPositions[index * 3 + 2] = position.z;
    });
    const masks = new Uint8Array(observations.length * size);
    observations.forEach((observation, index) => masks.set(observation.cell_states, index * size));
    let result: { flat_sensitivity_grid: Float32Array; observer_count: Uint16Array };
    try {
      result = wasm.sensitivity(
        flattenGridForWasm(input.grid), rows, cols, input.bounds.min_x, input.bounds.min_y,
        input.resolution, flatPositions, masks,
      ) as typeof result;
    } catch (error) {
      throw sensitivityWasmError(error);
    }
    flat_sensitivity_grid = result.flat_sensitivity_grid;
    observer_count = result.observer_count;
  }

  return {
    terrainKey: { ...input.terrainKey },
    sourceAnalysisIds: input.observations.map((observation) => observation.analysisId),
    grid_rows: rows,
    grid_cols: cols,
    resolution: input.resolution,
    flat_sensitivity_grid,
    observer_count,
    engine_used: "wasm",
  };
}
