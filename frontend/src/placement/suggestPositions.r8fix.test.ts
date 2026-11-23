/**
 * R8-FIX · inverted probes of the R8 review (evidence/r8/wp8-A.md, wp8-B.md, ARBITRAJE.md).
 * Each `it` starts from a reviewer probe, asserting the corrected behaviour (C1–C4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  listRadars: vi.fn(), runLOSAnalysis: vi.fn(), getLOSJob: vi.fn(), cancelLOSAnalysis: vi.fn(), releaseLOSJob: vi.fn(),
  runSensitivityAnalysis: vi.fn(), cancelSensitivityAnalysis: vi.fn(), releaseSensitivityJob: vi.fn(),
  generateSynthetic: vi.fn(), getTerrainGrid: vi.fn(), activateTerrain: vi.fn(), releaseTerrain: vi.fn(),
  uploadDXF: vi.fn(), uploadSTL: vi.fn(), previewTerrainBounds: vi.fn(), exportPDF: vi.fn(), exportCSV: vi.fn(),
}));

import * as api from "../services/api";
import { useAnalysisStore } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useTerrainStore } from "../store/terrainStore";
import { loadRadarWasm } from "../wasm/loader";
import { runOptimizerJob, type OptimizerJobRequest, type OptimizerWasm, type OptimizerWorkerMessage } from "../workers/optimizerWorker";
import type { ToolEnvelope } from "./toolEnvelope";
import { parseAndValidateArgs } from "./validate";
import {
  OPTIMIZER_WATCHDOG_MARGIN_MS, runOptimizerInWorker, setOptimizerRunnerForTests, subscribeOptimizerProgress, type OptimizerRunner,
} from "./suggestPositions";
import { byName, createSuggestionToolkit, ctxFor, drive, installFakeApi, loadProfiles, loadTerrain, resetStores, type SuggestionToolkit } from "./placement.testSupport";

let kit: SuggestionToolkit;
let wasm: OptimizerWasm;
const realRunner: OptimizerRunner = async (request, { signal }) => {
  if (signal.aborted) return { status: "cancelled" };
  return { status: "result", result: runOptimizerJob(request, { wasm, now: () => 0 }) };
};

beforeEach(async () => {
  wasm = (await loadRadarWasm()) as unknown as OptimizerWasm;
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetStores();
  useAoiStore.getState().clear();
  useQualityPolicyStore.getState().resetPolicy();
  installFakeApi();
  kit = createSuggestionToolkit();
  setOptimizerRunnerForTests({ runner: realRunner, available: () => true });
});
afterEach(() => {
  setOptimizerRunnerForTests(null);
  resetStores();
  vi.useRealTimers();
});

async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolEnvelope> {
  const tool = byName(kit.tools, name);
  const checked = parseAndValidateArgs(tool.parameters, JSON.stringify(args));
  if (!checked.ok) throw new Error(checked.summary);
  return drive(tool.execute(checked.value as Record<string, unknown>, ctxFor(signal)));
}
const code = (env: ToolEnvelope) => (env.ok ? "OK" : env.error.code);
const hint = (env: ToolEnvelope) => (env.ok ? null : env.error.hint ?? null);
const O = { x: 350_000.5, y: 6_400_000.25 };
const square = (x0: number, y0: number, x1: number, y1: number) => ({
  vertices: [{ x: O.x + x0, y: O.y + y0 }, { x: O.x + x1, y: O.y + y0 }, { x: O.x + x1, y: O.y + y1 }, { x: O.x + x0, y: O.y + y1 }],
});
const ARGS = { k: 2, candidate_set: "regular_grid", min_separation_m: 5 };

async function ready(profile = "perfil-a"): Promise<void> {
  await drive(loadTerrain(30, 20, 1));
  await loadProfiles();
  useAnalysisStore.getState().selectRadar(profile);
}
const key = () => useTerrainStore.getState().terrainKey!;

/** Runs the real coarse pass, then applies `mutate` before returning (the user acts during the run). */
function runnerThen(mutate: () => void): OptimizerRunner {
  return async (request, options) => {
    const out = await realRunner(request, options);
    mutate();
    return out;
  };
}

describe("C1 · the AOI is part of the run signature (R8A-1, R8B-1)", () => {
  it("R8A-1: the area is redrawn (same terrain key) during the coarse pass → SUPERSEDED, nothing published", async () => {
    await ready("perfil-b");
    useAoiStore.setState({ polygon: square(18, 6, 26, 14), terrainKey: { ...key() } });
    setOptimizerRunnerForTests({ runner: runnerThen(() => useAoiStore.setState({ polygon: square(1, 1, 5, 5), terrainKey: { ...key() } })), available: () => true });
    const env = await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid", min_separation_m: 3 });
    expect(code(env)).toBe("SUPERSEDED");
    expect(useAnalysisStore.getState().history).toHaveLength(0);
    expect(useAnalysisStore.getState().azCenterOverride).toBeNull();
  });

  it.each(["clear", "redraw", "draw"] as const)("R8B-1: AOI %s during the run → SUPERSEDED", async (mode) => {
    await ready("perfil-b");
    if (mode !== "draw") useAoiStore.setState({ polygon: square(18, 6, 26, 14), terrainKey: { ...key() } });
    setOptimizerRunnerForTests({
      runner: runnerThen(() => {
        if (mode === "clear") useAoiStore.getState().clear();
        else useAoiStore.setState({ polygon: square(1, 1, 6, 6), terrainKey: { ...key() } });
      }),
      available: () => true,
    });
    const env = await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid", min_separation_m: 3 });
    expect(code(env)).toBe("SUPERSEDED");
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });
});

/** Fires `fn` once the first verification is in the history and the second LOS is running. */
function duringSecondVerification(fn: () => void): () => void {
  let fired = false;
  return useAnalysisStore.subscribe((s) => {
    if (!fired && s.history.length === 1 && s.loading) {
      fired = true;
      queueMicrotask(fn);
    }
  });
}

describe("C1 · snapshot revalidated around every verification (R8A-2)", () => {
  it("R8A-2: a limit changed between verification 1 and 2 → SUPERSEDED, never a mixed union", async () => {
    await ready();
    let fired = false;
    const unsub = useAnalysisStore.subscribe((s) => {
      if (!fired && s.history.length === 1) {
        fired = true;
        queueMicrotask(() => useAnalysisStore.getState().setOverrides({ rangeMax: 7 }));
      }
    });
    const env = await call("suggest_radar_positions", ARGS);
    unsub();
    expect(fired).toBe(true);
    expect(code(env)).toBe("SUPERSEDED");
    // No entry with the user's new limit was produced by the tool.
    const agentEntries = useAnalysisStore.getState().history.filter((e) => e.origin === "agent");
    expect(agentEntries.every((e) => e.snapshot!.radars[0]!.overrides.rangeMax === null)).toBe(true);
  });
});

describe("C2 · partial verification is reported as left_in_history (R8B-2)", () => {
  const leftRefs = (env: ToolEnvelope): string[] => {
    const h = hint(env);
    const m = h ? /^left_in_history: \[([A0-9, ]*)\]$/u.exec(h) : null;
    return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
  };
  const agentCount = () => useAnalysisStore.getState().history.filter((e) => e.origin === "agent").length;

  it("R8B-2a: the policy changes during the 2nd verification → SUPERSEDED listing every agent entry left", async () => {
    await ready();
    const unsub = duringSecondVerification(() => useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.2, highMin: 0.8 }));
    const env = await call("suggest_radar_positions", ARGS);
    unsub();
    expect(code(env)).toBe("SUPERSEDED");
    expect(leftRefs(env)).toHaveLength(agentCount());
    expect(leftRefs(env).length).toBeGreaterThan(0);
    expect(env.ok ? "" : env.error.message).toMatch(/análisis válidos de esas posiciones, pero la sugerencia quedó incompleta/u);
  });

  it("R8B-2b: Stop during the 2nd verification → CANCELLED_BY_USER with left_in_history [A1]", async () => {
    await ready();
    const controller = new AbortController();
    const unsub = duringSecondVerification(() => controller.abort());
    const env = await call("suggest_radar_positions", ARGS, controller.signal);
    unsub();
    expect(code(env)).toBe("CANCELLED_BY_USER");
    expect(leftRefs(env)).toEqual(["A1"]);
    expect(agentCount()).toBe(1);
  });

  it("R8B-2c: the user starts an LOS during the 2nd verification → SUPERSEDED; the user's entry is not listed", async () => {
    await ready();
    const unsub = duringSecondVerification(() => {
      void useAnalysisStore.getState().runAnalysis(key().terrain_id);
    });
    const env = await call("suggest_radar_positions", ARGS);
    unsub();
    await drive(new Promise((r) => setTimeout(r, 5000)));
    expect(code(env)).toBe("SUPERSEDED");
    expect(leftRefs(env)).toEqual(["A1"]);
    expect(agentCount()).toBe(1);
  });

  it("R8B-2d: rangeMax changes during the 2nd verification → SUPERSEDED with left_in_history [A1]", async () => {
    await ready();
    const unsub = duringSecondVerification(() => useAnalysisStore.getState().setRangeOverrides(null, 7));
    const env = await call("suggest_radar_positions", ARGS);
    unsub();
    expect(code(env)).toBe("SUPERSEDED");
    expect(leftRefs(env)).toEqual(["A1"]);
    expect(agentCount()).toBe(1);
  });

  it("a supersede during the coarse pass leaves nothing and reports no left_in_history", async () => {
    await ready();
    setOptimizerRunnerForTests({ runner: runnerThen(() => useAnalysisStore.getState().setRangeOverrides(null, 9)), available: () => true });
    const env = await call("suggest_radar_positions", ARGS);
    expect(code(env)).toBe("SUPERSEDED");
    expect(hint(env)).toBeNull();
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });
});

describe("C3 · watchdog on the page (R8B-4)", () => {
  class SilentWorker {
    onmessage: ((event: MessageEvent<OptimizerWorkerMessage>) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = 0;
    postMessage() {}
    terminate() {
      this.terminated++;
    }
  }
  const request = { values: new Float64Array(4), timeBudgetS: 10 } as unknown as OptimizerJobRequest;

  it("R8B-4: a Worker that never answers is terminated after budget + margin and returns TIMEOUT", async () => {
    const worker = new SilentWorker();
    let settled: unknown = "PENDIENTE";
    void runOptimizerInWorker(request, { signal: new AbortController().signal }, () => worker as unknown as Worker).then((o) => { settled = o; });
    await vi.advanceTimersByTimeAsync(10_000 + OPTIMIZER_WATCHDOG_MARGIN_MS - 1);
    expect(settled).toBe("PENDIENTE");
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toMatchObject({ status: "error", code: "TIMEOUT" });
    expect(worker.terminated).toBe(1);
  });

  it("a message re-arms the watchdog with the remaining budget plus the margin", async () => {
    const worker = new SilentWorker();
    let settled: unknown = "PENDIENTE";
    void runOptimizerInWorker(request, { signal: new AbortController().signal }, () => worker as unknown as Worker).then((o) => { settled = o; });
    await vi.advanceTimersByTimeAsync(20_000);
    worker.onmessage!({ data: { type: "progress", runId: "x", progress: { phase: "coarse_los", done: 1, total: 9, bestValue: 1 } } } as MessageEvent);
    // The deadline was at 10 s: only the margin is left from now on.
    await vi.advanceTimersByTimeAsync(OPTIMIZER_WATCHDOG_MARGIN_MS - 1);
    expect(settled).toBe("PENDIENTE");
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toMatchObject({ status: "error", code: "TIMEOUT" });
  });

  it("the tool maps the watchdog to a retryable TIMEOUT in Spanish", async () => {
    await ready();
    setOptimizerRunnerForTests({ runner: async () => ({ status: "error", code: "TIMEOUT", message: "x" }), available: () => true });
    const env = await call("suggest_radar_positions", ARGS);
    expect(code(env)).toBe("TIMEOUT");
    expect(env.ok ? null : env.error.retryable).toBe(true);
    expect(env.ok ? "" : env.error.message).toMatch(/no respondió/u);
  });
});

describe("C4 · details (R8A-4, R8A-5, R8B-5)", () => {
  it.each([
    ["empty", { vertices: [] }, /área a monitorear está vacía/u],
    ["collinear", { vertices: [{ x: O.x + 1, y: O.y + 1 }, { x: O.x + 5, y: O.y + 1 }, { x: O.x + 9, y: O.y + 1 }] }, /colineales/u],
    ["smaller than a cell", square(10.2, 10.2, 10.5, 10.5), /menor que una celda/u],
  ] as const)("R8A-5: a degenerate AOI (%s) is refused before running with a specific message", async (_name, polygon, message) => {
    await ready("perfil-b");
    let calls = 0;
    setOptimizerRunnerForTests({ runner: async (r, o) => { calls++; return realRunner(r, o); }, available: () => true });
    useAoiStore.setState({ polygon: polygon as any, terrainKey: { ...key() } });
    const env = await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid" });
    expect(code(env)).toBe("INVALID_ARGUMENT");
    expect(env.ok ? "" : env.error.message).toMatch(message);
    expect(calls).toBe(0);
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });

  it("R8B-5: progress events carry a runId and the callId, distinct per run", async () => {
    await ready();
    const seen: Array<{ runId: string; callId: string }> = [];
    const unsub = subscribeOptimizerProgress((event) => seen.push({ runId: event.runId, callId: event.callId }));
    setOptimizerRunnerForTests({
      runner: async (request, options) => {
        options.onProgress?.({ phase: "coarse_los", done: 1, total: 1, bestValue: 1 });
        return realRunner(request, options);
      },
      available: () => true,
    });
    await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid", min_separation_m: 5 });
    await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid", min_separation_m: 5 });
    unsub();
    expect(seen).toHaveLength(2);
    expect(typeof seen[0]!.runId).toBe("string");
    expect(seen[0]!.runId).not.toBe(seen[1]!.runId);
    expect(seen[0]!.callId).toBe("c1");
  });
});

describe("R8-FIX2 · residuals of R8-CLOSE", () => {
  it("R8C-1: an area that does not overlap the terrain is INVALID_ARGUMENT in Spanish, with no writes (probe RC-6 «fuera»)", async () => {
    await ready("perfil-b");
    let calls = 0;
    setOptimizerRunnerForTests({ runner: async (r, o) => { calls++; return realRunner(r, o); }, available: () => true });
    useAoiStore.setState({ polygon: square(200, 200, 210, 210), terrainKey: { ...key() } });
    const before = JSON.stringify({
      position: useAnalysisStore.getState().radarPosition, az: useAnalysisStore.getState().azCenterOverride,
      selection: useAnalysisStore.getState().history.map((e) => e.selected),
    });
    const env = await call("suggest_radar_positions", { k: 1, candidate_set: "regular_grid" });
    expect(code(env)).toBe("INVALID_ARGUMENT");
    expect(env.ok ? "" : env.error.message).toBe("El área a monitorear no se superpone con el terreno cargado.");
    expect(calls).toBe(0);
    expect(vi.mocked(api.runLOSAnalysis)).not.toHaveBeenCalled();
    expect(useAnalysisStore.getState().history).toHaveLength(0);
    expect(JSON.stringify({
      position: useAnalysisStore.getState().radarPosition, az: useAnalysisStore.getState().azCenterOverride,
      selection: useAnalysisStore.getState().history.map((e) => e.selected),
    })).toBe(before);
  });

  it.each(["microtask", "sync"] as const)("R8C-2 (%s): a limit changed right after verification 1 → only ONE LOS runs and left_in_history is exactly [A1]", async (when) => {
    await ready();
    let fired = false;
    const unsub = useAnalysisStore.subscribe((s) => {
      if (!fired && s.history.length === 1 && !s.loading) {
        fired = true;
        // «microtask»: verification 1 is published and the change lands before the 2nd LOS
        // (only the revalidation around runAnalysisAndWait catches it). «sync»: the change lands
        // inside the publication, so the store answers `superseded` with the entry already in.
        if (when === "microtask") queueMicrotask(() => useAnalysisStore.getState().setRangeOverrides(null, 7));
        else useAnalysisStore.getState().setRangeOverrides(null, 7);
      }
    });
    const env = await call("suggest_radar_positions", ARGS);
    unsub();
    expect(fired).toBe(true);
    expect(code(env)).toBe("SUPERSEDED");
    expect(vi.mocked(api.runLOSAnalysis)).toHaveBeenCalledTimes(1);
    expect(hint(env)).toBe("left_in_history: [A1]");
    expect(useAnalysisStore.getState().history).toHaveLength(1);
  });
});
