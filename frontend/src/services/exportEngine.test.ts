import { describe, expect, it } from "vitest";
import { generateCSVBlob, generatePDFBlob } from "./exportEngine";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";
import { activateLocalTerrain, clearLocalTerrainCache, getLocalTerrain, saveLocalTerrain } from "./localDataStore";

const resultWithUnknownCells = {
  cell_states: new Uint8Array([0, 1, 2, 3, 4, 5]),
  grid_rows: 1,
  grid_cols: 6,
  resolution: 2,
  shadow_grid: [[false, false, false, false, true, false]],
  quality_grid: [[Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, 0.2, 0, 0.8]],
  flat_quality_grid: new Float32Array([-1, -1, -1, -1, -1, 0.8]),
  coverage_polygon: [],
  coverage_pct: null,
  completeness_pct: 50,
  visible_area_m2: 4,
  shadow_zones: [{ zone_id: 1, cell_count: 1 }],
} as unknown as LOSResponse;

const request: AnalysisSnapshot = Object.freeze({
  terrainKey: Object.freeze({ terrain_id: "terrain-1", epoch: 3 }),
  analysisId: "job-abc",
  sourceAnalysisIds: Object.freeze(["job-abc"]),
  generation: 9,
  radars: Object.freeze([Object.freeze({
    radarId: "radar-1",
    radarModelId: "radar-model-1",
    position: Object.freeze({ x: 0, y: 0, z: 10 }),
    overrides: Object.freeze({ rangeMin: 25, rangeMax: null, elMin: null, elMax: null, azCenter: 90, azWidth: 45 }),
  })]),
});

describe("exportEngine NODATA contract", () => {
  it("exports a historical snapshot after its terrain grid has been evicted", async () => {
    clearLocalTerrainCache();
    const terrainA = {
      metadata: {
        terrain_id: request.terrainKey.terrain_id,
        bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
        resolution: 1,
        grid_rows: 1,
        grid_cols: 1,
      },
      grid: [[1]],
    };
    const terrainB = {
      metadata: { ...terrainA.metadata, terrain_id: "terrain-current" },
      grid: [[2]],
    };

    try {
      saveLocalTerrain(terrainA);
      activateLocalTerrain(terrainA.metadata.terrain_id);
      saveLocalTerrain(terrainB);
      activateLocalTerrain(terrainB.metadata.terrain_id);
      expect(getLocalTerrain(terrainA.metadata.terrain_id)).toBeUndefined();

      const blob = generateCSVBlob(request, resultWithUnknownCells);
      const csv = await blob.text();
      expect(csv).toContain("# Terrain ID,terrain-1");
      expect(csv).toContain("# Terrain Epoch,3");
    } finally {
      clearLocalTerrainCache();
    }
  });

  it("exports cell states and marks only SHADOW cells as shadowed", async () => {
    const blob = generateCSVBlob(request, resultWithUnknownCells);
    const csv = await blob.text();

    expect(csv).toContain("row,col,state,quality,shadowed");
    expect(csv).toContain("0,0,NODATA,,0");
    expect(csv).toContain("0,1,OUT_OF_RANGE,,0");
    expect(csv).toContain("0,2,OUTSIDE_FOV,,0");
    expect(csv).toContain("0,3,UNKNOWN_RAY,,0");
    expect(csv).toContain("0,4,SHADOW,0.0000,1");
    expect(csv).toContain("0,5,VISIBLE,0.8000,0");
    expect(csv).not.toMatch(/NaN|Infinity/);
    expect(csv).toContain("# Coverage %,N/A");
    expect(csv).toContain("# Completeness %,50.00");
    expect(csv).toContain("# Terrain ID,terrain-1");
    expect(csv).toContain("# Terrain Epoch,3");
    expect(csv).toContain("# Analysis ID,job-abc");
    expect(csv).toContain("# Analysis Generation,9");
    expect(csv).toContain("# Radar ID,radar-1");
    expect(csv).toContain("# Radar Model,radar-model-1");
    expect(csv).toContain("# Radar Position X,0.000");
    expect(csv).toContain("# Radar Overrides,rangeMin=25; azCenter=90; azWidth=45");
  });

  it("prints null coverage as no data instead of zero in the PDF", async () => {
    const blob = generatePDFBlob(request, resultWithUnknownCells);
    const pdfText = await blob.text();

    expect(blob.type).toBe("application/pdf");
    expect(pdfText).toContain("(Sin datos) Tj");
    expect(pdfText).not.toContain("(0.00 %) Tj");
    expect(pdfText).toContain("(Terrain ID: terrain-1) Tj");
    expect(pdfText).toContain("(Terrain Epoch: 3) Tj");
    expect(pdfText).toContain("(Analysis ID: job-abc) Tj");
    expect(pdfText).toContain("(Analysis Generation: 9) Tj");
    expect(pdfText).toContain("(Radar Model: radar-model-1) Tj");
    expect(pdfText).toContain("(Radar Position: X=0.0  Y=0.0  Z=10.0) Tj");
    expect(pdfText).toContain("(Radar Overrides: rangeMin=25; azCenter=90; azWidth=45) Tj");
    expect(pdfText).toContain("1");
  });
});
