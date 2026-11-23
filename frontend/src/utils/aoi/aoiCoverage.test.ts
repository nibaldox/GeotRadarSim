import { describe, expect, it } from "vitest";
import { mergeResults } from "../../store/analysisStore";
import { LOSCellState } from "../../types/api";
import type { LOSResponse } from "../../types/api";
import { DEFAULT_QUALITY_POLICY, computeQualitySummary } from "../qualityMetrics";
import type { QualityPolicy } from "../qualityMetrics";
import { objectiveQualityMetric, objectiveValueFromAoiCoverage, objectiveValueFromSummary } from "../optimizer/objective";
import { asLOSResponse, randomInt, seededRandom } from "../optimizer/optimizer.testSupport";
import type { LosCellOutput, OptimizerObjective } from "../optimizer/types";
import { aoiPercent, computeAoiCoverage } from "./aoiCoverage";
import { aoiMaskForGrid } from "./aoiMask";

const OBJECTIVES: readonly OptimizerObjective[] = ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"];

/** Values that sit on, just below and just above the Float32 thresholds, plus sentinels. */
function edgyValue(random: () => number, policy: QualityPolicy): number {
  const roll = random();
  const near = random() < 0.5 ? policy.mediumMin : policy.highMin;
  if (roll < 0.1) return near;
  if (roll < 0.2) return Math.fround(near);
  if (roll < 0.25) return Math.fround(near) - 2 ** -26;
  if (roll < 0.3) return Math.fround(near) + 2 ** -26;
  if (roll < 0.35) return Number.NaN;
  if (roll < 0.38) return -1;
  if (roll < 0.4) return 0;
  if (roll < 0.42) return 1;
  return random();
}

function randomPolicy(random: () => number): QualityPolicy {
  if (random() < 0.4) return DEFAULT_QUALITY_POLICY;
  const mediumMin = Math.round(random() * 600) / 1000;
  return { mediumMin, highMin: mediumMin + 0.05 + Math.round(random() * 300) / 1000 };
}

function randomTerrain(random: () => number, rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => (random() < 0.12 ? Number.NaN : random() * 50)));
}

function randomOutput(random: () => number, terrain: number[][], policy: QualityPolicy): LosCellOutput {
  const rows = terrain.length;
  const cols = terrain[0]!.length;
  const size = rows * cols;
  const cell_states = new Uint8Array(size);
  const flat_quality_grid = new Float32Array(size).fill(-1);
  const flat_projection_grid = new Float32Array(size).fill(Number.NaN);
  for (let idx = 0; idx < size; idx++) {
    if (!Number.isFinite(terrain[Math.floor(idx / cols)]![idx % cols]!)) {
      cell_states[idx] = LOSCellState.NODATA;
      continue;
    }
    const roll = random();
    if (roll < 0.55) {
      cell_states[idx] = LOSCellState.VISIBLE;
      flat_quality_grid[idx] = edgyValue(random, policy);
      flat_projection_grid[idx] = edgyValue(random, policy);
    } else if (roll < 0.7) cell_states[idx] = LOSCellState.SHADOW;
    else if (roll < 0.8) cell_states[idx] = LOSCellState.OUTSIDE_FOV;
    else if (roll < 0.9) cell_states[idx] = LOSCellState.UNKNOWN_RAY;
    else cell_states[idx] = LOSCellState.OUT_OF_RANGE;
  }
  return { cell_states, flat_quality_grid, flat_projection_grid };
}

const key = { terrain_id: "dtm-test", epoch: 7 };
const snapshot = { terrainKey: key, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] };
/** R14 WP14-4/WP14-5: the context is required (metric, terrain and terrain key, like the summary). */
const ctx = (metric: "INCIDENCE" | "PROJECTION", terrainGrid: number[][], terrainResolution: number) =>
  ({ metric, terrainGrid, terrainResolution, terrainKey: key, snapshot });

describe("computeAoiCoverage parity with computeQualitySummary (whole valid terrain as the AOI)", () => {
  it("gives exactly the summary's counts and percentages: 500 instances × 3 objectives, singles and unions", () => {
    const random = seededRandom(20261122);
    let compared = 0;
    let unions = 0;
    for (let instance = 0; instance < 500; instance++) {
      const rows = randomInt(random, 2, 14);
      const cols = randomInt(random, 2, 14);
      const resolution = [0.5, 1, 2, 3.3][instance % 4]!;
      const terrain = randomTerrain(random, rows, cols);
      if (!terrain.some((row) => row.some(Number.isFinite))) terrain[0]![0] = 1;
      const policy = randomPolicy(random);
      const radarCount = randomInt(random, 1, 3);
      const outputs = Array.from({ length: radarCount }, () => randomOutput(random, terrain, policy));
      // The app's union, in its order (history newest first): mergeResults over that list.
      const result: LOSResponse = mergeResults(outputs.map((output) => asLOSResponse(output, rows, cols, resolution)));
      if (radarCount > 1) unions++;
      // Polygon enclosing the whole node extent: the mask must be every finite node.
      const min_x = -37.5;
      const min_y = 12.25;
      const pad = resolution / 2;
      const mask = aoiMaskForGrid({ grid: terrain, bounds: { min_x, min_y }, resolution }, {
        vertices: [
          { x: min_x - pad, y: min_y - pad },
          { x: min_x + (cols - 1) * resolution + pad, y: min_y - pad },
          { x: min_x + (cols - 1) * resolution + pad, y: min_y + (rows - 1) * resolution + pad },
          { x: min_x - pad, y: min_y + (rows - 1) * resolution + pad },
        ],
      });
      for (let idx = 0; idx < mask.length; idx++) {
        expect(mask[idx]).toBe(Number.isFinite(terrain[Math.floor(idx / cols)]![idx % cols]!) ? 1 : 0);
      }
      for (const objective of OBJECTIVES) {
        const metric = objectiveQualityMetric(objective);
        const summary = computeQualitySummary({
          metric, policy, losResult: result, terrainGrid: terrain, terrainResolution: resolution, terrainKey: key, snapshot,
        });
        const coverage = computeAoiCoverage(result, mask, policy, ctx(metric, terrain, resolution));
        expect(summary).not.toBeNull();
        expect(coverage).not.toBeNull();
        const s = summary!;
        const a = coverage!;
        expect(a.metric).toBe(s.metric);
        expect(a.qualityModel).toBe(s.qualityModel);
        expect(a.policy).toEqual(s.policy);
        expect(Object.is(a.aoiCellCount, s.target.cellCount)).toBe(true);
        expect(Object.is(a.aoiAreaM2, s.target.nominalAreaM2)).toBe(true);
        expect(Object.is(a.usefulCount, s.usefulCount)).toBe(true);
        expect(Object.is(a.usefulPct, s.usefulCoveragePct)).toBe(true);
        expect(Object.is(a.usefulAreaM2, s.usefulAreaM2)).toBe(true);
        expect(Object.is(a.visibleCount, s.visibleCount)).toBe(true);
        expect(Object.is(a.mediumHighAmongVisiblePct, s.mediumHighAmongVisiblePct)).toBe(true);
        expect(a.distribution).toEqual(s.distribution);
        if (s.distribution) {
          for (const field of Object.keys(s.distribution) as Array<keyof typeof s.distribution>) {
            expect(Object.is(a.distribution![field], s.distribution[field])).toBe(true);
          }
        }
        expect(objectiveValueFromAoiCoverage(a, objective, policy)).toBe(objectiveValueFromSummary(s, objective, policy));
        compared++;
      }
    }
    expect(compared).toBe(1500);
    expect(unions).toBeGreaterThan(200);
  });
});

describe("computeAoiCoverage inside a partial AOI", () => {
  it("counts only AOI cells with the summary's band rule, and the AOI cells are the denominator", () => {
    const random = seededRandom(77);
    for (let instance = 0; instance < 200; instance++) {
      const rows = randomInt(random, 2, 10);
      const cols = randomInt(random, 2, 10);
      const terrain = randomTerrain(random, rows, cols);
      const policy = randomPolicy(random);
      const output = randomOutput(random, terrain, policy);
      const result = asLOSResponse(output, rows, cols, 2);
      const mask = new Uint8Array(rows * cols);
      for (let idx = 0; idx < mask.length; idx++) {
        if (Number.isFinite(terrain[Math.floor(idx / cols)]![idx % cols]!) && random() < 0.5) mask[idx] = 1;
      }
      let cells = 0;
      let visible = 0;
      let useful = 0;
      for (let idx = 0; idx < mask.length; idx++) {
        if (mask[idx] !== 1) continue;
        cells++;
        if (output.cell_states[idx] !== LOSCellState.VISIBLE) continue;
        visible++;
        const q = output.flat_quality_grid[idx]!;
        if (Number.isFinite(q) && q >= 0 && q <= 1 && Math.fround(q) >= Math.fround(policy.mediumMin)) useful++;
      }
      const coverage = computeAoiCoverage(result, mask, policy, ctx("INCIDENCE", terrain, 2))!;
      expect(coverage.metric).toBe("INCIDENCE");
      expect(coverage.aoiCellCount).toBe(cells);
      expect(coverage.visibleCount).toBe(visible);
      expect(coverage.usefulCount).toBe(useful);
      expect(Object.is(coverage.usefulPct, aoiPercent(useful, cells))).toBe(true);
      expect(Object.is(coverage.visiblePct, aoiPercent(visible, cells))).toBe(true);
      expect(coverage.aoiAreaM2).toBe(cells * 4);
    }
  });

  it("returns null instead of a number for incoherent input", () => {
    const terrain = [[1, 1], [1, 1]];
    const output = randomOutput(seededRandom(3), terrain, DEFAULT_QUALITY_POLICY);
    const result = asLOSResponse(output, 2, 2, 1);
    const mask = Uint8Array.from([1, 1, 0, 1]);
    const c = ctx("INCIDENCE", terrain, 1);
    expect(computeAoiCoverage(result, mask, DEFAULT_QUALITY_POLICY, c)).not.toBeNull();
    expect(computeAoiCoverage(result, Uint8Array.from([1, 1, 0]), DEFAULT_QUALITY_POLICY, c)).toBeNull();
    expect(computeAoiCoverage(result, Uint8Array.from([1, 2, 0, 1]), DEFAULT_QUALITY_POLICY, c)).toBeNull();
    expect(computeAoiCoverage(result, [1, 1, 0, 1] as never, DEFAULT_QUALITY_POLICY, c)).toBeNull();
    expect(computeAoiCoverage(result, mask, { mediumMin: 0.7, highMin: 0.3 }, c)).toBeNull();
    expect(computeAoiCoverage({ ...result, quality_model: undefined }, mask, DEFAULT_QUALITY_POLICY, c)).toBeNull();
    expect(computeAoiCoverage({ ...result, flat_projection_grid: undefined }, mask, DEFAULT_QUALITY_POLICY, ctx("PROJECTION", terrain, 1))).toBeNull();
    expect(computeAoiCoverage(result, mask, DEFAULT_QUALITY_POLICY, { ...c, metric: "OTHER" as never })).toBeNull();
    const nodataInAoi = Uint8Array.from(result.cell_states);
    nodataInAoi[1] = LOSCellState.NODATA;
    expect(computeAoiCoverage({ ...result, cell_states: nodataInAoi }, mask, DEFAULT_QUALITY_POLICY, c)).toBeNull();
    // R14 WP14-5: a finite node marked NODATA is incoherent for the summary too, even outside the AOI.
    const nodataOutside = Uint8Array.from(result.cell_states);
    nodataOutside[2] = LOSCellState.NODATA;
    expect(computeAoiCoverage({ ...result, cell_states: nodataOutside }, mask, DEFAULT_QUALITY_POLICY, c)).toBeNull();
    const unknown = Uint8Array.from(result.cell_states);
    unknown[2] = 250;
    expect(computeAoiCoverage({ ...result, cell_states: unknown }, mask, DEFAULT_QUALITY_POLICY, c)).toBeNull();
  });

  it("reads whatever union order it is given, exactly like the summary (it never re-merges)", () => {
    const random = seededRandom(99);
    const rows = 1;
    const cols = 400;
    const terrain = [new Array<number>(cols).fill(0)];
    const policy = { mediumMin: 0.3, highMin: 0.7 };
    const make = (values: number[]): LOSResponse => {
      const states = new Uint8Array(cols).fill(LOSCellState.VISIBLE);
      const output: LosCellOutput = {
        cell_states: states,
        flat_quality_grid: new Float32Array(cols).fill(0.5),
        flat_projection_grid: Float32Array.from(values),
      };
      return asLOSResponse(output, rows, cols, 1);
    };
    const a = make(Array.from({ length: cols }, () => random()));
    const b = make(Array.from({ length: cols }, () => random()));
    const c = make(Array.from({ length: cols }, () => random()));
    const mask = new Uint8Array(cols).fill(1);
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
      const merged = mergeResults(order);
      const summary = computeQualitySummary({
        metric: "PROJECTION", policy, losResult: merged, terrainGrid: terrain, terrainResolution: 1, terrainKey: key, snapshot,
      })!;
      expect(computeAoiCoverage(merged, mask, policy, ctx("PROJECTION", terrain, 1))!.usefulCount).toBe(summary.usefulCount);
    }
  });
});
