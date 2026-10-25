/**
 * QualityDashboard — global quality summary for the current selected set
 * (the active LOS result, merged from the selected history entries by the
 * analysis store). Uses the same shared QualitySummaryView and policy as the
 * per-card summaries so every surface reports identical numbers.
 *
 * Guards: active terrain metadata (dimensions + resolution) is the expected
 * source of truth, never the result's own resolution; exact terrain epoch with
 * result provenance is required (a missing snapshot or terrain key is not proof
 * of currency); loading and terrain transitions pause the summary instead of
 * showing stale numbers.
 */

import { useMemo } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { computeQualitySummary, metricLabel } from "../utils/qualityMetrics";
import type { QualityMetric, QualitySummary } from "../utils/qualityMetrics";
import { QualitySummaryView } from "./QualitySummaryView";

const metricForMode = (mode: "QUALITY" | "SENSITIVITY"): QualityMetric =>
  mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";

export function QualityDashboard() {
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
    return computeQualitySummary({
      metric,
      policy,
      losResult,
      terrainGrid,
      // Expected dimensions and resolution come from the ACTIVE metadata.
      terrainResolution: terrainMetadata.resolution,
      terrainKey,
      snapshot: activeSnapshot,
    });
  }, [guarded, losResult, activeSnapshot, terrainGrid, terrainMetadata, terrainKey, metric, policy]);

  return (
    <section
      aria-label="Resumen global de calidad"
      data-testid="quality-global-summary"
      className="glass-panel"
    >
      <h3 style={{ margin: "0 0 8px 0" }}>Resumen global de calidad</h3>
      {guarded ? (
        <div role="status" data-testid="quality-global-summary-guarded">
          Resumen de calidad en pausa: análisis en curso o terreno en transición.
        </div>
      ) : losResult ? (
        <QualitySummaryView
          summary={summary}
          metricLabel={metricLabel(metric)}
          coveragePct={losResult.coverage_pct ?? null}
          completenessPct={losResult.completeness_pct ?? null}
        />
      ) : (
        <div>
          Sin análisis seleccionado. Ejecute un análisis o seleccione entradas
          del historial para ver el resumen de calidad.
        </div>
      )}
    </section>
  );
}
