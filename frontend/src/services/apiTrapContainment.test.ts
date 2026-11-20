/**
 * Trap-containment invariant of services/api.ts: a LOS or sensitivity Worker serves exactly one
 * job. When that job ends (success, an error message such as a translated WASM trap, or a
 * Worker error event), api.ts detaches the handlers and terminates that Worker, and the next job
 * gets a new Worker. A Worker whose WASM instance trapped is therefore never reused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSynthetic, getLOSJob, releaseLOSJob, releaseSensitivityJob, releaseTerrain, runLOSAnalysis, runSensitivityAnalysis } from "./api";
import { clearLocalTerrainCache, saveLocalTerrain } from "./localDataStore";
import { LOSCellState, type SensitivityMapResponse, type SensitivityObservation } from "../types/api";

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminateCalls = 0;
  constructor(readonly url: URL | string) {
    ControlledWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminateCalls++;
  }
  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

beforeEach(() => {
  ControlledWorker.instances = [];
  vi.stubGlobal("Worker", ControlledWorker);
  clearLocalTerrainCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TRAP_MESSAGE = "RuntimeError: unreachable";
const terrainKey = { terrain_id: "terrain-trap-containment", epoch: 3 };

function installSensitivityTerrain(): void {
  saveLocalTerrain({
    metadata: { terrain_id: terrainKey.terrain_id, bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 6 }, resolution: 2, grid_rows: 2, grid_cols: 3 },
    grid: [[1, 2, 3], [4, 5, 6]],
  });
}

function sensitivityObservation(): SensitivityObservation {
  return {
    analysisId: "analysis-trap",
    snapshot: {
      terrainKey,
      analysisId: "analysis-trap",
      sourceAnalysisIds: ["analysis-trap"],
      generation: 1,
      radars: [{ radarId: "radar-trap", radarModelId: "groundprobe-ssr-fx", position: { x: 1, y: 1, z: 9 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }],
    },
    grid_rows: 2,
    grid_cols: 3,
    resolution: 2,
    cell_states: new Uint8Array(6).fill(LOSCellState.SHADOW),
  };
}

// No VISIBLE cell, so the valid map is all no-data with zero contributors.
const sensitivitySuccess = (): SensitivityMapResponse => ({
  terrainKey,
  sourceAnalysisIds: ["analysis-trap"],
  grid_rows: 2,
  grid_cols: 3,
  resolution: 2,
  flat_sensitivity_grid: new Float32Array(6).fill(Number.NaN),
  observer_count: new Uint16Array(6),
});

type Outcome = "success" | "error message" | "error event";
const outcomes: Outcome[] = ["success", "error message", "error event"];

function finish(worker: ControlledWorker, outcome: Outcome, success: () => unknown): void {
  if (outcome === "success") worker.emitMessage(success());
  else if (outcome === "error message") worker.emitMessage({ error: TRAP_MESSAGE });
  else worker.emitError(TRAP_MESSAGE);
}

function expectContained(worker: ControlledWorker): void {
  expect(worker.terminateCalls).toBe(1);
  expect(worker.onmessage).toBeNull();
  expect(worker.onerror).toBeNull();
  expect(worker.posted).toHaveLength(1);
}

describe("LOS Worker containment", () => {
  for (const outcome of outcomes) {
    it(`terminates the LOS Worker after ${outcome} and starts the next job on a new Worker`, async () => {
      const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
      const request = { terrain_id: terrain.terrain_id, radar_position: { x: 10, y: 10, z: 5 }, radar_model_id: "groundprobe-ssr-fx" };
      const first = await runLOSAnalysis(request);
      const firstWorker = ControlledWorker.instances[0]!;
      expect(firstWorker.terminateCalls).toBe(0);

      finish(firstWorker, outcome, () => ({ coverage_percent: 12.5 }));

      const status = await getLOSJob(first.job_id);
      expect(status.status).toBe(outcome === "success" ? "COMPLETED" : "FAILED");
      if (outcome !== "success") expect(status.error).toBe(TRAP_MESSAGE);
      expectContained(firstWorker);

      const second = await runLOSAnalysis(request);
      expect(ControlledWorker.instances).toHaveLength(2);
      const secondWorker = ControlledWorker.instances[1]!;
      expect(secondWorker).not.toBe(firstWorker);
      expect(secondWorker.posted).toHaveLength(1);
      expect(firstWorker.posted).toHaveLength(1);
      finish(secondWorker, "success", () => ({ coverage_percent: 50 }));
      expect((await getLOSJob(second.job_id)).status).toBe("COMPLETED");
      expectContained(secondWorker);
      expect(firstWorker.terminateCalls).toBe(1);

      releaseLOSJob(first.job_id);
      releaseLOSJob(second.job_id);
      releaseTerrain(terrain.terrain_id);
    });
  }
});

describe("sensitivity Worker containment", () => {
  for (const outcome of outcomes) {
    it(`terminates the sensitivity Worker after ${outcome} and starts the next job on a new Worker`, async () => {
      installSensitivityTerrain();
      const request = { terrainKey, observations: [sensitivityObservation()] };
      const first = await runSensitivityAnalysis(request);
      const firstWorker = ControlledWorker.instances[0]!;
      expect(firstWorker.terminateCalls).toBe(0);

      finish(firstWorker, outcome, sensitivitySuccess);

      const status = await getLOSJob(first.job_id);
      expect(status.status).toBe(outcome === "success" ? "COMPLETED" : "FAILED");
      if (outcome !== "success") expect(status.error).toBe(TRAP_MESSAGE);
      expectContained(firstWorker);

      const second = await runSensitivityAnalysis(request);
      expect(ControlledWorker.instances).toHaveLength(2);
      const secondWorker = ControlledWorker.instances[1]!;
      expect(secondWorker).not.toBe(firstWorker);
      expect(firstWorker.posted).toHaveLength(1);
      finish(secondWorker, "success", sensitivitySuccess);
      expect((await getLOSJob(second.job_id)).status).toBe("COMPLETED");
      expectContained(secondWorker);
      expect(firstWorker.terminateCalls).toBe(1);

      releaseSensitivityJob(first.job_id);
      releaseSensitivityJob(second.job_id);
    });
  }

  it("terminates the sensitivity Worker when its output fails main-thread validation", async () => {
    installSensitivityTerrain();
    const job = await runSensitivityAnalysis({ terrainKey, observations: [sensitivityObservation()] });
    const worker = ControlledWorker.instances[0]!;
    worker.emitMessage({ ...sensitivitySuccess(), observer_count: new Uint16Array(6).fill(1) });
    expect((await getLOSJob(job.job_id)).status).toBe("FAILED");
    expectContained(worker);
    releaseSensitivityJob(job.job_id);
  });
});
