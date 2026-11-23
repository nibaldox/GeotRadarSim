/**
 * R14-FIX WP14-2 and WP14-6: orientation and fit on the FINE AOI cells, centred on the minimal arc.
 * `aoi_fits_azimuth: true` must guarantee that the full-resolution LOS leaves no AOI cell in
 * OUTSIDE_FOV, checked with the app's real TS engine (adopted from probes P-A7, P-A6, P-A8, P-U2).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LOSCellState } from "../../types/api";
import { aoiAzimuthWindow, bearingDeg, isBearingInWindow } from "../aoi/aoiAzimuth";
import { aoiMaskForGrid } from "../aoi/aoiMask";
import { orientTowardsAoi, orientWith, prepareAoiCells } from "./aoi";
import { gridInput, loadLosHandler, rarRadar, runLos, withAzimuthOverride } from "./aoiEngine.testSupport";
import { optimizeCoarse } from "./optimize";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import type { LosScorer } from "./types";
import { randomInt, seededRandom } from "./optimizer.testSupport";

vi.mock("../../wasm/loader", () => ({
  flattenGridForWasm: () => { throw new Error("no wasm"); },
  loadRadarWasm: () => Promise.reject(new Error("no wasm")),
}));

const flatGrid = (rows: number, cols: number, min_x: number, min_y: number, resolution: number) => ({
  grid: Array.from({ length: rows }, () => new Array<number>(cols).fill(0)),
  bounds: { min_x, min_y },
  resolution,
});

/** Count AOI cells the engine puts in OUTSIDE_FOV (open elevation, range ≥ 0: only azimuth rejects). */
function outsideFov(states: Uint8Array, mask: Uint8Array): number {
  let count = 0;
  mask.forEach((value, idx) => { if (value === 1 && states[idx] === LOSCellState.OUTSIDE_FOV) count++; });
  return count;
}

const openRadar = rarRadar({ min_range_m: 0, max_range_m: 1e6, elevation_min_deg: -90, elevation_max_deg: 90 });

describe("WP14-2: fit on the fine cells, checked with the full-resolution TS LOS", () => {
  beforeAll(async () => { await loadLosHandler(); });

  it("P-A7 inverted: at the smallest fitting width, the real LOS leaves 0 AOI cells outside the azimuth", () => {
    const g = flatGrid(121, 121, 1000, 2000, 1);
    const mask = aoiMaskForGrid(g, { vertices: [{ x: 1001, y: 2061 }, { x: 1119, y: 2061 }, { x: 1119, y: 2069 }, { x: 1001, y: 2069 }] });
    const cells = prepareAoiCells(g, mask);
    const pos = { x: 1060, y: 2020, z: 2 };
    let width = 60;
    while (!orientTowardsAoi(cells, pos.x, pos.y, width).aoi_fits_azimuth) width += 0.25;
    for (const w of [width - 0.25, width, width + 0.25]) {
      const o = orientTowardsAoi(cells, pos.x, pos.y, w);
      const fine = runLos(gridInput(g, withAzimuthOverride(openRadar, o.az_center_deg, w), pos));
      const n = mask.reduce((sum, v) => sum + v, 0);
      const outside = outsideFov(fine.cell_states, mask);
      expect(outside === 0).toBe(o.aoi_fits_azimuth);
      expect(Object.is(((n - outside) / n) * 100, o.aoi_in_azimuth_pct)).toBe(true);
    }
  });

  it("fits ⇔ 0 cells outside the azimuth and the share is exact, on 60 seeded AOIs × 3 widths (UTM origin)", () => {
    const res = 2;
    const g = flatGrid(61, 61, 351234.37, 6543210.9, res);
    const random = seededRandom(1402);
    let checked = 0;
    let fits = 0;
    for (let t = 0; t < 120 && checked < 180; t++) {
      const r0 = randomInt(random, 0, 50);
      const c0 = randomInt(random, 0, 50);
      const poly = { vertices: [
        { x: g.bounds.min_x + c0 * res, y: g.bounds.min_y + r0 * res },
        { x: g.bounds.min_x + (c0 + randomInt(random, 5, 10)) * res, y: g.bounds.min_y + r0 * res },
        { x: g.bounds.min_x + (c0 + 3) * res, y: g.bounds.min_y + (r0 + randomInt(random, 5, 10)) * res },
      ] };
      let mask: Uint8Array;
      try { mask = aoiMaskForGrid(g, poly); } catch { continue; }
      const pr = randomInt(random, 0, 60);
      const pc = randomInt(random, 0, 60);
      if (mask[pr * 61 + pc]) continue;
      const pos = { x: g.bounds.min_x + pc * res, y: g.bounds.min_y + pr * res, z: 2 };
      const cells = prepareAoiCells(g, mask);
      for (const width of [20, 60, 150]) {
        const o = orientTowardsAoi(cells, pos.x, pos.y, width);
        const fine = runLos(gridInput(g, withAzimuthOverride(openRadar, o.az_center_deg, width), pos));
        const n = mask.reduce((sum, v) => sum + v, 0);
        const outside = outsideFov(fine.cell_states, mask);
        expect(outside === 0).toBe(o.aoi_fits_azimuth);
        expect(Object.is(((n - outside) / n) * 100, o.aoi_in_azimuth_pct)).toBe(true);
        if (o.aoi_fits_azimuth) fits++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(150);
    expect(fits).toBeGreaterThanOrEqual(10);
    expect(checked - fits).toBeGreaterThanOrEqual(10);
  });
});

describe("WP14-2: through optimizeCoarse, every reported fit holds in the full-resolution TS LOS", () => {
  beforeAll(async () => { await loadLosHandler(); });

  it("fits ⇔ 0 AOI cells in OUTSIDE_FOV for every candidate (flat 121 × 121, factor 4, 3 widths)", () => {
    const g = flatGrid(121, 121, 1000, 2000, 1);
    const polygon = { vertices: [{ x: 1001, y: 2061 }, { x: 1119, y: 2061 }, { x: 1119, y: 2069 }, { x: 1001, y: 2069 }] };
    const mask = aoiMaskForGrid(g, polygon);
    const constant: LosScorer = (request) => {
      const size = request.grid.grid.length * request.grid.grid[0]!.length;
      return { cell_states: new Uint8Array(size).fill(LOSCellState.VISIBLE), flat_quality_grid: new Float32Array(size).fill(0.9), flat_projection_grid: new Float32Array(size).fill(0.9) };
    };
    let fits = 0;
    let misfits = 0;
    for (const width of [60, 104, 150]) {
      const result = optimizeCoarse({
        source: g, k: 1, policy: DEFAULT_QUALITY_POLICY, los: constant, candidateSet: "regular_grid", minSeparationM: 0,
        coarseFactor: 4, candidateParams: { maxCandidates: 24 },
        aoi: { polygon, mask, profile: { rangeMinM: 0, rangeMaxM: 1e6, azimuthWidthDeg: width } },
      });
      expect(result.status).toBe("OK");
      for (const info of result.aoi!.candidates) {
        const c = result.candidates[info.index]!;
        const fine = runLos(gridInput(g, withAzimuthOverride(openRadar, info.az_center_deg, width), { x: c.x, y: c.y, z: 2 }));
        const outside = outsideFov(fine.cell_states, mask);
        expect(outside === 0).toBe(info.aoi_fits_azimuth);
        if (info.aoi_fits_azimuth) fits++;
        else misfits++;
      }
    }
    expect(fits).toBeGreaterThan(5);
    expect(misfits).toBeGreaterThan(5);
  }, 120_000);
});

describe("WP14-2 at the boundary: width equal to the spread", () => {
  beforeAll(async () => { await loadLosHandler(); });

  it("reports fits from the exact count, never from spread ≤ width, and agrees with the TS LOS (400 seeded cases)", () => {
    // At width = spread the app's rounded window can drop an extreme cell: fits must then be false.
    const random = seededRandom(1426);
    const res = 0.7;
    const g = flatGrid(41, 41, 351000.3, 6543000.7, res);
    let dropped = 0;
    let kept = 0;
    for (let t = 0; t < 400; t++) {
      const mask = new Uint8Array(41 * 41);
      const n = randomInt(random, 2, 4);
      for (let i = 0; i < n; i++) mask[randomInt(random, 0, mask.length - 1)] = 1;
      const radarNode = randomInt(random, 0, mask.length - 1);
      if (mask[radarNode]) continue;
      const pos = { x: g.bounds.min_x + (radarNode % 41) * res, y: g.bounds.min_y + Math.floor(radarNode / 41) * res, z: 2 };
      const cells = prepareAoiCells(g, mask);
      const spread = orientTowardsAoi(cells, pos.x, pos.y, 359).aoi_spread_deg;
      if (!(spread > 0 && spread < 359)) continue;
      const o = orientTowardsAoi(cells, pos.x, pos.y, spread);
      const fine = runLos(gridInput(g, withAzimuthOverride(openRadar, o.az_center_deg, spread), pos));
      const outside = outsideFov(fine.cell_states, mask);
      expect(o.aoi_fits_azimuth).toBe(outside === 0);
      if (outside > 0) dropped++;
      else kept++;
    }
    // Both outcomes occur, so `fits = spread ≤ width` would be wrong here.
    expect(dropped).toBeGreaterThan(10);
    expect(kept).toBeGreaterThan(10);
  }, 120_000);
});

describe("WP14-6: centre on the minimal arc, or on the window that holds the most cells", () => {
  const grid11 = flatGrid(11, 11, 0, 0, 1);

  it("P-A8 inverted: two opposite cells give 50 % and a centre that is stable under ±1e-9 m", () => {
    const mask = new Uint8Array(121);
    mask[5 * 11 + 0] = 1;
    mask[5 * 11 + 10] = 1;
    const cells = prepareAoiCells(grid11, mask);
    const o = orientTowardsAoi(cells, 5, 5, 150);
    expect(o.aoi_in_azimuth_pct).toBe(50);
    expect(o.aoi_fits_azimuth).toBe(false);
    expect(o.aoi_spread_deg).toBe(180);
    for (const dy of [1e-9, -1e-9]) {
      const p = orientTowardsAoi(cells, 5, 5 + dy, 150);
      expect(p.aoi_in_azimuth_pct).toBe(50);
      expect(Math.abs(p.az_center_deg - o.az_center_deg)).toBeLessThan(1e-6);
    }
  });

  it("reaches the best share of a 0.5° grid search on the U and dumbbell AOIs of the probe", () => {
    const n = 81;
    const g = flatGrid(n, n, 0, 0, 1);
    const shapes = [
      { poly: { vertices: [{ x: 2, y: 30 }, { x: 22, y: 30 }, { x: 22, y: 60 }, { x: 58, y: 60 }, { x: 58, y: 30 }, { x: 78, y: 30 }, { x: 78, y: 78 }, { x: 2, y: 78 }] }, at: [40, 45] },
      { poly: { vertices: [{ x: 2, y: 20 }, { x: 28, y: 20 }, { x: 28, y: 55 }, { x: 52, y: 55 }, { x: 52, y: 20 }, { x: 78, y: 20 }, { x: 78, y: 70 }, { x: 52, y: 70 }, { x: 52, y: 58 }, { x: 28, y: 58 }, { x: 28, y: 70 }, { x: 2, y: 70 }] }, at: [40, 40] },
    ];
    for (const { poly, at } of shapes) {
      const mask = aoiMaskForGrid(g, poly);
      const cells = prepareAoiCells(g, mask);
      const o = orientTowardsAoi(cells, at[0]!, at[1]!, 150);
      const bearings: number[] = [];
      mask.forEach((v, i) => { if (v) bearings.push(bearingDeg(i % n - at[0]!, Math.floor(i / n) - at[1]!)); });
      let best = 0;
      for (let c = -180; c < 180; c += 0.5) {
        const w = aoiAzimuthWindow(c, 150);
        best = Math.max(best, bearings.filter((b) => isBearingInWindow(b, w)).length);
      }
      expect(o.aoi_in_azimuth_pct).toBeGreaterThanOrEqual((best / bearings.length) * 100);
    }
  });

  it("spread ≤ width (with margin) always fits, centred on the arc midpoint (500 seeded cases)", () => {
    const random = seededRandom(1406);
    const g = flatGrid(31, 31, 351000.3, 6543000.7, 0.7);
    let fitting = 0;
    for (let t = 0; t < 500; t++) {
      const mask = new Uint8Array(31 * 31);
      const count = randomInt(random, 1, 40);
      for (let k = 0; k < count; k++) mask[randomInt(random, 0, mask.length - 1)] = 1;
      const pr = randomInt(random, 0, 30);
      const pc = randomInt(random, 0, 30);
      if (mask[pr * 31 + pc]) continue;
      const x = g.bounds.min_x + pc * 0.7;
      const y = g.bounds.min_y + pr * 0.7;
      const cells = prepareAoiCells(g, mask);
      const width = randomInt(random, 10, 200);
      const o = orientTowardsAoi(cells, x, y, width);
      if (o.aoi_spread_deg <= width - 1e-6) {
        expect(o.aoi_fits_azimuth).toBe(true);
        expect(o.aoi_in_azimuth_pct).toBe(100);
        fitting++;
      }
      // Exactness of the reported share against the engine test.
      const window = aoiAzimuthWindow(o.az_center_deg, width);
      let inside = 0;
      for (let i = 0; i < cells.xs.length; i++) if (isBearingInWindow(bearingDeg(cells.xs[i]! - x, cells.ys[i]! - y), window)) inside++;
      expect(o.aoi_in_azimuth_pct).toBe((inside / cells.xs.length) * 100);
    }
    expect(fitting).toBeGreaterThan(100);
  });
});

describe("WP14-2/WP14-6: the bucketed fast path equals the full-sort reference", () => {
  it("gives Object.is-identical orientations on 600 seeded configurations (duplicates, ties, wide and narrow widths)", () => {
    const random = seededRandom(1407);
    let fast = 0;
    for (let t = 0; t < 600; t++) {
      const rows = randomInt(random, 2, 40);
      const cols = randomInt(random, 2, 40);
      const res = [0.3, 1, 2, 0.7][t % 4]!;
      const g = flatGrid(rows, cols, 351234.37, 6543210.9, res);
      const mask = new Uint8Array(rows * cols);
      const density = [0.02, 0.2, 0.6][t % 3]!;
      for (let i = 0; i < mask.length; i++) if (random() < density) mask[i] = 1;
      if (!mask.includes(1)) mask[0] = 1;
      // Radar on a node (may be outside or inside the cloud of cells) or far away.
      const far = t % 5 === 0;
      const x = g.bounds.min_x + (far ? -50 * res : randomInt(random, 0, cols - 1) * res);
      const y = g.bounds.min_y + (far ? randomInt(random, -20, rows + 20) * res : randomInt(random, 0, rows - 1) * res);
      const cells = prepareAoiCells(g, mask);
      const width = [0.5, 5, 30, 90, 150, 200, 359][t % 7]!;
      const a = orientWith(cells, x, y, width, false);
      const b = orientWith(cells, x, y, width, true);
      expect(Object.is(a.az_center_deg, b.az_center_deg)).toBe(true);
      expect(a.aoi_fits_azimuth).toBe(b.aoi_fits_azimuth);
      expect(Object.is(a.aoi_in_azimuth_pct, b.aoi_in_azimuth_pct)).toBe(true);
      expect(Object.is(a.aoi_spread_deg, b.aoi_spread_deg)).toBe(true);
      if (a.aoi_spread_deg < 180 && !a.aoi_fits_azimuth) fast++;
    }
    expect(fast).toBeGreaterThan(50);
  });
});
