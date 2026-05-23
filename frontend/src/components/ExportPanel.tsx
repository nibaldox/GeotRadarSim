/**
 * ExportPanel — sidebar panel with PDF, CSV, and Image export buttons.
 *
 * All exports are 100% client-side (no server required).
 * - PDF: uses jsPDF with a structured coverage report.
 * - CSV: serializes the quality grid row by row.
 * - Image: captures the WebGL canvas as PNG.
 */

import { useState, useCallback } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { exportPDF, exportCSV } from "../services/api";

export function ExportPanel() {
  const losResult = useAnalysisStore((s) => s.losResult);
  const selectedRadarId = useAnalysisStore((s) => s.selectedRadarId);
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const terrainId = useTerrainStore((s) => s.metadata?.terrain_id);
  const hasAnalysis = losResult !== null;

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
    if (!losResult || !selectedRadarId || !radarPosition) return;

    try {
      const blob = await exportPDF({
        terrain_id: terrainId ?? "terrain",
        radar_position: radarPosition,
        radar_model_id: selectedRadarId,
      }, losResult);
      downloadBlob(blob, `coverage-report-${terrainId ?? "terrain"}.pdf`);
    } catch (err) {
      console.error("PDF export failed:", err);
      alert("Failed to export PDF report");
    }
  };

  // ─── CSV Export ───────────────────────────────────────────────────────────

  const handleExportCSV = async () => {
    if (!losResult || !selectedRadarId || !radarPosition) return;

    try {
      const blob = await exportCSV({
        terrain_id: terrainId ?? "terrain",
        radar_position: radarPosition,
        radar_model_id: selectedRadarId,
      }, losResult);
      downloadBlob(blob, `coverage-data-${terrainId ?? "terrain"}.csv`);
    } catch (err) {
      console.error("CSV export failed:", err);
      alert("Failed to export CSV data");
    }
  };

  // ─── Image Export ─────────────────────────────────────────────────────────

  const handleExportImage = () => {
    const canvas = document.querySelector("canvas");
    if (!canvas) {
      alert("Canvas not found. Make sure the terrain is visible.");
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `terrain-snapshot-${terrainId ?? "terrain"}.png`);
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
              <div><span className="text-value">Coverage:</span> {losResult!.coverage_pct.toFixed(1)}%</div>
              <div><span className="text-value">Visible area:</span> {losResult!.visible_area_m2.toFixed(0)} m²</div>
              <div><span className="text-value">Shadow zones:</span> {losResult!.shadow_zones.length}</div>
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

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
