/**
 * Optional export quality-report context: provenance captured at the export
 * click and verified again inside the export engine.
 *
 * The builder only produces a context from the exact current terrain grid and
 * metadata; anything stale, legacy or mismatched yields no context instead of
 * a report with wrong numbers. The validator re-derives every reported number
 * from the result being exported and rejects any disagreement (including
 * user-fabricated summaries). Pure helpers: no stores, no I/O.
 */

import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";
import {
  QUALITY_MODEL_V2,
  classifyQualityValue,
  computeQualitySummary,
  isValidQualityPolicy,
} from "./qualityMetrics";
import type {
  CommonTarget,
  QualityMetric,
  QualityPolicy,
  QualitySummary,
} from "./qualityMetrics";

/** UI layer identity (kept in the vector store); mapped to the exported metric. */
export type VisualizationMode = "QUALITY" | "SENSITIVITY";

export function metricForVisualizationMode(mode: VisualizationMode): QualityMetric {
  return mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";
}

/**
 * Immutable capture of the metric/policy/target/summary being reported,
 * bound to the snapshot and result dimensions it was computed from.
 */
export interface QualityExportContext {
  readonly qualityModel: typeof QUALITY_MODEL_V2;
  readonly metric: QualityMetric;
  readonly policy: QualityPolicy;
  readonly terrainKey: Readonly<{ terrain_id: string; epoch: number }>;
  readonly analysisId: string | null;
  readonly sourceAnalysisIds: readonly string[];
  readonly gridRows: number;
  readonly gridCols: number;
  readonly resolution: number;
  readonly target: CommonTarget;
  readonly summary: QualitySummary;
}

export interface QualityExportContextInput {
  snapshot: AnalysisSnapshot;
  losResult: LOSResponse;
  metric: QualityMetric;
  policy: QualityPolicy;
  /** Current active terrain grid; expected resolution comes from metadata, not the result. */
  terrainGrid: readonly (readonly number[])[] | null | undefined;
  terrainMetadata: Readonly<{ terrain_id: string; resolution: number; grid_rows: number; grid_cols: number }> | null | undefined;
  terrainKey: Readonly<{ terrain_id: string; epoch: number }> | null | undefined;
}

export class QualityExportContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityExportContextError";
  }
}

function sameTerrainKey(
  left: Readonly<{ terrain_id: string; epoch: number }> | null | undefined,
  right: Readonly<{ terrain_id: string; epoch: number }> | null | undefined,
): boolean {
  return !!left && !!right && left.terrain_id === right.terrain_id && left.epoch === right.epoch;
}

function sameIds(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  return !!left && !!right && left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Cells whose terrain node exists (v2 results mark missing terrain nodes NODATA). */
function countNonNodata(cellStates: Uint8Array): number {
  let count = 0;
  for (let idx = 0; idx < cellStates.length; idx++) {
    if (cellStates[idx] !== LOSCellState.NODATA) count++;
  }
  return count;
}

/**
 * Capture the quality-report context at the export click. Returns null (no
 * quality report, legacy export keeps working) when the current metadata is
 * stale, the result is legacy/unversioned, or the summary cannot be computed
 * from the exact current grid.
 */
export function buildQualityExportContext(input: QualityExportContextInput): QualityExportContext | null {
  const { snapshot, losResult, metric, policy, terrainGrid, terrainMetadata, terrainKey } = input;
  if (!snapshot || !losResult) return null;
  if (losResult.quality_model !== QUALITY_MODEL_V2) return null;
  if (metric !== "INCIDENCE" && metric !== "PROJECTION") return null;
  if (!isValidQualityPolicy(policy)) return null;
  if (!terrainGrid || !terrainMetadata || !terrainKey) return null;
  if (!sameTerrainKey(terrainKey, snapshot.terrainKey)) return null;
  if (terrainMetadata.terrain_id !== snapshot.terrainKey.terrain_id) return null;

  const rows = terrainGrid.length;
  const cols = rows > 0 ? terrainGrid[0]!.length : 0;
  if (rows !== terrainMetadata.grid_rows || cols !== terrainMetadata.grid_cols) return null;
  if (terrainGrid.some((row) => row.length !== cols)) return null;

  const summary = computeQualitySummary({
    metric,
    policy,
    losResult,
    terrainGrid,
    terrainResolution: terrainMetadata.resolution,
    terrainKey,
    snapshot,
  });
  if (!summary) return null;
  // The exact shared target equals the cells of this result that carry terrain data.
  if (summary.target.cellCount !== countNonNodata(losResult.cell_states)) return null;

  return Object.freeze({
    qualityModel: QUALITY_MODEL_V2,
    metric,
    policy: Object.freeze({ mediumMin: policy.mediumMin, highMin: policy.highMin }),
    terrainKey: Object.freeze({ terrain_id: snapshot.terrainKey.terrain_id, epoch: snapshot.terrainKey.epoch }),
    analysisId: snapshot.analysisId,
    sourceAnalysisIds: Object.freeze([...snapshot.sourceAnalysisIds]),
    gridRows: losResult.grid_rows,
    gridCols: losResult.grid_cols,
    resolution: losResult.resolution,
    target: Object.freeze({ ...summary.target }),
    summary: Object.freeze({
      ...summary,
      policy: Object.freeze({ ...summary.policy }),
      target: Object.freeze({ ...summary.target }),
      distribution: summary.distribution ? Object.freeze({ ...summary.distribution }) : null,
    }),
  });
}

function numbersEqual(left: number, right: number): boolean {
  return left === right || Math.abs(left - right) <= 1e-9;
}

function assertNumberEqual(label: string, actual: unknown, expected: number | null): void {
  if (expected === null) {
    if (actual !== null) throw new QualityExportContextError(`Quality export context ${label} must be null`);
    return;
  }
  if (typeof actual !== "number" || !numbersEqual(actual, expected)) {
    throw new QualityExportContextError(`Quality export context ${label} does not match the exported result`);
  }
}

/**
 * Reject any context that does not describe exactly the snapshot and result
 * being exported. Every reported number is re-derived from the result itself
 * (the shared target being the non-NODATA cells of the v2 grid), so a stale or
 * fabricated summary can never reach a PDF/CSV.
 */
export function validateQualityExportContext(
  context: unknown,
  snapshot: AnalysisSnapshot,
  losResult: LOSResponse,
): QualityExportContext {
  if (!context || typeof context !== "object") {
    throw new QualityExportContextError("Quality export context must be an object");
  }
  const candidate = context as Partial<QualityExportContext>;
  if (candidate.qualityModel !== QUALITY_MODEL_V2) {
    throw new QualityExportContextError("Quality export context has an unknown quality model");
  }
  if (candidate.metric !== "INCIDENCE" && candidate.metric !== "PROJECTION") {
    throw new QualityExportContextError("Quality export context has an unknown metric");
  }
  if (!isValidQualityPolicy(candidate.policy)) {
    throw new QualityExportContextError("Quality export context carries an invalid policy");
  }
  const summary = candidate.summary as Partial<QualitySummary> | undefined;
  const target = candidate.target as Partial<CommonTarget> | undefined;
  if (!summary || typeof summary !== "object" || !target || typeof target !== "object") {
    throw new QualityExportContextError("Quality export context is missing its summary or target");
  }

  // Provenance: the context must belong to the exact snapshot being exported.
  if (!sameTerrainKey(candidate.terrainKey, snapshot.terrainKey)) {
    throw new QualityExportContextError("Quality export context does not match the snapshot terrain epoch");
  }
  if (candidate.analysisId !== snapshot.analysisId) {
    throw new QualityExportContextError("Quality export context does not match the snapshot analysis id");
  }
  if (!sameIds(candidate.sourceAnalysisIds, snapshot.sourceAnalysisIds)) {
    throw new QualityExportContextError("Quality export context does not match the snapshot source analyses");
  }

  // Result identity: dimensions, resolution and score model.
  if (!losResult || losResult.quality_model !== QUALITY_MODEL_V2) {
    throw new QualityExportContextError("Quality export context requires a geometric-v2 result");
  }
  if (candidate.gridRows !== losResult.grid_rows || candidate.gridCols !== losResult.grid_cols ||
      candidate.resolution !== losResult.resolution) {
    throw new QualityExportContextError("Quality export context does not match the result grid or resolution");
  }
  if (!(losResult.cell_states instanceof Uint8Array) ||
      losResult.cell_states.length !== losResult.grid_rows * losResult.grid_cols) {
    throw new QualityExportContextError("Quality export context requires a full cell-state grid");
  }

  // Policy consistency between the context and its summary.
  if (!isValidQualityPolicy(summary.policy) ||
      summary.policy.mediumMin !== candidate.policy.mediumMin ||
      summary.policy.highMin !== candidate.policy.highMin) {
    throw new QualityExportContextError("Quality export context summary disagrees with its policy");
  }
  if (summary.metric !== candidate.metric) {
    throw new QualityExportContextError("Quality export context summary disagrees with its metric");
  }
  if (summary.qualityModel !== QUALITY_MODEL_V2) {
    throw new QualityExportContextError("Quality export context summary has an unknown quality model");
  }
  if (target.label !== "Topografía válida completa") {
    throw new QualityExportContextError("Quality export context has an unexpected target definition");
  }

  // Re-derive every number from the result being exported.
  const size = losResult.grid_rows * losResult.grid_cols;
  const metricGrid = candidate.metric === "PROJECTION" ? losResult.flat_projection_grid : losResult.flat_quality_grid;
  if (!(metricGrid instanceof Float32Array) || metricGrid.length !== size) {
    throw new QualityExportContextError("Quality export context requires the selected metric grid");
  }

  const targetCount = countNonNodata(losResult.cell_states);
  const resolution = losResult.resolution;
  let visibleCount = 0;
  let usefulCount = 0;
  let lowCount = 0;
  let mediumCount = 0;
  let highCount = 0;
  let noIndexCount = 0;
  for (let idx = 0; idx < size; idx++) {
    if (losResult.cell_states[idx] !== LOSCellState.VISIBLE) continue;
    visibleCount++;
    const value = metricGrid[idx]!;
    const measured = Number.isFinite(value) && value >= 0 && value <= 1;
    if (!measured) {
      noIndexCount++;
      continue;
    }
    const band = classifyQualityValue(value, candidate.policy);
    if (band === "low") lowCount++;
    else if (band === "medium") mediumCount++;
    else highCount++;
    if (value >= candidate.policy.mediumMin) usefulCount++;
  }

  if (target.cellCount !== targetCount || summary.target?.cellCount !== targetCount) {
    throw new QualityExportContextError("Quality export context target count does not match the exported result");
  }
  assertNumberEqual("target nominal area", target.nominalAreaM2, targetCount * resolution * resolution);
  assertNumberEqual("summary target nominal area", summary.target?.nominalAreaM2, targetCount * resolution * resolution);
  assertNumberEqual("useful count", summary.usefulCount, usefulCount);
  assertNumberEqual("useful coverage", summary.usefulCoveragePct, targetCount > 0 ? (usefulCount / targetCount) * 100 : null);
  assertNumberEqual("useful area", summary.usefulAreaM2, targetCount > 0 ? usefulCount * resolution * resolution : null);
  assertNumberEqual("visible count", summary.visibleCount, visibleCount);
  assertNumberEqual(
    "medium+high among visible",
    summary.mediumHighAmongVisiblePct,
    visibleCount > 0 ? (usefulCount / visibleCount) * 100 : null,
  );

  const distribution = summary.distribution as QualitySummary["distribution"];
  if (visibleCount === 0) {
    if (distribution !== null && distribution !== undefined) {
      throw new QualityExportContextError("Quality export context reports a distribution without visible cells");
    }
  } else {
    if (!distribution || typeof distribution !== "object") {
      throw new QualityExportContextError("Quality export context is missing its visible distribution");
    }
    if (distribution.lowCount !== lowCount || distribution.mediumCount !== mediumCount ||
        distribution.highCount !== highCount || distribution.noIndexCount !== noIndexCount) {
      throw new QualityExportContextError("Quality export context distribution counts do not match the exported result");
    }
    assertNumberEqual("low share", distribution.lowPct, (lowCount / visibleCount) * 100);
    assertNumberEqual("medium share", distribution.mediumPct, (mediumCount / visibleCount) * 100);
    assertNumberEqual("high share", distribution.highPct, (highCount / visibleCount) * 100);
    assertNumberEqual("no-index share", distribution.noIndexPct, (noIndexCount / visibleCount) * 100);
  }

  return candidate as QualityExportContext;
}
