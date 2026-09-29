/**
 * Tests for terrain visualization utilities.
 *
 * These pure functions handle the data transformations needed
 * by the Three.js terrain mesh — testable without WebGL.
 */

import { describe, it, expect } from "vitest";
import {
  elevationToColor,
  normalizeGrid,
  buildVertexData,
  getMinElevation,
  getMaxElevation,
  getTerrainExtent,
} from "../utils/terrain";

describe("elevationToColor", () => {
  it("maps minimum elevation to blue (0,0,1)", () => {
    const [r, g, b] = elevationToColor(0, 0, 100);
    expect(r).toBeCloseTo(0, 1);
    expect(g).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(1, 1);
  });

  it("maps maximum elevation to red (1,0,0)", () => {
    const [r, g, b] = elevationToColor(100, 0, 100);
    expect(r).toBeCloseTo(1, 1);
    expect(g).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("maps mid elevation to greenish (gradient midpoint)", () => {
    const [_r, g, _b] = elevationToColor(50, 0, 100);
    // At midpoint of blue→green→red gradient, should be near green
    expect(g).toBeGreaterThan(0.3);
  });

  it("returns neutral grey on min >= max (degenerate range)", () => {
    expect(elevationToColor(50, 100, 100)).toEqual([0.7, 0.7, 0.7]);
    expect(elevationToColor(50, 101, 100)).toEqual([0.7, 0.7, 0.7]);
  });
});

describe("normalizeGrid", () => {
  it("returns flat Float32Array of vertex positions from a grid", () => {
    const grid = [
      [10, 20],
      [30, 40],
    ];
    const result = normalizeGrid(grid, 0, 0, 1.0);

    // 2x2 grid = 4 vertices, each with x,y,z = 12 floats
    expect(result.length).toBe(12);
    // First vertex: x=0, y=10, z=0
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(10);
    expect(result[2]).toBe(0);
    // Second vertex: x=1, y=20, z=0
    expect(result[3]).toBe(1);
    expect(result[4]).toBe(20);
    expect(result[5]).toBe(0);
  });

  it("handles single-cell grid", () => {
    const grid = [[5]];
    const result = normalizeGrid(grid, 0, 0, 2.0);

    expect(result.length).toBe(3);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(5);
    expect(result[2]).toBe(0);
  });
});

describe("buildVertexData", () => {
  it("returns positions, colors, and indices from a grid", () => {
    const grid = [
      [0, 5, 10],
      [3, 8, 15],
      [6, 12, 20],
    ];
    const { positions, colors, indices } = buildVertexData(grid, 0, 0, 1.0);

    // 3x3 = 9 vertices
    const vertexCount = 9;
    expect(positions.length).toBe(vertexCount * 3);
    expect(colors.length).toBe(vertexCount * 3);

    // Indices: (3-1)*(3-1) = 4 quads * 2 triangles * 3 = 24
    expect(indices.length).toBe(24);

    // First triangle indices should be valid
    expect(indices[0]!).toBeGreaterThanOrEqual(0);
    expect(indices[0]!).toBeLessThan(vertexCount);
  });

  it("produces consistent position and color counts", () => {
    const grid = [[1, 2], [3, 4]];
    const { positions, colors } = buildVertexData(grid, 0, 0, 1.0);

    // Same number of position and color components
    expect(positions.length).toBe(colors.length);
    // Every 3 color components should be in [0,1]
    for (let i = 0; i < colors.length; i += 3) {
      expect(colors[i]!).toBeGreaterThanOrEqual(0);
      expect(colors[i]!).toBeLessThanOrEqual(1);
      expect(colors[i + 1]!).toBeGreaterThanOrEqual(0);
      expect(colors[i + 1]!).toBeLessThanOrEqual(1);
      expect(colors[i + 2]!).toBeGreaterThanOrEqual(0);
      expect(colors[i + 2]!).toBeLessThanOrEqual(1);
    }
  });
});

describe("getMinElevation", () => {
  it("returns minimum z from grid", () => {
    const grid = [[10, 20], [5, 30]];
    expect(getMinElevation(grid)).toBe(5);
  });
});

describe("getMaxElevation", () => {
  it("returns maximum z from grid", () => {
    const grid = [[10, 20], [5, 30]];
    expect(getMaxElevation(grid)).toBe(30);
  });
});

describe("non-finite elevations", () => {
  const grid = [[Number.NEGATIVE_INFINITY, 5], [10, Number.POSITIVE_INFINITY]];

  it("ignores both infinities when computing elevation bounds", () => {
    expect(getMinElevation(grid)).toBe(5);
    expect(getMaxElevation(grid)).toBe(10);
  });

  it("keeps generated positions finite when the grid contains infinities", () => {
    const normalized = normalizeGrid(grid, 0, 0, 2);
    const { positions } = buildVertexData(grid, 0, 0, 2);

    expect(Array.from(normalized).every(Number.isFinite)).toBe(true);
    expect(Array.from(positions).every(Number.isFinite)).toBe(true);
  });

  it("keeps the terrain extent finite when the grid contains infinities", () => {
    const extent = getTerrainExtent(grid, 2);

    expect(extent).toEqual({ width: 2, depth: 2, height: 5, centerX: 1, centerZ: -1 });
    expect(Object.values(extent).every(Number.isFinite)).toBe(true);
  });

  it("measures node-to-node extents rather than adding a cell beyond the mesh", () => {
    expect(getTerrainExtent([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]], 2)).toEqual({
      width: 6,
      depth: 4,
      height: 11,
      centerX: 3,
      centerZ: -2,
    });
  });

  it("gives singleton grids zero horizontal extent and a finite center", () => {
    expect(getTerrainExtent([[5]], 2)).toEqual({
      width: 0,
      depth: 0,
      height: 0,
      centerX: 0,
      centerZ: 0,
    });
  });
});
