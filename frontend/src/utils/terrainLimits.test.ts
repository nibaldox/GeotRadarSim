import { describe, expect, it } from "vitest";
import {
  gridNodeCountForSpan,
  MAX_TERRAIN_GRID_CELLS,
  MAX_TERRAIN_GRID_DIMENSION,
  validateTerrainGridDimensions,
  validateTerrainResolution,
  validateTerrainTotalArea,
} from "./terrainLimits";

describe("shared terrain grid endpoint counting", () => {
  it("uses a bounded tolerance of one billionth of the resolution", () => {
    expect(gridNodeCountForSpan(0.3 - 0.5e-10, 0.1)).toBe(4);
    expect(gridNodeCountForSpan(0.3 - 2e-10, 0.1)).toBe(3);
  });

  it("keeps 200 m at 3 m resolution to 67 nodes without extrapolating the bounds", () => {
    expect(gridNodeCountForSpan(200, 3)).toBe(67);
  });
});

describe("shared terrain and LOS resource limits", () => {
  it("sets the worker-safe shared limits", () => {
    expect(MAX_TERRAIN_GRID_CELLS).toBe(1_000_000);
    expect(MAX_TERRAIN_GRID_DIMENSION).toBe(16_384);
  });

  it("accepts exactly one million cells and a 2×2 terrain grid without allocating either", () => {
    expect(validateTerrainGridDimensions(1000, 1000)).toBe(MAX_TERRAIN_GRID_CELLS);
    expect(validateTerrainGridDimensions(2, 2)).toBe(4);
  });

  it("rejects 1024×1024 because it exceeds the existing LOS-safe one-million-cell cap", () => {
    expect(() => validateTerrainGridDimensions(1024, 1024)).toThrow(/1,000,000 cells/i);
  });

  it("rejects an over-limit 2×2,097,152 grid before allocation", () => {
    expect(() => validateTerrainGridDimensions(2, 2_097_152)).toThrow(/dimension|maximum/i);
  });

  it("rejects a grid over one million cells even when both axes are below the axis cap", () => {
    expect(() => validateTerrainGridDimensions(1000, 1001)).toThrow(/1,000,000 cells/i);
  });

  it("rejects subnormal resolution whose squared cell area underflows", () => {
    expect(() => validateTerrainResolution(Number.MIN_VALUE)).toThrow(/resolution.*area|area.*resolution/i);
  });

  it("rejects a finite per-cell area whose total overflows across the grid", () => {
    expect(() => validateTerrainTotalArea(1e308, 4, "LOS")).toThrow(/total.*area|area.*total/i);
  });

  it("accepts finite total grid area", () => {
    expect(validateTerrainTotalArea(1e308, 1, "LOS")).toBe(1e308);
  });
});
