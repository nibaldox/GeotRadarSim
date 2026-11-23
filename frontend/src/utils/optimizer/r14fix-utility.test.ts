/**
 * R14-FIX WP14-1: with an AOI the candidate pool adds open ground (quota with berms and edges),
 * and a run where no candidate adds AOI coverage ends in NO_COVERAGE instead of a silent OK.
 * Adopted from the R14 probe P-U2 (benched wall), with the app's real TS LOS engine.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LOSCellState } from "../../types/api";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import { aoiMaskForGrid } from "../aoi/aoiMask";
import type { AoiPolygon } from "../aoi/aoiPolygon";
import { generateCandidates } from "./candidates";
import { optimizeCoarse } from "./optimize";
import { gridInput, loadLosHandler, rarRadar, realScorer, runLos, withAzimuthOverride } from "./aoiEngine.testSupport";
import { asLOSResponse } from "./optimizer.testSupport";
import { computeAoiCoverage } from "../aoi/aoiCoverage";
import type { LosScorer, OptimizerGrid } from "./types";

vi.mock("../../wasm/loader", () => ({
  flattenGridForWasm: () => { throw new Error("no wasm"); },
  loadRadarWasm: () => Promise.reject(new Error("no wasm")),
}));

const RES = 2;
const X0 = 351000;
const Y0 = 6543000;

/** Benched wall rising north: floor y ≤ 150 (z = 0); 10 benches of 15 m (face 65°, berm 8 m); flat crest. 201 × 301, 2 m. */
function bermWall(): OptimizerGrid {
  const face = 15 / Math.tan((65 * Math.PI) / 180);
  const step = face + 8;
  const z = (y: number) => {
    if (y <= 150) return 0;
    const t = y - 150;
    const k = Math.floor(t / step);
    if (k >= 10) return 150;
    const u = t - k * step;
    return k * 15 + (u < face ? (u / face) * 15 : 15);
  };
  return { grid: Array.from({ length: 301 }, (_, r) => new Array<number>(201).fill(z(r * RES))), bounds: { min_x: X0, min_y: Y0 }, resolution: RES };
}

/** Benches 3–7 of the wall. */
const BENCHES: AoiPolygon = {
  vertices: [{ x: X0 + 60, y: Y0 + 195 }, { x: X0 + 340, y: Y0 + 195 }, { x: X0 + 340, y: Y0 + 270 }, { x: X0 + 60, y: Y0 + 270 }],
};

const radar = rarRadar();
const PROFILE = { rangeMinM: radar.min_range_m!, rangeMaxM: radar.max_range_m, azimuthWidthDeg: radar.h_beam_width_deg };

describe("WP14-1: open ground in the AOI candidate pool", () => {
  beforeAll(async () => { await loadLosHandler(); });

  it("on a benched wall chooses the open floor (≈ 42 % coarse), confirmed by the full-resolution TS LOS", () => {
    const source = bermWall();
    const mask = aoiMaskForGrid(source, BENCHES);
    const result = optimizeCoarse({
      source, k: 1, policy: DEFAULT_QUALITY_POLICY, los: realScorer(radar), objective: "USEFUL_INCIDENCE",
      minSeparationM: 20, aoi: { polygon: BENCHES, mask, profile: PROFILE },
    });
    expect(result.status).toBe("OK");
    const kinds = new Set(result.candidates.map((candidate) => candidate.kind));
    expect(kinds.has("OPEN_GROUND")).toBe(true);
    expect([...kinds].some((kind) => kind === "BERM" || kind === "CREST" || kind === "PERIMETER")).toBe(true);
    expect(result.candidates.length).toBeLessThanOrEqual(160);
    const pick = result.candidates[result.greedy!.selected[0]!]!;
    expect(pick.kind).toBe("OPEN_GROUND");
    expect(pick.y - Y0).toBeLessThan(150); // the floor
    const pct = result.greedy!.aoi_useful_pct!;
    expect(pct).toBeGreaterThan(38);
    expect(pct).toBeLessThan(46);
    // Same position and azimuth centre with the full-resolution TS LOS (WP8's verification path).
    const az = result.aoi!.candidates[pick.index]!.az_center_deg;
    const fine = runLos(gridInput(source, withAzimuthOverride(radar, az), { x: pick.x, y: pick.y, z: pick.groundZ + 2 }));
    const key = { terrain_id: "dtm-test", epoch: 1 };
    const coverage = computeAoiCoverage(asLOSResponse({
      cell_states: fine.cell_states, flat_quality_grid: fine.flat_quality_grid!, flat_projection_grid: fine.flat_projection_grid!,
    }, 301, 201, RES), mask, DEFAULT_QUALITY_POLICY, {
      metric: "INCIDENCE", terrainGrid: source.grid, terrainResolution: RES, terrainKey: key,
      snapshot: { terrainKey: key, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] },
    })!;
    expect(coverage.usefulPct!).toBeGreaterThan(38);
  }, 120_000);
});

describe("WP14-1: open-ground quota in generateCandidates", () => {
  // Stepped terrain: flat benches with steep faces (berms) plus wide flat ground.
  const stepped = (): OptimizerGrid => ({
    grid: Array.from({ length: 60 }, () => Array.from({ length: 80 }, (_, c) => (c < 20 ? 30 : c < 22 ? 30 - 5 * (c - 19) : 20))),
    bounds: { min_x: 0, min_y: 0 },
    resolution: 1,
  });

  it("splits N into ⌈N/2⌉ berms/edges and ⌊N/2⌋ open ground, ceding the surplus, in row-major order", () => {
    const source = stepped();
    const result = generateCandidates(source, {
      minSeparationM: 0, params: { maxCandidates: 10 }, nodeFilter: () => true, openGround: true,
    });
    const edges = result.candidates.filter((candidate) => candidate.kind !== "OPEN_GROUND").length;
    const open = result.candidates.filter((candidate) => candidate.kind === "OPEN_GROUND").length;
    // Box thinning returns at most its cap, so each group holds ≤ its share of the quota.
    expect(edges).toBeGreaterThan(0);
    expect(edges).toBeLessThanOrEqual(5);
    expect(open).toBeGreaterThan(0);
    expect(edges + open).toBeLessThanOrEqual(10);
    expect(result.openGroundQuota).toEqual({ edges, openGround: open });
    expect(result.candidates.filter((c) => c.kind === "OPEN_GROUND").every((c) => c.col < 9 || c.col > 31)).toBe(true);
    const idx = result.candidates.map((candidate) => candidate.row * 80 + candidate.col);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(result.candidates.map((candidate) => candidate.index)).toEqual(result.candidates.map((_, i) => i));
    // Only two berm/edge nodes pass the filter: open ground takes the other 8 slots.
    const fewEdges = generateCandidates(source, {
      minSeparationM: 0, params: { maxCandidates: 10 }, openGround: true,
      nodeFilter: (node) => (node % 80 >= 9 && node % 80 <= 31 ? node === 30 * 80 + 25 || node === 30 * 80 + 28 : true),
    });
    expect(fewEdges.candidates.filter((candidate) => candidate.kind !== "OPEN_GROUND").length).toBe(2);
    const fewOpen = fewEdges.openGroundQuota!.openGround;
    expect(fewEdges.openGroundQuota).toEqual({ edges: 2, openGround: fewOpen });
    // The 3 slots the edges could not use go to open ground: more than its own share of 5.
    expect(fewOpen).toBeGreaterThan(5);
    expect(fewOpen).toBeLessThanOrEqual(8);
    // And the reverse: no open ground left, the edges take every slot.
    const noOpen = generateCandidates(source, {
      minSeparationM: 0, params: { maxCandidates: 10 }, openGround: true,
      nodeFilter: (node) => node % 80 >= 9 && node % 80 <= 31,
    });
    expect(noOpen.openGroundQuota!.openGround).toBe(0);
    expect(noOpen.openGroundQuota!.edges).toBeGreaterThan(5);
    expect(noOpen.openGroundQuota!.edges).toBeLessThanOrEqual(10);
  });

  it("is absent without the option (no openGroundQuota key, no OPEN_GROUND kind)", () => {
    const result = generateCandidates(stepped(), { minSeparationM: 0, params: { maxCandidates: 10 }, nodeFilter: () => true });
    expect("openGroundQuota" in result).toBe(false);
    expect(result.candidates.some((candidate) => candidate.kind === "OPEN_GROUND")).toBe(false);
  });
});

describe("WP14-1: NO_COVERAGE", () => {
  const flat = (): OptimizerGrid => ({
    grid: Array.from({ length: 60 }, (_, r) => Array.from({ length: 60 }, (_, c) => (r < 30 ? 0 : c < 30 ? 10 : 0))),
    bounds: { min_x: 0, min_y: 0 },
    resolution: 1,
  });
  const polygon: AoiPolygon = { vertices: [{ x: 35, y: 35 }, { x: 55, y: 35 }, { x: 55, y: 55 }, { x: 35, y: 55 }] };
  const losWith = (state: (subject: "candidate" | "fixed") => number): LosScorer => (request) => {
    const size = request.grid.grid.length * request.grid.grid[0]!.length;
    const s = state(request.subject.kind);
    const cell_states = new Uint8Array(size).fill(s);
    const q = new Float32Array(size).fill(s === LOSCellState.VISIBLE ? 0.9 : -1);
    return { cell_states, flat_quality_grid: q, flat_projection_grid: Float32Array.from(q, (v) => (v < 0 ? Number.NaN : v)) };
  };

  it("replaces a silent OK at 0 % when no candidate sees the AOI", () => {
    const result = optimizeCoarse({
      source: flat(), k: 2, policy: DEFAULT_QUALITY_POLICY, los: losWith(() => LOSCellState.SHADOW), minSeparationM: 5,
      candidateSet: "regular_grid", aoi: { polygon, profile: { rangeMinM: 0, rangeMaxM: 500, azimuthWidthDeg: 150 } },
    });
    expect(result.status).toBe("NO_COVERAGE");
    expect(result.aoi!.message).toBe("Ninguna ubicación candidata ve el área con la métrica elegida.");
    expect(result.greedy!.selected).toEqual([]);
    expect(result.candidateValues.every((value) => value === 0)).toBe(true);
  });

  it("says so when fixed radars already cover what any candidate would add", () => {
    const result = optimizeCoarse({
      source: flat(), k: 1, policy: DEFAULT_QUALITY_POLICY, los: losWith(() => LOSCellState.VISIBLE), minSeparationM: 5,
      candidateSet: "regular_grid", fixed: [{ x: 1, y: 1, z: 5 }],
      aoi: { polygon, profile: { rangeMinM: 0, rangeMaxM: 500, azimuthWidthDeg: 150 } },
    });
    expect(result.status).toBe("NO_COVERAGE");
    expect(result.aoi!.message).toBe("Ninguna ubicación candidata agrega cobertura del área a la de los radares fijos con la métrica elegida.");
  });
});
