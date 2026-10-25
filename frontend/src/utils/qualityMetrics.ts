/**
 * Pure geometric-quality policy and summary helpers.
 *
 * Shared by history cards, the global summary, both color layers, their
 * legends and the export pipeline so every surface reports the same policy,
 * target and numbers. No I/O, no stores, no React.
 */

import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

/** Score-model tag carried by every new worker/merged result. */
export const QUALITY_MODEL_V2 = "geometric-v2";
export type QualityModelTag = typeof QUALITY_MODEL_V2;

/** Selected index: surface incidence or slope-motion projection. */
export type QualityMetric = "INCIDENCE" | "PROJECTION";

export interface QualityPolicy {
  mediumMin: number;
  highMin: number;
}

/**
 * Provisional band defaults copied from the legacy LOS legend.
 * Not equipment-certified thresholds.
 */
export const DEFAULT_QUALITY_POLICY: QualityPolicy = { mediumMin: 0.3, highMin: 0.7 };

export type QualityBand = "low" | "medium" | "high";

export function isValidQualityPolicy(policy: unknown): policy is QualityPolicy {
  if (!policy || typeof policy !== "object") return false;
  const { mediumMin, highMin } = policy as QualityPolicy;
  return Number.isFinite(mediumMin) && Number.isFinite(highMin) &&
    0 <= mediumMin && mediumMin < highMin && highMin <= 1;
}

/** Strict boundaries: low q < mediumMin; medium mediumMin <= q < highMin; high q >= highMin. */
export function classifyQualityValue(value: number, policy: QualityPolicy): QualityBand | null {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  if (value < policy.mediumMin) return "low";
  if (value < policy.highMin) return "medium";
  return "high";
}

function formatThreshold(value: number): string {
  return value.toFixed(2);
}

/** Numeric band interval exactly as classified and painted, for legends and exports. */
export function formatBandRange(band: QualityBand, policy: QualityPolicy): string {
  switch (band) {
    case "low": return `0.00 - ${formatThreshold(policy.mediumMin)}`;
    case "medium": return `${formatThreshold(policy.mediumMin)} - ${formatThreshold(policy.highMin)}`;
    case "high": return `${formatThreshold(policy.highMin)} - 1.00`;
  }
}

export function metricLabel(metric: QualityMetric): string {
  return metric === "PROJECTION" ? "Proyección del movimiento" : "Incidencia superficial";
}

export interface CommonTarget {
  /** Explicit shared-target definition label. */
  label: "Topografía válida completa";
  cellCount: number;
  /** Nominal planar area, count × resolution². Not inclined surface area. */
  nominalAreaM2: number;
}

/** All finite raster nodes of the active terrain; independent of any radar footprint. */
export function computeCommonTarget(
  terrainGrid: readonly (readonly number[])[],
  resolution: number,
): CommonTarget {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new RangeError("Common target resolution must be finite and positive");
  }
  let cellCount = 0;
  for (const row of terrainGrid) {
    for (const value of row) {
      if (Number.isFinite(value)) cellCount++;
    }
  }
  return {
    label: "Topografía válida completa",
    cellCount,
    nominalAreaM2: cellCount * resolution * resolution,
  };
}

export interface QualityDistribution {
  lowCount: number;
  mediumCount: number;
  highCount: number;
  /** VISIBLE cells whose selected metric is missing (no computable gradient). */
  noIndexCount: number;
  lowPct: number;
  mediumPct: number;
  highPct: number;
  noIndexPct: number;
}

export interface QualitySummary {
  metric: QualityMetric;
  qualityModel: QualityModelTag;
  policy: QualityPolicy;
  target: CommonTarget;
  /** VISIBLE cells with a finite selected metric at or above mediumMin. */
  usefulCount: number;
  /** usefulCount / common target, or null without a target. */
  usefulCoveragePct: number | null;
  usefulAreaM2: number | null;
  visibleCount: number;
  /** Same useful numerator over all VISIBLE cells, or null without visible cells. */
  mediumHighAmongVisiblePct: number | null;
  /** Low/medium/high/no-index over all VISIBLE, or null without visible cells. */
  distribution: QualityDistribution | null;
}

export interface QualitySummaryInput {
  metric: QualityMetric;
  policy: QualityPolicy;
  losResult: LOSResponse;
  terrainGrid: readonly (readonly number[])[];
  terrainResolution: number;
  /** Active terrain key; combined with the result/snapshot key as an epoch guard. */
  terrainKey?: Readonly<{ terrain_id: string; epoch: number }> | null;
  /** Immutable provenance of the result being summarized, when available. */
  snapshot?: AnalysisSnapshot | null;
}

const sameKey = (
  left: Readonly<{ terrain_id: string; epoch: number }> | null | undefined,
  right: Readonly<{ terrain_id: string; epoch: number }> | null | undefined,
): boolean => {
  if (!left || !right) return true;
  return left.terrain_id === right.terrain_id && left.epoch === right.epoch;
};

/**
 * Current quality summary for one result, or null when quality is unavailable
 * (legacy/unversioned data, wrong version, mismatched terrain epoch, dimensions
 * or resolution, or a missing metric grid). Missing is never reported as zero.
 */
export function computeQualitySummary(input: QualitySummaryInput): QualitySummary | null {
  const { metric, policy, losResult, terrainGrid, terrainResolution } = input;
  if (!isValidQualityPolicy(policy)) return null;
  if (losResult.quality_model !== QUALITY_MODEL_V2) return null;

  const rows = terrainGrid.length;
  const cols = rows > 0 ? terrainGrid[0]!.length : 0;
  if (losResult.grid_rows !== rows || losResult.grid_cols !== cols ||
      losResult.resolution !== terrainResolution ||
      !(losResult.cell_states instanceof Uint8Array) ||
      losResult.cell_states.length !== rows * cols) {
    return null;
  }
  const resultKey = input.snapshot?.terrainKey ?? null;
  if (!sameKey(input.terrainKey, resultKey)) return null;

  const size = rows * cols;
  const metricGrid = metric === "PROJECTION" ? losResult.flat_projection_grid : losResult.flat_quality_grid;
  if (!(metricGrid instanceof Float32Array) || metricGrid.length !== size) return null;

  const target = computeCommonTarget(terrainGrid, terrainResolution);
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
    // v2 incidence reserves -1 as the non-visible sentinel; NaN means missing index.
    const measured = Number.isFinite(value) && value >= 0 && value <= 1;
    if (!measured) {
      noIndexCount++;
      continue;
    }
    const band = classifyQualityValue(value, policy);
    if (band === "low") lowCount++;
    else if (band === "medium") mediumCount++;
    else highCount++;
    if (value >= policy.mediumMin) usefulCount++;
  }

  return {
    metric,
    qualityModel: QUALITY_MODEL_V2,
    policy: { mediumMin: policy.mediumMin, highMin: policy.highMin },
    target,
    usefulCount,
    usefulCoveragePct: target.cellCount > 0 ? (usefulCount / target.cellCount) * 100 : null,
    usefulAreaM2: target.cellCount > 0 ? usefulCount * terrainResolution * terrainResolution : null,
    visibleCount,
    mediumHighAmongVisiblePct: visibleCount > 0 ? (usefulCount / visibleCount) * 100 : null,
    distribution: visibleCount > 0 ? {
      lowCount,
      mediumCount,
      highCount,
      noIndexCount,
      lowPct: (lowCount / visibleCount) * 100,
      mediumPct: (mediumCount / visibleCount) * 100,
      highPct: (highCount / visibleCount) * 100,
      noIndexPct: (noIndexCount / visibleCount) * 100,
    } : null,
  };
}
