/**
 * R14-FIX WP14-4, WP14-5, WP14-8 and WP14-9 on the AOI module (adopted from probes P-A1, P-A2,
 * P-B1, P-B3 and P-B4).
 */
import { describe, expect, it } from "vitest";
import { LOSCellState } from "../../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../../types/api";
import { DEFAULT_QUALITY_POLICY, computeQualitySummary } from "../qualityMetrics";
import type { QualityMetric } from "../qualityMetrics";
import { asLOSResponse, randomInt, seededRandom } from "../optimizer/optimizer.testSupport";
import type { LosCellOutput } from "../optimizer/types";
import { optimizeCoarse } from "../optimizer/optimize";
import { computeAoiCoverage } from "./aoiCoverage";
import { aoiMaskForGrid } from "./aoiMask";
import { AoiError, validateAoiPolygon } from "./aoiPolygon";

const KEY = { terrain_id: "dtm-test", epoch: 1 };
const SNAPSHOT: AnalysisSnapshot = { terrainKey: KEY, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] };

function randomCase(seed: number) {
  const random = seededRandom(seed);
  const rows = randomInt(random, 3, 12);
  const cols = randomInt(random, 3, 12);
  const terrain = Array.from({ length: rows }, () => Array.from({ length: cols }, () => (random() < 0.1 ? Number.NaN : random() * 10)));
  if (!terrain.some((row) => row.some(Number.isFinite))) terrain[0]![0] = 1;
  const size = rows * cols;
  const out: LosCellOutput = {
    cell_states: new Uint8Array(size),
    flat_quality_grid: new Float32Array(size).fill(-1),
    flat_projection_grid: new Float32Array(size).fill(Number.NaN),
  };
  for (let i = 0; i < size; i++) {
    if (!Number.isFinite(terrain[Math.floor(i / cols)]![i % cols]!)) { out.cell_states[i] = LOSCellState.NODATA; continue; }
    if (random() < 0.6) {
      out.cell_states[i] = LOSCellState.VISIBLE;
      out.flat_quality_grid[i] = random();
      out.flat_projection_grid[i] = random();
    } else out.cell_states[i] = LOSCellState.SHADOW;
  }
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (Number.isFinite(terrain[Math.floor(i / cols)]![i % cols]!) && random() < 0.6) mask[i] = 1;
  return { rows, cols, terrain, out, mask, random };
}

const context = (metric: QualityMetric, terrain: number[][], resolution: number) =>
  ({ metric, terrainGrid: terrain, terrainResolution: resolution, terrainKey: KEY, snapshot: SNAPSHOT });

describe("WP14-4: the metric is required", () => {
  it("a call without the metric is rejected by the type and returns null at run time", () => {
    const { rows, cols, terrain, out, mask } = randomCase(1);
    const result = asLOSResponse(out, rows, cols, 1);
    // @ts-expect-error the 4th argument (with `metric`) is required
    expect(computeAoiCoverage(result, mask, DEFAULT_QUALITY_POLICY)).toBeNull();
    // @ts-expect-error `metric` is required inside the context
    expect(computeAoiCoverage(result, mask, DEFAULT_QUALITY_POLICY, { terrainGrid: terrain, terrainResolution: 1, terrainKey: KEY, snapshot: SNAPSHOT })).toBeNull();
    expect(computeAoiCoverage(result, mask, DEFAULT_QUALITY_POLICY, context("PROJECTION", terrain, 1))!.metric).toBe("PROJECTION");
  });
});

describe("WP14-5: null in the same incoherent cases as computeQualitySummary", () => {
  it("P-A2 inverted: VISIBLE on a NaN node, NODATA on a finite node outside the AOI, a resolution mismatch", () => {
    const terrain = [[Number.NaN, 1, 1], [1, 1, 1], [1, 1, 1]];
    const visible = (states: number[]): LOSResponse => asLOSResponse({
      cell_states: Uint8Array.from(states),
      flat_quality_grid: new Float32Array(9).fill(0.9),
      flat_projection_grid: new Float32Array(9).fill(0.9),
    }, 3, 3, 1);
    const all = new Uint8Array(9).fill(1);
    all[0] = 0;
    const r1 = visible(new Array(9).fill(LOSCellState.VISIBLE));
    expect(computeQualitySummary({ metric: "INCIDENCE", policy: DEFAULT_QUALITY_POLICY, losResult: r1, terrainGrid: terrain, terrainResolution: 1, terrainKey: KEY, snapshot: SNAPSHOT })).toBeNull();
    expect(computeAoiCoverage(r1, all, DEFAULT_QUALITY_POLICY, context("INCIDENCE", terrain, 1))).toBeNull();
    const finite = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
    const r2 = visible([LOSCellState.NODATA, 2, 2, 2, 2, 2, 2, 2, 2].map((s, i) => (i === 0 ? s : LOSCellState.VISIBLE)));
    expect(computeAoiCoverage(r2, all, DEFAULT_QUALITY_POLICY, context("INCIDENCE", finite, 1))).toBeNull();
    const r3 = { ...visible(new Array(9).fill(LOSCellState.VISIBLE)), resolution: 2 };
    expect(computeAoiCoverage(r3, all, DEFAULT_QUALITY_POLICY, context("INCIDENCE", finite, 1))).toBeNull();
    // A mask cell on a NaN node is incoherent too.
    const nanMask = new Uint8Array(9).fill(1);
    const r4 = visible([LOSCellState.NODATA, ...new Array(8).fill(LOSCellState.VISIBLE)]);
    expect(computeAoiCoverage(r4, nanMask, DEFAULT_QUALITY_POLICY, context("INCIDENCE", terrain, 1))).toBeNull();
    nanMask[0] = 0;
    expect(computeAoiCoverage(r4, nanMask, DEFAULT_QUALITY_POLICY, context("INCIDENCE", terrain, 1))).not.toBeNull();
  });

  it("is null exactly when the summary is null, over 400 seeded coherent and corrupted inputs", () => {
    const corruptions: Array<(c: ReturnType<typeof randomCase>, r: LOSResponse) => { result: LOSResponse; ctx: ReturnType<typeof context> } | null> = [
      () => null, // coherent
      (c, r) => {
        const i = c.terrain.flat().findIndex((v) => !Number.isFinite(v));
        if (i < 0) return null;
        const s = Uint8Array.from(r.cell_states); s[i] = LOSCellState.VISIBLE;
        return { result: { ...r, cell_states: s }, ctx: context("INCIDENCE", c.terrain, 1) };
      },
      (c, r) => {
        const i = c.terrain.flat().findIndex((v, k) => Number.isFinite(v) && c.mask[k] === 0);
        if (i < 0) return null;
        const s = Uint8Array.from(r.cell_states); s[i] = LOSCellState.NODATA;
        return { result: { ...r, cell_states: s }, ctx: context("INCIDENCE", c.terrain, 1) };
      },
      (c, r) => ({ result: { ...r, resolution: 2 }, ctx: context("INCIDENCE", c.terrain, 1) }),
      (c, r) => ({ result: r, ctx: { ...context("INCIDENCE", c.terrain, 1), terrainKey: { terrain_id: "other", epoch: 1 } } }),
      (c, r) => ({ result: { ...r, quality_model: undefined }, ctx: context("INCIDENCE", c.terrain, 1) }),
      (c, r) => ({ result: { ...r, flat_projection_grid: undefined }, ctx: context("PROJECTION", c.terrain, 1) }),
      (c, r) => ({ result: r, ctx: context("INCIDENCE", c.terrain.map((row) => [...row, 1]), 1) }),
      (c, r) => { const s = Uint8Array.from(r.cell_states); s[s.length - 1] = 250; return { result: { ...r, cell_states: s }, ctx: context("INCIDENCE", c.terrain, 1) }; },
    ];
    let nulls = 0;
    let numbers = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const c = randomCase(100 + seed);
      if (!c.mask.includes(1)) continue;
      const base = asLOSResponse(c.out, c.rows, c.cols, 1);
      const variant = corruptions[seed % corruptions.length]!(c, base) ?? { result: base, ctx: context("INCIDENCE", c.terrain, 1) };
      const summary = computeQualitySummary({ metric: variant.ctx.metric, policy: DEFAULT_QUALITY_POLICY, losResult: variant.result,
        terrainGrid: variant.ctx.terrainGrid, terrainResolution: variant.ctx.terrainResolution, terrainKey: variant.ctx.terrainKey, snapshot: variant.ctx.snapshot });
      const coverage = computeAoiCoverage(variant.result, c.mask, DEFAULT_QUALITY_POLICY, variant.ctx);
      expect(coverage === null).toBe(summary === null);
      if (coverage === null) nulls++;
      else numbers++;
    }
    expect(nulls).toBeGreaterThan(150);
    expect(numbers).toBeGreaterThan(40);
  });
});

describe("WP14-8: the mask does not depend on the vertex order or orientation", () => {
  it("P-B3 inverted: 0 of the 1200 reversed/rotated variants differ (non-dyadic res, UTM origin)", () => {
    let polys = 0;
    let differing = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const random = seededRandom(seed);
      const res = [0.3, 0.1, 0.7, 1, 2][seed % 5]!;
      const g = { grid: Array.from({ length: 60 }, () => new Array<number>(60).fill(0)), bounds: { min_x: 351234.37, min_y: 6543210.9 }, resolution: res };
      const n = randomInt(random, 3, 12);
      const verts = Array.from({ length: n }, (_, i) => {
        const a = (2 * Math.PI * (i + random() * 0.5)) / n;
        const r = 8 + random() * 20;
        return { x: g.bounds.min_x + Math.round(30 + r * Math.cos(a)) * res, y: g.bounds.min_y + Math.round(30 + r * Math.sin(a)) * res };
      });
      let base: Uint8Array;
      try { base = aoiMaskForGrid(g, { vertices: verts }); } catch { continue; }
      polys++;
      const variants = [[...verts].reverse(), [...verts.slice(1), verts[0]!], [...verts.slice(3), ...verts.slice(0, 3)].reverse()];
      for (const v of variants) {
        const m = aoiMaskForGrid(g, { vertices: v });
        if (m.some((value, i) => value !== base[i])) differing++;
      }
    }
    expect(polys).toBeGreaterThan(300);
    expect(differing).toBe(0);
  });

  it("canonicalises the ring: counter-clockwise, starting at the lexicographically smallest vertex", () => {
    const v = validateAoiPolygon({ vertices: [{ x: 4, y: 3 }, { x: 4, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 3 }] });
    expect(v.vertices).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
    expect(v.signedAreaM2).toBe(12);
  });
});

describe("WP14-9: clearer codes and messages", () => {
  const sq = (x0: number, y0: number, x1: number, y1: number) => ({ vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
  const codeOf = (fn: () => unknown): string => {
    try { fn(); return "OK"; } catch (e) { return e instanceof AoiError ? e.code : String(e); }
  };

  it("names coordinate overflow and accepts a tiny square at UTM coordinates (it simply holds no node)", () => {
    expect(codeOf(() => validateAoiPolygon(sq(-1e154, -1e154, 1e154, 1e154)))).toBe("AOI_COORDINATES_TOO_LARGE");
    expect(codeOf(() => validateAoiPolygon(sq(-1e200, -1e200, 1e200, 1e200)))).toBe("AOI_COORDINATES_TOO_LARGE");
    expect(codeOf(() => validateAoiPolygon(sq(351000, 6543000, 351000 + 1e-6, 6543000 + 1e-6)))).toBe("OK");
    const g = { grid: Array.from({ length: 5 }, () => new Array<number>(5).fill(0)), bounds: { min_x: 351000.5, min_y: 6543000.5 }, resolution: 1 };
    expect(codeOf(() => aoiMaskForGrid(g, sq(351001.1, 6543001.1, 351001.1 + 1e-6, 6543001.1 + 1e-6)))).toBe("AOI_NO_VALID_CELLS");
  });

  it("does not claim a regular-grid fallback when no candidate is left, and labels the percentage", () => {
    const grid = Array.from({ length: 40 }, () => new Array<number>(40).fill(0));
    const source = { grid, bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    const los = () => { throw new Error("no LOS expected"); };
    const everything = sq(-5, -5, 45, 45);
    const result = optimizeCoarse({ source, k: 1, policy: DEFAULT_QUALITY_POLICY, los,
      aoi: { polygon: everything, profile: { rangeMinM: 0, rangeMaxM: 100, azimuthWidthDeg: 150 } } });
    expect(result.status).toBe("NO_CANDIDATES");
    expect(result.candidateGeneration.fallbackReason ?? "").not.toMatch(/se usa una grilla regular/);
    const visible = optimizeCoarse({ source, k: 1, policy: DEFAULT_QUALITY_POLICY, objective: "VISIBLE_AREA", candidateSet: "regular_grid",
      los: (request) => {
        const size = request.grid.grid.length * request.grid.grid[0]!.length;
        return { cell_states: new Uint8Array(size).fill(LOSCellState.VISIBLE), flat_quality_grid: new Float32Array(size).fill(0.9), flat_projection_grid: new Float32Array(size).fill(0.9) };
      },
      aoi: { polygon: sq(20, 20, 30, 30), profile: { rangeMinM: 0, rangeMaxM: 100, azimuthWidthDeg: 150 } } });
    expect(visible.status).toBe("OK");
    expect(visible.aoi!.pctLabel).toMatch(/visible/i);
    expect(visible.aoi!.pctLabel).toMatch(/grilla gruesa/);
  });
});
