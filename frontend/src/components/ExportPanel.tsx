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

import { useState } from "react";
import "../styles/panels.css";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { metricLabel } from "../utils/qualityMetrics";
import { metricForVisualizationMode } from "../utils/qualityReport";
import { ExportError, isCurrentExport, prepareExport, sameTerrainKey } from "../services/exportActions";
import type { ExportFormat } from "../services/exportActions";
import { prepareManagementReport } from "../report/reportAction";
import { ReportError } from "../report/types";
import { reportStateSignature } from "../report/reportModel";

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

  const handleExport = async (format: ExportFormat) => {
    try {
      const prepared = await prepareExport(format);
      if (!isCurrentExport(prepared.provenance.snapshot, prepared.provenance.result)) return;
      try {
        downloadBlob(prepared.blob, prepared.filename);
      } catch (error) {
        if (!isCurrentExport(prepared.provenance.snapshot, prepared.provenance.result)) return;
        if (format === "png") throw error;
        throw new ExportError("EXPORT_FAILED", error);
      }
    } catch (err) {
      if (!(err instanceof ExportError)) throw err;
      if (err.code === "CANVAS_NOT_FOUND") {
        alert("No se encontró el visor. Asegúrate de que el terreno esté visible.");
      } else if (err.code === "EXPORT_FAILED" && format !== "png") {
        console.error(`${format.toUpperCase()} export failed:`, err.cause);
        alert(format === "pdf" ? "No se pudo exportar el PDF técnico" : "No se pudo exportar el CSV");
      }
    }
  };

  const [reportTitle, setReportTitle] = useState("");
  const [reportGenerating, setReportGenerating] = useState(false);
  const handleReport = async () => {
    if (reportGenerating) return;
    setReportGenerating(true);
    const { activeSnapshot: snapshot, losResult: result } = useAnalysisStore.getState();
    try {
      const signature = reportStateSignature();
      const prepared = await prepareManagementReport({ title: reportTitle });
      if (!snapshot || !result || !isCurrentExport(snapshot, result) || signature !== reportStateSignature()) {
        throw new ReportError("STALE", "El análisis cambió durante la generación. Vuelve a generar el informe.");
      }
      downloadBlob(prepared.blob, prepared.filename);
    } catch (err) {
      if (err instanceof ReportError) alert(err.message);
      else {
        console.error("No se pudo generar el informe.", err);
        alert("No se pudo generar el informe. Inténtalo nuevamente.");
      }
    } finally {
      setReportGenerating(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="glass-panel panel-fields panel-export" aria-label="Exportar">
      <label className="cs-label" htmlFor="management-report-title">Título del informe (opcional)</label>
      <input id="management-report-title" value={reportTitle} maxLength={80} onChange={(event) => setReportTitle(event.target.value)} />
      <button className="btn-compact primary" disabled={!hasAnalysis || reportGenerating} onClick={() => void handleReport()}>{reportGenerating ? "Generando…" : "Informe para reunión"}</button>
      <div className="panel-export-row field-row">
        <button disabled={!hasAnalysis} onClick={() => void handleExport("pdf")} className="btn-compact">PDF técnico</button>
        <button disabled={!hasAnalysis} onClick={() => void handleExport("csv")} className="btn-compact" title={isV2Result ? `Los informes PDF y CSV incluyen cobertura útil y calidad (métrica: ${metricLabel(metricForVisualizationMode(visualizationMode))}).` : "Resultado sin modelo de calidad v2: los informes no incluyen cobertura útil y conservan la visibilidad (candidatos)."}>CSV</button>
        <button disabled={!hasAnalysis} onClick={() => void handleExport("png")} className="btn-compact">PNG</button>
      </div>
      {!hasAnalysis && <span className="panel-muted">Aún no hay análisis. Ubica un radar y calcula la cobertura.</span>}
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
