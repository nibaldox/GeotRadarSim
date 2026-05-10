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
    <div className="glass-panel">
      <h3>Export</h3>

      {hasAnalysis ? (
        <div className="text-sm" style={{ marginBottom: "12px" }}>
          <div><span className="text-value">Coverage:</span> {losResult!.coverage_pct.toFixed(1)}%</div>
          <div><span className="text-value">Visible area:</span> {losResult!.visible_area_m2.toFixed(0)} m²</div>
          <div><span className="text-value">Shadow zones:</span> {losResult!.shadow_zones.length}</div>
        </div>
      ) : (
        <p className="text-sm" style={{ marginBottom: "12px", margin: "0 0 12px 0" }}>
          No analysis data. Run LOS analysis first.
        </p>
      )}

      <div className="flex-col">
        <button
          disabled={!hasAnalysis}
          onClick={() => void handleExportPDF()}
          className="btn-secondary"
        >
          📄 PDF Report
        </button>
        <button
          disabled={!hasAnalysis}
          onClick={() => void handleExportCSV()}
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
