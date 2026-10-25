/**
 * ExportPanel — sidebar panel with PDF, CSV, and Image export buttons.
 *
 * All exports are 100% client-side (no server required).
 * - PDF: uses jsPDF with a structured coverage report.
 * - CSV: serializes the quality grid row by row.
 * - Image: captures the WebGL canvas as PNG.
 *
 * For current geometric-v2 results the click captures an optional quality
 * context (metric, policy copy, target and summary from the current terrain
 * grid) that the export engine re-verifies before writing the useful-coverage
 * report. Legacy exports keep working without it and never invent one.
 */

import { useState, useCallback } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { exportPDF, exportCSV } from "../services/api";
import { metricLabel } from "../utils/qualityMetrics";
import { buildQualityExportContext, metricForVisualizationMode } from "../utils/qualityReport";
import type { QualityExportContext } from "../utils/qualityReport";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const sameTerrainKey = (
  left: Readonly<{ terrain_id: string; epoch: number }> | null,
  right: Readonly<{ terrain_id: string; epoch: number }> | null,
): boolean => !!left && !!right && left.terrain_id === right.terrain_id && left.epoch === right.epoch;

function cloneAnalysisSnapshot(snapshot: AnalysisSnapshot): AnalysisSnapshot {
  return {
    terrainKey: { ...snapshot.terrainKey },
    analysisId: snapshot.analysisId,
    sourceAnalysisIds: [...snapshot.sourceAnalysisIds],
    generation: snapshot.generation,
    radars: snapshot.radars.map((radar) => ({
      radarId: radar.radarId,
      radarModelId: radar.radarModelId,
      position: { ...radar.position },
      overrides: { ...radar.overrides },
    })),
  };
}

function isCurrentExport(snapshot: AnalysisSnapshot, result: LOSResponse): boolean {
  const analysis = useAnalysisStore.getState();
  const terrain = useTerrainStore.getState();
  return analysis.activeSnapshot === snapshot && analysis.losResult === result &&
    !analysis.terrainTransitioning &&
    sameTerrainKey(snapshot.terrainKey, analysis.terrainKey) &&
    sameTerrainKey(snapshot.terrainKey, terrain.terrainKey) &&
    terrain.metadata?.terrain_id === snapshot.terrainKey.terrain_id;
}

/**
 * Capture the quality-report context synchronously at the click from the
 * current metric/policy/terrain grid. Returns null (legacy export) for
 * unversioned results or stale terrain metadata.
 */
function captureQualityContext(snapshot: AnalysisSnapshot, result: LOSResponse): QualityExportContext | null {
  const terrain = useTerrainStore.getState();
  return buildQualityExportContext({
    snapshot,
    losResult: result,
    metric: metricForVisualizationMode(useVectorStore.getState().visualizationMode),
    policy: useQualityPolicyStore.getState().policy,
    terrainGrid: terrain.grid,
    terrainMetadata: terrain.metadata,
    terrainKey: terrain.terrainKey,
  });
}

export function ExportPanel() {
  const losResult = useAnalysisStore((s) => s.losResult);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const analysisTerrainKey = useAnalysisStore((s) => s.terrainKey);
  const terrainTransitioning = useAnalysisStore((s) => s.terrainTransitioning);
  const terrainKey = useTerrainStore((s) => s.terrainKey);
  const terrainId = useTerrainStore((s) => s.metadata?.terrain_id);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const hasAnalysis = !!losResult && !!activeSnapshot && !terrainTransitioning &&
    sameTerrainKey(activeSnapshot.terrainKey, analysisTerrainKey) &&
    sameTerrainKey(activeSnapshot.terrainKey, terrainKey) &&
    terrainId === activeSnapshot.terrainKey.terrain_id;
  const isV2Result = losResult?.quality_model === "geometric-v2";

  // Collapsible state
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      return localStorage.getItem("geotradar-collapse-export") === "true";
    }
    return false;
  });

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== "undefined" && localStorage.setItem) {
        localStorage.setItem("geotradar-collapse-export", String(next));
      }
      return next;
    });
  }, []);

  // ─── PDF Export ───────────────────────────────────────────────────────────

  const handleExportPDF = async () => {
    const snapshot = useAnalysisStore.getState().activeSnapshot;
    const result = useAnalysisStore.getState().losResult;
    if (!snapshot || !result || !isCurrentExport(snapshot, result)) return;

    const qualityContext = captureQualityContext(snapshot, result);
    try {
      const exportableSnapshot = cloneAnalysisSnapshot(snapshot);
      const blob = await exportPDF(exportableSnapshot, result, qualityContext ?? undefined);
      if (!isCurrentExport(snapshot, result)) return;
      downloadBlob(blob, `coverage-report-${snapshot.terrainKey.terrain_id}.pdf`);
    } catch (err) {
      if (!isCurrentExport(snapshot, result)) return;
      console.error("PDF export failed:", err);
      alert("Failed to export PDF report");
    }
  };

  // ─── CSV Export ───────────────────────────────────────────────────────────

  const handleExportCSV = async () => {
    const snapshot = useAnalysisStore.getState().activeSnapshot;
    const result = useAnalysisStore.getState().losResult;
    if (!snapshot || !result || !isCurrentExport(snapshot, result)) return;

    const qualityContext = captureQualityContext(snapshot, result);
    try {
      const exportableSnapshot = cloneAnalysisSnapshot(snapshot);
      const blob = await exportCSV(exportableSnapshot, result, qualityContext ?? undefined);
      if (!isCurrentExport(snapshot, result)) return;
      downloadBlob(blob, `coverage-data-${snapshot.terrainKey.terrain_id}.csv`);
    } catch (err) {
      if (!isCurrentExport(snapshot, result)) return;
      console.error("CSV export failed:", err);
      alert("Failed to export CSV data");
    }
  };

  // ─── Image Export ─────────────────────────────────────────────────────────

  const handleExportImage = () => {
    const snapshot = useAnalysisStore.getState().activeSnapshot;
    const result = useAnalysisStore.getState().losResult;
    if (!snapshot || !result || !isCurrentExport(snapshot, result)) return;
    const canvas = document.querySelector("canvas");
    if (!canvas) {
      alert("Canvas not found. Make sure the terrain is visible.");
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob || !isCurrentExport(snapshot, result)) return;
      downloadBlob(blob, `terrain-snapshot-${snapshot.terrainKey.terrain_id}.png`);
    }, "image/png");
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="glass-panel">
      <div 
        onClick={toggleCollapse}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
      >
        <h3 style={{ margin: 0 }}>Export</h3>
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
        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {hasAnalysis ? (
            <div className="text-sm" style={{ marginBottom: "2px" }}>
              <div><span className="text-value">Visibilidad (candidatos):</span> {formatPercent(losResult!.coverage_pct)}</div>
              <div><span className="text-value">Completeness:</span> {formatPercent(losResult!.completeness_pct)}</div>
              <div><span className="text-value">Visible area:</span> {Number.isFinite(losResult!.visible_area_m2) ? `${losResult!.visible_area_m2.toFixed(0)} m²` : "Sin datos"}</div>
              <div><span className="text-value">Shadow zones:</span> {losResult!.shadow_zones.length}</div>
              {isV2Result ? (
                <div>
                  Los informes PDF y CSV incluyen cobertura útil y calidad (métrica: {metricLabel(metricForVisualizationMode(visualizationMode))}).
                </div>
              ) : (
                <div>
                  Resultado sin modelo de calidad v2: los informes no incluyen cobertura útil y conservan la visibilidad (candidatos).
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm" style={{ marginBottom: "2px", margin: "0 0 4px 0" }}>
              No analysis data. Run LOS analysis first.
            </p>
          )}

          <div className="flex-col">
            <button
              disabled={!hasAnalysis}
              onClick={handleExportPDF}
              className="btn-secondary"
            >
              📄 PDF Report
            </button>
            <button
              disabled={!hasAnalysis}
              onClick={handleExportCSV}
              className="btn-secondary"
            >
              📊 CSV Data
            </button>
            <button
              disabled={!hasAnalysis}
              onClick={handleExportImage}
              className="btn-secondary"
            >
              🖼 Image (PNG)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Sin datos";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
