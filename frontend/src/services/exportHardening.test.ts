import { describe, expect, it } from "vitest";
import { generateCSVBlob } from "./exportEngine";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const result = { cell_states: new Uint8Array([5]), grid_rows: 1, grid_cols: 1, resolution: 1,
  shadow_grid: [[false]], quality_grid: [[0]], coverage_polygon: [], coverage_pct: 100,
  completeness_pct: 100, visible_area_m2: 1, shadow_zones: [] } as unknown as LOSResponse;

describe("CSV text hardening", () => {
  it.each([["a;b", "a;b"], ["a\tb", "a\tb"], ["x;=1+1", '"x;=1+1"'],
    ["a;\t+1", '"a;\t+1"'], ["a; -1", '"a; -1"'], ["a; @SUM(1)", '"a; @SUM(1)"'],
    ["rangeMin=25; azCenter=90; azWidth=45", "rangeMin=25; azCenter=90; azWidth=45"],
    ["azCenter=-90; azWidth=45", "azCenter=-90; azWidth=45"], ["a;-90", '"a;-90"'],
    ["simple", "simple"], ["=1+1", '"\'=1+1"'], ["\tstart", '"\'\tstart"'],
    ['a;=1+"2"', '"a;=1+""2"""']])
  ("quotes and protects %j", async (terrainId, expected) => {
    const snapshot = { terrainKey: { terrain_id: terrainId, epoch: 1 }, analysisId: "a",
      sourceAnalysisIds: ["a"], generation: 1, radars: [] } as AnalysisSnapshot;
    expect((await generateCSVBlob(snapshot, result).text()).split("\n")).toContain(`# Terrain ID,${expected}`);
  });
});
