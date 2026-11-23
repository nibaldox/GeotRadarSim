/**
 * R1C-WP7-2 (LOW): the app keeps 10 history entries (`analysisStore.ts` L630), so a union of
 * fixed + k > 10 radars cannot be shown. Reviewer probe P6 (`r1close.union.probe.test.ts`):
 * 8 fixed + k = 4 gave greedy 12 against 10 in the app. The optimizer now rejects it up front,
 * before any LOS evaluation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import { MAX_UNION_RADARS, assertGreedyArguments, greedySelect } from "./greedy";
import type { GreedyCandidateInput } from "./greedy";
import { scoreLosOutput } from "./objective";
import { optimizeCoarse } from "./optimize";
import { flatTerrain, visibleOn } from "./optimizer.testSupport";
import type { OptimizerGrid, RadarPosition } from "./types";

const policy = DEFAULT_QUALITY_POLICY;

function entry(cell: number, x: number): GreedyCandidateInput {
  return { score: scoreLosOutput(visibleOn(4, [cell]), "VISIBLE_AREA", policy), x, y: 0 };
}
function fixedRadars(count: number): GreedyCandidateInput[] {
  return Array.from({ length: count }, (_, i) => entry(i % 4, -1000 - i * 100));
}
const candidates = [entry(0, 100), entry(1, 200), entry(2, 300)];

describe("R1C-WP7-2: fixed radars + k must fit in the app history (10 entries)", () => {
  it("R1C-WP7-2: the union limit is 10", () => {
    expect(MAX_UNION_RADARS).toBe(10);
  });

  it("R1C-WP7-2: greedySelect rejects 8 fixed + k = 4 (reviewer P6: the app shows 10, greedy would report 12)", () => {
    expect(() => greedySelect(candidates, {
      k: 4, objective: "VISIBLE_AREA", policy, minSeparationM: 0, fixed: fixedRadars(8),
    })).toThrow(RangeError);
  });

  it("R1C-WP7-2: the error names the fixed count, k and the limit", () => {
    expect(() => greedySelect(candidates, {
      k: 2, objective: "VISIBLE_AREA", policy, minSeparationM: 0, fixed: fixedRadars(9),
    })).toThrow("Fixed radars (9) + k (2) must be at most 10: the app history keeps 10 entries, so the union would be truncated");
  });

  it("R1C-WP7-2: exactly 10 in the union is accepted (9 fixed + k = 1, and 4 fixed + k = 6)", () => {
    expect(() => greedySelect(candidates, {
      k: 1, objective: "VISIBLE_AREA", policy, minSeparationM: 0, fixed: fixedRadars(9),
    })).not.toThrow();
    expect(() => greedySelect(candidates, {
      k: 3, objective: "VISIBLE_AREA", policy, minSeparationM: 0, fixed: fixedRadars(4),
    })).not.toThrow();
  });

  it("R1C-WP7-2: assertGreedyArguments applies the limit, with maxUnion overriding the default", () => {
    const base = { objective: "VISIBLE_AREA" as const, policy, minSeparationM: 0 };
    expect(() => assertGreedyArguments({ ...base, k: 1, fixed: fixedRadars(9) })).not.toThrow();
    expect(() => assertGreedyArguments({ ...base, k: 2, fixed: fixedRadars(9) })).toThrow(RangeError);
    expect(() => assertGreedyArguments({ ...base, k: 2, fixed: fixedRadars(2), maxUnion: 4 })).not.toThrow();
    expect(() => assertGreedyArguments({ ...base, k: 3, fixed: fixedRadars(2), maxUnion: 4 })).toThrow(RangeError);
    expect(() => assertGreedyArguments({ ...base, k: 1, maxUnion: 0 })).toThrow(RangeError);
    expect(() => assertGreedyArguments({ ...base, k: 1, maxUnion: 2.5 })).toThrow(RangeError);
  });

  describe("optimizeCoarse", () => {
    const source: OptimizerGrid = { grid: flatTerrain(40, 60, 0), bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    const fixedPositions = (count: number): RadarPosition[] =>
      Array.from({ length: count }, (_, i) => ({ x: -100 - i * 10, y: 0, z: 0 }));

    const cellsOf = (grid: OptimizerGrid) => grid.grid.length * grid.grid[0]!.length;

    it("R1C-WP7-2: 10 fixed + k = 1 throws RangeError before any LOS call", () => {
      let calls = 0;
      expect(() => optimizeCoarse({
        source, policy, k: 1, candidateSet: "regular_grid", fixed: fixedPositions(10),
        los: (req) => { calls++; return visibleOn(cellsOf(req.grid), [0]); },
      })).toThrow(RangeError);
      expect(calls).toBe(0);
    });

    it("R1C-WP7-2: 9 fixed + k = 1 (the limit exactly) is accepted", () => {
      const result = optimizeCoarse({
        source, policy, k: 1, candidateSet: "regular_grid", fixed: fixedPositions(9),
        los: (req) => visibleOn(cellsOf(req.grid), [0]),
      });
      expect(result.status).toBe("OK");
    });
  });
});
