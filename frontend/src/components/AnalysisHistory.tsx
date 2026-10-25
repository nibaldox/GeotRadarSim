import { useState, useCallback, useMemo } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { computeQualitySummary, metricLabel } from "../utils/qualityMetrics";
import type { QualityMetric, QualitySummary } from "../utils/qualityMetrics";
import { QualitySummaryView } from "./QualitySummaryView";

const metricForMode = (mode: "QUALITY" | "SENSITIVITY"): QualityMetric =>
  mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";

export function AnalysisHistory() {
  const history = useAnalysisStore((s) => s.history);
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

  // Collapsible state
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      return localStorage.getItem("geotradar-collapse-history") === "true";
    }
    return false;
  });

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== "undefined" && localStorage.setItem) {
        localStorage.setItem("geotradar-collapse-history", String(next));
      }
      return next;
    });
  }, []);

  if (history.length === 0) return null;

  return (
    <div className="glass-panel mt-4">
      <div 
        onClick={toggleCollapse}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none", marginBottom: isCollapsed ? "0px" : "12px" }}
      >
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>History</h3>
          {!isCollapsed && (
            <button
              onClick={(e) => { e.stopPropagation(); clearHistory(); }}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--danger)",
                cursor: "pointer",
                fontSize: "10px",
                textTransform: "uppercase",
                fontWeight: "bold",
                letterSpacing: "0.05em",
                outline: "none"
              }}
            >
              Clear All
            </button>
          )}
        </div>
        <svg 
          viewBox="0 0 24 24" 
          width="16" 
          height="16" 
          fill="none" 
          stroke="var(--text-secondary)" 
          strokeWidth="2.5" 
          strokeLinecap="round" 
          strokeLinejoin="round"
          style={{ 
            transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", 
            transition: "transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)" 
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {!isCollapsed && (
        <div className="flex-col" style={{ gap: "8px" }}>
        {history.map((entry, idx) => {
          const isSelected = !!entry.selected;
          const summary = summaries[idx] ?? null;
          return (
            <div
              key={`${entry.timestamp}-${idx}`}
              onClick={() => toggleHistoryEntrySelection(idx)}
              title="Click to toggle selection & merge coverage"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                width: "100%",
                padding: "10px",
                background: isSelected ? "var(--accent-glow)" : "rgba(255,255,255,0.03)",
                border: isSelected ? "1px solid var(--accent-color)" : "1px solid var(--panel-border)",
                borderRadius: "8px",
                fontSize: "11px",
                cursor: "pointer",
                boxSizing: "border-box",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                position: "relative"
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                  e.currentTarget.style.borderColor = "var(--panel-border-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                  e.currentTarget.style.borderColor = "var(--panel-border)";
                }
              }}
            >
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {}} // Toggled by parent div onClick
                style={{
                  cursor: "pointer",
                  accentColor: "var(--accent-color)",
                  width: "14px",
                  height: "14px"
                }}
              />

              {/* Card info */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "2px" }}>
                <div className="flex-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ opacity: 0.6, fontSize: "10px", fontFamily: "var(--font-mono)" }}>
                    {entry.timestamp}
                  </span>
                </div>
                <QualitySummaryView
                  compact
                  summary={summary}
                  metricLabel={metricLabel(metric)}
                  coveragePct={entry.coveragePct}
                  completenessPct={entry.result.completeness_pct ?? null}
                />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", opacity: 0.8, fontFamily: "var(--font-mono)", fontSize: "10px" }}>
                  <span><span style={{ opacity: 0.4 }}>X:</span> {entry.position.x.toFixed(0)}</span>
                  <span><span style={{ opacity: 0.4 }}>Y:</span> {entry.position.y.toFixed(0)}</span>
                  <span><span style={{ opacity: 0.4 }}>Z:</span> {entry.position.z.toFixed(0)}</span>
                </div>
              </div>

              {/* Deletion "X" Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation(); // Prevent parent toggle
                  removeHistoryEntry(idx);
                }}
                title="Remove from history"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: "bold",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--danger)";
                  e.currentTarget.style.background = "rgba(255, 0, 0, 0.1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-secondary)";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                &times;
              </button>
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}
