import { describe, expect, it } from "vitest";
import {
  gridNodeCountForSpan,
  MAX_TERRAIN_GRID_CELLS,
  MAX_TERRAIN_GRID_DIMENSION,
  NICE_RESOLUTION_STEPS,
  suggestResolutionForSpan,
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

describe("suggestResolutionForSpan", () => {
  it("keeps NICE_RESOLUTION_STEPS strictly ascending so the suggestion loop terminates at the first fit", () => {
    const steps = NICE_RESOLUTION_STEPS;
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
    }
  });

  it("snaps a 200×200 m terrain to 0.25 m because finer steps already fit the 1 M cell budget with margin", () => {
    // 200 m / 0.25 m = 801 nodes per axis → 641,601 cells, fits within 850k budget.
    // 200 m / 0.1 m would be 2001² ≈ 4 M cells, over budget, so we don't go finer.
    expect(suggestResolutionForSpan(200, 200)).toBe(0.25);
  });

  it("snaps a 1 km × 1 km terrain to 2 m because 1 m would overflow the 1 M cell budget", () => {
    // 1000 m / 1 m = 1001 nodes per axis → 1,002,001 cells > 1M cap.
    // 1000 m / 2 m = 501 nodes per axis → 251,001 cells, fits within 850k budget.
    expect(suggestResolutionForSpan(1000, 1000)).toBe(2);
  });

  it("snaps a 5 km × 5 km terrain to 10 m", () => {
    // 5000 m / 5 m = 1001 nodes per axis → ~1M cells, over budget.
    // 5000 m / 10 m = 501 nodes per axis → 251,001 cells, fits.
    expect(suggestResolutionForSpan(5000, 5000)).toBe(10);
  });

  it("honors a custom budget and safety factor", () => {
    // With a 100k budget and 1.0 safety factor, 100 m span fits at r=0.5 (201²=40,401 cells)
    // but r=0.25 yields 401² = 160,801 cells which exceeds the 100k budget.
    expect(suggestResolutionForSpan(100, 100, 100_000, 1.0)).toBe(0.5);
  });

  it("returns the largest NICE step when no smaller step keeps the grid under budget", () => {
    // 100,000 km × 100,000 km cannot fit even at the coarsest step (r=5000 → 20,001² ≈ 4e8 cells).
    // We return the largest step so the caller can surface validateTerrainGridDimensions
    // with an actionable "your file is too large even at 5 km/cell" message.
    expect(suggestResolutionForSpan(100_000_000, 100_000_000)).toBe(
      NICE_RESOLUTION_STEPS[NICE_RESOLUTION_STEPS.length - 1],
    );
  });

  it("rejects non-positive or non-finite spans", () => {
    expect(() => suggestResolutionForSpan(0, 100)).toThrow(/finite and positive/i);
    expect(() => suggestResolutionForSpan(-1, 100)).toThrow(/finite and positive/i);
    expect(() => suggestResolutionForSpan(Number.NaN, 100)).toThrow(/finite and positive/i);
    expect(() => suggestResolutionForSpan(Infinity, 100)).toThrow(/finite and positive/i);
  });

  it("rejects an out-of-range safety factor", () => {
    expect(() => suggestResolutionForSpan(100, 100, 1_000_000, 0)).toThrow(/safetyFactor/i);
    expect(() => suggestResolutionForSpan(100, 100, 1_000_000, 1.5)).toThrow(/safetyFactor/i);
    expect(() => suggestResolutionForSpan(100, 100, 0)).toThrow(/maxCells/i);
  });
});
