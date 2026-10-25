import { describe, expect, it } from "vitest";
import { generateCSVBlob, generatePDFBlob } from "./exportEngine";
import { buildQualityExportContext, QualityExportContextError } from "../utils/qualityReport";
import type { QualityExportContext } from "../utils/qualityReport";
import { computeQualitySummary } from "../utils/qualityMetrics";
import type { QualityMetric } from "../utils/qualityMetrics";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";
import { LOSCellState } from "../types/api";
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
    expect(csv).toContain("# Visibilidad (candidatos) %,N/A");
    expect(csv).toContain("# Completitud %,50.00");
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

// ────────────────────────────────────────────────────────────────────────────
// Optional quality-report context (geometric-v2 useful coverage and quality)
// ────────────────────────────────────────────────────────────────────────────

/** Decode jsPDF literal strings (octal + escaped parens) so accented labels are assertable. */
async function pdfLiteralText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return raw
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    .replace(/\\([()\\])/g, "$1");
}

const qualitySnapshot: AnalysisSnapshot = Object.freeze({
  terrainKey: Object.freeze({ terrain_id: "terrain-q", epoch: 5 }),
  analysisId: "job-quality",
  sourceAnalysisIds: Object.freeze(["job-quality"]),
  generation: 4,
  radars: Object.freeze([Object.freeze({
    radarId: "radar-q",
    radarModelId: "radar-model-q",
    position: Object.freeze({ x: 1, y: 2, z: 3 }),
    overrides: Object.freeze({ rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null }),
  })]),
});

const qualityTerrainGrid = [[0, 0, 0], [0, Number.NaN, 0]];
const qualityTerrainMetadata = { terrain_id: "terrain-q", resolution: 2, grid_rows: 2, grid_cols: 3 };
const qualityTerrainKey = { terrain_id: "terrain-q", epoch: 5 };
const qualityPolicy = { mediumMin: 0.3, highMin: 0.7 };

function v2Result(): LOSResponse {
  return {
    shadow_grid: [[false, false, false], [true, false, false]],
    cell_states: new Uint8Array([
      LOSCellState.VISIBLE, LOSCellState.VISIBLE, LOSCellState.VISIBLE,
      LOSCellState.SHADOW, LOSCellState.NODATA, LOSCellState.OUT_OF_RANGE,
    ]),
    grid_rows: 2,
    grid_cols: 3,
    resolution: 2,
    coverage_polygon: [],
    coverage_pct: 80,
    completeness_pct: 82.5,
    visible_area_m2: 12,
    shadow_zones: [{ zone_id: 1, cell_count: 1 }],
    quality_grid: [[0, 0.5, 0], [0, 0, 0]],
    flat_quality_grid: new Float32Array([0, 0.5, Number.NaN, -1, -1, -1]),
    flat_projection_grid: new Float32Array([Number.NaN, 0.8, 0.25, Number.NaN, Number.NaN, Number.NaN]),
    quality_model: "geometric-v2",
  };
}

function buildContext(metric: QualityMetric = "INCIDENCE", losResult = v2Result()): QualityExportContext {
  const context = buildQualityExportContext({
    snapshot: qualitySnapshot,
    losResult,
    metric,
    policy: qualityPolicy,
    terrainGrid: qualityTerrainGrid,
    terrainMetadata: qualityTerrainMetadata,
    terrainKey: qualityTerrainKey,
  });
  expect(context).not.toBeNull();
  return context!;
}

describe("exportEngine quality report metadata", () => {
  it("writes the captured policy, metric identity and useful-coverage numbers into the CSV", async () => {
    const losResult = v2Result();
    const context = buildContext("INCIDENCE", losResult);
    const expected = computeQualitySummary({
      metric: "INCIDENCE",
      policy: qualityPolicy,
      losResult,
      terrainGrid: qualityTerrainGrid,
      terrainResolution: qualityTerrainMetadata.resolution,
      terrainKey: qualityTerrainKey,
      snapshot: qualitySnapshot,
    });
    expect(expected).not.toBeNull();

    const csv = await generateCSVBlob(qualitySnapshot, losResult, context).text();
    expect(csv).toContain("# Informe de calidad (cobertura útil)");
    expect(csv).toContain("# Modelo de calidad,geometric-v2");
    expect(csv).toContain("# Métrica del índice,Incidencia superficial");
    expect(csv).toContain("# Umbrales de clasificación,media >= 0.3; alta >= 0.7 (provisional; no certificado)");
    expect(csv).toContain("# Objetivo común,Topografía válida completa");
    expect(csv).toContain("# Celdas objetivo,5");
    expect(csv).toContain("# Área nominal m2,20.00");
    expect(csv).toContain(`# Cobertura útil %,${expected!.usefulCoveragePct!.toFixed(2)}`);
    expect(csv).toContain(`# Área útil m2,${expected!.usefulAreaM2!.toFixed(2)}`);
    expect(csv).toContain(`# Media + alta de lo visible %,${expected!.mediumHighAmongVisiblePct!.toFixed(2)}`);
    expect(csv).toContain(`# Distribución baja %,${expected!.distribution!.lowPct.toFixed(2)} (${expected!.distribution!.lowCount})`);
    expect(csv).toContain(`# Distribución media %,${expected!.distribution!.mediumPct.toFixed(2)} (${expected!.distribution!.mediumCount})`);
    expect(csv).toContain(`# Distribución alta %,${expected!.distribution!.highPct.toFixed(2)} (${expected!.distribution!.highCount})`);
    expect(csv).toContain(`# Sin índice %,${expected!.distribution!.noIndexPct.toFixed(2)} (${expected!.distribution!.noIndexCount})`);
    expect(csv).toContain("# Visibilidad (candidatos) %,80.00");
    expect(csv).toContain("# Completitud %,82.50");
  });

  it("reports the projection metric identity and numbers when the sensitivity view is exported", async () => {
    const losResult = v2Result();
    const context = buildContext("PROJECTION", losResult);
    const csv = await generateCSVBlob(qualitySnapshot, losResult, context).text();

    expect(csv).toContain("# Métrica del índice,Proyección del movimiento");
    // visible projections: NaN (no index), 0.8 (high/useful), 0.25 (low)
    expect(csv).toContain("# Distribución baja %,33.33 (1)");
    expect(csv).toContain("# Distribución media %,0.00 (0)");
    expect(csv).toContain("# Distribución alta %,33.33 (1)");
    expect(csv).toContain("# Sin índice %,33.33 (1)");
  });

  it("writes the quality headline into the PDF ahead of the legacy visibility summary", async () => {
    const losResult = v2Result();
    const context = buildContext("INCIDENCE", losResult);
    const pdfText = await pdfLiteralText(generatePDFBlob(qualitySnapshot, losResult, context));

    expect(pdfText).toContain("(Cobertura útil y calidad) Tj");
    expect(pdfText).toContain("Incidencia superficial");
    expect(pdfText).toContain("geometric-v2");
    expect(pdfText).toContain("media >= 0.3; alta >= 0.7");
    expect(pdfText).toContain("Topografía válida completa");
    expect(pdfText).toContain("Visibilidad (candidatos)");
    expect(pdfText).toContain("20.00 %");
    expect(pdfText).toContain("33.33 %");
    expect(pdfText.indexOf("Cobertura útil y calidad")).toBeLessThan(pdfText.indexOf("Visibilidad (candidatos)"));
  });

  it("keeps direct no-context calls on the legacy report without a fabricated quality summary", async () => {
    const losResult = v2Result();
    const csv = await generateCSVBlob(qualitySnapshot, losResult).text();
    const pdfText = await pdfLiteralText(generatePDFBlob(qualitySnapshot, losResult));

    expect(csv).toContain("# Quality Model,geometric-v2");
    expect(csv).not.toContain("# Informe de calidad");
    expect(csv).not.toContain("# Cobertura útil %");
    expect(csv).toContain("# Visibilidad (candidatos) %,80.00");
    expect(pdfText).not.toContain("Cobertura útil y calidad");
    expect(pdfText).toContain("geometric-v2");
    expect(pdfText).toContain("Visibilidad (candidatos)");
  });
});

describe("exportEngine per-cell incidence/projection columns", () => {
  it("names incidence and projection separately and leaves non-visible or missing indices blank", async () => {
    const losResult = v2Result();
    const context = buildContext("INCIDENCE", losResult);
    const csv = await generateCSVBlob(qualitySnapshot, losResult, context).text();

    expect(csv).toContain("# Cell States (row,col,state,incidence,projection,shadowed)");
    expect(csv).toContain("row,col,state,incidence,projection,shadowed");
    expect(csv).toContain("0,0,VISIBLE,0,,0");
    expect(csv).toContain("0,1,VISIBLE,0.5,0.8,0");
    expect(csv).toContain("0,2,VISIBLE,,0.25,0");
    expect(csv).toContain("1,0,SHADOW,,,1");
    expect(csv).toContain("1,1,NODATA,,,0");
    expect(csv).toContain("1,2,OUT_OF_RANGE,,,0");
    expect(csv).not.toMatch(/NaN|Infinity/);
  });

  it("keeps the measured zero and never fabricates zeros for missing projection", async () => {
    const losResult = v2Result();
    const csv = await generateCSVBlob(qualitySnapshot, losResult, buildContext("INCIDENCE", losResult)).text();

    // measured incidence zero is exported as zero, not as blank
    expect(csv).toMatch(/0,0,VISIBLE,0,,0/);
    // non-visible and no-gradient cells never become a fabricated zero
    expect(csv).not.toMatch(/SHADOW,0/);
    expect(csv).not.toMatch(/NODATA,0/);
    expect(csv).not.toMatch(/OUT_OF_RANGE,0/);
  });

  it("keeps incidence/projection columns for a v2 result exported without context", async () => {
    const csv = await generateCSVBlob(qualitySnapshot, v2Result()).text();
    expect(csv).toContain("row,col,state,incidence,projection,shadowed");
    expect(csv).toContain("0,1,VISIBLE,0.5,0.8,0");
    expect(csv).not.toContain("row,col,state,quality,shadowed");
  });

  it("keeps the legacy quality column for unversioned results", async () => {
    const csv = await generateCSVBlob(request, resultWithUnknownCells).text();
    expect(csv).toContain("row,col,state,quality,shadowed");
    expect(csv).not.toContain("row,col,state,incidence,projection,shadowed");
  });
});

describe("exportEngine v2 value precision", () => {
  it("writes Float32 round-trip values whose recounted bands match the reported distribution", async () => {
    const losResult = v2Result();
    losResult.cell_states = new Uint8Array([5, 5, 5, 5, 0, 5]);
    losResult.flat_quality_grid = new Float32Array([
      Math.fround(0.29998), Math.fround(0.69998), 0.9, 0, -1, Number.NaN,
    ]);
    losResult.flat_projection_grid = new Float32Array(6).fill(Number.NaN);
    const csv = await generateCSVBlob(qualitySnapshot, losResult, buildContext("INCIDENCE", losResult)).text();

    // Round-trip Float32 tokens: toFixed(4) would round these across the thresholds.
    expect(csv).toContain("0,0,VISIBLE,0.29998,,0");
    expect(csv).toContain("0,1,VISIBLE,0.69998,,0");
    expect(csv).toContain("1,0,VISIBLE,0,,0");
    expect(csv).not.toContain("0.3000");
    expect(csv).not.toContain("0.7000");
    expect(csv).toContain("# Precisión de clasificación,Float32 (índices y umbrales");

    // Recounting the exported rows with the policy reproduces the reported counts.
    const counts = { low: 0, medium: 0, high: 0, noIndex: 0 };
    for (const line of csv.split("\n")) {
      const match = /^\d+,\d+,VISIBLE,([^,]*),/.exec(line);
      if (!match) continue;
      const raw = match[1]!;
      if (raw === "") {
        counts.noIndex++;
        continue;
      }
      const value = Math.fround(Number(raw));
      if (value < Math.fround(0.3)) counts.low++;
      else if (value < Math.fround(0.7)) counts.medium++;
      else counts.high++;
    }
    const headerCount = (label: string): number => {
      const line = csv.split("\n").find((row) => row.startsWith(label));
      return Number(/\((\d+)\)$/.exec(line!)![1]);
    };
    expect(counts.low).toBe(headerCount("# Distribución baja %"));
    expect(counts.medium).toBe(headerCount("# Distribución media %"));
    expect(counts.high).toBe(headerCount("# Distribución alta %"));
    expect(counts.noIndex).toBe(headerCount("# Sin índice %"));
  });
});

describe("exportEngine rejects mismatched quality contexts", () => {
  it("rejects a user-fabricated summary instead of reporting its numbers", () => {
    const losResult = v2Result();
    const context = buildContext("INCIDENCE", losResult);
    const fabricated = { ...context, summary: { ...context.summary, usefulCount: 2, usefulCoveragePct: 40 } };

    expect(() => generatePDFBlob(qualitySnapshot, losResult, fabricated)).toThrow(QualityExportContextError);
    expect(() => generateCSVBlob(qualitySnapshot, losResult, fabricated)).toThrow(QualityExportContextError);
  });

  it("rejects a stale context captured for another snapshot, result or policy", () => {
    const losResult = v2Result();
    const context = buildContext("INCIDENCE", losResult);
    const otherSnapshot: AnalysisSnapshot = { ...qualitySnapshot, sourceAnalysisIds: ["job-other"] };
    const otherResult = v2Result();
    otherResult.grid_cols = 4;

    expect(() => generatePDFBlob(otherSnapshot, losResult, context)).toThrow(QualityExportContextError);
    expect(() => generateCSVBlob(qualitySnapshot, otherResult, context)).toThrow(QualityExportContextError);
    expect(() => generateCSVBlob(qualitySnapshot, losResult, {
      ...context,
      policy: { mediumMin: 0.8, highMin: 0.2 },
    })).toThrow(QualityExportContextError);
    expect(() => generateCSVBlob(qualitySnapshot, losResult, {} as QualityExportContext)).toThrow(QualityExportContextError);
    expect(() => generateCSVBlob(qualitySnapshot, losResult, null as unknown as QualityExportContext)).toThrow(QualityExportContextError);
  });

  it("rejects a legacy result exported under a v2 quality context", () => {
    const context = buildContext("INCIDENCE");
    const legacy = v2Result();
    delete legacy.quality_model;
    expect(() => generateCSVBlob(qualitySnapshot, legacy, context)).toThrow(QualityExportContextError);
  });
});
