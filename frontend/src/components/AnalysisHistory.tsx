import { useState, useMemo } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { computeQualitySummary, metricLabel } from "../utils/qualityMetrics";
import type { QualityMetric, QualitySummary } from "../utils/qualityMetrics";
import { QualitySummaryView } from "./QualitySummaryView";
import { Section } from "./ui/Section";
import { radarMarkerColor } from "../hooks/useGlobalQuality";
import "../styles/history.css";

const formatPercent = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Sin datos";

const metricForMode = (mode: "QUALITY" | "SENSITIVITY"): QualityMetric =>
  mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";

export function AnalysisHistory() {
  const history = useAnalysisStore((s) => s.history);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const [openEntries, setOpenEntries] = useState<Set<string>>(() => new Set());
  const clearHistory = useAnalysisStore((s) => s.clearHistory);
  const toggleHistoryEntrySelection = useAnalysisStore((s) => s.toggleHistoryEntrySelection);
  const removeHistoryEntry = useAnalysisStore((s) => s.removeHistoryEntry);
  const terrainGrid = useTerrainStore((s) => s.grid);
  const terrainMetadata = useTerrainStore((s) => s.metadata);
  const terrainKey = useTerrainStore((s) => s.terrainKey);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const policy = useQualityPolicyStore((s) => s.policy);
  const metric = metricForMode(visualizationMode);

  // Per-entry current quality summary with terrain/epoch guards; reclassified
  // live by policy edits without rerunning any LOS analysis.
  const summaries = useMemo(
    () => history.map((entry): QualitySummary | null => {
      if (!terrainGrid || !terrainMetadata) return null;
      const resultKey = entry.snapshot?.terrainKey ?? null;
      // A missing snapshot or terrain key is not proof of currency while the
      // terrain state is active: no current quality, recalculate instead.
      if (!terrainKey || !resultKey) return null;
      return computeQualitySummary({
        metric,
        policy,
        losResult: entry.result,
        terrainGrid,
        // Expected dimensions and resolution come from the ACTIVE metadata.
        terrainResolution: terrainMetadata.resolution,
        terrainKey,
        snapshot: entry.snapshot ?? null,
      });
    }),
    [history, terrainGrid, terrainMetadata, terrainKey, metric, policy],
  );

  if (history.length === 0) return null;

  return (
    <Section id="history" title="Historial" defaultOpen storageKey="geotradar-collapse-history"
      summary={`${history.filter((entry) => entry.selected).length} de ${history.length} seleccionados`}
      actions={<button type="button" className="history-clear" onClick={clearHistory}>Borrar todo</button>}>
      <div className="history-list">
        {history.map((entry, idx) => {
          const key = `${entry.radarId}-${entry.timestamp}`;
          const open = openEntries.has(key);
          const summary = summaries[idx] ?? null;
          const snapshotIndex = activeSnapshot?.radars.findIndex((radar) => radar.radarId === entry.radarId) ?? -1;
          const color = radarMarkerColor(snapshotIndex >= 0 ? snapshotIndex : idx);
          const toggleDetail = () => setOpenEntries((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          });
          return (
            <div className="history-entry" key={`${key}-${idx}`}>
              <div className="history-row">
                <label className="history-select">
                  <input type="checkbox" checked={!!entry.selected}
                    aria-label={`Seleccionar radar ${idx + 1}`}
                    onChange={() => toggleHistoryEntrySelection(idx)} />
                </label>
                <div className="history-row-toggle" role="button" tabIndex={0} aria-expanded={open}
                  onClick={toggleDetail}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleDetail();
                    }
                  }}>
                  <span className="history-color" aria-hidden="true" style={{ backgroundColor: color }} />
                  <span className="history-name">R {idx + 1}</span>
                  <span className="history-metrics">útil {formatPercent(summary?.usefulCoveragePct)} · vis {formatPercent(entry.coveragePct)}</span>
                </div>
                <button type="button" className="history-remove" title="Quitar del historial"
                  aria-label="Quitar del historial" onClick={() => removeHistoryEntry(idx)}>×</button>
              </div>
              {open && <div className="history-detail">
                <div>E {entry.position.x.toFixed(0)} · N {entry.position.y.toFixed(0)} · Cota {entry.position.z.toFixed(0)} m</div>
                <div>{entry.timestamp}</div>
                <QualitySummaryView compact summary={summary} metricLabel={metricLabel(metric)}
                  coveragePct={entry.coveragePct} completenessPct={entry.result.completeness_pct ?? null} />
              </div>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
