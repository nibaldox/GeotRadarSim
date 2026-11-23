import { describe, expect, it } from "vitest";
import { mergeResults } from "../../store/analysisStore";
import { LOSCellState } from "../../types/api";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import { aoiAzimuthWindow, bearingDeg, isBearingInWindow } from "../aoi/aoiAzimuth";
import { aoiPercent, computeAoiCoverage } from "../aoi/aoiCoverage";
import { aoiMaskCellCount, aoiMaskForGrid } from "../aoi/aoiMask";
import { aoiPolygonDistanceRange, validateAoiPolygon } from "../aoi/aoiPolygon";
import type { AoiPolygon } from "../aoi/aoiPolygon";
import { coarsenAoiMask } from "./aoi";
import { coarsenGrid } from "./coarsen";
import type { OptimizerAoiProfile } from "./aoi";
import { objectiveQualityMetric } from "./objective";
import { optimizeCoarse } from "./optimize";
import type { CoarseOptimizationInput, CoarseOptimizationResult } from "./optimize";
import { asLOSResponse } from "./optimizer.testSupport";
import type { LosCellOutput, LosRequest, LosScorer, OptimizerGrid } from "./types";

const TAN40 = Math.tan((40 * Math.PI) / 180);

/**
 * Synthetic V pit, 1 m nodes, 81 rows (y = north) × 41 cols (x = east), origin (2000, 5000).
 * South rim y ≤ 16 (flat, z = 20·tan40), south wall 16 < y < 36 (40°), floor 36 ≤ y ≤ 44 (z = 0),
 * north wall 44 < y < 64 (40°), north rim y ≥ 64.
 */
function vPit(): OptimizerGrid {
  const rows = 81;
  const cols = 41;
  const rim = 20 * TAN40;
  const z = (y: number): number => (y <= 16 ? rim : y < 36 ? (36 - y) * TAN40 : y <= 44 ? 0 : y < 64 ? (y - 44) * TAN40 : rim);
  return {
    grid: Array.from({ length: rows }, (_, r) => new Array<number>(cols).fill(z(r))),
    bounds: { min_x: 2000, min_y: 5000 },
    resolution: 1,
  };
}

/** North-wall AOI (strictly inside the wall). */
const NORTH_WALL: AoiPolygon = {
  vertices: [{ x: 2004, y: 5047 }, { x: 2036, y: 5047 }, { x: 2036, y: 5061 }, { x: 2004, y: 5061 }],
};

/**
 * Small geometric LOS on the grid it is handed: horizontal range limits, the azimuth window
 * the app would build from `azimuthCenterDeg` (`normalizeAzimuthRange(center, width)`),
 * occlusion by sampling the bilinear surface along the ray, incidence =
 * clamp(dot(upward normal, target→radar), 0, 1).
 */
function geometricLos(profile: OptimizerAoiProfile, calls: LosRequest[]): LosScorer {
  return (request) => {
    calls.push(request);
    const { grid, bounds, resolution } = request.grid;
    const rows = grid.length;
    const cols = grid[0]!.length;
    const size = rows * cols;
    const window = request.azimuthCenterDeg === undefined ? null : aoiAzimuthWindow(request.azimuthCenterDeg, profile.azimuthWidthDeg);
    const zAt = (x: number, y: number): number => {
      const fc = Math.min(cols - 1.000001, Math.max(0, (x - bounds.min_x) / resolution));
      const fr = Math.min(rows - 1.000001, Math.max(0, (y - bounds.min_y) / resolution));
      const c0 = Math.floor(fc);
      const r0 = Math.floor(fr);
      const tc = fc - c0;
      const tr = fr - r0;
      const g = (r: number, c: number) => grid[r]![c]!;
      return (g(r0, c0) * (1 - tc) + g(r0, c0 + 1) * tc) * (1 - tr) + (g(r0 + 1, c0) * (1 - tc) + g(r0 + 1, c0 + 1) * tc) * tr;
    };
    const cell_states = new Uint8Array(size);
    const flat_quality_grid = new Float32Array(size).fill(-1);
    const flat_projection_grid = new Float32Array(size).fill(Number.NaN);
    const { x: rx, y: ry, z: rz } = request.position;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const tz = grid[r]![c]!;
        const tx = bounds.min_x + c * resolution;
        const ty = bounds.min_y + r * resolution;
        const dx = tx - rx;
        const dy = ty - ry;
        const d = Math.hypot(dx, dy);
        if (d < profile.rangeMinM || d > profile.rangeMaxM) {
          cell_states[idx] = LOSCellState.OUT_OF_RANGE;
          continue;
        }
        if (!isBearingInWindow(bearingDeg(dx, dy), window)) {
          cell_states[idx] = LOSCellState.OUTSIDE_FOV;
          continue;
        }
        let blocked = false;
        const steps = Math.max(2, Math.ceil(d / (resolution / 2)));
        for (let s = 1; s < steps - 1 && !blocked; s++) {
          const t = s / steps;
          if (zAt(rx + dx * t, ry + dy * t) > rz + (tz - rz) * t + 1e-6) blocked = true;
        }
        if (blocked) {
          cell_states[idx] = LOSCellState.SHADOW;
          continue;
        }
        cell_states[idx] = LOSCellState.VISIBLE;
        const cl = Math.max(0, c - 1);
        const cr = Math.min(cols - 1, c + 1);
        const rl = Math.max(0, r - 1);
        const ru = Math.min(rows - 1, r + 1);
        const gx = (grid[r]![cr]! - grid[r]![cl]!) / ((cr - cl) * resolution);
        const gy = (grid[ru]![c]! - grid[rl]![c]!) / ((ru - rl) * resolution);
        const norm = Math.hypot(gx, gy, 1);
        const len = Math.hypot(dx, dy, rz - tz) || 1;
        const dot = (-gx * -dx + -gy * -dy + (rz - tz)) / (norm * len);
        flat_quality_grid[idx] = Math.min(1, Math.max(0, dot));
        flat_projection_grid[idx] = Math.min(1, Math.abs(dot) * 0.9);
      }
    }
    return { cell_states, flat_quality_grid, flat_projection_grid };
  };
}

const PROFILE: OptimizerAoiProfile = { rangeMinM: 0, rangeMaxM: 120, azimuthWidthDeg: 150 };

function aoiInput(calls: LosRequest[], extra: Partial<CoarseOptimizationInput> = {}, profile = PROFILE): CoarseOptimizationInput {
  const source = vPit();
  return {
    source,
    k: 1,
    policy: DEFAULT_QUALITY_POLICY,
    los: geometricLos(profile, calls),
    minSeparationM: 6,
    maxCoarseNodes: 1000,
    aoi: { polygon: NORTH_WALL, mask: aoiMaskForGrid(source, NORTH_WALL), profile },
    ...extra,
  };
}

/** Coarse AOI coverage of one member list, in the order given, with the same LOS. */
function coverageOf(result: CoarseOptimizationResult, members: LosRequest[], input: CoarseOptimizationInput) {
  const scorer = geometricLos(input.aoi!.profile, []);
  const outputs: LosCellOutput[] = members.map((call) => scorer(call));
  const { rows, cols, resolution, factor } = result.coarse;
  const mask = coarsenAoiMask(input.aoi!.mask!, input.source.grid.length, input.source.grid[0]!.length, factor);
  // R14 WP14-4/WP14-5: the coverage needs the metric and the (coarse) terrain with its key.
  const key = { terrain_id: "dtm-test", epoch: 1 };
  return computeAoiCoverage(mergeResults(outputs.map((output) => asLOSResponse(output, rows, cols, resolution))), mask,
    input.policy, {
      metric: objectiveQualityMetric(result.objective), terrainGrid: coarsenGrid(input.source, factor).grid,
      terrainResolution: resolution, terrainKey: key,
      snapshot: { terrainKey: key, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] },
    })!;
}

describe("optimizeCoarse with an area to monitor", () => {
  it("places the radar on the opposite (south) wall for a north-wall AOI and orients it north", () => {
    const calls: LosRequest[] = [];
    const input = aoiInput(calls);
    const result = optimizeCoarse(input);
    expect(result.status).toBe("OK");
    expect(result.coarse.factor).toBe(2);
    const chosen = result.candidates[result.greedy!.selected[0]!]!;
    expect(chosen.y - 5000).toBeLessThan(36); // south rim or south wall side of the floor
    expect(chosen.y - 5000).toBeLessThanOrEqual(16); // the south rim itself
    const info = result.aoi!.candidates[chosen.index]!;
    // Faces north (towards the wall), within a few degrees of the bearing to the AOI centre.
    expect(Math.abs(info.az_center_deg)).toBeLessThan(90);
    expect(Math.abs(info.az_center_deg - bearingDeg(2020 - chosen.x, 5054 - chosen.y))).toBeLessThan(5);
    expect(info.aoi_fits_azimuth).toBe(true);
    // It beats every candidate north of the floor (the AOI's own rim) and on the floor.
    const pct = result.aoi!.candidates.map((entry) => entry.aoi_useful_pct!);
    const best = pct[chosen.index]!;
    expect(best).toBe(Math.max(...pct));
    for (const candidate of result.candidates) {
      if (candidate.y - 5000 >= 36) expect(pct[candidate.index]!).toBeLessThan(best);
    }
    expect(result.candidates.some((candidate) => candidate.y - 5000 >= 64)).toBe(true);
    // The reported percentage is computeAoiCoverage on the coarse grid with the same LOS.
    const call = calls.find((entry) => entry.subject.kind === "candidate" && entry.subject.index === chosen.index)!;
    const coverage = coverageOf(result, [call], input);
    expect(Object.is(best, coverage.usefulPct)).toBe(true);
    expect(result.greedy!.aoi_useful_pct).toBe(best);
    expect(result.greedy!.guaranteeScope).toBe("coarse_thinned_candidates");
  });

  it("keeps candidates outside the AOI and within range, and hands each LOS its azimuth centre", () => {
    const calls: LosRequest[] = [];
    const profile = { rangeMinM: 20, rangeMaxM: 45, azimuthWidthDeg: 150 };
    const input = aoiInput(calls, { fixed: [{ x: 2020, y: 5070, z: 30 }], k: 2 }, profile);
    const result = optimizeCoarse(input);
    expect(result.status).toBe("OK");
    const mask = input.aoi!.mask!;
    const cols = input.source.grid[0]!.length;
    const polygon = validateAoiPolygon(NORTH_WALL);
    for (const candidate of result.candidates) {
      expect(mask[candidate.row * cols + candidate.col]).toBe(0);
      // R14 WP14-3: in range of the polygon, [dmin, dmax] ∩ [20, 45] ≠ ∅ (inclusive tolerance).
      const { min, max } = aoiPolygonDistanceRange(polygon, candidate.x, candidate.y);
      expect(min <= 45 * (1 + 1e-9) && max >= 20 * (1 - 1e-9)).toBe(true);
    }
    for (const call of calls) {
      if (call.subject.kind === "fixed") {
        expect("azimuthCenterDeg" in call).toBe(false);
      } else {
        expect(call.azimuthCenterDeg).toBe(result.aoi!.candidates[call.subject.index]!.az_center_deg);
      }
    }
    expect(result.aoi!.filter.outsideAndInRange).toBeGreaterThan(0);
    expect(result.aoi!.filter.outsideAoi).toBeGreaterThanOrEqual(result.aoi!.filter.outsideAndInRange);
    // Fixed radar scored on the AOI too; the union value is the app's metric in app order.
    expect(result.aoi!.fixed_aoi_useful_pct).toHaveLength(1);
    const greedy = result.greedy!;
    const members = greedy.unionOrder.map((member) => calls.find((call) =>
      call.subject.kind === member.kind && call.subject.index === member.index)!);
    const coverage = coverageOf(result, members, input);
    expect(greedy.value).toBe(coverage.usefulCount);
    expect(Object.is(greedy.aoi_useful_pct, coverage.usefulPct)).toBe(true);
    expect(greedy.steps.every((step) => step.aoi_useful_pct === aoiPercent(step.unionValue, result.aoi!.coarseCellCount))).toBe(true);
  });

  it("matches brute force over the candidates for k = 1 and keeps (1 − 1/e)·OPT for k = 2", () => {
    for (const objective of ["VISIBLE_AREA", "USEFUL_INCIDENCE"] as const) {
      const calls: LosRequest[] = [];
      const input = aoiInput(calls, { objective, k: 2, minSeparationM: 0, candidateParams: { maxCandidates: 12 } },
        { rangeMinM: 0, rangeMaxM: 60, azimuthWidthDeg: 90 });
      const result = optimizeCoarse(input);
      expect(result.status).toBe("OK");
      const candidateCalls = calls.filter((call) => call.subject.kind === "candidate");
      const value = (members: LosRequest[]) => {
        const coverage = coverageOf(result, members, input);
        return objective === "VISIBLE_AREA" ? coverage.visibleCount : coverage.usefulCount;
      };
      const singles = candidateCalls.map((call) => value([call]));
      expect(result.candidateValues).toEqual(singles);
      expect(result.greedy!.steps[0]!.unionValue).toBe(Math.max(...singles));
      let opt = 0;
      for (let i = 0; i < candidateCalls.length; i++) {
        for (let j = i + 1; j < candidateCalls.length; j++) opt = Math.max(opt, value([candidateCalls[j]!, candidateCalls[i]!]));
      }
      expect(result.greedy!.value).toBeGreaterThanOrEqual((1 - 1 / Math.E) * opt);
      expect(result.greedy!.value).toBeLessThanOrEqual(opt);
    }
  });

  it("returns NO_CANDIDATES with its reason when the AOI is out of range of every candidate", () => {
    const calls: LosRequest[] = [];
    const result = optimizeCoarse(aoiInput(calls, {}, { rangeMinM: 500, rangeMaxM: 2500, azimuthWidthDeg: 150 }));
    expect(result.status).toBe("NO_CANDIDATES");
    expect(result.aoi!.noCandidatesReason).toBe("AOI_OUT_OF_RANGE");
    expect(result.aoi!.message).toMatch(/alcance/);
    expect(result.greedy).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns NO_CANDIDATES when the AOI covers every eligible node", () => {
    const source = vPit();
    const everything: AoiPolygon = { vertices: [{ x: 1990, y: 4990 }, { x: 2050, y: 4990 }, { x: 2050, y: 5090 }, { x: 1990, y: 5090 }] };
    const calls: LosRequest[] = [];
    const result = optimizeCoarse({ ...aoiInput(calls), aoi: { polygon: everything, mask: aoiMaskForGrid(source, everything), profile: PROFILE } });
    expect(result.status).toBe("NO_CANDIDATES");
    expect(result.aoi!.noCandidatesReason).toBe("AOI_COVERS_ALL_ELIGIBLE_NODES");
    expect(calls).toHaveLength(0);
  });

  it("returns AOI_TOO_SMALL when the AOI holds fine nodes but no coarse node", () => {
    const source = vPit();
    // Single fine row y = 5051 (odd): with f = 2 coarse rows are the even fine rows.
    const sliver: AoiPolygon = { vertices: [{ x: 2004.5, y: 5050.8 }, { x: 2030.5, y: 5050.8 }, { x: 2030.5, y: 5051.2 }, { x: 2004.5, y: 5051.2 }] };
    const mask = aoiMaskForGrid(source, sliver);
    expect(aoiMaskCellCount(mask)).toBe(26);
    const calls: LosRequest[] = [];
    const result = optimizeCoarse({ ...aoiInput(calls), aoi: { polygon: sliver, mask, profile: PROFILE } });
    expect(result.status).toBe("AOI_TOO_SMALL");
    expect(result.aoi!.coarseCellCount).toBe(0);
    expect(result.aoi!.message).toMatch(/grilla gruesa/);
    expect(calls).toHaveLength(0);
  });

  it("keeps a candidate whose AOI does not fit in the azimuth width, flagged with its covered share", () => {
    const calls: LosRequest[] = [];
    // Narrow width and a close range: from the south rim the wide north wall spans more than 40°.
    const result = optimizeCoarse(aoiInput(calls, { k: 1 }, { rangeMinM: 0, rangeMaxM: 120, azimuthWidthDeg: 40 }));
    expect(result.status).toBe("OK");
    const misfits = result.aoi!.candidates.filter((entry) => !entry.aoi_fits_azimuth);
    expect(misfits.length).toBeGreaterThan(0);
    for (const entry of misfits) {
      expect(entry.aoi_in_azimuth_pct).toBeLessThan(100);
      expect(entry.aoi_useful_pct).not.toBeNull();
    }
    expect(result.candidateValues).toHaveLength(result.candidates.length);
  });

  it("is deterministic: two AOI runs give the same JSON", () => {
    const first = optimizeCoarse(aoiInput([], { k: 2 }));
    const second = optimizeCoarse(aoiInput([], { k: 2 }));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("validates the AOI option before any LOS", () => {
    const calls: LosRequest[] = [];
    const base = aoiInput(calls);
    expect(() => optimizeCoarse({ ...base, aoi: { polygon: NORTH_WALL, mask: new Uint8Array(3), profile: PROFILE } })).toThrow(RangeError);
    expect(() => optimizeCoarse({ ...base, aoi: { polygon: NORTH_WALL, mask: base.aoi!.mask, profile: { ...PROFILE, rangeMaxM: -1 } } })).toThrow(RangeError);
    // R14 WP14-3: the polygon is required, and a given mask must be the polygon's.
    expect(() => optimizeCoarse({ ...base, aoi: { mask: base.aoi!.mask, profile: PROFILE } as never })).toThrow(RangeError);
    const other = Uint8Array.from(base.aoi!.mask!);
    other[other.indexOf(1)] = 0;
    expect(() => optimizeCoarse({ ...base, aoi: { polygon: NORTH_WALL, mask: other, profile: PROFILE } })).toThrow(RangeError);
    expect(() => optimizeCoarse({ ...base, aoi: null as never })).toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("reports CANCELLED with the orientation already computed", () => {
    const calls: LosRequest[] = [];
    const result = optimizeCoarse(aoiInput(calls, { isCancelled: () => calls.length >= 2 }));
    expect(result.status).toBe("CANCELLED");
    expect(result.aoi!.candidates.length).toBe(result.candidates.length);
    expect(result.aoi!.candidates.every((entry) => entry.aoi_useful_pct === null)).toBe(true);
  });
});
