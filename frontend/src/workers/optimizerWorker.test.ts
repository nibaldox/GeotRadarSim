/**
 * WP8 · optimizer Worker with the REAL WASM engine (optimizador.md §8, P3–P6).
 *
 * - P3: terrains with a known geometric optimum (wall, cone, two pits).
 * - P4: the Worker's WASM LOS equals the app's LOS Worker (engine "wasm") byte for byte at the
 *   chosen positions, and so do `mergeResults` + `computeQualitySummary` over them.
 * - P5: two runs give the same JSON (P = 1 only in v1; see REPORT).
 * - P6: fake clock → budget reductions with their note; deadline mid-run → no partial result;
 *   WASM that does not start → NOT_AVAILABLE.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRadarWasm, flattenGridForWasm } from "../wasm/loader";
import { normalizeAzimuthRange } from "../services/api";
import { mergeResults } from "../store/analysisStore";
import { computeQualitySummary, DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
import type { LOSResponse, RadarConfig } from "../types/api";
import type { LOSWorkerInput, LOSWorkerOutput } from "./losWorker";
import {
  handleOptimizerMessage,
  normalizeAzimuthRangeForWorker,
  runOptimizerJob,
  wasmLos,
  WASM_NOT_AVAILABLE_MESSAGE,
  type OptimizerJobRequest,
  type OptimizerRadar,
  type OptimizerWasm,
  type OptimizerWorkerMessage,
} from "./optimizerWorker";

let wasm: OptimizerWasm;
type Handler = (event: MessageEvent<LOSWorkerInput>) => void | Promise<void>;
let losHandler: Handler;
const timings: Record<string, number> = {};

beforeAll(async () => {
  wasm = (await loadRadarWasm()) as unknown as OptimizerWasm;
  vi.resetModules();
  const scope: { onmessage: Handler | null; postMessage: () => void } = { onmessage: null, postMessage: () => undefined };
  vi.stubGlobal("self", scope);
  await import("./losWorker");
  vi.unstubAllGlobals();
  losHandler = scope.onmessage!;
});

afterAll(() => {
  // Timings for evidence/wp8/REPORT.md.
  console.info(`[WP8 timings] ${JSON.stringify(timings)}`);
});

const RES = 2;
const RADAR_360: OptimizerRadar = {
  min_range_m: 1, max_range_m: 2000, elevation_min_deg: -90, elevation_max_deg: 90,
  h_beam_width_deg: 360, scan_pattern: "SAR360", azimuth_range_deg: null,
};

function build(rows: number, cols: number, z: (x: number, y: number) => number): number[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => z(c * RES, r * RES)));
}

function request(grid: number[][], overrides: Partial<OptimizerJobRequest> = {}): OptimizerJobRequest {
  return {
    values: flattenGridForWasm(grid),
    rows: grid.length,
    cols: grid[0]!.length,
    min_x: 0,
    min_y: 0,
    resolution: RES,
    radar: RADAR_360,
    azimuthWidthDeg: 360,
    fixed: [],
    k: 1,
    objective: "VISIBLE_AREA",
    policy: DEFAULT_QUALITY_POLICY,
    candidateSet: "regular_grid",
    minSeparationM: 10,
    heightAboveGroundM: 2,
    timeBudgetS: 600,
    ...overrides,
  };
}

const realClock = { now: () => performance.now() };
function run(req: OptimizerJobRequest, label?: string) {
  const t0 = performance.now();
  const out = runOptimizerJob(req, { wasm, ...realClock });
  if (label) timings[label] = Math.round(performance.now() - t0);
  return out;
}
function chosen(out: ReturnType<typeof run>) {
  expect(out.status).toBe("OK");
  return out.coarse!.greedy!.selected.map((i) => out.coarse!.candidates[i]!);
}

// (a) flat plane split by a 2-node-wide, 60 m wall at x = 58–60 m (cols 29 and 30).
const WALL = build(41, 60, (x) => (x === 58 || x === 60 ? 60 : 0));
// (b) convex cone, summit at (60, 60).
const CONE = build(61, 61, (x, y) => 30 - 0.3 * Math.hypot(x - 60, y - 60));
// (c) two paraboloid pits (centres x = 30 and x = 90) separated by a 2-node, 40 m ridge.
const PITS = build(41, 61, (x, y) =>
  x === 58 || x === 60 ? 40 : 0.006 * ((x - (x < 59 ? 30 : 90)) ** 2 + (y - 40) ** 2));

describe("P3 · terrains with a known geometric optimum (real WASM)", () => {
  it("(a) wall: k = 2 puts one radar on each side; k = 1 sees about one half", () => {
    const two = chosen(run(request(WALL, { k: 2 }), "P3a_k2_ms"));
    expect(two).toHaveLength(2);
    expect(two.some((c) => c.x < 58)).toBe(true);
    expect(two.some((c) => c.x > 60)).toBe(true);

    const one = run(request(WALL, { k: 1 }), "P3a_k1_ms");
    const coarse = one.coarse!;
    const total = coarse.coarse.rows * coarse.coarse.cols;
    const share = coarse.greedy!.value / total;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
    const left = Math.max(...coarse.candidates.filter((c) => c.x < 58).map((c) => coarse.candidateValues[c.index]!));
    const right = Math.max(...coarse.candidates.filter((c) => c.x > 60).map((c) => coarse.candidateValues[c.index]!));
    expect(Math.abs(left - right) / Math.max(left, right)).toBeLessThan(0.1);
  });

  it("(b) cone with a 360° profile: k = 1 picks the summit area", () => {
    const [pick] = chosen(run(request(CONE, { k: 1 }), "P3b_ms"));
    expect(Math.hypot(pick!.x - 60, pick!.y - 60)).toBeLessThanOrEqual(10);
  });

  it("(c) two pits separated by a ridge: k = 2 puts one radar in each pit", () => {
    const picks = chosen(run(request(PITS, { k: 2 }), "P3c_ms"));
    expect(picks).toHaveLength(2);
    // Each side of the ridge is one pit (the concave bowl is fully visible from any of its nodes).
    expect(picks.some((c) => c.x < 58)).toBe(true);
    expect(picks.some((c) => c.x > 60)).toBe(true);
    // With k = 1 the best single radar sees about one pit only: the ridge blocks the other.
    const one = run(request(PITS, { k: 1 })).coarse!;
    const share = one.greedy!.value / (one.coarse.rows * one.coarse.cols);
    expect(share).toBeLessThan(0.6);
  });
});

async function appLos(grid: number[][], radar: RadarConfig, pos: { x: number; y: number; z: number }): Promise<LOSWorkerOutput> {
  const posted: LOSWorkerOutput[] = [];
  vi.stubGlobal("self", { onmessage: null, postMessage: (m: LOSWorkerOutput) => posted.push(m) });
  try {
    await losHandler({
      data: {
        grid,
        bounds: { min_x: 0, min_y: 0, max_x: (grid[0]!.length - 1) * RES, max_y: (grid.length - 1) * RES },
        resolution: RES,
        radar_position: [pos.x, pos.y, pos.z],
        radar_config: radar,
        engine: "wasm",
        engine_explicit: true,
      },
    } as MessageEvent<LOSWorkerInput>);
  } finally {
    vi.unstubAllGlobals();
  }
  const out = posted[0]!;
  if (!out || out.error) throw new Error(`app LOS failed: ${out?.error}`);
  expect(out.engine_used).toBe("wasm");
  return out;
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

const asResponse = (out: LOSWorkerOutput): LOSResponse => out as unknown as LOSResponse;

const P4_KEY = { terrain_id: "p4", epoch: 1 };

describe("P4 · coherence with the app (full resolution, same engine)", () => {
  it("the chosen positions give the same bytes and the same union summary as the app's LOS Worker", async () => {
    const out = run(request(PITS, { k: 2, objective: "USEFUL_INCIDENCE" }));
    const picks = chosen(out);
    const appRadar: RadarConfig = {
      model_id: "p4", display_name: "p4", manufacturer: "p4", v_beam_width_deg: 30, ...RADAR_360,
      azimuth_range_deg: null,
    };
    const flat = flattenGridForWasm(PITS);
    const mine: LOSResponse[] = [];
    const theirs: LOSResponse[] = [];
    for (const c of picks) {
      const pos = { x: c.x, y: c.y, z: c.z };
      const app = await appLos(PITS, appRadar, pos);
      const own = wasmLos(wasm, flat, { rows: PITS.length, cols: PITS[0]!.length, min_x: 0, min_y: 0, resolution: RES }, pos, RADAR_360, 120_000);
      expect(sameBytes(own.cell_states, app.cell_states)).toBe(true);
      expect(sameBytes(own.flat_quality_grid, app.flat_quality_grid!)).toBe(true);
      expect(sameBytes(own.flat_projection_grid, app.flat_projection_grid!)).toBe(true);
      theirs.push(asResponse(app));
      mine.push(asResponse({ ...app, cell_states: own.cell_states, flat_quality_grid: own.flat_quality_grid, flat_projection_grid: own.flat_projection_grid }));
    }
    // App union order: newest first.
    const summary = (results: LOSResponse[]) => computeQualitySummary({
      metric: "INCIDENCE", policy: DEFAULT_QUALITY_POLICY, losResult: mergeResults([...results].reverse()),
      terrainGrid: PITS, terrainResolution: RES, terrainKey: P4_KEY, snapshot: { terrainKey: P4_KEY, analysisId: null, sourceAnalysisIds: [], generation: 0, radars: [] },
    } as Parameters<typeof computeQualitySummary>[0]);
    const a = summary(mine);
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(summary(theirs)));
  });

  it("the AOI azimuth window of the Worker is the app's normalizeAzimuthRange (differential)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 10_000; i++) {
      const center = (rnd() - 0.5) * 2000;
      const width = rnd() < 0.05 ? 360 + rnd() * 10 : 0.001 + rnd() * 359;
      const a = normalizeAzimuthRangeForWorker(center, width);
      const b = normalizeAzimuthRange(center, width);
      expect(a === null ? b === null : b !== null && Object.is(a[0], b[0]) && Object.is(a[1], b[1])).toBe(true);
    }
  });
});

describe("P5 · determinism", () => {
  it("two runs with the same input give the same JSON (timing apart)", () => {
    const strip = (o: ReturnType<typeof run>) => JSON.stringify({ ...o, timing: null });
    const req = request(PITS, { k: 2, objective: "USEFUL_INCIDENCE" });
    const t0 = performance.now();
    const first = strip(run(req));
    const second = strip(run(request(PITS, { k: 2, objective: "USEFUL_INCIDENCE" })));
    timings.P5_two_runs_ms = Math.round(performance.now() - t0);
    expect(second).toBe(first);
  });
});

/** Real WASM behind a fake clock: every LOS costs `costMs` of fake time. */
function fakeClock(costMs: (call: number) => number) {
  let t = 0;
  let calls = 0;
  const timed: OptimizerWasm = {
    compute_los: (...args: Parameters<OptimizerWasm["compute_los"]>) => {
      const out = wasm.compute_los(...args);
      t += costMs(calls++);
      return out;
    },
  };
  return { wasm: timed, now: () => t, calls: () => calls };
}

describe("P6 · budget, deadline and NOT_AVAILABLE", () => {
  it("an over-budget estimate reduces N, then the shortlist, then raises f, and says so", () => {
    const t0 = performance.now();
    const base = runOptimizerJob(request(CONE, { k: 2 }), fakeClock(() => 1));
    expect(base.reduced).toEqual({});
    expect(base.reductionNote).toBe("");
    const n0 = base.coarse!.candidates.length;
    // 1 s per coarse LOS, f = 1 here, 3 s budget: N drops to k, then the shortlist, then f rises.
    const clock = fakeClock(() => 1000);
    const out = runOptimizerJob(request(CONE, { k: 2, timeBudgetS: 3 }), clock);
    timings.P6_budget_ms = Math.round(performance.now() - t0);
    expect(out.reduced.max_candidates).toEqual({ from: n0, to: expect.any(Number) });
    expect(out.reduced.max_candidates!.to).toBeLessThan(n0);
    expect(out.reduced.shortlist_per_step).toEqual({ from: 3, to: 2 });
    expect(out.shortlistPerStep).toBe(2);
    expect(out.reductionNote).toMatch(/^Para respetar el presupuesto de tiempo, se redujeron los candidatos de \d+ a \d+; la lista corta pasó de 3 a 2/);
    expect(out.reduced.coarse_factor).toEqual({ from: 1, to: 2 });
    expect(out.coarse!.coarse.factor).toBe(2);
    expect(out.reductionNote).toMatch(/la grilla gruesa pasó del factor 1 al 2\.$/);
    expect(out.timing.calibration_ms).toBe(1000);
    expect(out.status).toBe("OK");
  });

  it("the deadline mid-run leaves no partial result (BUDGET_EXCEEDED, coarse null)", () => {
    // Calibration says 1 ms, then each LOS costs 5 s of a 10 s budget.
    const clock = fakeClock((call) => (call === 0 ? 1 : 5000));
    const out = runOptimizerJob(request(CONE, { k: 1, timeBudgetS: 10 }), clock);
    expect(out.status).toBe("BUDGET_EXCEEDED");
    expect(out.coarse).toBeNull();
    expect(clock.calls()).toBeLessThan(6);
  });

  it("the Worker answers NOT_AVAILABLE in Spanish when WASM does not start", async () => {
    const posted: OptimizerWorkerMessage[] = [];
    await handleOptimizerMessage(request(CONE), (m) => posted.push(m), () => Promise.reject(new Error("no wasm")));
    expect(posted).toEqual([{ type: "error", code: "NOT_AVAILABLE", message: WASM_NOT_AVAILABLE_MESSAGE }]);
  });

  it("the Worker posts progress and one result through the real WASM loader", async () => {
    const posted: OptimizerWorkerMessage[] = [];
    await handleOptimizerMessage(request(CONE, { k: 1 }), (m) => posted.push(m));
    const results = posted.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(posted.some((m) => m.type === "progress")).toBe(true);
    expect(posted[posted.length - 1]!.type).toBe("result");
  });
});

describe("R8-FIX C3 · a deadline inside one LOS is BUDGET_EXCEEDED (R8B-3)", () => {
  /** The real engine's error for a deadline hit inside compute_los. */
  function realDeadlineError(): unknown {
    const n = 900;
    const big = new Float64Array(n * n).fill(100);
    try {
      wasm.compute_los(big, n, n, 0, 0, 1, 500, 500, 105, 0, 5000, -90, 90, false, Number.NaN, Number.NaN, 0);
    } catch (error) {
      return error;
    }
    throw new Error("the real engine did not hit its deadline");
  }

  it("the real WASM throws a RangeError with code LOS_DEADLINE_EXCEEDED", () => {
    const error = realDeadlineError() as { code?: string };
    expect(error).toBeInstanceOf(RangeError);
    expect(error.code).toBe("LOS_DEADLINE_EXCEEDED");
  });

  it("R8B-3: that error in the middle of the coarse pass gives BUDGET_EXCEEDED with the reductions note, not invalid data", async () => {
    const thrown = realDeadlineError();
    let calls = 0;
    const deadlineWasm: OptimizerWasm = {
      compute_los: (...args: Parameters<OptimizerWasm["compute_los"]>) => {
        calls++;
        if (calls === 3) throw thrown;
        return wasm.compute_los(...args);
      },
    };
    const posted: OptimizerWorkerMessage[] = [];
    await handleOptimizerMessage(request(CONE, { k: 1, timeBudgetS: 3 }), (m) => posted.push(m), async () => deadlineWasm, fakeClock(() => 1000).now);
    const final = posted.filter((m) => m.type !== "progress");
    expect(final).toHaveLength(1);
    expect(final[0]!.type).toBe("result");
    const result = final[0]!.type === "result" ? final[0]!.result : null;
    expect(result!.status).toBe("BUDGET_EXCEEDED");
    expect(result!.coarse).toBeNull();
    expect(typeof result!.reductionNote).toBe("string");
  });

  it("the same error during calibration is BUDGET_EXCEEDED too", () => {
    const thrown = realDeadlineError();
    const out = runOptimizerJob(request(CONE, { k: 1 }), { wasm: { compute_los: () => { throw thrown; } }, now: () => 0 });
    expect(out.status).toBe("BUDGET_EXCEEDED");
    expect(out.coarse).toBeNull();
  });

  it("R8B-5: progress messages echo the request runId", async () => {
    const posted: OptimizerWorkerMessage[] = [];
    await handleOptimizerMessage({ ...request(CONE, { k: 1 }), runId: "run-7" }, (m) => posted.push(m));
    const progress = posted.filter((m) => m.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((m) => m.type === "progress" && m.runId === "run-7")).toBe(true);
  });
});
