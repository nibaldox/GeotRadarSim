/**
 * Tests for the optional export quality-report context: builder (captured at
 * the click from current stores) and engine-side validator.
 */

import { describe, expect, it } from "vitest";
import {
  buildQualityExportContext,
  metricForVisualizationMode,
  validateQualityExportContext,
  QualityExportContextError,
} from "./qualityReport";
import type { QualityExportContext } from "./qualityReport";
import { computeQualitySummary } from "./qualityMetrics";
import type { QualityMetric, QualityPolicy } from "./qualityMetrics";
import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const snapshot: AnalysisSnapshot = Object.freeze({
  terrainKey: Object.freeze({ terrain_id: "terrain-a", epoch: 5 }),
  analysisId: "job-a",
  sourceAnalysisIds: Object.freeze(["job-a"]),
  generation: 3,
  radars: Object.freeze([Object.freeze({
    radarId: "radar-1",
    radarModelId: "radar-model-1",
    position: Object.freeze({ x: 0, y: 0, z: 10 }),
    overrides: Object.freeze({ rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null }),
  })]),
});

const terrainGrid = [[0, 0, 0], [0, Number.NaN, 0]];
const terrainMetadata = {
  terrain_id: "terrain-a",
  resolution: 2,
  grid_rows: 2,
  grid_cols: 3,
};
const terrainKey = { terrain_id: "terrain-a", epoch: 5 };
const policy: QualityPolicy = { mediumMin: 0.3, highMin: 0.7 };

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

function legacyResult(): LOSResponse {
  const result = v2Result();
  delete result.quality_model;
  delete result.flat_projection_grid;
  return result;
}

function build(overrides: Partial<Parameters<typeof buildQualityExportContext>[0]> = {}, metric: QualityMetric = "INCIDENCE"): QualityExportContext | null {
  const losResult = overrides.losResult ?? v2Result();
  return buildQualityExportContext({
    snapshot: overrides.snapshot ?? snapshot,
    losResult,
    metric: overrides.metric ?? metric,
    policy: overrides.policy ?? policy,
    terrainGrid: overrides.terrainGrid !== undefined ? overrides.terrainGrid : terrainGrid,
    terrainMetadata: overrides.terrainMetadata !== undefined ? overrides.terrainMetadata : terrainMetadata,
    terrainKey: overrides.terrainKey !== undefined ? overrides.terrainKey : terrainKey,
  });
}

describe("metricForVisualizationMode", () => {
  it("maps the QUALITY layer to incidence and SENSITIVITY to projection", () => {
    expect(metricForVisualizationMode("QUALITY")).toBe("INCIDENCE");
    expect(metricForVisualizationMode("SENSITIVITY")).toBe("PROJECTION");
  });
});

describe("buildQualityExportContext", () => {
  it("computes the same summary numbers as computeQualitySummary on the current grid", () => {
    const losResult = v2Result();
    const context = build({ losResult });
    expect(context).not.toBeNull();
    const expected = computeQualitySummary({
      metric: "INCIDENCE",
      policy,
      losResult,
      terrainGrid,
      terrainResolution: terrainMetadata.resolution,
      terrainKey,
      snapshot,
    });
    expect(expected).not.toBeNull();
    expect(context!.summary).toEqual(expected);
    expect(context!.target).toEqual(expected!.target);
    expect(context!.qualityModel).toBe("geometric-v2");
    expect(context!.metric).toBe("INCIDENCE");
    expect(context!.terrainKey).toEqual({ terrain_id: "terrain-a", epoch: 5 });
    expect(context!.sourceAnalysisIds).toEqual(["job-a"]);
    expect(context!.analysisId).toBe("job-a");
    expect(context!.gridRows).toBe(2);
    expect(context!.gridCols).toBe(3);
    expect(context!.resolution).toBe(2);
  });

  it("shares the exact common-target number with the non-NODATA cell count", () => {
    const context = build();
    const nonNoData = Array.from(v2Result().cell_states!).filter((state) => state !== LOSCellState.NODATA).length;
    expect(nonNoData).toBe(5);
    expect(context!.target.cellCount).toBe(nonNoData);
    expect(context!.target.label).toBe("Topografía válida completa");
    expect(context!.target.nominalAreaM2).toBe(20);
  });

  it("captures a detached policy copy at build time", () => {
    const mutablePolicy: QualityPolicy = { mediumMin: 0.4, highMin: 0.8 };
    const context = build({ policy: mutablePolicy });
    mutablePolicy.mediumMin = 0.9;
    mutablePolicy.highMin = 0.95;
    expect(context!.policy).toEqual({ mediumMin: 0.4, highMin: 0.8 });
    expect(context!.summary.policy).toEqual({ mediumMin: 0.4, highMin: 0.8 });
  });

  it("selects the projection grid for the sensitivity metric", () => {
    const context = build({}, "PROJECTION");
    expect(context!.summary.metric).toBe("PROJECTION");
    // visible projections: NaN (no index), 0.8 (high), 0.25 (low)
    expect(context!.summary.distribution).toEqual({
      lowCount: 1,
      mediumCount: 0,
      highCount: 1,
      noIndexCount: 1,
      lowPct: (1 / 3) * 100,
      mediumPct: 0,
      highPct: (1 / 3) * 100,
      noIndexPct: (1 / 3) * 100,
    });
  });

  it("does not generate a context for a legacy unversioned result", () => {
    expect(build({ losResult: legacyResult() })).toBeNull();
  });

  it("does not generate a context from stale terrain metadata", () => {
    expect(build({ terrainKey: { terrain_id: "terrain-a", epoch: 4 } })).toBeNull();
    expect(build({ terrainKey: { terrain_id: "terrain-b", epoch: 5 } })).toBeNull();
    expect(build({ terrainMetadata: { ...terrainMetadata, terrain_id: "terrain-b" } })).toBeNull();
    expect(build({ snapshot: { ...snapshot, terrainKey: { terrain_id: "terrain-b", epoch: 5 } } })).toBeNull();
  });

  it("does not generate a context from missing or mismatched grid/metadata", () => {
    expect(build({ terrainGrid: null })).toBeNull();
    expect(build({ terrainMetadata: null })).toBeNull();
    expect(build({ terrainMetadata: { ...terrainMetadata, grid_rows: 3 } })).toBeNull();
    expect(build({ terrainMetadata: { ...terrainMetadata, resolution: 1 } })).toBeNull();
    expect(build({ terrainGrid: [[0, 0, 0], [0, 0, 0]] })).toBeNull();
  });

  it("does not generate a context for an invalid policy", () => {
    expect(build({ policy: { mediumMin: 0.7, highMin: 0.3 } })).toBeNull();
    expect(build({ policy: { mediumMin: Number.NaN, highMin: 0.7 } })).toBeNull();
    expect(build({ policy: { mediumMin: 0, highMin: 1.2 } })).toBeNull();
  });

  it("does not generate a context when the current grid disagrees with the result NODATA pattern", () => {
    const losResult = v2Result();
    expect(build({ losResult, terrainGrid: [[0, 0, 0], [0, 0, 0]] })).toBeNull();
  });
});

describe("validateQualityExportContext", () => {
  const accepted = (): QualityExportContext => {
    const context = build();
    expect(context).not.toBeNull();
    return context!;
  };

  it("accepts the context produced by the builder for the same snapshot and result", () => {
    const losResult = v2Result();
    const context = build({ losResult });
    expect(() => validateQualityExportContext(context, snapshot, losResult)).not.toThrow();
  });

  it("accepts a projection context that recomputes from the result", () => {
    const losResult = v2Result();
    const context = build({ losResult }, "PROJECTION");
    expect(() => validateQualityExportContext(context, snapshot, losResult)).not.toThrow();
  });

  it("rejects malformed contexts", () => {
    const losResult = v2Result();
    for (const malformed of [null, undefined, {}, "context", 42, { ...accepted(), summary: null }, { ...accepted(), policy: null }]) {
      expect(() => validateQualityExportContext(malformed, snapshot, losResult)).toThrow(QualityExportContextError);
    }
  });

  it("rejects a context whose provenance does not match the snapshot", () => {
    const losResult = v2Result();
    const context = accepted();
    expect(() => validateQualityExportContext(
      { ...context, terrainKey: { terrain_id: "terrain-a", epoch: 4 } }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      { ...context, sourceAnalysisIds: ["other-job"] }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      { ...context, analysisId: "other-job" }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      context, { ...snapshot, sourceAnalysisIds: ["job-a", "job-b"] }, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      context, { ...snapshot, terrainKey: { terrain_id: "terrain-a", epoch: 9 } }, losResult,
    )).toThrow(QualityExportContextError);
  });

  it("rejects a context whose dimensions, resolution or model differ from the result", () => {
    const context = accepted();
    expect(() => validateQualityExportContext(context, snapshot, { ...v2Result(), grid_cols: 4 })).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(context, snapshot, { ...v2Result(), grid_rows: 1 })).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(context, snapshot, { ...v2Result(), resolution: 1 })).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(context, snapshot, legacyResult())).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext({ ...context, qualityModel: "other" }, snapshot, v2Result())).toThrow(QualityExportContextError);
  });

  it("rejects a context carrying an invalid policy", () => {
    const losResult = v2Result();
    const context = accepted();
    expect(() => validateQualityExportContext(
      { ...context, policy: { mediumMin: 0.8, highMin: 0.2 }, summary: { ...context.summary, policy: { mediumMin: 0.8, highMin: 0.2 } } },
      snapshot, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      { ...context, policy: { mediumMin: 0.7, highMin: 0.7 } }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
  });

  it("rejects a context whose summary disagrees with the metric named by the context", () => {
    const losResult = v2Result();
    const context = accepted();
    expect(() => validateQualityExportContext(
      { ...context, metric: "PROJECTION" }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      { ...context, summary: { ...context.summary, metric: "PROJECTION" } }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
    expect(() => validateQualityExportContext(
      { ...context, summary: { ...context.summary, qualityModel: "geometric-v1" } }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
  });

  it("rejects a user-fabricated summary instead of reporting its numbers", () => {
    const losResult = v2Result();
    const context = accepted();
    const fabrications: QualityExportContext[] = [
      { ...context, summary: { ...context.summary, usefulCount: 2 } },
      { ...context, summary: { ...context.summary, usefulCoveragePct: 40 } },
      { ...context, summary: { ...context.summary, usefulAreaM2: 8 } },
      { ...context, summary: { ...context.summary, visibleCount: 4 } },
      { ...context, summary: { ...context.summary, mediumHighAmongVisiblePct: 100 } },
      { ...context, summary: { ...context.summary, distribution: { ...context.summary.distribution!, highCount: 2 } } },
      { ...context, summary: { ...context.summary, distribution: { ...context.summary.distribution!, noIndexCount: 0 } } },
      { ...context, summary: { ...context.summary, target: { ...context.summary.target, cellCount: 6 } } },
      { ...context, summary: { ...context.summary, target: { ...context.summary.target, nominalAreaM2: 24 } } },
      { ...context, target: { ...context.target, cellCount: 6 } },
      { ...context, target: { ...context.target, nominalAreaM2: 24 } },
      { ...context, target: { ...context.target, label: "Bounding box" as never } },
    ];
    for (const fabricated of fabrications) {
      expect(() => validateQualityExportContext(fabricated, snapshot, losResult)).toThrow(QualityExportContextError);
    }
  });

  it("rejects a valid context when paired with a different result", () => {
    const context = accepted();
    const otherResult = v2Result();
    otherResult.flat_quality_grid = new Float32Array([0.9, 0.9, Number.NaN, -1, -1, -1]);
    expect(() => validateQualityExportContext(context, snapshot, otherResult)).toThrow(QualityExportContextError);
  });

  it("counts Float32-boundary values by their classified band and rejects double-based counts", () => {
    const losResult = v2Result();
    losResult.flat_quality_grid = new Float32Array([
      Math.fround(0.35), Math.fround(0.7), Number.NaN, -1, -1, -1,
    ]);
    const boundaryPolicy: QualityPolicy = { mediumMin: 0.35, highMin: 0.7 };
    const context = build({ losResult, policy: boundaryPolicy });
    expect(context).not.toBeNull();
    // Both values sit exactly on their Float32 cutoff: medium and high, both useful.
    expect(context!.summary.usefulCount).toBe(2);
    expect(context!.summary.mediumHighAmongVisiblePct).toBeCloseTo((2 / 3) * 100, 10);
    expect(() => validateQualityExportContext(context, snapshot, losResult)).not.toThrow();
    // A summary counted with JS double comparisons (0 useful) is stale and rejected.
    expect(() => validateQualityExportContext(
      { ...context!, summary: { ...context!.summary, usefulCount: 0 } }, snapshot, losResult,
    )).toThrow(QualityExportContextError);
  });
});
