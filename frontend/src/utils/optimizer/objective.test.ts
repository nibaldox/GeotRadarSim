import { describe, expect, it } from "vitest";
import { mergeResults } from "../../store/analysisStore";
import { LOSCellState } from "../../types/api";
import { DEFAULT_QUALITY_POLICY, computeQualitySummary } from "../qualityMetrics";
import type { QualityPolicy } from "../qualityMetrics";
import {
  UnionState,
  evaluateUnion,
  objectiveQualityMetric,
  objectiveValueFromSummary,
  scoreLosOutput,
} from "./objective";
import { asLOSResponse, losOutput, randomInt, seededRandom } from "./optimizer.testSupport";
import type { LosCellOutput, OptimizerObjective } from "./types";

const OBJECTIVES: readonly OptimizerObjective[] = ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"];
const NON_NODATA_STATES = [
  LOSCellState.OUT_OF_RANGE,
  LOSCellState.OUTSIDE_FOV,
  LOSCellState.UNKNOWN_RAY,
  LOSCellState.SHADOW,
  LOSCellState.VISIBLE,
  LOSCellState.VISIBLE,
];

/** Index values clustered around the Float32 threshold so boundary handling is exercised. */
function indexValue(random: () => number, policy: QualityPolicy): number {
  const pick = random();
  if (pick < 0.1) return Number.NaN;
  if (pick < 0.2) return policy.mediumMin;
  if (pick < 0.3) return Math.fround(policy.mediumMin);
  if (pick < 0.35) return 0;
  if (pick < 0.4) return 1;
  if (pick < 0.6) return Math.fround(policy.mediumMin + (random() - 0.5) * 1e-6);
  return random();
}

function randomInstance(random: () => number, rows: number, cols: number, radars: number, policy: QualityPolicy) {
  const size = rows * cols;
  const terrain = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const nodata = new Set<number>();
  for (let idx = 0; idx < size; idx++) {
    if (random() < 0.08) {
      nodata.add(idx);
      terrain[Math.floor(idx / cols)]![idx % cols] = Number.NaN;
    }
  }
  const outputs: LosCellOutput[] = [];
  for (let r = 0; r < radars; r++) {
    const states: number[] = [];
    const quality: number[] = [];
    const projection: number[] = [];
    for (let idx = 0; idx < size; idx++) {
      states.push(nodata.has(idx) ? LOSCellState.NODATA : NON_NODATA_STATES[randomInt(random, 0, 5)]!);
      quality.push(indexValue(random, policy));
      projection.push(indexValue(random, policy));
    }
    outputs.push(losOutput(states, quality, projection));
  }
  return { terrain, outputs, size };
}

function summaryValue(
  outputs: readonly LosCellOutput[],
  objective: OptimizerObjective,
  policy: QualityPolicy,
  terrain: number[][],
  resolution: number,
): number {
  const rows = terrain.length;
  const cols = terrain[0]!.length;
  const merged = mergeResults(outputs.map((output) => asLOSResponse(output, rows, cols, resolution)));
  const terrainKey = { terrain_id: "t", epoch: 1 };
  const summary = computeQualitySummary({
    metric: objectiveQualityMetric(objective),
    policy,
    losResult: merged,
    terrainGrid: terrain,
    terrainResolution: resolution,
    terrainKey,
    snapshot: { terrainKey, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] },
  });
  if (!summary) throw new Error("summary unexpectedly unavailable");
  return objectiveValueFromSummary(summary, objective, policy);
}

describe("objective ↔ computeQualitySummary coherence", () => {
  it("objectiveQualityMetric maps each objective to the summary metric", () => {
    expect(objectiveQualityMetric("VISIBLE_AREA")).toBe("INCIDENCE");
    expect(objectiveQualityMetric("USEFUL_INCIDENCE")).toBe("INCIDENCE");
    expect(objectiveQualityMetric("USEFUL_PROJECTION")).toBe("PROJECTION");
  });

  for (const objective of OBJECTIVES) {
    it(`${objective}: union value equals mergeResults + computeQualitySummary (seeded, 120 instances)`, () => {
      const random = seededRandom(0x5eed_0000 + OBJECTIVES.indexOf(objective));
      // f32(0.7) < 0.7 and f32(0.3) > 0.3: both rounding directions of the threshold are covered.
      const policies: QualityPolicy[] = [
        DEFAULT_QUALITY_POLICY,
        { mediumMin: 0.7, highMin: 0.9 },
        { mediumMin: 0.1, highMin: 0.2 },
        { mediumMin: 0.55, highMin: 0.9 },
      ];
      for (let trial = 0; trial < 120; trial++) {
        const policy = policies[trial % policies.length]!;
        const rows = randomInt(random, 2, 9);
        const cols = randomInt(random, 2, 9);
        const radarCount = randomInt(random, 1, 4);
        const { terrain, outputs } = randomInstance(random, rows, cols, radarCount, policy);
        const scores = outputs.map((output) => scoreLosOutput(output, objective, policy));
        const expected = summaryValue(outputs, objective, policy, terrain, 2);
        expect(evaluateUnion(scores, objective, policy)).toBe(expected);
        // Single result: the standalone value is the summary of that result alone.
        expect(scores[0]!.value).toBe(summaryValue([outputs[0]!], objective, policy, terrain, 2));
        // Incremental gains reproduce the left-to-right union order used by mergeResults.
        const union = new UnionState(objective, policy, rows * cols);
        let running = 0;
        for (const score of scores) {
          const gain = union.gainOf(score);
          union.add(score);
          running += gain;
          expect(union.value).toBe(running);
        }
        expect(union.value).toBe(expected);
      }
    });
  }
});

describe("scoreLosOutput", () => {
  it("compares the index with mediumMin in Float32, like classifyQualityValue", () => {
    const policy = { mediumMin: 0.3, highMin: 0.7 };
    // 0.3 is stored as f32(0.3) > 0.3; anything below f32(0.3) after rounding is low.
    const below = 0.3 - 1e-7;
    const output = losOutput([5, 5, 5, 4], [0.3, Math.fround(0.3), below, 1]);
    const score = scoreLosOutput(output, "USEFUL_INCIDENCE", policy);
    expect(score.value).toBe(2);
    expect(scoreLosOutput(output, "VISIBLE_AREA", policy).value).toBe(3);
    // f32(0.7) = 0.69999998…: useful under mediumMin 0.7 in Float32, though below 0.7 in double.
    const high = { mediumMin: 0.7, highMin: 0.9 };
    expect(Math.fround(0.7)).toBeLessThan(0.7);
    expect(scoreLosOutput(losOutput([5], [0.7]), "USEFUL_INCIDENCE", high).value).toBe(1);
    expect(scoreLosOutput(losOutput([5], [1], [0.7]), "USEFUL_PROJECTION", high).value).toBe(1);
  });

  it("does not count VISIBLE cells without an index, nor non-VISIBLE cells", () => {
    const output = losOutput([5, 5, 3, 0], [Number.NaN, 0.9, 0.9, 0.9], [Number.NaN, 0.9, 0.9, 0.9]);
    expect(scoreLosOutput(output, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY).value).toBe(1);
    expect(scoreLosOutput(output, "USEFUL_PROJECTION", DEFAULT_QUALITY_POLICY).value).toBe(1);
    expect(scoreLosOutput(output, "VISIBLE_AREA", DEFAULT_QUALITY_POLICY).value).toBe(2);
  });

  it("rejects malformed inputs instead of guessing", () => {
    const good = losOutput([5, 4], [0.5, -1]);
    expect(() => scoreLosOutput(good, "USEFUL_INCIDENCE", { mediumMin: 0.7, highMin: 0.3 })).toThrow(RangeError);
    expect(() => scoreLosOutput({ ...good, cell_states: Uint8Array.from([5, 9]) }, "VISIBLE_AREA", DEFAULT_QUALITY_POLICY))
      .toThrow(RangeError);
    expect(() => scoreLosOutput({ ...good, flat_quality_grid: new Float32Array(3) }, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY))
      .toThrow(RangeError);
    // geometric-v2 indices live in [0, 1]; a VISIBLE value above 1 is a contract violation.
    expect(() => scoreLosOutput(losOutput([5], [1.5]), "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY)).toThrow(RangeError);
    expect(() => scoreLosOutput(losOutput([5], [0.5], [-0.5]), "USEFUL_PROJECTION", DEFAULT_QUALITY_POLICY))
      .toThrow(RangeError);
  });

  it("refuses to mix scores of different objectives or grid sizes", () => {
    const policy = DEFAULT_QUALITY_POLICY;
    const visible = scoreLosOutput(losOutput([5, 5]), "VISIBLE_AREA", policy);
    const useful = scoreLosOutput(losOutput([5, 5]), "USEFUL_INCIDENCE", policy);
    const small = scoreLosOutput(losOutput([5]), "VISIBLE_AREA", policy);
    expect(() => evaluateUnion([visible, useful], "VISIBLE_AREA", policy)).toThrow(RangeError);
    expect(() => evaluateUnion([visible, small], "VISIBLE_AREA", policy)).toThrow(RangeError);
    expect(evaluateUnion([], "VISIBLE_AREA", policy)).toBe(0);
  });
});

describe("USEFUL_PROJECTION is not monotone", () => {
  it("adding a low-projection radar can lower the union below the threshold (RMS)", () => {
    const policy = DEFAULT_QUALITY_POLICY; // mediumMin 0.3
    const strong = scoreLosOutput(losOutput([5, 5, 4], [1, 1, -1], [0.35, 0.35, Number.NaN]), "USEFUL_PROJECTION", policy);
    const weak = scoreLosOutput(losOutput([5, 5, 5], [1, 1, 1], [0.05, 0.05, 0.31]), "USEFUL_PROJECTION", policy);
    expect(evaluateUnion([strong], "USEFUL_PROJECTION", policy)).toBe(2);
    // RMS(0.35, 0.05) = 0.25 < 0.3 on both shared cells; the new cell adds 1.
    expect(evaluateUnion([strong, weak], "USEFUL_PROJECTION", policy)).toBe(1);
    const union = new UnionState("USEFUL_PROJECTION", policy, 3);
    union.add(strong);
    expect(union.gainOf(weak)).toBe(-1);
  });
});
