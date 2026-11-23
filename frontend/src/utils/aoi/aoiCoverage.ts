/**
 * «Cobertura del área»: the single source of the AOI coverage metric.
 *
 * Same classification as `computeQualitySummary` (`utils/qualityMetrics.ts`): VISIBLE cells,
 * the selected metric grid (incidence or projection), `classifyQualityValue` with Float32
 * thresholds of the current policy, and the useful numerator = medium + high bands. The
 * only difference is the domain: cells whose mask byte is 1, and the denominator is the
 * number of AOI cells (valid terrain inside the polygon, from `aoiMaskForGrid`).
 *
 * With a mask equal to every finite terrain node, every count and percentage is exactly
 * the summary's (`aoiCoverage.test.ts` checks 500 instances × 3 objectives with `Object.is`).
 *
 * `result` is one LOS result (single radar) or the app's union (`unifiedLos`, built by
 * `mergeResults` in history order, newest first). The order matters for the projection
 * RMS in Float32, so pass the union exactly as the app built it; this module never merges.
 *
 * Null cases (R14 WP14-5): it returns null exactly when `computeQualitySummary` would return
 * null for the same result, metric, policy, terrain and terrain key — it calls the summary
 * itself as the coherence guard (model tag, sizes, resolution, terrain/epoch key, NODATA ⇔
 * non-finite terrain, known states, metric grid) — and also when the mask is not a 0/1
 * Uint8Array of the same size or marks a node without finite terrain.
 *
 * The metric is required (R14 WP14-4): the caller passes the metric selected in the app, so
 * the area coverage can never silently use another index than the dashboard.
 */

import { LOSCellState } from "../../types/api";
import type { LOSResponse } from "../../types/api";
import { QUALITY_MODEL_V2, classifyQualityValue, computeQualitySummary } from "../qualityMetrics";
import type { QualityDistribution, QualityMetric, QualityModelTag, QualityPolicy, QualitySummaryInput } from "../qualityMetrics";

export interface AoiCoverage {
  readonly metric: QualityMetric;
  readonly qualityModel: QualityModelTag;
  readonly policy: QualityPolicy;
  /** AOI cells (valid terrain inside the polygon): the denominator. */
  readonly aoiCellCount: number;
  /** Nominal planar area of the AOI, count × resolution². */
  readonly aoiAreaM2: number;
  /** VISIBLE AOI cells with a finite selected metric at or above mediumMin (Float32). */
  readonly usefulCount: number;
  /** usefulCount / aoiCellCount × 100: «Cobertura del área» (`aoi_useful_pct`). */
  readonly usefulPct: number | null;
  readonly usefulAreaM2: number | null;
  readonly visibleCount: number;
  /** visibleCount / aoiCellCount × 100. */
  readonly visiblePct: number | null;
  /** usefulCount / visibleCount × 100 inside the AOI. */
  readonly mediumHighAmongVisiblePct: number | null;
  readonly distribution: QualityDistribution | null;
}

/** What `computeQualitySummary` needs besides the result and the policy; all required. */
export interface AoiCoverageContext {
  /** Selected index, as in the summary (required). */
  readonly metric: QualityMetric;
  readonly terrainGrid: QualitySummaryInput["terrainGrid"];
  readonly terrainResolution: number;
  /** Active terrain key; must equal the result snapshot's key, as in the summary. */
  readonly terrainKey: QualitySummaryInput["terrainKey"];
  readonly snapshot: QualitySummaryInput["snapshot"];
}

/** Percentage with the summary's exact formula: (count / total) × 100, null without a total. */
export function aoiPercent(count: number, total: number): number | null {
  return total > 0 ? (count / total) * 100 : null;
}

export function computeAoiCoverage(
  result: LOSResponse,
  mask: Uint8Array,
  policy: QualityPolicy,
  context: AoiCoverageContext,
): AoiCoverage | null {
  if (!context || typeof context !== "object") return null;
  const metric = context.metric;
  if (metric !== "INCIDENCE" && metric !== "PROJECTION") return null;
  if (!result) return null;
  // The summary is the coherence guard: same null cases by construction.
  const summary = computeQualitySummary({
    metric, policy, losResult: result, terrainGrid: context.terrainGrid, terrainResolution: context.terrainResolution,
    terrainKey: context.terrainKey, snapshot: context.snapshot,
  });
  if (summary === null) return null;
  const { grid_rows: rows, grid_cols: cols, resolution } = result;
  const size = rows * cols;
  if (!(mask instanceof Uint8Array) || mask.length !== size) return null;
  const metricGrid = (metric === "PROJECTION" ? result.flat_projection_grid : result.flat_quality_grid)!;

  let aoiCellCount = 0;
  let visibleCount = 0;
  let usefulCount = 0;
  let lowCount = 0;
  let mediumCount = 0;
  let highCount = 0;
  let noIndexCount = 0;
  for (let idx = 0; idx < size; idx++) {
    const inside = mask[idx]!;
    if (inside === 0) continue;
    if (inside !== 1) return null;
    aoiCellCount++;
    const state = result.cell_states[idx]!;
    // The summary already checked NODATA ⇔ non-finite terrain, so this is an AOI cell without terrain.
    if (state === LOSCellState.NODATA) return null;
    if (state !== LOSCellState.VISIBLE) continue;
    visibleCount++;
    const value = metricGrid[idx]!;
    const measured = Number.isFinite(value) && value >= 0 && value <= 1;
    if (!measured) {
      noIndexCount++;
      continue;
    }
    const band = classifyQualityValue(value, policy);
    if (band === "low") lowCount++;
    else if (band === "medium") mediumCount++;
    else highCount++;
    if (band === "medium" || band === "high") usefulCount++;
  }

  return {
    metric,
    qualityModel: QUALITY_MODEL_V2,
    policy: { mediumMin: policy.mediumMin, highMin: policy.highMin },
    aoiCellCount,
    aoiAreaM2: aoiCellCount * resolution * resolution,
    usefulCount,
    usefulPct: aoiPercent(usefulCount, aoiCellCount),
    usefulAreaM2: aoiCellCount > 0 ? usefulCount * resolution * resolution : null,
    visibleCount,
    visiblePct: aoiPercent(visibleCount, aoiCellCount),
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
