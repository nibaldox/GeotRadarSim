/**
 * R1-FIX regressions for WP7 (arbitration `evidence/r1/ARBITRAJE.md`, rows WP7B-1..6 and WP7A-1..4).
 * Each test adopts the reviewer's probe (`evidence/r1/wp7-{A,B}-probes/`) inverted to assert the
 * correct behaviour, with the reviewer's exact values.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mergeResults, useAnalysisStore } from "../../store/analysisStore";
import type { HistoryEntry } from "../../store/analysisStore";
import { LOSCellState } from "../../types/api";
import type { LOSResponse } from "../../types/api";
import { DEFAULT_QUALITY_POLICY, computeQualitySummary } from "../qualityMetrics";
import type { QualityPolicy } from "../qualityMetrics";
import { classifyCandidateNodes, generateCandidates, thinNodes } from "./candidates";
import { coarsenGrid, validateOptimizerGrid } from "./coarsen";
import { greedySelect } from "./greedy";
import { UnionState, evaluateUnion, objectiveQualityMetric, objectiveValueFromSummary, scoreLosOutput } from "./objective";
import { optimizeCoarse } from "./optimize";
import type { CoarseOptimizationInput } from "./optimize";
import { asLOSResponse, flatTerrain, losOutput, randomInt, seededRandom, visibleOn } from "./optimizer.testSupport";
import type { LosCellOutput, LosRequest, OptimizerGrid, OptimizerObjective } from "./types";

const V = LOSCellState.VISIBLE;
const O = LOSCellState.OUT_OF_RANGE;
const KEY = { terrain_id: "t", epoch: 1 };
const policy = DEFAULT_QUALITY_POLICY;

function summaryOf(result: LOSResponse, objective: OptimizerObjective, summaryPolicy: QualityPolicy, terrain: number[][]) {
  return computeQualitySummary({
    metric: objectiveQualityMetric(objective),
    policy: summaryPolicy,
    losResult: result,
    terrainGrid: terrain,
    terrainResolution: 2,
    terrainKey: KEY,
    snapshot: { terrainKey: KEY, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] },
  });
}

/** Benches every 6 columns: 4 flat nodes then a 2-node steep face (reviewer B fixture). */
function stepped(rows: number, cols: number): OptimizerGrid {
  const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    let z = 0;
    for (let c = 0; c < cols; c++) {
      if (c % 6 >= 4) z += 3;
      grid[r]![c] = z;
    }
  }
  return { grid, bounds: { min_x: 1000, min_y: 2000 }, resolution: 1 };
}

const fakeLos = (cells: number) => (req: LosRequest): LosCellOutput => {
  const size = req.grid.grid.length * req.grid.grid[0]!.length;
  const seen: number[] = [];
  for (let i = 0; i < size; i++) if ((i + Math.round(req.position.x)) % 7 === 0) seen.push(i);
  return visibleOn(size, seen.slice(0, cells));
};

describe("WP7B-1: thinning with a tiny min_separation_m", () => {
  it("WP7B-1: 1e-9, 5e-324 and 1e-320 thin exactly like min_sep = 0 (box side = resolution), never collapsing", () => {
    const source: OptimizerGrid = { grid: flatTerrain(120, 120, 5), bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    const reference = generateCandidates(source, { candidateSet: "regular_grid", minSeparationM: 0 });
    expect(reference.candidates.length).toBeGreaterThan(100);
    for (const sep of [1e-9, 5e-324, 1e-320]) {
      const result = generateCandidates(source, { candidateSet: "regular_grid", minSeparationM: sep });
      expect(result.candidates.length).toBe(reference.candidates.length);
      expect(result.candidates).toEqual(reference.candidates);
      expect(result.boxSideM).toBe(reference.boxSideM);
    }
  });

  it("WP7B-1: the box side never starts below the resolution", () => {
    const result = thinNodes([0, 1, 2, 3], 4, 2, 0.5, 160);
    expect(result.boxSideM).toBe(2);
    expect(result.nodes).toEqual([0, 1, 2, 3]);
  });

  it("WP7B-1: STL-sized synthetic grid (543 × 685 at 2 m) with 1e-9 needs few passes and stays under the time cap", () => {
    const source: OptimizerGrid = { grid: flatTerrain(543, 685, 5), bounds: { min_x: 0, min_y: 0 }, resolution: 2 };
    const classification = classifyCandidateNodes(source);
    const t0 = performance.now();
    const tiny = thinNodes(classification.regular, classification.cols, 2, 1e-9);
    const elapsed = performance.now() - t0;
    const zero = thinNodes(classification.regular, classification.cols, 2, 0);
    expect(tiny).toEqual(zero);
    expect(tiny.nodes.length).toBeLessThanOrEqual(160);
    // Before the fix: ~113 full passes and 9 787 ms (reviewer run r1B-run4). The jump start
    // skips the sides that provably cannot fit, so only a handful of passes remain.
    expect(tiny.passes).toBeLessThanOrEqual(4);
    expect(elapsed).toBeLessThan(3000);
  }, 30_000);

  it("WP7B-1: the jump start does not change the result for a sparse pool (no over-thinning)", () => {
    // Sparse pool: 40 isolated nodes 30 m apart fit at side = min_sep already.
    const cols = 1000;
    const nodes = Array.from({ length: 40 }, (_, i) => (i % 8) * 30 * cols + Math.floor(i / 8) * 30);
    const result = thinNodes(nodes, cols, 1, 10, 160);
    expect(result.boxSideM).toBe(10);
    expect(result.nodes).toEqual([...nodes].sort((a, b) => a - b));
  });

  it("WP7B-1: duplicated nodes do not inflate the jump start", () => {
    const random = seededRandom(7);
    const nodes = Array.from({ length: 4000 }, () => randomInt(random, 0, 199 * 300 - 1));
    const a = thinNodes(nodes, 300, 1.7, 13, 40);
    const shuffled = [...nodes, ...nodes.slice(0, 500), ...nodes, ...nodes].sort(() => random() - 0.5);
    expect(thinNodes(shuffled, 300, 1.7, 13, 40)).toEqual(a);
  });

  it("WP7B-1: an iteration cap stops a thinning that does not converge", () => {
    // Two far corners with N_max = 1 need a second pass; a cap of 1 pass must refuse.
    expect(() => thinNodes([0, 99 * 100 + 99], 100, 1, 1, 1, 1.25, 1)).toThrow(RangeError);
    const all = Array.from({ length: 100 * 100 }, (_, i) => i);
    expect(() => thinNodes(all, 100, 1, 1, 160, 1.0001)).toThrow(RangeError); // growth outside [1.05, 4]
  });
});

describe("WP7B-2: argument validation before any LOS", () => {
  const source = stepped(40, 60);
  for (const [label, extra] of [
    ["k=0", { k: 0 }],
    ["k=1.5", { k: 1.5 }],
    ["shortlist=0", { k: 1, shortlistPerStep: 0 }],
    ["objective=BOGUS", { k: 1, objective: "BOGUS" }],
    ["policy invalid", { k: 1, policy: { mediumMin: 0.7, highMin: 0.3 } }],
  ] as const) {
    it(`WP7B-2: ${label} throws RangeError with 0 LOS calls`, () => {
      let calls = 0;
      expect(() => optimizeCoarse({
        source, policy, minSeparationM: 0,
        los: (req) => { calls++; return fakeLos(30)(req); },
        ...(extra as Record<string, unknown>),
      } as CoarseOptimizationInput)).toThrow(RangeError);
      expect(calls).toBe(0);
    });
  }

  it("WP7B-2: k = 0 is an error also when there are no candidates", () => {
    const flat: OptimizerGrid = { grid: flatTerrain(3, 3, 0), bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    expect(() => optimizeCoarse({ source: flat, policy, k: 0, los: fakeLos(1) })).toThrow(RangeError);
    expect(optimizeCoarse({ source: flat, policy, k: 1, los: fakeLos(1) }).status).toBe("NO_CANDIDATES");
  });
});

describe("WP7B-3 (DOC): a deadline with an injectable clock is checked between LOS evaluations", () => {
  it("WP7B-3: a fake clock past the deadline stops before the next LOS", () => {
    let clock = 0;
    let calls = 0;
    const deadline = 5;
    const result = optimizeCoarse({
      source: stepped(40, 60), policy, k: 2, minSeparationM: 0,
      los: (req) => { calls++; clock++; return fakeLos(30)(req); },
      isCancelled: () => clock >= deadline,
    });
    expect(result.status).toBe("CANCELLED");
    expect(calls).toBe(deadline);
  });
});

describe("WP7B-4: candidates stay inside the coarse extent", () => {
  it("WP7B-4: 600 × 900 with f = 4: every coarse LOS position lies inside the coarse grid minus the margin", () => {
    const rows = 600;
    const cols = 900;
    const source: OptimizerGrid = { grid: flatTerrain(rows, cols, 0), bounds: { min_x: 100, min_y: 200 }, resolution: 1 };
    const positions: Array<[number, number]> = [];
    const result = optimizeCoarse({
      source, policy, k: 1, minSeparationM: 50, candidateSet: "regular_grid",
      los: (req) => { positions.push([req.position.x, req.position.y]); return fakeLos(3)(req); },
    });
    expect(result.coarse.factor).toBe(4);
    const coarse = coarsenGrid(source, 4);
    const m = 2;
    expect(positions.length).toBe(result.candidates.length);
    expect(positions.length).toBeGreaterThan(0);
    for (const [x, y] of positions) {
      expect(x).toBeGreaterThanOrEqual(coarse.bounds.min_x + m);
      expect(y).toBeGreaterThanOrEqual(coarse.bounds.min_y + m);
      expect(x).toBeLessThanOrEqual(coarse.bounds.max_x - m);
      expect(y).toBeLessThanOrEqual(coarse.bounds.max_y - m);
    }
  });

  it("WP7B-4: 12 × 12 with f = 4 (reviewer probe): no candidate outside [0, 8]²", () => {
    const small: OptimizerGrid = { grid: flatTerrain(12, 12, 0), bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    const coarse = coarsenGrid(small, 4);
    const seen: Array<[number, number]> = [];
    const result = optimizeCoarse({
      source: small, policy, k: 1, minSeparationM: 0, candidateSet: "regular_grid", coarseFactor: 4,
      los: (req) => { seen.push([req.position.x, req.position.y]); return fakeLos(3)(req); },
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(seen.filter(([x, y]) => x > coarse.bounds.max_x || y > coarse.bounds.max_y)).toEqual([]);
    expect(result.candidateGeneration.extentNodes).toEqual({ rows: 9, cols: 9 });
  });
});

describe("WP7B-5: resolutions whose cell area is not representable are rejected", () => {
  it("WP7B-5: res² = 0 (1e-170) or res² = ∞ (1e200) throw, as compute_los does", () => {
    for (const resolution of [1e-170, 1e200]) {
      const source: OptimizerGrid = { grid: flatTerrain(10, 10, 0), bounds: { min_x: 0, min_y: 0 }, resolution };
      expect(() => validateOptimizerGrid(source)).toThrow(RangeError);
      expect(() => classifyCandidateNodes(source)).toThrow(RangeError);
    }
    expect(() => validateOptimizerGrid({ grid: flatTerrain(3, 3, 0), bounds: { min_x: 0, min_y: 0 }, resolution: 1e-150 }))
      .not.toThrow();
  });
});

describe("WP7B-6: the guarantee carries its scope", () => {
  it("WP7B-6: guaranteeScope is coarse_thinned_candidates", () => {
    const candidates = [[0, 1], [2]].map((cells, i) => ({ score: scoreLosOutput(visibleOn(4, cells), "VISIBLE_AREA", policy), x: i, y: 0 }));
    const greedy = greedySelect(candidates, { k: 1, objective: "VISIBLE_AREA", policy });
    expect(greedy.guarantee).toBe("1-1/e");
    expect(greedy.guaranteeScope).toBe("coarse_thinned_candidates");
  });
});

describe("WP7A-1: USEFUL_PROJECTION is evaluated in the app's union order", () => {
  // Reviewer A values (probe-search-rms-order.mjs), default policy (mediumMin 0.3).
  const a = Math.fround(0.36081400513648987);
  const b = Math.fround(0.37391608953475952);
  const t = Math.fround(0.000079498306149616838);
  const A = losOutput([V, O, O, O], [1, 1, 1, 1], [a, 1, 1, 1]);
  const B = losOutput([V, V, O, O], [1, 1, 1, 1], [b, 1, 1, 1]);
  const C = losOutput([V, O, V, V], [1, 1, 1, 1], [t, 1, 1, 1]);
  const terrain = [[0, 0, 0, 0]];
  const obj: OptimizerObjective = "USEFUL_PROJECTION";
  const resp = (o: LosCellOutput) => asLOSResponse(o, 1, 4, 2);
  const score = (o: LosCellOutput) => scoreLosOutput(o, obj, policy);

  beforeEach(() => {
    useAnalysisStore.setState({ terrainKey: null, terrainTransitioning: false, history: [], losResult: null, activeSnapshot: null });
  });

  it("WP7A-1: the trio is order dependent: [A,B,C] → 4, [C,B,A] → 3 (both match mergeResults in that order)", () => {
    expect(evaluateUnion([A, B, C].map(score), obj, policy))
      .toBe(objectiveValueFromSummary(summaryOf(mergeResults([A, B, C].map(resp)), obj, policy, terrain)!, obj, policy));
    expect(evaluateUnion([C, B, A].map(score), obj, policy)).toBe(3);
    expect(objectiveValueFromSummary(summaryOf(mergeResults([C, B, A].map(resp)), obj, policy, terrain)!, obj, policy)).toBe(3);
  });

  it("WP7A-1: greedy with A fixed reports the value the real history union shows (3), with the app order", () => {
    const greedy = greedySelect(
      [{ score: score(B), x: 100, y: 0 }, { score: score(C), x: 200, y: 0 }],
      { k: 2, objective: obj, policy, minSeparationM: 0, fixed: [{ score: score(A), x: 0, y: 0 }] },
    );
    const entry = (o: LosCellOutput, selected: boolean): HistoryEntry => ({
      position: { x: 0, y: 0, z: 0 }, coveragePct: null, timestamp: "", result: resp(o), radarId: "r",
      selected, terrain_id: KEY.terrain_id, terrain_epoch: KEY.epoch,
    });
    // Each runAnalysis prepends its entry: after A (fixed), then B, then C the history is [C, B, A].
    useAnalysisStore.setState({ terrainKey: KEY, history: [entry(C, true), entry(B, true), entry(A, false)] });
    useAnalysisStore.getState().toggleHistoryEntrySelection(2);
    const app = objectiveValueFromSummary(summaryOf(useAnalysisStore.getState().losResult!, obj, policy, terrain)!, obj, policy);
    expect(app).toBe(3);
    expect(greedy.selected).toEqual([0, 1]);
    expect(greedy.value).toBe(app);
    expect(greedy.unionOrder).toEqual([
      { kind: "candidate", index: 1 },
      { kind: "candidate", index: 0 },
      { kind: "fixed", index: 0 },
    ]);
    expect(greedy.steps.map((step) => step.unionValue)).toEqual([2, 3]);
  });

  it("WP7A-1: prepending in UnionState equals evaluateUnion of the resulting order", () => {
    const union = new UnionState(obj, policy, 4);
    union.add(score(A));
    expect(union.gainOfPrepend(score(B))).toBe(1);
    union.prepend(score(B));
    union.prepend(score(C));
    expect(union.value).toBe(evaluateUnion([C, B, A].map(score), obj, policy));
  });
});

describe("WP7A-2: scores and summary readings are bound to their policy", () => {
  const out = losOutput([V, V], [0.5, 0.8], [0.5, 0.8]);
  const terrain = [[0, 0]];
  const strict = { mediumMin: 0.6, highMin: 0.9 };

  it("WP7A-2 (A-5): evaluateUnion rejects scores computed with another policy", () => {
    const scores = [scoreLosOutput(out, "USEFUL_INCIDENCE", strict)];
    expect(scores[0]!.policy).toEqual(strict);
    expect(() => evaluateUnion(scores, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY)).toThrow(RangeError);
    const union = new UnionState("USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY, 2);
    expect(() => union.gainOf(scores[0]!)).toThrow(RangeError);
  });

  it("WP7A-2 (A-3): objectiveValueFromSummary rejects a summary computed with another policy", () => {
    const fromOther = summaryOf(asLOSResponse(out, 1, 2, 2), "USEFUL_INCIDENCE", strict, terrain)!;
    expect(() => objectiveValueFromSummary(fromOther, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY)).toThrow(RangeError);
    expect(objectiveValueFromSummary(fromOther, "USEFUL_INCIDENCE", strict)).toBe(1);
  });
});

describe("WP7A-3: VISIBLE/NODATA disagreement between radars is rejected", () => {
  it("WP7A-3 (A-2): A = [NODATA, VISIBLE], B = [VISIBLE, VISIBLE] throws in every objective", () => {
    const A = losOutput([LOSCellState.NODATA, V]);
    const B = losOutput([V, V]);
    for (const obj of ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"] as const) {
      expect(() => evaluateUnion([A, B].map((o) => scoreLosOutput(o, obj, policy)), obj, policy)).toThrow(RangeError);
      expect(() => evaluateUnion([B, A].map((o) => scoreLosOutput(o, obj, policy)), obj, policy)).toThrow(RangeError);
      const union = new UnionState(obj, policy, 2);
      union.add(scoreLosOutput(A, obj, policy));
      expect(() => union.gainOf(scoreLosOutput(B, obj, policy))).toThrow(RangeError);
      expect(() => union.gainOfPrepend(scoreLosOutput(B, obj, policy))).toThrow(RangeError);
    }
    // Agreeing NODATA stays valid.
    expect(evaluateUnion([A, A].map((o) => scoreLosOutput(o, "VISIBLE_AREA", policy)), "VISIBLE_AREA", policy)).toBe(1);
  });
});

describe("WP7A-4: extended differential against mergeResults + computeQualitySummary", () => {
  const f = Math.fround;
  const POLICIES: QualityPolicy[] = [
    { mediumMin: 0, highMin: 0.5 }, DEFAULT_QUALITY_POLICY, { mediumMin: 0.7, highMin: 0.9 },
    { mediumMin: 0.999, highMin: 1 }, { mediumMin: 1e-7, highMin: 1e-6 },
  ];
  function edgeValue(random: () => number, edgePolicy: QualityPolicy): number {
    const thr = f(edgePolicy.mediumMin);
    const u32 = new Uint32Array(1);
    const f32 = new Float32Array(u32.buffer);
    const pick = random();
    if (pick < 0.08) return Number.NaN;
    if (pick < 0.12) return Number.POSITIVE_INFINITY;
    if (pick < 0.16) return Number.NEGATIVE_INFINITY;
    if (pick < 0.2) return -0;
    if (pick < 0.24) return 0;
    if (pick < 0.28) return 1;
    if (pick < 0.32) return f(1e-30 * random());
    if (pick < 0.6) { f32[0] = thr; u32[0] = u32[0]! + randomInt(random, -3, 3); return f32[0]!; }
    if (pick < 0.7) return -1; // non-visible sentinel, also on VISIBLE cells
    return f(random());
  }
  for (const objective of ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"] as const) {
    it(`WP7A-4 (A-4): ${objective}: 3000 instances, 1–8 radars, 1×N and N×1, random union order`, () => {
      const random = seededRandom(0xa11ce + objective.length);
      let compared = 0;
      let fiveOrMore = 0;
      for (let trial = 0; trial < 3000; trial++) {
        const trialPolicy = POLICIES[trial % POLICIES.length]!;
        const shape = trial % 3;
        const rows = shape === 0 ? 1 : randomInt(random, 1, 6);
        const cols = shape === 1 ? 1 : randomInt(random, 1, 6);
        const size = rows * cols;
        const terrain = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
        const nodata = new Set<number>();
        for (let i = 0; i < size; i++) if (random() < 0.1) { nodata.add(i); terrain[Math.floor(i / cols)]![i % cols] = Number.NaN; }
        const outputs: LosCellOutput[] = [];
        const n = randomInt(random, 1, 8);
        if (n >= 5) fiveOrMore++;
        for (let r = 0; r < n; r++) {
          const states = Array.from({ length: size }, (_, i) => nodata.has(i) ? 0 : [1, 2, 3, 4, 5, 5, 5][randomInt(random, 0, 6)]!);
          const q = Array.from({ length: size }, () => edgeValue(random, trialPolicy));
          const p = Array.from({ length: size }, () => edgeValue(random, trialPolicy));
          // v2 engine contract: VISIBLE index in [0,1], NaN or sentinel; the optimizer rejects >1 and negative projections.
          const qq = q.map((v) => (Number.isFinite(v) && v > 1 ? 1 : v));
          const pp = p.map((v) => (Number.isFinite(v) && (v < 0 || v > 1) ? Number.NaN : v));
          outputs.push(losOutput(states, qq, pp));
        }
        // Variable order: a seeded permutation, applied to both sides.
        const order = outputs.map((_, i) => i).sort(() => random() - 0.5);
        const ordered = order.map((i) => outputs[i]!);
        const scores = ordered.map((o) => scoreLosOutput(o, objective, trialPolicy));
        const summary = summaryOf(mergeResults(ordered.map((o) => asLOSResponse(o, rows, cols, 2))), objective, trialPolicy, terrain);
        expect(summary).not.toBeNull();
        expect(evaluateUnion(scores, objective, trialPolicy)).toBe(objectiveValueFromSummary(summary!, objective, trialPolicy));
        compared++;
      }
      expect(compared).toBe(3000);
      expect(fiveOrMore).toBeGreaterThan(0);
    });
  }
});
