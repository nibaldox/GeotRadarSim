import { describe, expect, it } from "vitest";
import * as apiTypes from "./api";
import type { SensitivityMapRequest, SensitivityMapResponse } from "./api";

describe("LOS cell-state codes", () => {
  it("keeps stable uint8 codes for every LOS outcome", () => {
    expect(apiTypes.LOSCellState).toEqual({
      NODATA: 0,
      OUT_OF_RANGE: 1,
      OUTSIDE_FOV: 2,
      UNKNOWN_RAY: 3,
      SHADOW: 4,
      VISIBLE: 5,
    });
  });
});

const terrainKey = { terrain_id: "terrain-types", epoch: 3 } as const;
const snapshot = {
  terrainKey,
  analysisId: "analysis-types",
  sourceAnalysisIds: ["analysis-types"],
  generation: 9,
  radars: [{
    radarId: "radar-types",
    radarModelId: "groundprobe-ssr-fx",
    position: { x: 100, y: 200, z: 30 },
    overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
  }],
} as const;

const sensitivityRequest: SensitivityMapRequest = {
  terrainKey,
  observations: [{
    analysisId: "analysis-types",
    snapshot,
    grid_rows: 1,
    grid_cols: 2,
    resolution: 2,
    cell_states: new Uint8Array([apiTypes.LOSCellState.VISIBLE, apiTypes.LOSCellState.SHADOW]),
  }],
};

const sensitivityResponse: SensitivityMapResponse = {
  terrainKey,
  sourceAnalysisIds: ["analysis-types"],
  grid_rows: 1,
  grid_cols: 2,
  resolution: 2,
  flat_sensitivity_grid: new Float32Array([0, Number.NaN]),
  observer_count: new Uint16Array([1, 0]),
};

describe("geometric sensitivity API types", () => {
  it("carries stable analysis snapshot provenance and each analysis's cell states", () => {
    expect(sensitivityRequest.terrainKey).toEqual(terrainKey);
    expect(sensitivityRequest.observations[0]!.analysisId).toBe("analysis-types");
    expect(sensitivityRequest.observations[0]!.snapshot.radars[0]!.position).toEqual({ x: 100, y: 200, z: 30 });
    expect(sensitivityRequest.observations[0]!.cell_states).toEqual(new Uint8Array([5, 4]));
  });

  it("uses contributor counts and distinguishes a measured zero from no data", () => {
    expect(sensitivityResponse.flat_sensitivity_grid).toBeInstanceOf(Float32Array);
    expect(sensitivityResponse.observer_count).toBeInstanceOf(Uint16Array);
    expect(sensitivityResponse.flat_sensitivity_grid[0]).toBe(0);
    expect(sensitivityResponse.observer_count[0]).toBe(1);
    expect(Number.isNaN(sensitivityResponse.flat_sensitivity_grid[1])).toBe(true);
    expect(sensitivityResponse.observer_count[1]).toBe(0);
    expect(sensitivityResponse).not.toHaveProperty("sensitivityGrid");
  });
});
