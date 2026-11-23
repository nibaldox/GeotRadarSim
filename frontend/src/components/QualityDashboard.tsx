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
 *
 * The figures come from `useGlobalSummary` (hooks/useGlobalQuality.ts), the
 * same source the viewer KPI bar reads. «Sugerir ubicación» is mounted by
 * App.tsx in its own sidebar slot, not here.
 */

import { metricLabel } from "../utils/qualityMetrics";
import { useGlobalSummary } from "../hooks/useGlobalQuality";
import { QualitySummaryView } from "./QualitySummaryView";
import { AoiCoverageView } from "./AoiCoverageView";
import "../styles/results.css";

export function QualityDashboard() {
  const { summary, guarded, metric, visibility, completeness, hasResult } = useGlobalSummary();

  return (
    <section
      aria-label="Resumen global de calidad"
      data-testid="quality-global-summary"
      className="quality-dashboard results-section"
    >
      {guarded ? (
        <div role="status" data-testid="quality-global-summary-guarded">
          Resumen de calidad en pausa: análisis en curso o terreno en transición.
        </div>
      ) : hasResult ? (
        <QualitySummaryView
          variant="dense"
          summary={summary}
          metricLabel={metricLabel(metric)}
          coveragePct={visibility}
          completenessPct={completeness}
        />
      ) : (
        <div>
          Sin análisis seleccionado. Ejecute un análisis o seleccione entradas
          del historial para ver el resumen de calidad.
        </div>
      )}
      <AoiCoverageView current={!!summary && !guarded} />
    </section>
  );
}
