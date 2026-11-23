import { describe, expect, it } from "vitest";
import { randomInt, seededRandom } from "../optimizer/optimizer.testSupport";
import { aoiMaskCellCount, aoiMaskFingerprint, aoiMaskForGrid } from "./aoiMask";
import type { AoiGrid } from "./aoiMask";
import { AoiError, pointInAoiPolygon, validateAoiPolygon } from "./aoiPolygon";
import type { AoiErrorCode, AoiPolygon } from "./aoiPolygon";

const poly = (...points: Array<[number, number]>): AoiPolygon => ({ vertices: points.map(([x, y]) => ({ x, y })) });

function terrain(rows: number, cols: number, resolution = 1, min_x = 0, min_y = 0, nodata: number[] = []): AoiGrid {
  const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(5));
  for (const idx of nodata) grid[Math.floor(idx / cols)]![idx % cols] = Number.NaN;
  return { grid, bounds: { min_x, min_y }, resolution };
}

/** Cells set in a mask as "row,col" strings, for readable expectations. */
function cellsOf(mask: Uint8Array, cols: number): string[] {
  const out: string[] = [];
  mask.forEach((value, idx) => { if (value === 1) out.push(`${Math.floor(idx / cols)},${idx % cols}`); });
  return out;
}

function expectCode(fn: () => unknown, code: AoiErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AoiError);
    expect((error as AoiError).code).toBe(code);
    return;
  }
  throw new Error(`expected AoiError ${code}`);
}

/** Reference: test every node with the exact node coordinate, without the bbox window. */
function bruteMask(source: AoiGrid, polygon: AoiPolygon): Uint8Array {
  const validated = validateAoiPolygon(polygon);
  const rows = source.grid.length;
  const cols = source.grid[0]!.length;
  const mask = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = source.bounds.min_x + c * source.resolution;
      const y = source.bounds.min_y + r * source.resolution;
      if (Number.isFinite(source.grid[r]![c]!) && pointInAoiPolygon(validated, x, y)) mask[r * cols + c] = 1;
    }
  }
  return mask;
}

describe("aoiMaskForGrid", () => {
  it("uses the LOS index convention and the node as the cell centre (vertices on nodes are inside)", () => {
    // 4 rows × 5 cols, origin (100, 200), 2 m: node (r, c) at (100 + 2c, 200 + 2r).
    const source = terrain(4, 5, 2, 100, 200);
    const mask = aoiMaskForGrid(source, poly([102, 202], [106, 202], [106, 204], [102, 204]));
    expect(mask).toBeInstanceOf(Uint8Array);
    expect(mask).toHaveLength(20);
    expect(cellsOf(mask, 5)).toEqual(["1,1", "1,2", "1,3", "2,1", "2,2", "2,3"]);
  });

  it("follows a concave polygon and leaves its notch out", () => {
    const source = terrain(8, 8);
    const mask = aoiMaskForGrid(source, poly([0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]));
    expect(mask[4 * 8 + 3]).toBe(0); // inside the notch
    expect(mask[4 * 8 + 1]).toBe(1);
    expect(mask[4 * 8 + 5]).toBe(1);
    expect(mask[1 * 8 + 3]).toBe(1);
    // 7 × 7 nodes of the closed square minus the 4 nodes strictly inside the notch (x = 3, y = 3…6).
    expect(aoiMaskCellCount(mask)).toBe(45);
    expect(mask).toEqual(bruteMask(source, poly([0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6])));
  });

  it("keeps a polygon one cell thin: exactly the row of nodes it covers", () => {
    const source = terrain(6, 10);
    const mask = aoiMaskForGrid(source, poly([1.5, 2.75], [7.5, 2.75], [7.5, 3.25], [1.5, 3.25]));
    expect(cellsOf(mask, 10)).toEqual(["3,2", "3,3", "3,4", "3,5", "3,6", "3,7"]);
    // A sliver between two node rows holds no node.
    expectCode(() => aoiMaskForGrid(source, poly([1.5, 2.2], [7.5, 2.2], [7.5, 2.8], [1.5, 2.8])), "AOI_NO_VALID_CELLS");
  });

  it("leaves NODATA nodes out and rejects an AOI with only NODATA inside", () => {
    const source = terrain(5, 5, 1, 0, 0, [12, 13]);
    const mask = aoiMaskForGrid(source, poly([1, 1], [3, 1], [3, 3], [1, 3]));
    expect(mask[12]).toBe(0);
    expect(mask[13]).toBe(0);
    expect(aoiMaskCellCount(mask)).toBe(7);
    expectCode(() => aoiMaskForGrid(source, poly([1.8, 2.2], [3.2, 2.2], [3.2, 2.6], [1.8, 2.6])), "AOI_NO_VALID_CELLS");
  });

  it("raises a typed error for an AOI outside the terrain and for an invalid grid or polygon", () => {
    const source = terrain(5, 5, 1, 1000, 2000);
    expectCode(() => aoiMaskForGrid(source, poly([0, 0], [10, 0], [10, 10])), "AOI_OUTSIDE_TERRAIN");
    expectCode(() => aoiMaskForGrid(source, poly([1004.5, 2000], [1010, 2000], [1010, 2004])), "AOI_OUTSIDE_TERRAIN");
    expectCode(() => aoiMaskForGrid({ ...source, resolution: 0 }, poly([1000, 2000], [1004, 2000], [1004, 2004])), "AOI_GRID_INVALID");
    expectCode(() => aoiMaskForGrid({ ...source, grid: [] }, poly([1000, 2000], [1004, 2000], [1004, 2004])), "AOI_GRID_INVALID");
    expectCode(() => aoiMaskForGrid(source, poly([1000, 2000], [1004, 2004], [1004, 2000], [1000, 2004])), "AOI_SELF_INTERSECTION");
  });

  it("is deterministic and equals a full per-node scan on 300 seeded polygons", () => {
    const random = seededRandom(1414);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const rows = randomInt(random, 3, 30);
      const cols = randomInt(random, 3, 30);
      const resolution = [0.5, 1, 2, 3.7][i % 4]!;
      const min_x = randomInt(random, -500, 500) + 0.25 * (i % 3);
      const min_y = randomInt(random, -500, 500);
      const nodata = Array.from({ length: randomInt(random, 0, 10) }, () => randomInt(random, 0, rows * cols - 1));
      const source = terrain(rows, cols, resolution, min_x, min_y, nodata);
      // Star-shaped polygon around a point of the extent: always simple.
      const n = randomInt(random, 3, 12);
      const cx = min_x + random() * (cols - 1) * resolution;
      const cy = min_y + random() * (rows - 1) * resolution;
      const radius = (0.3 + random() * 0.7) * Math.max(rows, cols) * resolution * 0.6;
      const vertices = Array.from({ length: n }, (_, k) => {
        const angle = (2 * Math.PI * (k + 0.2 + 0.6 * random())) / n;
        const r = radius * (0.35 + 0.65 * random());
        // Snap some vertices onto nodes to exercise the boundary rule.
        const snap = random() < 0.3;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        return snap
          ? { x: min_x + Math.round((x - min_x) / resolution) * resolution, y: min_y + Math.round((y - min_y) / resolution) * resolution }
          : { x, y };
      });
      let expected: Uint8Array;
      try {
        expected = bruteMask(source, { vertices });
      } catch (error) {
        expect(error).toBeInstanceOf(AoiError);
        continue;
      }
      if (aoiMaskCellCount(expected) === 0) {
        expect(() => aoiMaskForGrid(source, { vertices })).toThrow(AoiError);
        continue;
      }
      const first = aoiMaskForGrid(source, { vertices });
      expect(first).toEqual(expected);
      expect(aoiMaskForGrid(source, { vertices })).toEqual(first);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe("mask helpers", () => {
  it("counts cells and rejects bytes other than 0 and 1", () => {
    expect(aoiMaskCellCount(Uint8Array.from([0, 1, 1, 0]))).toBe(2);
    expect(() => aoiMaskCellCount(Uint8Array.from([0, 2]))).toThrow(RangeError);
    expect(() => aoiMaskCellCount([0, 1] as never)).toThrow(RangeError);
  });

  it("fingerprints the content: equal masks agree, any change differs", () => {
    const a = Uint8Array.from([0, 1, 1, 0, 1]);
    expect(aoiMaskFingerprint(a)).toBe(aoiMaskFingerprint(Uint8Array.from(a)));
    expect(aoiMaskFingerprint(a)).not.toBe(aoiMaskFingerprint(Uint8Array.from([1, 0, 1, 0, 1])));
    expect(aoiMaskFingerprint(a)).not.toBe(aoiMaskFingerprint(Uint8Array.from([0, 1, 1, 0, 1, 0])));
  });
});
