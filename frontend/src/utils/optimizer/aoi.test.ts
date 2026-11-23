import { describe, expect, it } from "vitest";
import { mergeResults } from "../../store/analysisStore";
import { LOSCellState } from "../../types/api";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import { aoiPercent, computeAoiCoverage } from "../aoi/aoiCoverage";
import { aoiAzimuthWindow, bearingDeg, isBearingInWindow } from "../aoi/aoiAzimuth";
import { coarsenAoiMask, orientTowardsAoi, prepareAoiCells, validateAoiMaskForGrid, validateAoiProfile } from "./aoi";
import { coarsenGrid } from "./coarsen";
import { greedySelect } from "./greedy";
import { UnionState, evaluateUnion, objectiveQualityMetric, scoreLosOutput } from "./objective";
import { asLOSResponse, randomInt, seededRandom } from "./optimizer.testSupport";
import type { LosCellOutput, OptimizerObjective } from "./types";

const OBJECTIVES: readonly OptimizerObjective[] = ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"];
const KEY = { terrain_id: "dtm-test", epoch: 1 };
/** R14 WP14-4/WP14-5: coverage context for a grid whose NODATA cells are `nodata`. */
function coverageContext(metric: "INCIDENCE" | "PROJECTION", nodata: Uint8Array, rows: number, cols: number) {
  const terrainGrid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (nodata[r * cols + c] ? Number.NaN : 0)));
  return { metric, terrainGrid, terrainResolution: 1, terrainKey: KEY,
    snapshot: { terrainKey: KEY, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] } };
}

function randomMask(random: () => number, size: number, density: number): Uint8Array {
  const mask = new Uint8Array(size);
  for (let idx = 0; idx < size; idx++) if (random() < density) mask[idx] = 1;
  return mask;
}

function randomOutput(random: () => number, size: number, nodata: Uint8Array): LosCellOutput {
  const cell_states = new Uint8Array(size);
  const flat_quality_grid = new Float32Array(size).fill(-1);
  const flat_projection_grid = new Float32Array(size).fill(Number.NaN);
  for (let idx = 0; idx < size; idx++) {
    if (nodata[idx]) {
      cell_states[idx] = LOSCellState.NODATA;
      continue;
    }
    const roll = random();
    if (roll < 0.5) {
      cell_states[idx] = LOSCellState.VISIBLE;
      flat_quality_grid[idx] = random() < 0.1 ? Number.NaN : random();
      flat_projection_grid[idx] = random() < 0.1 ? Number.NaN : random();
    } else if (roll < 0.7) cell_states[idx] = LOSCellState.SHADOW;
    else cell_states[idx] = LOSCellState.OUT_OF_RANGE;
  }
  return { cell_states, flat_quality_grid, flat_projection_grid };
}

describe("coarsenAoiMask: same subsampling rule as coarsenGrid", () => {
  it("keeps fine node (r·f, c·f) for every coarse node, on 300 seeded masks", () => {
    const random = seededRandom(31);
    for (let i = 0; i < 300; i++) {
      const rows = randomInt(random, 1, 40);
      const cols = randomInt(random, 1, 40);
      const factor = randomInt(random, 1, 7);
      const mask = randomMask(random, rows * cols, 0.4);
      const coarse = coarsenAoiMask(mask, rows, cols, factor);
      // Encode the mask as elevations and coarsen that grid: the layouts must agree byte by byte.
      const asGrid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => mask[r * cols + c]!));
      const coarseGrid = coarsenGrid({ grid: asGrid, bounds: { min_x: 0, min_y: 0 }, resolution: 1 }, factor);
      expect(coarse.length).toBe(coarseGrid.rows * coarseGrid.cols);
      expect(Array.from(coarse)).toEqual(coarseGrid.grid.flat());
      for (let r = 0; r < coarseGrid.rows; r++) {
        for (let c = 0; c < coarseGrid.cols; c++) {
          expect(coarse[r * coarseGrid.cols + c]).toBe(mask[r * factor * cols + c * factor]);
        }
      }
    }
  });

  it("rejects a mask of the wrong size or type", () => {
    expect(() => coarsenAoiMask(new Uint8Array(5), 2, 3, 1)).toThrow(RangeError);
    expect(() => coarsenAoiMask([0, 1] as never, 1, 2, 1)).toThrow(RangeError);
    expect(() => coarsenAoiMask(new Uint8Array(6), 2, 3, 0)).toThrow(RangeError);
  });
});

// R14 WP14-3: the cell-scanning `aoiRangeChecker` was replaced by the O(V) polygon filter
// `aoiRangeFilter`; its tests live in `r14fix-range.test.ts`.

describe("orientTowardsAoi (R14: fine cells, minimal arc)", () => {
  // Fine grid 21 × 21, 2 m, origin (500, 1000).
  const grid21 = {
    grid: Array.from({ length: 21 }, () => new Array<number>(21).fill(0)),
    bounds: { min_x: 500, min_y: 1000 },
    resolution: 2,
  };
  const rect = (r0: number, r1: number, c0: number, c1: number): Uint8Array => {
    const mask = new Uint8Array(21 * 21);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mask[r * 21 + c] = 1;
    return mask;
  };
  const orient = (mask: Uint8Array, x: number, y: number, width: number) => orientTowardsAoi(prepareAoiCells(grid21, mask), x, y, width);

  it("points the centre at the AOI with the engine convention (north 0, east 90)", () => {
    const north = orient(rect(18, 20, 9, 11), 520, 1000, 150);
    expect(north.az_center_deg).toBeCloseTo(0, 12);
    expect(north.aoi_fits_azimuth).toBe(true);
    expect(north.aoi_in_azimuth_pct).toBe(100);
    const east = orient(rect(9, 11, 18, 20), 500, 1020, 150);
    expect(east.az_center_deg).toBeCloseTo(90, 12);
    const southWest = orient(rect(0, 0, 0, 0), 520, 1020, 150);
    expect(southWest.az_center_deg).toBe(bearingDeg(-20, -20));
  });

  it("centres on the minimal arc when it fits, else on the most populated window (brute force, 100 cases)", () => {
    const random = seededRandom(33);
    for (let i = 0; i < 100; i++) {
      const mask = randomMask(random, 21 * 21, 0.1);
      if (!mask.some((v) => v === 1)) mask[0] = 1;
      const x = 500 + random() * 40;
      const y = 1000 + random() * 40;
      const bearings: number[] = [];
      mask.forEach((value, idx) => {
        if (value === 1) bearings.push(bearingDeg(500 + (idx % 21) * 2 - x, 1000 + Math.floor(idx / 21) * 2 - y));
      });
      const width = 120;
      const orientation = orient(mask, x, y, width);
      const sorted = [...bearings].sort((p, q) => p - q);
      let largest = sorted[0]! + 360 - sorted[sorted.length - 1]!;
      let after = 0;
      for (let k = 0; k + 1 < sorted.length; k++) {
        if (sorted[k + 1]! - sorted[k]! > largest) { largest = sorted[k + 1]! - sorted[k]!; after = k + 1; }
      }
      const spread = sorted.length === 1 ? 0 : 360 - largest;
      expect(Math.abs(orientation.aoi_spread_deg - spread)).toBeLessThan(1e-9);
      const window = aoiAzimuthWindow(orientation.az_center_deg, width);
      const inside = bearings.filter((bearing) => isBearingInWindow(bearing, window)).length;
      expect(orientation.aoi_in_azimuth_pct).toBe(aoiPercent(inside, bearings.length));
      expect(orientation.aoi_fits_azimuth).toBe(inside === bearings.length);
      if (spread < width - 1e-6) {
        const mid = sorted[after]! + spread / 2;
        const diff = ((orientation.az_center_deg - mid + 540) % 360) - 180;
        expect(Math.abs(diff)).toBeLessThan(1e-9);
        expect(orientation.aoi_fits_azimuth).toBe(true);
      } else {
        let best = 0;
        for (const start of sorted) {
          best = Math.max(best, bearings.filter((b) => ((b - start + 360) % 360) <= width).length);
        }
        expect(inside).toBe(best);
      }
    }
  });

  it("flags an AOI wider than the azimuth width without dropping it, and a full circle always fits", () => {
    // Radar in the middle of a long row of AOI cells: bearings spread over ~180°.
    const wide = orient(rect(12, 12, 0, 20), 520, 1022, 90);
    expect(wide.aoi_spread_deg).toBeGreaterThan(90);
    expect(wide.aoi_fits_azimuth).toBe(false);
    expect(wide.aoi_in_azimuth_pct).toBeGreaterThan(0);
    expect(wide.aoi_in_azimuth_pct).toBeLessThan(100);
    const full = orient(rect(12, 12, 0, 20), 520, 1022, 360);
    expect(full.aoi_fits_azimuth).toBe(true);
    expect(full.aoi_in_azimuth_pct).toBe(100);
  });
});

describe("AOI validation for the optimizer", () => {
  it("checks the profile and the fine mask against its DEM", () => {
    expect(() => validateAoiProfile({ rangeMinM: 10, rangeMaxM: 5, azimuthWidthDeg: 90 })).toThrow(RangeError);
    expect(() => validateAoiProfile({ rangeMinM: -1, rangeMaxM: 5, azimuthWidthDeg: 90 })).toThrow(RangeError);
    expect(() => validateAoiProfile({ rangeMinM: 0, rangeMaxM: Infinity, azimuthWidthDeg: 90 })).toThrow(RangeError);
    expect(() => validateAoiProfile({ rangeMinM: 0, rangeMaxM: 5, azimuthWidthDeg: 0 })).toThrow(RangeError);
    expect(() => validateAoiProfile(undefined as never)).toThrow(RangeError);
    const source = { grid: [[1, Number.NaN], [1, 1]], bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    expect(validateAoiMaskForGrid(Uint8Array.from([1, 0, 1, 0]), source)).toBe(2);
    expect(() => validateAoiMaskForGrid(Uint8Array.from([1, 1, 0, 0]), source)).toThrow(RangeError);
    expect(() => validateAoiMaskForGrid(Uint8Array.from([0, 0, 0, 0]), source)).toThrow(RangeError);
    expect(() => validateAoiMaskForGrid(Uint8Array.from([1, 0, 1]), source)).toThrow(RangeError);
  });
});

describe("objective with an AOI", () => {
  it("scores only AOI cells, exactly as computeAoiCoverage counts them (single radar and app-order unions)", () => {
    const random = seededRandom(34);
    for (let i = 0; i < 200; i++) {
      const rows = randomInt(random, 2, 9);
      const cols = randomInt(random, 2, 9);
      const size = rows * cols;
      const nodata = randomMask(random, size, 0.1);
      const aoi = randomMask(random, size, 0.5);
      for (let idx = 0; idx < size; idx++) if (nodata[idx]) aoi[idx] = 0;
      if (!aoi.some((v) => v === 1)) continue;
      const objective = OBJECTIVES[i % 3]!;
      const metric = objectiveQualityMetric(objective);
      const outputs = Array.from({ length: randomInt(random, 1, 4) }, () => randomOutput(random, size, nodata));
      const scores = outputs.map((output) => scoreLosOutput(output, objective, DEFAULT_QUALITY_POLICY, { mask: aoi }));
      for (let r = 0; r < outputs.length; r++) {
        const coverage = computeAoiCoverage(asLOSResponse(outputs[r]!, rows, cols, 1), aoi, DEFAULT_QUALITY_POLICY,
          coverageContext(metric, nodata, rows, cols))!;
        expect(scores[r]!.value).toBe(objective === "VISIBLE_AREA" ? coverage.visibleCount : coverage.usefulCount);
        expect(scores[r]!.aoi!.cellCount).toBe(coverage.aoiCellCount);
      }
      const merged = mergeResults(outputs.map((output) => asLOSResponse(output, rows, cols, 1)));
      const coverage = computeAoiCoverage(merged, aoi, DEFAULT_QUALITY_POLICY, coverageContext(metric, nodata, rows, cols))!;
      expect(evaluateUnion(scores, objective, DEFAULT_QUALITY_POLICY, { mask: aoi }))
        .toBe(objective === "VISIBLE_AREA" ? coverage.visibleCount : coverage.usefulCount);
    }
  });

  it("never mixes AOI and non-AOI scores, nor scores of different AOIs", () => {
    const nodata = new Uint8Array(4);
    const output = randomOutput(seededRandom(35), 4, nodata);
    const plain = scoreLosOutput(output, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY);
    expect(plain.aoi).toBeUndefined();
    const a = scoreLosOutput(output, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY, { mask: Uint8Array.from([1, 1, 0, 0]) });
    const b = scoreLosOutput(output, "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY, { mask: Uint8Array.from([0, 1, 1, 0]) });
    expect(() => evaluateUnion([plain, a], "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY)).toThrow(RangeError);
    expect(() => evaluateUnion([a], "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY)).toThrow(RangeError);
    expect(() => evaluateUnion([a, b], "USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY, { mask: Uint8Array.from([1, 1, 0, 0]) })).toThrow(RangeError);
    const union = new UnionState("USEFUL_INCIDENCE", DEFAULT_QUALITY_POLICY, 4, { mask: Uint8Array.from([1, 1, 0, 0]) });
    expect(() => union.gainOf(plain)).toThrow(RangeError);
    expect(() => greedySelect([{ score: a, x: 0, y: 0 }], { k: 1, objective: "USEFUL_INCIDENCE", policy: DEFAULT_QUALITY_POLICY }))
      .toThrow(RangeError);
  });

  it("rejects an AOI cell that the LOS output marks NODATA, and a mask of the wrong size", () => {
    const output = randomOutput(seededRandom(36), 4, Uint8Array.from([0, 1, 0, 0]));
    expect(() => scoreLosOutput(output, "VISIBLE_AREA", DEFAULT_QUALITY_POLICY, { mask: Uint8Array.from([0, 1, 0, 0]) })).toThrow(RangeError);
    expect(() => scoreLosOutput(output, "VISIBLE_AREA", DEFAULT_QUALITY_POLICY, { mask: Uint8Array.from([1, 0, 0]) })).toThrow(RangeError);
    expect(() => scoreLosOutput(output, "VISIBLE_AREA", DEFAULT_QUALITY_POLICY, { mask: Uint8Array.from([1, 0, 2, 0]) })).toThrow(RangeError);
  });
});

describe("greedySelect with an AOI (brute force on small instances)", () => {
  it("matches the optimum for k = 1, keeps (1 − 1/e)·OPT for k ≤ 3, and reports AOI percentages from the same counts", () => {
    const random = seededRandom(37);
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const size = randomInt(random, 12, 48);
      const nodata = randomMask(random, size, 0.05);
      const aoi = randomMask(random, size, 0.45);
      for (let idx = 0; idx < size; idx++) if (nodata[idx]) aoi[idx] = 0;
      if (!aoi.some((v) => v === 1)) continue;
      const objective = i % 2 === 0 ? "VISIBLE_AREA" : "USEFUL_INCIDENCE";
      const n = randomInt(random, 2, 8);
      const k = randomInt(random, 1, 3);
      const outputs = Array.from({ length: n }, () => randomOutput(random, size, nodata));
      const candidates = outputs.map((output, index) => ({
        score: scoreLosOutput(output, objective, DEFAULT_QUALITY_POLICY, { mask: aoi }), x: index * 100, y: 0,
      }));
      const greedy = greedySelect(candidates, { k, objective, policy: DEFAULT_QUALITY_POLICY, aoi: { mask: aoi } });
      // Brute force over every subset of size ≤ k with the app's metric on the merged union.
      let opt = 0;
      const metric = objectiveQualityMetric(objective);
      const subsets = (start: number, chosen: number[]): void => {
        if (chosen.length > 0) {
          const merged = mergeResults(chosen.map((index) => asLOSResponse(outputs[index]!, 1, size, 1)));
          const coverage = computeAoiCoverage(merged, aoi, DEFAULT_QUALITY_POLICY, coverageContext(metric, nodata, 1, size))!;
          opt = Math.max(opt, objective === "VISIBLE_AREA" ? coverage.visibleCount : coverage.usefulCount);
        }
        if (chosen.length === k) return;
        for (let index = start; index < n; index++) subsets(index + 1, [...chosen, index]);
      };
      subsets(0, []);
      if (k === 1) expect(greedy.value).toBe(opt);
      expect(greedy.value).toBeGreaterThanOrEqual((1 - 1 / Math.E) * opt - 1e-9);
      expect(greedy.value).toBeLessThanOrEqual(opt);
      // The reported union value is the app's metric on the union in app order.
      if (greedy.selected.length > 0) {
        const ordered = greedy.unionOrder.map((member) => asLOSResponse(outputs[member.index]!, 1, size, 1));
        const coverage = computeAoiCoverage(mergeResults(ordered), aoi, DEFAULT_QUALITY_POLICY, coverageContext(metric, nodata, 1, size))!;
        expect(greedy.value).toBe(objective === "VISIBLE_AREA" ? coverage.visibleCount : coverage.usefulCount);
        if (objective === "USEFUL_INCIDENCE") expect(Object.is(greedy.aoi_useful_pct, coverage.usefulPct)).toBe(true);
        else expect(Object.is(greedy.aoi_useful_pct, coverage.visiblePct)).toBe(true);
      }
      const cells = aoi.reduce((sum, v) => sum + v, 0);
      expect(greedy.aoiCellCount).toBe(cells);
      expect(greedy.guaranteeScope).toBe("coarse_thinned_candidates");
      for (const step of greedy.steps) {
        expect(step.aoi_useful_pct).toBe(aoiPercent(step.unionValue, cells));
        for (const top of step.top) {
          expect(top.aoi_useful_pct).toBe(aoiPercent(step.unionValue - step.marginalGain + top.gain, cells));
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("reports AOI percentages also when there is nothing to select", () => {
    const mask = Uint8Array.from([1, 0, 1, 0]);
    const empty = greedySelect([], { k: 1, objective: "USEFUL_INCIDENCE", policy: DEFAULT_QUALITY_POLICY, aoi: { mask } });
    expect(empty.stopReason).toBe("NO_FEASIBLE_CANDIDATE");
    expect(empty.aoiCellCount).toBe(2);
    expect(empty.aoi_useful_pct).toBe(0);
    const plain = greedySelect([], { k: 1, objective: "USEFUL_INCIDENCE", policy: DEFAULT_QUALITY_POLICY });
    expect("aoi_useful_pct" in plain).toBe(false);
  });
});
