import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import { greedySelect } from "./greedy";
import type { GreedyCandidateInput } from "./greedy";
import { evaluateUnion, scoreLosOutput } from "./objective";
import { losOutput, randomInt, seededRandom, visibleOn } from "./optimizer.testSupport";
import type { OptimizerObjective } from "./types";

const policy = DEFAULT_QUALITY_POLICY;

function setCandidates(size: number, sets: readonly (readonly number[])[], objective: OptimizerObjective = "VISIBLE_AREA"):
  GreedyCandidateInput[] {
  return sets.map((cells, index) => ({ score: scoreLosOutput(visibleOn(size, cells), objective, policy), x: index * 1000, y: 0 }));
}

/** Exhaustive optimum over every feasible subset of size ≤ k (N ≤ 12). */
function bruteForce(
  candidates: readonly GreedyCandidateInput[],
  k: number,
  objective: OptimizerObjective,
  minSeparationM = 0,
  fixed: readonly GreedyCandidateInput[] = [],
): { value: number; best: number[] } {
  let bestValue = -Infinity;
  let best: number[] = [];
  const n = candidates.length;
  const tooClose = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < minSeparationM ** 2;
  for (let mask = 0; mask < 1 << n; mask++) {
    const chosen: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) chosen.push(i);
    if (chosen.length > k) continue;
    const members = chosen.map((i) => candidates[i]!);
    const feasible = members.every((a, i) => members.every((b, j) => i === j || !tooClose(a, b))) &&
      members.every((a) => fixed.every((f) => !tooClose(a, f)));
    if (!feasible) continue;
    const value = evaluateUnion([...fixed, ...members].map((c) => c.score), objective, policy);
    if (value > bestValue) {
      bestValue = value;
      best = chosen;
    }
  }
  return { value: bestValue, best };
}

describe("greedySelect: known optimum (P2)", () => {
  it("matches brute force exactly on disjoint sets (greedy is optimal there)", () => {
    const candidates = setCandidates(20, [[0, 1], [2, 3, 4, 5, 6], [7], [8, 9, 10], [11, 12, 13, 14]]);
    for (const k of [1, 2, 3]) {
      const greedy = greedySelect(candidates, { k, objective: "VISIBLE_AREA", policy });
      const brute = bruteForce(candidates, k, "VISIBLE_AREA");
      expect(greedy.value).toBe(brute.value);
      expect([...greedy.selected].sort((a, b) => a - b)).toEqual(brute.best);
    }
  });

  it("matches brute force exactly on nested sets", () => {
    const candidates = setCandidates(10, [[0], [0, 1, 2], [0, 1, 2, 3, 4, 5], [6, 7]]);
    const greedy = greedySelect(candidates, { k: 2, objective: "VISIBLE_AREA", policy });
    expect(greedy.selected).toEqual([2, 3]);
    expect(greedy.value).toBe(bruteForce(candidates, 2, "VISIBLE_AREA").value);
  });

  it("can be suboptimal on the classic instance, yet stays above (1 − 1/e)·OPT", () => {
    // A takes half of B and half of C: greedy picks A then one of B/C (5), OPT is B ∪ C (6).
    const candidates = setCandidates(6, [[0, 1, 3, 4], [0, 1, 2], [3, 4, 5]]);
    const greedy = greedySelect(candidates, { k: 2, objective: "VISIBLE_AREA", policy });
    const brute = bruteForce(candidates, 2, "VISIBLE_AREA");
    expect(greedy.selected).toEqual([0, 1]);
    expect(greedy.value).toBe(5);
    expect(brute).toEqual({ value: 6, best: [1, 2] });
    expect(greedy.value).toBeGreaterThanOrEqual((1 - 1 / Math.E) * brute.value);
    expect(greedy.guarantee).toBe("1-1/e");
  });

  for (const objective of ["VISIBLE_AREA", "USEFUL_INCIDENCE"] as const) {
    it(`${objective}: ≥ (1 − 1/e)·OPT on 200 seeded random instances without separation; k = 1 is exact`, () => {
      const random = seededRandom(20261122 + (objective === "VISIBLE_AREA" ? 0 : 1));
      let suboptimal = 0;
      for (let trial = 0; trial < 200; trial++) {
        const n = randomInt(random, 2, 12);
        const k = randomInt(random, 1, 3);
        const size = randomInt(random, 16, 96);
        const density = 0.05 + random() * 0.4;
        const candidates: GreedyCandidateInput[] = [];
        for (let i = 0; i < n; i++) {
          const states: number[] = [];
          const quality: number[] = [];
          for (let cell = 0; cell < size; cell++) {
            states.push(random() < density ? 5 : 4);
            quality.push(random());
          }
          candidates.push({ score: scoreLosOutput(losOutput(states, quality), objective, policy), x: i, y: 0 });
        }
        const greedy = greedySelect(candidates, { k, objective, policy });
        const brute = bruteForce(candidates, k, objective);
        expect(greedy.value).toBe(evaluateUnion(greedy.selected.map((i) => candidates[i]!.score), objective, policy));
        expect(greedy.value).toBeLessThanOrEqual(brute.value);
        expect(greedy.value).toBeGreaterThanOrEqual((1 - 1 / Math.E) * brute.value);
        if (k === 1) expect(greedy.value).toBe(brute.value);
        if (greedy.value < brute.value) suboptimal++;
      }
      // With this seed some instances are strictly suboptimal (13 and 5 observed), so the
      // bound is exercised rather than trivially met by always-optimal fixtures.
      expect(suboptimal).toBeGreaterThan(0);
    });
  }
});

describe("greedySelect: rules", () => {
  it("breaks equal gains by the lower candidate index", () => {
    const candidates = setCandidates(8, [[4, 5], [0, 1], [2, 3], [6, 7]]);
    const greedy = greedySelect(candidates, { k: 4, objective: "VISIBLE_AREA", policy });
    expect(greedy.selected).toEqual([0, 1, 2, 3]);
    expect(greedy.steps[0]!.top).toEqual([{ index: 0, gain: 2 }, { index: 1, gain: 2 }, { index: 2, gain: 2 }]);
  });

  it("excludes candidates closer than min_separation_m to a chosen one and reports a heuristic", () => {
    const candidates: GreedyCandidateInput[] = [
      { score: scoreLosOutput(visibleOn(10, [0, 1, 2, 3, 4]), "VISIBLE_AREA", policy), x: 0, y: 0 },
      { score: scoreLosOutput(visibleOn(10, [5, 6, 7, 8]), "VISIBLE_AREA", policy), x: 30, y: 40 }, // 50 m away
      { score: scoreLosOutput(visibleOn(10, [5, 6, 7]), "VISIBLE_AREA", policy), x: 200, y: 0 },
    ];
    const strict = greedySelect(candidates, { k: 2, objective: "VISIBLE_AREA", policy, minSeparationM: 50.0001 });
    expect(strict.selected).toEqual([0, 2]);
    expect(strict.guarantee).toBe("heuristic");
    expect(strict.value).toBe(bruteForce(candidates, 2, "VISIBLE_AREA", 50.0001).value);
    // Exactly at the separation distance is allowed.
    const exact = greedySelect(candidates, { k: 2, objective: "VISIBLE_AREA", policy, minSeparationM: 50 });
    expect(exact.selected).toEqual([0, 1]);
  });

  it("counts fixed radars in the base value and keeps candidates away from them", () => {
    const fixed: GreedyCandidateInput[] = [
      { score: scoreLosOutput(visibleOn(10, [0, 1, 2, 3]), "VISIBLE_AREA", policy), x: 0, y: 0 },
    ];
    const candidates: GreedyCandidateInput[] = [
      { score: scoreLosOutput(visibleOn(10, [0, 1, 2, 3, 4]), "VISIBLE_AREA", policy), x: 500, y: 0 }, // +1
      { score: scoreLosOutput(visibleOn(10, [6, 7, 8]), "VISIBLE_AREA", policy), x: 10, y: 0 }, // +3 but too close
      { score: scoreLosOutput(visibleOn(10, [5, 6]), "VISIBLE_AREA", policy), x: 900, y: 0 }, // +2
    ];
    const greedy = greedySelect(candidates, { k: 1, objective: "VISIBLE_AREA", policy, fixed, minSeparationM: 50 });
    expect(greedy.baseValue).toBe(4);
    expect(greedy.selected).toEqual([2]);
    expect(greedy.steps[0]!.marginalGain).toBe(2);
    expect(greedy.value).toBe(6);
    expect(greedy.value).toBe(bruteForce(candidates, 1, "VISIBLE_AREA", 50, fixed).value);
    const free = greedySelect(candidates, { k: 1, objective: "VISIBLE_AREA", policy, fixed });
    expect(free.selected).toEqual([1]);
  });

  it("stops early with NO_IMPROVEMENT or NO_FEASIBLE_CANDIDATE", () => {
    const candidates = setCandidates(6, [[0, 1, 2], [0, 1], [2]]);
    const greedy = greedySelect(candidates, { k: 3, objective: "VISIBLE_AREA", policy });
    expect(greedy.selected).toEqual([0]);
    expect(greedy.stopReason).toBe("NO_IMPROVEMENT");
    const crowded = setCandidates(6, [[0], [1], [2]]).map((c) => ({ ...c, x: 0 }));
    const blocked = greedySelect(crowded, { k: 3, objective: "VISIBLE_AREA", policy, minSeparationM: 1 });
    expect(blocked.selected).toEqual([0]);
    expect(blocked.stopReason).toBe("NO_FEASIBLE_CANDIDATE");
    const full = greedySelect(setCandidates(6, [[0], [1]]), { k: 2, objective: "VISIBLE_AREA", policy });
    expect(full.stopReason).toBe("K_REACHED");
  });

  it("USEFUL_PROJECTION: evaluates the exact RMS objective, stops before k, guarantee none", () => {
    const objective = "USEFUL_PROJECTION";
    const make = (states: number[], projection: number[], x: number): GreedyCandidateInput =>
      ({ score: scoreLosOutput(losOutput(states, undefined, projection), objective, policy), x, y: 0 });
    const candidates = [
      make([5, 5, 5, 5, 4, 4], [0.35, 0.35, 0.35, 0.35, 0, 0], 0), // 4 useful
      make([5, 5, 5, 5, 5, 4], [0.05, 0.05, 0.05, 0.05, 0.31, 0], 100), // 1 new, drags 4 below 0.3
      make([5, 5, 4, 4, 4, 5], [0.04, 0.04, 0, 0, 0, 0.32], 200), // 1 new, drags 2 below
    ];
    const greedy = greedySelect(candidates, { k: 3, objective, policy });
    expect(greedy.selected).toEqual([0]);
    expect(greedy.value).toBe(4);
    expect(greedy.stopReason).toBe("NO_IMPROVEMENT");
    expect(greedy.guarantee).toBe("none");
    expect(greedy.steps[0]!.top.map((t) => t.index)).toEqual([0, 1, 2]);
    // The rejected additions really lower the objective (non-monotone).
    expect(evaluateUnion([candidates[0]!.score, candidates[1]!.score], objective, policy)).toBe(1);
    expect(evaluateUnion([candidates[0]!.score, candidates[2]!.score], objective, policy)).toBe(3);
  });

  it("keeps a shortlist of the top gains per step, unique, chosen first, at most shortlistPerStep·k", () => {
    const candidates = setCandidates(12, [[0, 1, 2, 3], [0, 1, 2], [4, 5, 6], [7, 8], [9], [4, 5]]);
    const greedy = greedySelect(candidates, { k: 2, objective: "VISIBLE_AREA", policy });
    expect(greedy.selected).toEqual([0, 2]);
    expect(greedy.steps[0]!.top).toEqual([{ index: 0, gain: 4 }, { index: 1, gain: 3 }, { index: 2, gain: 3 }]);
    expect(greedy.steps[1]!.top).toEqual([{ index: 2, gain: 3 }, { index: 3, gain: 2 }, { index: 5, gain: 2 }]);
    expect(greedy.shortlist).toEqual([0, 2, 1, 3, 5]);
    const narrow = greedySelect(candidates, { k: 2, objective: "VISIBLE_AREA", policy, shortlistPerStep: 1 });
    expect(narrow.shortlist).toEqual([0, 2]);
  });

  it("is deterministic and leaves its inputs untouched", () => {
    const random = seededRandom(7);
    const candidates: GreedyCandidateInput[] = [];
    for (let i = 0; i < 12; i++) {
      const cells = Array.from({ length: 64 }, (_, c) => c).filter(() => random() < 0.3);
      candidates.push({ score: scoreLosOutput(visibleOn(64, cells), "USEFUL_INCIDENCE", policy), x: i * 7, y: (i % 3) * 11 });
    }
    const masks = candidates.map((c) => Array.from(c.score.mask));
    const options = { k: 3, objective: "USEFUL_INCIDENCE" as const, policy, minSeparationM: 10 };
    const first = greedySelect(candidates, options);
    const second = greedySelect(candidates, options);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(candidates.map((c) => Array.from(c.score.mask))).toEqual(masks);
  });

  it("validates k, separation, shortlist and score consistency", () => {
    const candidates = setCandidates(4, [[0], [1]]);
    expect(() => greedySelect(candidates, { k: 0, objective: "VISIBLE_AREA", policy })).toThrow(RangeError);
    expect(() => greedySelect(candidates, { k: 1.5, objective: "VISIBLE_AREA", policy })).toThrow(RangeError);
    expect(() => greedySelect(candidates, { k: 1, objective: "VISIBLE_AREA", policy, minSeparationM: -1 })).toThrow(RangeError);
    expect(() => greedySelect(candidates, { k: 1, objective: "VISIBLE_AREA", policy, shortlistPerStep: 0 })).toThrow(RangeError);
    expect(() => greedySelect(candidates, { k: 1, objective: "USEFUL_INCIDENCE", policy })).toThrow(RangeError);
    expect(() => greedySelect([{ ...candidates[0]!, x: Number.NaN }], { k: 1, objective: "VISIBLE_AREA", policy }))
      .toThrow(RangeError);
    const empty = greedySelect([], { k: 2, objective: "VISIBLE_AREA", policy });
    expect(empty.selected).toEqual([]);
    expect(empty.stopReason).toBe("NO_FEASIBLE_CANDIDATE");
  });
});
