import { describe, expect, it } from "vitest";
import { LOSCellState, type AnalysisSnapshot, type SensitivityMapResponse } from "../types/api";
import { classifyOverlayCellState, sensitivityMapMatchesSnapshot, sensitivityValueForCell } from "./ShadowOverlay";

describe("ShadowOverlay cell-state classification", () => {
  it("renders only true shadows and visible cells, never NODATA as shadow", () => {
    expect([0, 1, 2, 3, 4, 5].map(classifyOverlayCellState)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "shadow",
      "visible",
    ]);
  });
});

const snapshot: AnalysisSnapshot = {
  terrainKey: { terrain_id: "terrain-overlay", epoch: 2 },
  analysisId: null,
  sourceAnalysisIds: ["analysis-a", "analysis-b"],
  generation: 5,
  radars: [],
};

const sensitivityMap: SensitivityMapResponse = {
  terrainKey: snapshot.terrainKey,
  sourceAnalysisIds: ["analysis-a", "analysis-b"],
  grid_rows: 1,
  grid_cols: 3,
  resolution: 2,
  flat_sensitivity_grid: new Float32Array([Number.NaN, 0, 0.75]),
  observer_count: new Uint16Array([0, 1, 2]),
};

describe("ShadowOverlay per-cell sensitivity mask", () => {
  it("discards cells with zero observers and preserves a measured zero", () => {
    expect(sensitivityValueForCell(sensitivityMap, 0)).toBeNull();
    expect(sensitivityValueForCell(sensitivityMap, 1)).toBe(0);
    expect(sensitivityValueForCell(sensitivityMap, 2)).toBe(0.75);
  });

  it("requires map provenance to match selected analysis IDs and terrain epoch", () => {
    expect(sensitivityMapMatchesSnapshot(sensitivityMap, snapshot, 1, 3, 2)).toBe(true);
    expect(sensitivityMapMatchesSnapshot(sensitivityMap, { ...snapshot, terrainKey: { terrain_id: "terrain-overlay", epoch: 1 } }, 1, 3, 2)).toBe(false);
    expect(sensitivityMapMatchesSnapshot(sensitivityMap, { ...snapshot, sourceAnalysisIds: ["analysis-a"] }, 1, 3, 2)).toBe(false);
  });

  it("returns no value for invalid or unavailable map samples", () => {
    expect(sensitivityValueForCell(sensitivityMap, -1)).toBeNull();
    expect(sensitivityValueForCell(sensitivityMap, 3)).toBeNull();
    expect(sensitivityValueForCell({ ...sensitivityMap, flat_sensitivity_grid: new Float32Array([Number.NaN, Number.NaN, 0.75]) }, 1)).toBeNull();
  });

  it("uses the individual VISIBLE state code, not the merged-state code", () => {
    expect(LOSCellState.VISIBLE).toBe(5);
    expect(sensitivityValueForCell(sensitivityMap, 1)).toBe(0);
  });
});
