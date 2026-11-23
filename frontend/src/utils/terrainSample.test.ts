import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleTerrainAtCoordinates } from "./terrainSample";

afterEach(() => vi.unstubAllGlobals());

describe("terrain sampling parity", () => {
  it("matches the worker bit-for-bit on seeded interior, edges, diagonals, NODATA and outside points", async () => {
    vi.resetModules();
    const workerScope = { onmessage: null };
    vi.stubGlobal("self", workerScope);
    const { sampleTerrainAtCoordinates: workerSample } = await import("../workers/losWorker");
    expect(workerScope.onmessage).not.toBeNull();
    const grid = Array.from({ length: 9 }, (_, row) =>
      Array.from({ length: 13 }, (_, col) => (row === 4 && col === 6 ? NaN : row * 17 - col * 3 + row * col / 8)),
    );
    const bounds = { min_x: -125, min_y: 230 };
    const resolution = 2;
    let state = 0x71a2b3c4;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
    let nulls = 0;
    let finite = 0;
    for (let i = 0; i < 15000; i++) {
      const col = Math.floor(random() * 12);
      const row = Math.floor(random() * 8);
      const t = random();
      let gx: number;
      let gy: number;
      switch (i % 6) {
        case 0: gx = random() * 12; gy = random() * 8; break;
        case 1: gx = col; gy = row + t; break;
        case 2: gx = col + t; gy = row + (1 - t); break;
        case 3: gx = 5 + random() * 2; gy = 3 + random() * 2; break;
        case 4: gx = i % 2 ? -0.1 - random() : 12.1 + random(); gy = random() * 8; break;
        default: gx = col + t; gy = i % 2 ? 0 : 8;
      }
      const x = bounds.min_x + gx * resolution;
      const y = bounds.min_y + gy * resolution;
      const actual = sampleTerrainAtCoordinates(grid, bounds, resolution, x, y);
      const expected = workerSample(grid, bounds, resolution, x, y);
      if (actual === null) nulls++; else finite++;
      expect(Object.is(actual, expected), `point ${i}: ${gx}, ${gy}`).toBe(true);
    }
    expect(nulls).toBeGreaterThan(0);
    expect(finite).toBeGreaterThan(0);
    expect(sampleTerrainAtCoordinates(grid, bounds, resolution, bounds.min_x + 11, bounds.min_y + 7)).toBeNull();
    expect(sampleTerrainAtCoordinates(grid, bounds, resolution, bounds.min_x, bounds.min_y)).toBe(0);
  });

  it("returns null for invalid grids and coordinates", () => {
    const bounds = { min_x: 0, min_y: 0 };
    expect(sampleTerrainAtCoordinates([[0, 1], [1]], bounds, 1, 0, 0)).toBeNull();
    expect(sampleTerrainAtCoordinates([[0, 1], [1, 2]], bounds, 0, 0, 0)).toBeNull();
    expect(sampleTerrainAtCoordinates([[0, 1], [1, 2]], bounds, 1, NaN, 0)).toBeNull();
  });
});
