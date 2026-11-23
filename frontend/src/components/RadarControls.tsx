/**
 * RadarControls — sidebar panel for radar model selection and position display.
 *
 * Shows a dropdown of available radar models loaded from the API.
 * Displays current radar position when placed on terrain.
 */

import { useEffect, useState, useCallback } from "react";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { Section } from "./ui/Section";
import "../styles/panels.css";

export function RadarControls() {
  const radars = useAnalysisStore((s) => s.radars);
  const selectedRadarId = useAnalysisStore((s) => s.selectedRadarId);
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const terrainTransitioning = useAnalysisStore((s) => s.terrainTransitioning);
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
    if (useAnalysisStore.getState().terrainTransitioning) return;
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

  const displayNumber = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) ? String(value) : "—";
  const defaultAperture = selectedRadar?.scan_pattern == null
    ? null : selectedRadar.scan_pattern === "SAR360" ? 360 : 120;
  const factoryRange = selectedRadar?.azimuth_range_deg ?? null;
  const factoryWidth = factoryRange
    ? factoryRange[1] >= factoryRange[0] ? factoryRange[1] - factoryRange[0] : factoryRange[1] - factoryRange[0] + 360
    : 360;
  const factoryCenter = factoryRange
    ? ((factoryRange[0] + factoryWidth / 2 + 540) % 360) - 180
    : 0;
  const adjustedCount = selectedRadar ? [
    [rangeMinOverride, selectedRadar.min_range_m],
    [rangeMaxOverride, selectedRadar.max_range_m],
    [elMinOverride, selectedRadar.elevation_min_deg],
    [elMaxOverride, selectedRadar.elevation_max_deg],
    [azCenterOverride, factoryCenter],
    [azWidthOverride, factoryWidth],
  ].filter(([value, factory]) => value != null && value !== factory).length : 0;
  const summary = selectedRadar
    ? `${selectedRadar.display_name ?? "—"} · ${displayNumber(rangeMinOverride ?? selectedRadar.min_range_m ?? null)}–${displayNumber(rangeMaxOverride ?? selectedRadar.max_range_m ?? null)} m · ${displayNumber(azWidthOverride ?? defaultAperture)}°`
    : "Sin modelo";

  return (
    <Section id="radar" title="Radar" summary={summary} defaultOpen storageKey="geotradar-collapse-radar">
      <div className="panel-fields">
        <label className="cs-label" htmlFor="radar-select">Modelo de radar</label>
        <select id="radar-select" aria-label="Modelo de radar" className="select-box" value={selectedRadarId ?? ""} onChange={(e) => selectRadar(e.target.value || null)} disabled={terrainTransitioning}>
          <option value="">Elige un modelo</option>
          {radars.map((r) => <option key={r.model_id} value={r.model_id}>{r.display_name}</option>)}
        </select>
        {selectedRadar && <Section id="radar-params" title="Parámetros" summary={adjustedCount === 0 ? "de fábrica" : `${adjustedCount} ${adjustedCount === 1 ? "ajustado" : "ajustados"}`} defaultOpen={false} storageKey="geotradar-collapse-radar-params">
          <div className="panel-muted">Fábrica: rango {selectedRadar.min_range_m}–{selectedRadar.max_range_m} m, haz {selectedRadar.h_beam_width_deg}° · Escáner: {selectedRadar.scan_pattern}</div>
          <div className="panel-overrides field-row">
            <label htmlFor="radar-range-min">Rango mín (m)<input id="radar-range-min" type="number" className="select-box" placeholder={String(selectedRadar.min_range_m)} value={rangeMinOverride ?? ""} onChange={(e) => setRangeOverrides(e.target.value ? Number(e.target.value) : null, rangeMaxOverride)} disabled={terrainTransitioning} /></label>
            <label htmlFor="radar-range-max">Rango máx (m)<input id="radar-range-max" type="number" className="select-box" placeholder={String(selectedRadar.max_range_m)} value={rangeMaxOverride ?? ""} onChange={(e) => setRangeOverrides(rangeMinOverride, e.target.value ? Number(e.target.value) : null)} disabled={terrainTransitioning} /></label>
            <label htmlFor="radar-el-min">Elev. mín (°)<input id="radar-el-min" type="number" className="select-box" placeholder={String(selectedRadar.elevation_min_deg)} value={elMinOverride ?? ""} onChange={(e) => setElevationOverrides(e.target.value ? Number(e.target.value) : null, elMaxOverride)} disabled={terrainTransitioning} /></label>
            <label htmlFor="radar-el-max">Elev. máx (°)<input id="radar-el-max" type="number" className="select-box" placeholder={String(selectedRadar.elevation_max_deg)} value={elMaxOverride ?? ""} onChange={(e) => setElevationOverrides(elMinOverride, e.target.value ? Number(e.target.value) : null)} disabled={terrainTransitioning} /></label>
            <label htmlFor="radar-az-center">Azimut (°)<input id="radar-az-center" type="number" className="select-box" placeholder="0" value={azCenterOverride ?? ""} onChange={(e) => setAzimuthOverrides(e.target.value ? Number(e.target.value) : null, azWidthOverride)} disabled={terrainTransitioning} /></label>
            <label htmlFor="radar-az-width">Apertura (°)<input id="radar-az-width" type="number" className="select-box" placeholder={String(selectedRadar.scan_pattern === "SAR360" ? 360 : 120)} value={azWidthOverride ?? ""} onChange={(e) => setAzimuthOverrides(azCenterOverride, e.target.value ? Number(e.target.value) : null)} disabled={terrainTransitioning} /></label>
          </div>
        </Section>}
        <span className="cs-label">Posición</span>
        <div className="panel-position field-row">
          <label htmlFor="radar-coord-x">E<input id="radar-coord-x" type="number" step="0.1" className="select-box" placeholder="Este" value={inputX} onChange={(e) => setInputX(e.target.value)} disabled={terrainTransitioning} /></label>
          <label htmlFor="radar-coord-y">N<input id="radar-coord-y" type="number" step="0.1" className="select-box" placeholder="Norte" value={inputY} onChange={(e) => setInputY(e.target.value)} disabled={terrainTransitioning} /></label>
          <label htmlFor="radar-coord-z">Cota<input id="radar-coord-z" type="number" step="0.1" className="select-box" placeholder="Cota" value={inputZ} onChange={(e) => setInputZ(e.target.value)} disabled={terrainTransitioning} /></label>
          <button className="btn-compact" onClick={handleApplyPosition} disabled={!inputX || !inputY || !inputZ || !selectedRadarId || terrainTransitioning}>Aplicar</button>
        </div>
        {!radarPosition && <span className="panel-muted">Haz clic en el terreno con «Agregar radar» para ubicarlo.</span>}
      </div>
    </Section>
  );
}
