/**
 * services/api.ts forwards the compute-engine flag to the LOS and sensitivity Workers.
 * Only the connection is tested here; validation and the watchdog are covered by api.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLOSAnalysis, cancelSensitivityAnalysis, generateSynthetic, releaseTerrain, runLOSAnalysis, runSensitivityAnalysis } from "./api";
import { COMPUTE_ENGINE_STORAGE_KEY } from "./computeEngine";
import { clearLocalTerrainCache, saveLocalTerrain } from "./localDataStore";
import { LOSCellState, type SensitivityObservation } from "../types/api";

class CapturingWorker {
  static instances: CapturingWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  constructor(readonly url: URL | string) {
    CapturingWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
}

const originalUrl = window.location.href;

beforeEach(() => {
  CapturingWorker.instances = [];
  vi.stubGlobal("Worker", CapturingWorker);
  localStorage.clear();
  clearLocalTerrainCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", originalUrl);
});

async function postedLOSEngine(): Promise<unknown> {
  const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
  const job = await runLOSAnalysis({ terrain_id: terrain.terrain_id, radar_position: { x: 10, y: 10, z: 5 }, radar_model_id: "groundprobe-ssr-fx" });
  const worker = CapturingWorker.instances[CapturingWorker.instances.length - 1]!;
  expect(String(worker.url)).toContain("losWorker");
  const message = worker.posted[0] as { engine?: unknown; radar_position: unknown };
  expect(message.radar_position).toEqual([10, 10, 5]);
  cancelLOSAnalysis(job.job_id);
  releaseTerrain(terrain.terrain_id);
  return message.engine;
}

async function postedSensitivityEngine(): Promise<unknown> {
  const terrainKey = { terrain_id: "api-engine-terrain", epoch: 2 };
  saveLocalTerrain({
    metadata: {
      terrain_id: terrainKey.terrain_id,
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 5 },
      resolution: 2,
      grid_rows: 2,
      grid_cols: 3,
    },
    grid: [[1, 2, 3], [4, 5, 6]],
  });
  const observation: SensitivityObservation = {
    analysisId: "analysis-engine",
    snapshot: {
      terrainKey,
      analysisId: "analysis-engine",
      sourceAnalysisIds: ["analysis-engine"],
      generation: 1,
      radars: [{ radarId: "radar-engine", radarModelId: "groundprobe-ssr-fx", position: { x: 1, y: 1, z: 9 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }],
    },
    grid_rows: 2,
    grid_cols: 3,
    resolution: 2,
    cell_states: new Uint8Array(6).fill(LOSCellState.VISIBLE),
  };
  const job = await runSensitivityAnalysis({ terrainKey, observations: [observation] });
  const worker = CapturingWorker.instances[CapturingWorker.instances.length - 1]!;
  expect(String(worker.url)).toContain("vectorWorker");
  const message = worker.posted[0] as { engine?: unknown; type: unknown };
  expect(message.type).toBe("SENSITIVITY");
  cancelSensitivityAnalysis(job.job_id);
  return message.engine;
}

describe("api.ts compute-engine connection", () => {
  it("sends engine 'ts' by default to both workers", async () => {
    expect(await postedLOSEngine()).toBe("ts");
    expect(await postedSensitivityEngine()).toBe("ts");
  });

  it("sends engine 'wasm' when localStorage selects it", async () => {
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    expect(await postedLOSEngine()).toBe("wasm");
    expect(await postedSensitivityEngine()).toBe("wasm");
  });

  it("lets ?engine= override localStorage", async () => {
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    window.history.replaceState(null, "", "/GeotRadarSim/?engine=ts");
    expect(await postedLOSEngine()).toBe("ts");
    expect(await postedSensitivityEngine()).toBe("ts");
  });
});
