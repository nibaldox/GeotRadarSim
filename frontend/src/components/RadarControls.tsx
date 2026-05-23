/**
 * RadarControls — sidebar panel for radar model selection and position display.
 *
 * Shows a dropdown of available radar models loaded from the API.
 * Displays current radar position when placed on terrain.
 */

import { useEffect, useState, useCallback } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";

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

  // Manual coordinate entry local states
  const [inputX, setInputX] = useState<string>("");
  const [inputY, setInputY] = useState<string>("");
  const [inputZ, setInputZ] = useState<string>("");

  // Collapsible state
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      return localStorage.getItem("geotradar-collapse-radar") === "true";
    }
    return false;
  });

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== "undefined" && localStorage.setItem) {
        localStorage.setItem("geotradar-collapse-radar", String(next));
      }
      return next;
    });
  }, []);

  const terrainMetadata = useTerrainStore((s) => s.metadata);
  const setRadarPosition = useAnalysisStore((s) => s.setRadarPosition);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);

  // Sync inputs with store's radarPosition when it changes
  useEffect(() => {
    if (radarPosition) {
      setInputX(radarPosition.x.toFixed(1));
      setInputY(radarPosition.y.toFixed(1));
      setInputZ(radarPosition.z.toFixed(1));
    } else {
      setInputX("");
      setInputY("");
      setInputZ("");
    }
  }, [radarPosition]);

  const handleApplyPosition = useCallback(async () => {
    if (!inputX || !inputY || !inputZ) return;
    
    const x = Number(inputX);
    const y = Number(inputY);
    const z = Number(inputZ);
    
    if (isNaN(x) || isNaN(y) || isNaN(z)) return;
    
    setRadarPosition({ x, y, z });
    
    if (terrainMetadata) {
      await runAnalysis(terrainMetadata.terrain_id);
    }
  }, [inputX, inputY, inputZ, terrainMetadata, setRadarPosition, runAnalysis]);

  useEffect(() => {
    if (radars.length === 0) {
      void loadRadars();
    }
  }, [radars.length, loadRadars]);

  const selectedRadar = radars.find((r) => r.model_id === selectedRadarId);

  return (
    <div className="glass-panel flex-col">
      <div 
        onClick={toggleCollapse}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
      >
        <h3 style={{ margin: 0 }}>Radar Model</h3>
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
        <div className="flex-col" style={{ marginTop: "10px", gap: "10px" }}>
          <div className="flex-col" style={{ gap: "4px" }}>
            <label htmlFor="radar-select" className="text-sm" style={{ fontWeight: 500 }}>
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
          </div>

          {selectedRadar && (
            <div className="text-sm flex-col" style={{ gap: "10px", marginTop: "4px" }}>
              <div className="hud-card flex-col" style={{ gap: "6px" }}>
                <div style={{ fontWeight: "bold", color: "var(--text-secondary)", textTransform: "uppercase", fontSize: "9px", letterSpacing: "0.05em" }}>
                  📊 Parámetros del Haz de Fábrica
                </div>
                <div className="hud-metric-row">
                  <span className="hud-metric-label">Rango Default</span>
                  <span className="hud-metric-value">{selectedRadar.min_range_m}m - {selectedRadar.max_range_m}m</span>
                </div>
                <div className="hud-metric-row">
                  <span className="hud-metric-label">Escáner</span>
                  <span className="hud-metric-value">{selectedRadar.scan_pattern}</span>
                </div>
                <div className="hud-metric-row">
                  <span className="hud-metric-label">Haz Horizontal</span>
                  <span className="hud-metric-value">{selectedRadar.h_beam_width_deg}°</span>
                </div>
              </div>
              
              <div className="flex-col" style={{ gap: "8px" }}>
                <span style={{ fontSize: "10px", textTransform: "uppercase", fontWeight: "bold", opacity: 0.8, letterSpacing: "0.05em" }}>
                  Overrides de Configuración:
                </span>
                
                <div className="flex-row" style={{ gap: "8px" }}>
                  <div className="flex-col" style={{ flex: 1, gap: "4px" }}>
                    <label className="text-sm" style={{ fontSize: "10px", opacity: 0.7 }}>Min Range (m)</label>
                    <input
                      type="number"
                      className="select-box"
                      style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                      placeholder={String(selectedRadar.min_range_m)}
                      value={rangeMinOverride ?? ""}
                      onChange={(e) => setRangeOverrides(e.target.value ? Number(e.target.value) : null, rangeMaxOverride)}
                    />
                  </div>
                  <div className="flex-col" style={{ flex: 1, gap: "4px" }}>
                    <label className="text-sm" style={{ fontSize: "10px", opacity: 0.7 }}>Max Range (m)</label>
                    <input
                      type="number"
                      className="select-box"
                      style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                      placeholder={String(selectedRadar.max_range_m)}
                      value={rangeMaxOverride ?? ""}
                      onChange={(e) => setRangeOverrides(rangeMinOverride, e.target.value ? Number(e.target.value) : null)}
                    />
                  </div>
                </div>

                <div className="flex-row" style={{ gap: "8px" }}>
                  <div className="flex-col" style={{ flex: 1, gap: "4px" }}>
                    <label className="text-sm" style={{ fontSize: "10px", opacity: 0.7 }}>Min Elevación (°)</label>
                    <input
                      type="number"
                      className="select-box"
                      style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                      placeholder={String(selectedRadar.elevation_min_deg)}
                      value={elMinOverride ?? ""}
                      onChange={(e) => setElevationOverrides(e.target.value ? Number(e.target.value) : null, elMaxOverride)}
                    />
                  </div>
                  <div className="flex-col" style={{ flex: 1, gap: "4px" }}>
                    <label className="text-sm" style={{ fontSize: "10px", opacity: 0.7 }}>Max Elevación (°)</label>
                    <input
                      type="number"
                      className="select-box"
                      style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                      placeholder={String(selectedRadar.elevation_max_deg)}
                      value={elMaxOverride ?? ""}
                      onChange={(e) => setElevationOverrides(elMinOverride, e.target.value ? Number(e.target.value) : null)}
                    />
                  </div>
                </div>

                <div className="flex-row" style={{ gap: "8px" }}>
                  <div className="flex-col" style={{ flex: 1, gap: "4px" }}>
                    <label className="text-sm" style={{ fontSize: "10px", opacity: 0.7 }}>Azimut Centro (°)</label>
                    <input
                      type="number"
                      className="select-box"
                      style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                      placeholder="0"
                      value={azCenterOverride ?? ""}
                      onChange={(e) => setAzimuthOverrides(e.target.value ? Number(e.target.value) : null, azWidthOverride)}
                    />
                  </div>
                  <div className="flex-col" style={{ flex: 1, gap: "4px" }}>
                    <label className="text-sm" style={{ fontSize: "10px", opacity: 0.7 }}>Apertura Escán (°)</label>
                    <input
                      type="number"
                      className="select-box"
                      style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: "11px" }}
                      placeholder={String(selectedRadar.scan_pattern === "SAR360" ? 360 : 120)}
                      value={azWidthOverride ?? ""}
                      onChange={(e) => setAzimuthOverrides(azCenterOverride, e.target.value ? Number(e.target.value) : null)}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          <h4 className="mt-2" style={{ marginBottom: "2px" }}>Position Settings</h4>
          <div className="flex-col text-sm" style={{ gap: "8px" }}>
            <div className="flex-row" style={{ gap: "10px", alignItems: "center" }}>
              <label htmlFor="radar-coord-x" style={{ width: "20px", fontWeight: "bold", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>X:</label>
              <input
                id="radar-coord-x"
                type="number"
                step="0.1"
                className="select-box"
                style={{ padding: "6px 10px", flex: 1, fontFamily: "var(--font-mono)" }}
                placeholder="Easting"
                value={inputX}
                onChange={(e) => setInputX(e.target.value)}
              />
            </div>
            <div className="flex-row" style={{ gap: "10px", alignItems: "center" }}>
              <label htmlFor="radar-coord-y" style={{ width: "20px", fontWeight: "bold", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>Y:</label>
              <input
                id="radar-coord-y"
                type="number"
                step="0.1"
                className="select-box"
                style={{ padding: "6px 10px", flex: 1, fontFamily: "var(--font-mono)" }}
                placeholder="Northing"
                value={inputY}
                onChange={(e) => setInputY(e.target.value)}
              />
            </div>
            <div className="flex-row" style={{ gap: "10px", alignItems: "center" }}>
              <label htmlFor="radar-coord-z" style={{ width: "20px", fontWeight: "bold", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>Z:</label>
              <input
                id="radar-coord-z"
                type="number"
                step="0.1"
                className="select-box"
                style={{ padding: "6px 10px", flex: 1, fontFamily: "var(--font-mono)" }}
                placeholder="Elevation"
                value={inputZ}
                onChange={(e) => setInputZ(e.target.value)}
              />
            </div>
            
            <button
              className="btn-primary mt-2"
              onClick={handleApplyPosition}
              disabled={!inputX || !inputY || !inputZ || !selectedRadarId}
              style={{ padding: "10px 14px", fontSize: "12px", alignSelf: "stretch" }}
            >
              Apply Coordinates
            </button>
            
            {!radarPosition && (
              <p className="text-sm" style={{ margin: "2px 0 0", opacity: 0.6, fontSize: "11px", textAlign: "center" }}>
                * Click on terrain to place automatically
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
