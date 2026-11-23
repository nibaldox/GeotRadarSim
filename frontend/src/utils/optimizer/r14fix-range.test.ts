/**
 * R14-FIX WP14-3 and WP14-7: range filter in O(V) per node from the AOI polygon, inclusive with a
 * relative tolerance so it never drops a node the engine would accept (adopted from probes P-B8, P-A9).
 */
import { describe, expect, it } from "vitest";
import { validateAoiPolygon } from "../aoi/aoiPolygon";
import { aoiMaskForGrid } from "../aoi/aoiMask";
import { aoiRangeFilter } from "./aoi";
import { optimizeCoarse } from "./optimize";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import { LOSCellState } from "../../types/api";
import { randomInt, seededRandom } from "./optimizer.testSupport";
import type { LosScorer, OptimizerGrid } from "./types";

const constLos: LosScorer = (request) => {
  const { grid } = request.grid;
  const rows = grid.length;
  const cols = grid[0]!.length;
  const size = rows * cols;
  const cell_states = new Uint8Array(size).fill(LOSCellState.VISIBLE);
  const q = new Float32Array(size).fill(0.9);
  for (let i = 0; i < size; i++) {
    if (!Number.isFinite(grid[Math.floor(i / cols)]![i % cols]!)) { cell_states[i] = LOSCellState.NODATA; q[i] = -1; }
  }
  return { cell_states, flat_quality_grid: q, flat_projection_grid: Float32Array.from(q) };
};

/** The probe's STL-sized synthetic pit (685 × 543 at 2 m, UTM-like origin). */
function stlSizedPit(rows = 685, cols = 543, res = 2): OptimizerGrid {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    const d = Math.hypot((c - cx) / cx, (r - cy) / cy);
    if (d > 1.02) return Number.NaN;
    const level = Math.min(10, Math.floor(d * 12));
    const frac = d * 12 - Math.floor(d * 12);
    return level * 15 + (frac > 0.6 ? ((frac - 0.6) / 0.4) * 15 : 0) - 150;
  }));
  return { grid, bounds: { min_x: 351234.37, min_y: 6543210.9 }, resolution: res };
}

/** Engine acceptance of one AOI cell from a radar node: !(d < min || d > max) with the engine's hypot. */
const engineIn = (cx: number, cy: number, rx: number, ry: number, min: number, max: number): boolean => {
  const d = Math.hypot(cx - rx, cy - ry);
  return !(d < min || d > max || !Number.isFinite(d));
};

describe("WP14-3: range filter cost", () => {
  it("P-B8 inverted: 685 × 543, AOI of 400 × 400 nodes, 50–150 m — filter over every outside node in < 1 s", () => {
    const res = 2;
    const src = stlSizedPit(685, 543, res);
    const { min_x: x0, min_y: y0 } = src.bounds;
    const side = 400;
    const r0 = 342 - side / 2;
    const c0 = 271 - side / 2;
    const polygon = { vertices: [
      { x: x0 + c0 * res, y: y0 + r0 * res }, { x: x0 + (c0 + side) * res, y: y0 + r0 * res },
      { x: x0 + (c0 + side) * res, y: y0 + (r0 + side) * res }, { x: x0 + c0 * res, y: y0 + (r0 + side) * res },
    ] };
    const mask = aoiMaskForGrid(src, polygon);
    const t0 = performance.now();
    const inRange = aoiRangeFilter(validateAoiPolygon(polygon), 50, 150);
    let ok = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) continue;
      if (inRange(x0 + (i % 543) * res, y0 + Math.floor(i / 543) * res)) ok++;
    }
    const filterMs = performance.now() - t0;
    expect(ok).toBeGreaterThan(100_000);
    expect(filterMs).toBeLessThan(1000);
    const t1 = performance.now();
    const result = optimizeCoarse({
      source: src, k: 2, policy: DEFAULT_QUALITY_POLICY, los: constLos,
      aoi: { polygon, mask, profile: { rangeMinM: 50, rangeMaxM: 150, azimuthWidthDeg: 150 } },
    });
    const totalMs = performance.now() - t1;
    expect(result.status).toBe("OK");
    // Logged for the report (one run, Node/jsdom, not a browser measurement).
    (globalThis as { process?: { stdout?: { write?: (s: string) => void } } }).process?.stdout?.write?.(
      `WP14-3 timing: filter ${filterMs.toFixed(0)} ms over ${mask.length - mask.reduce((s, v) => s + v, 0)} nodes; optimizeCoarse ${totalMs.toFixed(0)} ms\n`);
  }, 60_000);
});

describe("WP14-3/WP14-7: range filter semantics", () => {
  it("never rejects a node from which some AOI cell is in range for the engine (300 seeded polygons, non-dyadic res)", () => {
    const random = seededRandom(1403);
    let accepted = 0;
    let rejected = 0;
    for (let t = 0; t < 300; t++) {
      const rows = randomInt(random, 4, 26);
      const cols = randomInt(random, 4, 26);
      const res = [0.1, 0.3, 0.7, 1, 2, 3.3][t % 6]!;
      const min_x = 351000 + random() * 1000;
      const min_y = 6.5e6 + random() * 1000;
      const g = { grid: Array.from({ length: rows }, () => new Array<number>(cols).fill(0)), bounds: { min_x, min_y }, resolution: res };
      const n = randomInt(random, 3, 9);
      const cx = min_x + random() * (cols - 1) * res;
      const cy = min_y + random() * (rows - 1) * res;
      const radius = (0.2 + random() * 0.6) * Math.max(rows, cols) * res * 0.5;
      const vertices = Array.from({ length: n }, (_, k) => {
        const a = (2 * Math.PI * (k + 0.2 + 0.6 * random())) / n;
        const r = radius * (0.35 + 0.65 * random());
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });
      let mask: Uint8Array;
      try { mask = aoiMaskForGrid(g, { vertices }); } catch { continue; }
      const span = Math.hypot(rows, cols) * res;
      const a = random() * span;
      const b = random() * span;
      const lo = t % 5 === 0 ? 0 : Math.min(a, b);
      const hi = Math.max(a, b);
      const filter = aoiRangeFilter(validateAoiPolygon({ vertices }), lo, hi);
      for (let idx = 0; idx < mask.length; idx++) {
        if (mask[idx]) continue;
        const x = min_x + (idx % cols) * res;
        const y = min_y + Math.floor(idx / cols) * res;
        let engine = false;
        for (let cell = 0; cell < mask.length && !engine; cell++) {
          if (mask[cell] === 1) engine = engineIn(min_x + (cell % cols) * res, min_y + Math.floor(cell / cols) * res, x, y, lo, hi);
        }
        const ours = filter(x, y);
        if (engine) expect(ours).toBe(true);
        if (ours) accepted++;
        else rejected++;
      }
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(1000);
  });

  it("P-A9 inverted: exactly at the limit, with non-dyadic resolutions, it never drops what the engine accepts", () => {
    const triples: Array<[number, number]> = [[3, 4], [6, 8], [30, 40], [60, 80], [5, 12], [8, 15], [20, 21]];
    const random = seededRandom(99);
    let engineAccepted = 0;
    for (let t = 0; t < 4000; t++) {
      const [a, b] = triples[t % triples.length]!;
      const res = [0.1, 0.2, 0.25, 0.3, 0.5, 0.7, 1, 1.5, 2, 3][randomInt(random, 0, 9)]!;
      const minX = 350000 + random() * 1000;
      const minY = 6.5e6 + random() * 1000;
      const rx = minX + 1 * res;
      const ry = minY + 1 * res;
      const cx = minX + (a + 1) * res;
      const cy = minY + (b + 1) * res;
      // One-node AOI: a small square around the node (the polygon the user drew around it).
      const h = res / 4;
      const polygon = validateAoiPolygon({ vertices: [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }] });
      const d = Math.hypot(a, b) * res;
      for (const [lo, hi] of [[d, 1e9], [0, d]] as const) {
        if (!engineIn(cx, cy, rx, ry, lo, hi)) continue;
        engineAccepted++;
        expect(aoiRangeFilter(polygon, lo, hi)(rx, ry)).toBe(true);
      }
    }
    expect(engineAccepted).toBeGreaterThan(3000);
  });

  it("is inclusive with a relative tolerance of 1e-9 · max(1, d) and rejects clearly out-of-band nodes", () => {
    const polygon = validateAoiPolygon({ vertices: [{ x: 100, y: 0 }, { x: 110, y: 0 }, { x: 110, y: 10 }, { x: 100, y: 10 }] });
    // From the origin: nearest point (100, 0) at 100 m, farthest vertex (110, 10) at √12200 ≈ 110.454 m.
    expect(aoiRangeFilter(polygon, 0, 100)(0, 0)).toBe(true);
    expect(aoiRangeFilter(polygon, 0, 100 - 0.5e-7)(0, 0)).toBe(true); // within 1e-9 · 100
    expect(aoiRangeFilter(polygon, 0, 100 - 1e-6)(0, 0)).toBe(false);
    expect(aoiRangeFilter(polygon, Math.sqrt(12200), 1e9)(0, 0)).toBe(true);
    expect(aoiRangeFilter(polygon, Math.sqrt(12200) + 1e-6, 1e9)(0, 0)).toBe(false);
    expect(aoiRangeFilter(polygon, 103, 104)(0, 0)).toBe(true); // band strictly between nearest and farthest
    expect(aoiRangeFilter(polygon, 0, 0)(105, 5)).toBe(true); // inside the polygon: distance 0
  });
});
