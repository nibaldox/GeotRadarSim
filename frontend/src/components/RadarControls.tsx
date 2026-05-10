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
  const rangeMinOverride = useAnalysisStore((s) => s.rangeMinOverride);
  const rangeMaxOverride = useAnalysisStore((s) => s.rangeMaxOverride);
  const setRangeOverrides = useAnalysisStore((s) => s.setRangeOverrides);
  const elMinOverride = useAnalysisStore((s) => s.elMinOverride);
  const elMaxOverride = useAnalysisStore((s) => s.elMaxOverride);
  const setElevationOverrides = useAnalysisStore((s) => s.setElevationOverrides);
  const azCenterOverride = useAnalysisStore((s) => s.azCenterOverride);
  const azWidthOverride = useAnalysisStore((s) => s.azWidthOverride);
  const setAzimuthOverrides = useAnalysisStore((s) => s.setAzimuthOverrides);

  useEffect(() => {
    if (radars.length === 0) {
      void loadRadars();
    }
  }, [radars.length, loadRadars]);

  const selectedRadar = radars.find((r) => r.model_id === selectedRadarId);

  return (
    <div className="glass-panel">
      <h3>Radar Model</h3>

      <label htmlFor="radar-select" className="text-sm" style={{ display: "block", marginBottom: "4px" }}>
        Select Radar Model
      </label>
      <select
        id="radar-select"
        aria-label="Radar model selector"
        className="select-box"
        value={selectedRadarId ?? ""}
        onChange={(e) => selectRadar(e.target.value || null)}
      >
        <option value="">-- Select model --</option>
        {radars.map((r) => (
          <option key={r.model_id} value={r.model_id}>
            {r.display_name}
          </option>
        ))}
      </select>

      {selectedRadar && (
        <div className="text-sm mt-2">
          <div><span className="text-value">Default Range:</span> {selectedRadar.min_range_m}m - {selectedRadar.max_range_m}m</div>
          
          <div className="flex-col mt-2" style={{ gap: "4px" }}>
            <div className="flex-col">
              <label className="text-xs" style={{ opacity: 0.7 }}>Min Range (m)</label>
              <input
                type="number"
                className="select-box"
                style={{ padding: "4px 8px" }}
                placeholder={String(selectedRadar.min_range_m)}
                value={rangeMinOverride ?? ""}
                onChange={(e) => setRangeOverrides(e.target.value ? Number(e.target.value) : null, rangeMaxOverride)}
              />
            </div>
            <div className="flex-col">
              <label className="text-xs" style={{ opacity: 0.7 }}>Max Range (m)</label>
              <input
                type="number"
                className="select-box"
                style={{ padding: "4px 8px" }}
                placeholder={String(selectedRadar.max_range_m)}
                value={rangeMaxOverride ?? ""}
                onChange={(e) => setRangeOverrides(rangeMinOverride, e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          </div>

          <div className="flex-col mt-2" style={{ gap: "4px" }}>
            <div className="flex-col">
              <label className="text-xs" style={{ opacity: 0.7 }}>Min Elevation (°)</label>
              <input
                type="number"
                className="select-box"
                style={{ padding: "4px 8px" }}
                placeholder={String(selectedRadar.elevation_min_deg)}
                value={elMinOverride ?? ""}
                onChange={(e) => setElevationOverrides(e.target.value ? Number(e.target.value) : null, elMaxOverride)}
              />
            </div>
            <div className="flex-col">
              <label className="text-xs" style={{ opacity: 0.7 }}>Max Elevation (°)</label>
              <input
                type="number"
                className="select-box"
                style={{ padding: "4px 8px" }}
                placeholder={String(selectedRadar.elevation_max_deg)}
                value={elMaxOverride ?? ""}
                onChange={(e) => setElevationOverrides(elMinOverride, e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          </div>

          <div className="flex-col mt-2" style={{ gap: "4px" }}>
            <div className="flex-col">
              <label className="text-xs" style={{ opacity: 0.7 }}>Azimuth Center (°)</label>
              <input
                type="number"
                className="select-box"
                style={{ padding: "4px 8px" }}
                placeholder="0"
                value={azCenterOverride ?? ""}
                onChange={(e) => setAzimuthOverrides(e.target.value ? Number(e.target.value) : null, azWidthOverride)}
              />
            </div>
            <div className="flex-col">
              <label className="text-xs" style={{ opacity: 0.7 }}>Scan Aperture (°)</label>
              <input
                type="number"
                className="select-box"
                style={{ padding: "4px 8px" }}
                placeholder={String(selectedRadar.scan_pattern === "SAR360" ? 360 : 120)}
                value={azWidthOverride ?? ""}
                onChange={(e) => setAzimuthOverrides(azCenterOverride, e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          </div>

          <div className="mt-2"><span className="text-value">Scan:</span> {selectedRadar.scan_pattern}</div>
          <div><span className="text-value">H-Beam:</span> {selectedRadar.h_beam_width_deg}°</div>
        </div>
      )}

      <h4 className="mt-4">Position</h4>
      {radarPosition ? (
        <div className="text-sm">
          <div><span className="text-value">X:</span> {radarPosition.x.toFixed(1)}</div>
          <div><span className="text-value">Y:</span> {radarPosition.y.toFixed(1)}</div>
          <div><span className="text-value">Z:</span> {radarPosition.z.toFixed(1)}</div>
        </div>
      ) : (
        <p className="text-sm" style={{ margin: 0 }}>
          Click on terrain to place radar
        </p>
      )}
    </div>
  );
}
