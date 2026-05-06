/**
 * RadarControls — sidebar panel for radar model selection and position display.
 *
 * Shows a dropdown of available radar models loaded from the API.
 * Displays current radar position when placed on terrain.
 */

import { useEffect } from "react";
import { useAnalysisStore } from "../store/analysisStore";

export function RadarControls() {
  const radars = useAnalysisStore((s) => s.radars);
  const selectedRadarId = useAnalysisStore((s) => s.selectedRadarId);
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const loadRadars = useAnalysisStore((s) => s.loadRadars);
  const selectRadar = useAnalysisStore((s) => s.selectRadar);

  useEffect(() => {
    if (radars.length === 0) {
      void loadRadars();
    }
  }, [radars.length, loadRadars]);

  const selectedRadar = radars.find((r) => r.model_id === selectedRadarId);

  return (
    <div style={{
      padding: "12px",
      backgroundColor: "#1e1e2e",
      borderRadius: "8px",
      color: "#e0e0e0",
      fontSize: "14px",
    }}>
      <h3 style={{ margin: "0 0 8px 0", color: "#fff" }}>Radar Model</h3>

      <label htmlFor="radar-select" style={{ display: "block", marginBottom: "4px" }}>
        Select Radar Model
      </label>
      <select
        id="radar-select"
        aria-label="Radar model selector"
        value={selectedRadarId ?? ""}
        onChange={(e) => selectRadar(e.target.value || null)}
        style={{
          width: "100%",
          padding: "6px",
          borderRadius: "4px",
          backgroundColor: "#2a2a3e",
          color: "#e0e0e0",
          border: "1px solid #444",
        }}
      >
        <option value="">-- Select model --</option>
        {radars.map((r) => (
          <option key={r.model_id} value={r.model_id}>
            {r.display_name}
          </option>
        ))}
      </select>

      {selectedRadar && (
        <div style={{ marginTop: "8px", fontSize: "12px", color: "#aaa" }}>
          <div>Range: {selectedRadar.max_range_m}m</div>
          <div>Scan: {selectedRadar.scan_pattern}</div>
          <div>H-Beam: {selectedRadar.h_beam_width_deg}°</div>
        </div>
      )}

      <h4 style={{ margin: "12px 0 4px 0", color: "#fff" }}>Position</h4>
      {radarPosition ? (
        <div style={{ fontSize: "12px", color: "#aaa" }}>
          <div>X: {radarPosition.x.toFixed(1)}</div>
          <div>Y: {radarPosition.y.toFixed(1)}</div>
          <div>Z: {radarPosition.z.toFixed(1)}</div>
        </div>
      ) : (
        <p style={{ fontSize: "12px", color: "#888", margin: 0 }}>
          Click on terrain to place radar
        </p>
      )}
    </div>
  );
}
