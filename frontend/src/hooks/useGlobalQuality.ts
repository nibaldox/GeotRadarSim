/**
 * useGlobalQuality — single source of the global quality figures.
 *
 * Moves, WITHOUT logic changes:
 * - the `useMemo` that `QualityDashboard` used to compute the global
 *   `QualitySummary` (same guards: loading/multi-loading/terrain transition,
 *   missing result/grid/metadata, missing active or result terrain key), plus
 *   `coverage_pct` and `completeness_pct` read straight from `losResult`;
 * - the area-of-interest coverage that `AoiCoverageView` computed inline
 *   (same currency conditions and the same try/catch), now with the mask
 *   memoised.
 *
 * `QualityDashboard`, `AoiCoverageView` and `KpiBar` all read from here.
 * Each computation goes through a module-level single-entry cache keyed by the
 * identity of its inputs, so the three surfaces share one result object for
 * the same store state instead of recomputing it per component.
 */

import { useMemo } from "react";
import { useAnalysisStore, RADAR_COLORS } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useAoiStore } from "../store/aoiStore";
import { computeQualitySummary } from "../utils/qualityMetrics";
import type { QualityMetric, QualitySummary } from "../utils/qualityMetrics";
import { aoiMaskForGrid, computeAoiCoverage } from "../utils/aoi";

export const metricForMode = (mode: "QUALITY" | "SENSITIVITY"): QualityMetric =>
  mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";

/** Same color the viewer uses for the i-th radar of the active snapshot (TerrainViewer markers). */
export const radarMarkerColor = (index: number): string =>
  RADAR_COLORS[index % RADAR_COLORS.length] || "#ff4444";

// ─── Shared single-entry caches (identity-keyed, no logic of their own) ─────

interface CacheSlot<T> { deps: readonly unknown[]; value: T }

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));
}

function cached<T>(slot: { current: CacheSlot<T> | null }, deps: readonly unknown[], compute: () => T): T {
  if (slot.current && sameDeps(slot.current.deps, deps)) return slot.current.value;
  const value = compute();
  slot.current = { deps, value };
  return value;
}

const summarySlot: { current: CacheSlot<QualitySummary | null> | null } = { current: null };
type MaskOutcome = { ok: true; mask: ReturnType<typeof aoiMaskForGrid> } | { ok: false };
const maskSlot: { current: CacheSlot<MaskOutcome> | null } = { current: null };
type AoiCoverage = ReturnType<typeof computeAoiCoverage> | null;
const coverageSlot: { current: CacheSlot<AoiCoverage> | null } = { current: null };

/** Test-only: drop the shared caches so a test starts from a cold state. */
export function resetGlobalQualityCacheForTests(): void {
  summarySlot.current = null;
  maskSlot.current = null;
  coverageSlot.current = null;
}

// ─── Global summary (moved from QualityDashboard) ───────────────────────────

export interface GlobalSummaryState {
  summary: QualitySummary | null;
  guarded: boolean;
  metric: QualityMetric;
  /** `losResult.coverage_pct ?? null` («Visibilidad (candidatos)»), or null without a result. */
  visibility: number | null;
  /** `losResult.completeness_pct ?? null`, or null without a result. */
  completeness: number | null;
  hasResult: boolean;
}

export function useGlobalSummary(): GlobalSummaryState {
  const policy = useQualityPolicyStore((s) => s.policy);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const terrainGrid = useTerrainStore((s) => s.grid);
  const terrainMetadata = useTerrainStore((s) => s.metadata);
  const terrainKey = useTerrainStore((s) => s.terrainKey);
  const losResult = useAnalysisStore((s) => s.losResult);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const loading = useAnalysisStore((s) => s.loading);
  const multiLoading = useAnalysisStore((s) => s.multiLoading);
  const terrainTransitioning = useAnalysisStore((s) => s.terrainTransitioning);
  const metric: QualityMetric = metricForMode(visualizationMode);

  const guarded = loading || multiLoading || terrainTransitioning;

  const summary: QualitySummary | null = useMemo(() => {
    if (guarded || !losResult || !terrainGrid || !terrainMetadata) return null;
    const resultKey = activeSnapshot?.terrainKey ?? null;
    // Missing snapshot or terrain key is not proof of currency.
    if (!terrainKey || !resultKey) return null;
    return cached(summarySlot, [losResult, activeSnapshot, terrainGrid, terrainMetadata, terrainKey, metric, policy], () =>
      computeQualitySummary({
        metric,
        policy,
        losResult,
        terrainGrid,
        // Expected dimensions and resolution come from the ACTIVE metadata.
        terrainResolution: terrainMetadata.resolution,
        terrainKey,
        snapshot: activeSnapshot,
      }),
    );
  }, [guarded, losResult, activeSnapshot, terrainGrid, terrainMetadata, terrainKey, metric, policy]);

  return {
    summary,
    guarded,
    metric,
    visibility: losResult ? losResult.coverage_pct ?? null : null,
    completeness: losResult ? losResult.completeness_pct ?? null : null,
    hasResult: !!losResult,
  };
}

// ─── Area-of-interest coverage (moved from AoiCoverageView) ─────────────────

export interface AoiCoverageState {
  hasPolygon: boolean;
  coverage: AoiCoverage;
}

/** `current` keeps its old meaning: the caller asserts the global summary is current. */
export function useAoiCoverage(current: boolean): AoiCoverageState {
  const polygon = useAoiStore((s) => s.polygon);
  const areaKey = useAoiStore((s) => s.terrainKey);
  const grid = useTerrainStore((s) => s.grid);
  const metadata = useTerrainStore((s) => s.metadata);
  const terrainKey = useTerrainStore((s) => s.terrainKey);
  const terrainLoading = useTerrainStore((s) => s.loading);
  const losResult = useAnalysisStore((s) => s.losResult);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const analysisKey = useAnalysisStore((s) => s.terrainKey);
  const loading = useAnalysisStore((s) => s.loading);
  const multiLoading = useAnalysisStore((s) => s.multiLoading);
  const terrainTransitioning = useAnalysisStore((s) => s.terrainTransitioning);
  const policy = useQualityPolicyStore((s) => s.policy);
  const mode = useVectorStore((s) => s.visualizationMode);
  const same = (a: typeof terrainKey, b: typeof terrainKey) => !!a && !!b && a.terrain_id === b.terrain_id && a.epoch === b.epoch;
  let coverage: AoiCoverage = null;
  if (current && polygon && grid && metadata && losResult && !loading && !multiLoading && !terrainLoading && !terrainTransitioning && same(terrainKey, areaKey) && same(terrainKey, analysisKey) && same(terrainKey, activeSnapshot?.terrainKey ?? null) && metadata.terrain_id === terrainKey?.terrain_id) {
    try {
      const outcome = cached(maskSlot, [grid, metadata.bounds, metadata.resolution, polygon], (): MaskOutcome => {
        try {
          return { ok: true, mask: aoiMaskForGrid({grid,bounds:metadata.bounds,resolution:metadata.resolution},polygon) };
        } catch {
          return { ok: false };
        }
      });
      if (!outcome.ok) throw new Error("AOI mask unavailable");
      const metric = mode === 'SENSITIVITY' ? 'PROJECTION' : 'INCIDENCE';
      coverage = cached(coverageSlot, [losResult, outcome.mask, policy, metric, grid, metadata.resolution, terrainKey, activeSnapshot], () =>
        computeAoiCoverage(losResult, outcome.mask, policy, {
          metric,
          terrainGrid: grid,
          terrainResolution: metadata.resolution,
          terrainKey,
          snapshot: activeSnapshot,
        }),
      );
    } catch { /* The area has no valid grid cells. */ }
  }
  return { hasPolygon: !!polygon, coverage };
}

// ─── Combined source for the KPI bar and the results section ────────────────

export interface GlobalQuality {
  summary: QualitySummary | null;
  guarded: boolean;
  metric: QualityMetric;
  visibility: number | null;
  completeness: number | null;
  aoi: { usefulPct: number | null; visiblePct: number | null; cellCount: number } | null;
  /** Viewer marker colors of the radars in the active union (snapshot order). */
  radarColors: string[];
}

export function useGlobalQuality(): GlobalQuality {
  const { summary, guarded, metric, visibility, completeness } = useGlobalSummary();
  // Same `current` the dashboard has always passed to the area view.
  const { coverage } = useAoiCoverage(!!summary && !guarded);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const radarColors = useMemo(
    () => (summary && activeSnapshot ? activeSnapshot.radars.map((_, index) => radarMarkerColor(index)) : []),
    [summary, activeSnapshot],
  );
  const aoi = useMemo(
    () => (coverage ? { usefulPct: coverage.usefulPct, visiblePct: coverage.visiblePct, cellCount: coverage.aoiCellCount } : null),
    [coverage],
  );
  return { summary, guarded, metric, visibility, completeness, aoi, radarColors };
}
