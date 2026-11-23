/**
 * WP8 · `suggest_radar_positions` through the REAL loop, stores, citation verifier and WASM
 * coarse pass (in process; the Worker transport has its own tests at the bottom).
 *
 * The full-resolution LOS runs through the app path (`runAnalysisAndWait`) over the mocked
 * `services/api` fake LOS, as every store-backed tool test does; the WASM full-resolution
 * equality with the app's LOS Worker is P4 in `workers/optimizerWorker.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  listRadars: vi.fn(), runLOSAnalysis: vi.fn(), getLOSJob: vi.fn(), cancelLOSAnalysis: vi.fn(), releaseLOSJob: vi.fn(),
  runSensitivityAnalysis: vi.fn(), cancelSensitivityAnalysis: vi.fn(), releaseSensitivityJob: vi.fn(),
  generateSynthetic: vi.fn(), getTerrainGrid: vi.fn(), activateTerrain: vi.fn(), releaseTerrain: vi.fn(),
  uploadDXF: vi.fn(), uploadSTL: vi.fn(), previewTerrainBounds: vi.fn(), exportPDF: vi.fn(), exportCSV: vi.fn(),
}));

import { useAnalysisStore } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { useTerrainStore } from "../store/terrainStore";
import { loadRadarWasm } from "../wasm/loader";
import { runOptimizerJob, type OptimizerJobRequest, type OptimizerWasm, type OptimizerWorkerMessage } from "../workers/optimizerWorker";
import type { ToolEnvelope } from "./toolEnvelope";
import { parseAndValidateArgs } from "./validate";
import { runOptimizerInWorker, setOptimizerRunnerForTests, type OptimizerRunner } from "./suggestPositions";
import { byName, createSuggestionToolkit, ctxFor, drive, installFakeApi, loadProfiles, loadTerrain, resetStores, type SuggestionToolkit } from "./placement.testSupport";

let kit: SuggestionToolkit;
let wasm: OptimizerWasm;
let runnerCalls = 0;

/** Real WASM coarse pass in process, with a frozen clock (no reductions, deterministic). */
const realRunner: OptimizerRunner = async (request, { signal }) => {
  runnerCalls++;
  if (signal.aborted) return { status: "cancelled" };
  return { status: "result", result: runOptimizerJob(request, { wasm, now: () => 0 }) };
};

beforeEach(async () => {
  wasm = (await loadRadarWasm()) as unknown as OptimizerWasm;
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetStores();
  useAoiStore.getState().clear();
  installFakeApi();
  kit = createSuggestionToolkit();
  runnerCalls = 0;
  setOptimizerRunnerForTests({ runner: realRunner, available: () => true });
});
afterEach(() => {
  setOptimizerRunnerForTests(null);
  resetStores();
  vi.useRealTimers();
});

async function ready(): Promise<void> {
  await drive(loadTerrain(30, 20, 1));
  await loadProfiles();
  useAnalysisStore.getState().selectRadar("perfil-a");
}

async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolEnvelope> {
  const tool = byName(kit.tools, name);
  const checked = parseAndValidateArgs(tool.parameters, JSON.stringify(args));
  if (!checked.ok) throw new Error(checked.summary);
  return drive(tool.execute(checked.value as Record<string, unknown>, ctxFor(signal)));
}
const code = (env: ToolEnvelope) => (env.ok ? "OK" : env.error.code);

const ARGS = { k: 2, candidate_set: "regular_grid", min_separation_m: 5 };

describe("suggest_radar_positions · real tool through the loop", () => {
  it("same inputs → same JSON (determinism through the tool)", async () => {
    await ready();
    const first = await call("suggest_radar_positions", ARGS);
    const firstData = JSON.stringify(first.ok ? first.data : null);
    resetStores();
    installFakeApi();
    kit = createSuggestionToolkit();
    await ready();
    const second = await call("suggest_radar_positions", ARGS);
    expect(JSON.stringify(second.ok ? second.data : null)).toBe(firstData);
    expect(first.ok).toBe(true);
  });
});

describe("suggest_radar_positions · area to monitor", () => {
  it("orients each pick to the drawn area and verifies it with that azimuth centre (azCenterOverride)", async () => {
    await drive(loadTerrain(30, 20, 1));
    await loadProfiles();
    useAnalysisStore.getState().selectRadar("perfil-b");
    const key = useTerrainStore.getState().terrainKey!;
    const o = { x: 350_000.5, y: 6_400_000.25 };
    useAoiStore.setState({
      polygon: { vertices: [{ x: o.x + 18, y: o.y + 6 }, { x: o.x + 26, y: o.y + 6 }, { x: o.x + 26, y: o.y + 14 }, { x: o.x + 18, y: o.y + 14 }] },
      terrainKey: { ...key },
    });
    let seen: OptimizerJobRequest | null = null;
    setOptimizerRunnerForTests({
      runner: async (request, options) => {
        seen = request;
        return realRunner(request, options);
      },
      available: () => true,
    });
    const env = await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid", min_separation_m: 3 });
    expect(code(env)).toBe("OK");
    expect(seen!.aoi).toBeDefined();
    const data = env.ok ? (env.data as any) : null;
    expect(typeof data.suggestions[0].aoi_fits_azimuth).toBe("boolean");
    expect(data.aoi_note).toMatch(/centro del azimut/u);
    // The verified LOS used an azimuth centre set by the tool, and the pick lies outside the area.
    const entry = useAnalysisStore.getState().history[0]!;
    expect(entry.snapshot!.radars[0]!.overrides.azCenter).not.toBeNull();
    expect(useAnalysisStore.getState().azCenterOverride).toBe(entry.snapshot!.radars[0]!.overrides.azCenter);
    const p = data.suggestions[0].position;
    expect(p.x_m >= 18 && p.x_m <= 26 && p.y_m >= 6 && p.y_m <= 14).toBe(false);
  });
});

describe("suggest_radar_positions · refusal paths", () => {
  it("NOT_AVAILABLE when WASM does not start in the Worker, and when Workers are missing", async () => {
    await ready();
    setOptimizerRunnerForTests({
      runner: async () => ({ status: "error", code: "NOT_AVAILABLE", message: "El motor de cálculo WebAssembly no se pudo iniciar; el optimizador de posiciones no está disponible." }),
      available: () => true,
    });
    const env = await call("suggest_radar_positions", ARGS);
    expect(code(env)).toBe("NOT_AVAILABLE");
    expect(env.ok ? "" : env.error.message).toMatch(/WebAssembly/u);
    setOptimizerRunnerForTests({ runner: realRunner, available: () => false });
    expect(code(await call("suggest_radar_positions", ARGS))).toBe("NOT_AVAILABLE");
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });

  it("SUPERSEDED when the terrain changes during the run, and nothing is published", async () => {
    await ready();
    setOptimizerRunnerForTests({
      runner: async (request, options) => {
        const out = await realRunner(request, options);
        await useTerrainStore.getState().generateSynthetic({ size_x: 30, size_y: 20, depth: 5, resolution: 1 });
        return out;
      },
      available: () => true,
    });
    const env = await call("suggest_radar_positions", ARGS);
    expect(code(env)).toBe("SUPERSEDED");
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });

  it("Stop cancels the run: no result and no history entry", async () => {
    await ready();
    const controller = new AbortController();
    setOptimizerRunnerForTests({
      runner: (_request, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "cancelled" }))),
      available: () => true,
    });
    const pending = call("suggest_radar_positions", ARGS, controller.signal);
    controller.abort();
    expect(code(await pending)).toBe("CANCELLED_BY_USER");
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });

  it("an area drawn on another terrain is refused (STALE_REF) before running", async () => {
    await ready();
    const key = useTerrainStore.getState().terrainKey!;
    useAoiStore.setState({
      polygon: { vertices: [{ x: 350_005, y: 6_400_005 }, { x: 350_015, y: 6_400_005 }, { x: 350_010, y: 6_400_012 }] },
      terrainKey: { terrain_id: key.terrain_id, epoch: key.epoch + 99 },
    });
    const env = await call("suggest_radar_positions", ARGS);
    expect(code(env)).toBe("STALE_REF");
    expect(env.ok ? "" : env.error.message).toMatch(/otro terreno/u);
    expect(runnerCalls).toBe(0);
  });
});

describe("runOptimizerInWorker · terminate on Stop, no partial result", () => {
  class FakeWorker {
    onmessage: ((event: MessageEvent<OptimizerWorkerMessage>) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = 0;
    posted: unknown[] = [];
    postMessage(message: unknown) {
      this.posted.push(message);
    }
    terminate() {
      this.terminated++;
    }
  }
  const request = { values: new Float64Array(4) } as unknown as OptimizerJobRequest;

  it("abort terminates the Worker at once and a late result is ignored", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const progress: unknown[] = [];
    const pending = runOptimizerInWorker(request, { signal: controller.signal, onProgress: (p) => progress.push(p) }, () => worker as unknown as Worker);
    worker.onmessage!({ data: { type: "progress", progress: { phase: "coarse_los", done: 1, total: 4, bestValue: 3 } } } as MessageEvent);
    const handler = worker.onmessage!;
    controller.abort();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(worker.terminated).toBe(1);
    handler({ data: { type: "result", result: {} } } as MessageEvent);
    expect(worker.onmessage).toBeNull();
    expect(progress).toHaveLength(1);
  });

  it("a result terminates the Worker; a Worker that cannot start is NOT_AVAILABLE", async () => {
    const worker = new FakeWorker();
    const pending = runOptimizerInWorker(request, { signal: new AbortController().signal }, () => worker as unknown as Worker);
    worker.onmessage!({ data: { type: "result", result: { status: "OK" } } } as MessageEvent);
    expect(await pending).toEqual({ status: "result", result: { status: "OK" } });
    expect(worker.terminated).toBe(1);
    const failed = await runOptimizerInWorker(request, { signal: new AbortController().signal }, () => {
      throw new Error("no worker");
    });
    expect(failed.status).toBe("error");
    expect(failed.status === "error" && failed.code).toBe("NOT_AVAILABLE");
  });
});
