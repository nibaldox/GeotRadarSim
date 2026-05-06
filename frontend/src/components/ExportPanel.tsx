/**
 * ExportPanel — sidebar panel with PDF, CSV, and Image export buttons.
 *
 * Buttons are disabled when no analysis has been run.
 * Shows coverage stats when analysis exists.
 */

import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { exportPDF, exportCSV } from "../services/api";

export function ExportPanel() {
  const losResult = useAnalysisStore((s) => s.losResult);
  const selectedRadarId = useAnalysisStore((s) => s.selectedRadarId);
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const terrainId = useTerrainStore((s) => s.metadata?.terrain_id);
  const hasAnalysis = losResult !== null;

  const buildExportRequest = () => {
    if (!terrainId || !selectedRadarId || !radarPosition) return null;
    return {
      terrain_id: terrainId,
      radar_position: radarPosition,
      radar_model_id: selectedRadarId,
    };
  };

  const handleExportPDF = async () => {
    const req = buildExportRequest();
    if (!req) return;
    try {
      const blob = await exportPDF(req);
      downloadBlob(blob, `coverage-report-${terrainId}.pdf`);
    } catch (err) {
      console.error("PDF export failed:", err);
    }
  };

  const handleExportCSV = async () => {
    const req = buildExportRequest();
    if (!req) return;
    try {
      const blob = await exportCSV(req);
      downloadBlob(blob, `coverage-data-${terrainId}.csv`);
    } catch (err) {
      console.error("CSV export failed:", err);
    }
  };

  const handleExportImage = () => {
    // Image export requires canvas access — placeholder
    const canvas = document.querySelector("canvas");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `terrain-snapshot-${terrainId ?? "unknown"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <div style={{
      padding: "12px",
      backgroundColor: "#1e1e2e",
      borderRadius: "8px",
      color: "#e0e0e0",
      fontSize: "14px",
    }}>
      <h3 style={{ margin: "0 0 8px 0", color: "#fff" }}>Export</h3>

      {hasAnalysis ? (
        <div style={{ marginBottom: "8px", fontSize: "12px", color: "#aaa" }}>
          Coverage: {losResult!.coverage_pct.toFixed(1)}%
          <br />
          Visible area: {losResult!.visible_area_m2.toFixed(0)} m²
          <br />
          Shadow zones: {losResult!.shadow_zones.length}
        </div>
      ) : (
        <p style={{ fontSize: "12px", color: "#888", margin: "0 0 8px 0" }}>
          No analysis data. Run LOS analysis first.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <button
          disabled={!hasAnalysis}
          onClick={() => void handleExportPDF()}
          style={buttonStyle(!hasAnalysis)}
        >
          📄 PDF Report
        </button>
        <button
          disabled={!hasAnalysis}
          onClick={() => void handleExportCSV()}
          style={buttonStyle(!hasAnalysis)}
        >
          📊 CSV Data
        </button>
        <button
          disabled={!hasAnalysis}
          onClick={handleExportImage}
          style={buttonStyle(!hasAnalysis)}
        >
          🖼 Image (PNG)
        </button>
      </div>
    </div>
  );
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: "4px",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    backgroundColor: disabled ? "#333" : "#4a9eff",
    color: disabled ? "#666" : "#fff",
    fontSize: "13px",
    fontWeight: "bold",
    textAlign: "left",
  };
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
