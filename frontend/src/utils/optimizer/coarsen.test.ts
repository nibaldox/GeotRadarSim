import { describe, expect, it } from "vitest";
import {
  MAX_COARSE_NODES,
  chooseCoarsenFactor,
  coarseNodeCount,
  coarseRadarZ,
  coarsenGrid,
} from "./coarsen";

describe("coarseNodeCount / chooseCoarsenFactor", () => {
  it("counts nodes per axis as floor((n − 1)/f) + 1", () => {
    expect(coarseNodeCount(543, 4)).toBe(136);
    expect(coarseNodeCount(685, 4)).toBe(172);
    expect(coarseNodeCount(543, 3)).toBe(181);
    expect(coarseNodeCount(685, 3)).toBe(229);
    expect(coarseNodeCount(1, 7)).toBe(1);
    expect(coarseNodeCount(10, 1)).toBe(10);
  });

  it("picks the smallest integer factor with ≤ 40 000 coarse nodes (design examples)", () => {
    expect(MAX_COARSE_NODES).toBe(40_000);
    // STL real 543 × 685: f = 3 gives 41 449 > 40 000; f = 4 gives 23 392.
    expect(coarseNodeCount(543, 3) * coarseNodeCount(685, 3)).toBe(41_449);
    expect(chooseCoarsenFactor(543, 685)).toBe(4);
    expect(coarseNodeCount(543, 4) * coarseNodeCount(685, 4)).toBe(23_392);
    // Bench synthetic 600 × 900: f = 3 gives 60 000; f = 4 gives 33 750.
    expect(chooseCoarsenFactor(600, 900)).toBe(4);
    expect(coarseNodeCount(600, 4) * coarseNodeCount(900, 4)).toBe(33_750);
    // Already small grids keep full resolution.
    expect(chooseCoarsenFactor(200, 200)).toBe(1);
    expect(chooseCoarsenFactor(201, 201)).toBe(2);
    expect(chooseCoarsenFactor(10, 10, 16)).toBe(3);
  });

  it("rejects degenerate inputs", () => {
    expect(() => chooseCoarsenFactor(0, 10)).toThrow(RangeError);
    expect(() => chooseCoarsenFactor(10, 10, 0)).toThrow(RangeError);
    expect(() => coarseNodeCount(10, 0)).toThrow(RangeError);
    expect(() => coarseNodeCount(10, 1.5)).toThrow(RangeError);
  });
});

describe("coarsenGrid", () => {
  const rows = 7;
  const cols = 10;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => r * 100 + c));
  grid[3]![6] = Number.NaN;
  grid[2]![2] = Number.NaN; // not on a multiple of 3 → dropped

  it("keeps the nodes whose indices are multiples of f, NaN stays NODATA", () => {
    const coarse = coarsenGrid({ grid, bounds: { min_x: 1000, min_y: -50 }, resolution: 2 }, 3);
    expect(coarse.rows).toBe(3);
    expect(coarse.cols).toBe(4);
    expect(coarse.factor).toBe(3);
    expect(coarse.resolution).toBe(6);
    expect(coarse.grid).toEqual([
      [0, 3, 6, 9],
      [300, 303, Number.NaN, 309],
      [600, 603, 606, 609],
    ]);
    expect(Number.isNaN(coarse.grid[1]![2])).toBe(true);
  });

  it("follows the extent contract: nodes at min + index × (f·res), max at the last multiple", () => {
    const coarse = coarsenGrid({ grid, bounds: { min_x: 1000, min_y: -50 }, resolution: 2 }, 3);
    expect(coarse.bounds).toEqual({ min_x: 1000, min_y: -50, max_x: 1000 + 3 * 6, max_y: -50 + 2 * 6 });
    // Last effective fine node is the last multiple (col 9, row 6), not the source edge.
    expect(coarse.bounds.max_x).toBe(1000 + 9 * 2);
    expect(coarse.bounds.max_y).toBe(-50 + 6 * 2);
  });

  it("f = 1 returns an independent copy; the source is never mutated", () => {
    const snapshot = JSON.stringify(grid);
    const same = coarsenGrid({ grid, bounds: { min_x: 0, min_y: 0 }, resolution: 1 }, 1);
    expect(same.grid).toEqual(grid);
    expect(same.grid).not.toBe(grid);
    expect(same.grid[0]).not.toBe(grid[0]);
    expect(JSON.stringify(grid)).toBe(snapshot);
  });

  it("validates grid shape, resolution and factor", () => {
    const bounds = { min_x: 0, min_y: 0 };
    expect(() => coarsenGrid({ grid: [], bounds, resolution: 1 }, 1)).toThrow(RangeError);
    expect(() => coarsenGrid({ grid: [[1, 2], [3]], bounds, resolution: 1 }, 1)).toThrow(RangeError);
    expect(() => coarsenGrid({ grid, bounds, resolution: 0 }, 1)).toThrow(RangeError);
    expect(() => coarsenGrid({ grid, bounds, resolution: 1 }, 0)).toThrow(RangeError);
    expect(() => coarsenGrid({ grid, bounds: { min_x: Number.NaN, min_y: 0 }, resolution: 1 }, 1)).toThrow(RangeError);
  });
});

describe("coarseRadarZ (buried-radar adjustment of the coarse pass)", () => {
  it("uses max(fine ground, coarse surface) + h and flags the adjustment", () => {
    expect(coarseRadarZ(10, 12.5, 2)).toEqual({ z: 14.5, adjusted: true });
    expect(coarseRadarZ(10, 9, 2)).toEqual({ z: 12, adjusted: false });
    expect(coarseRadarZ(10, 10, 2)).toEqual({ z: 12, adjusted: false });
    expect(coarseRadarZ(10, null, 2)).toEqual({ z: 12, adjusted: false });
  });

  it("rejects non-finite ground or height", () => {
    expect(() => coarseRadarZ(Number.NaN, 1, 2)).toThrow(RangeError);
    expect(() => coarseRadarZ(1, 1, -1)).toThrow(RangeError);
  });
});
