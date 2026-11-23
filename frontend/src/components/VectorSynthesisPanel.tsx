import { useMemo } from "react";
import { useVectorStore } from "../store/vectorStore";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";
import { Section } from "./ui/Section";
import "../styles/panels.css";

function countObservedCells(counts: Uint16Array | null): number {
  if (!counts) return 0;
  let observed = 0;
  for (const count of counts) if (count > 0) observed++;
  return observed;
}

export function VectorSynthesisPanel() {
  const sensitivityMap = useVectorStore((s) => s.sensitivityMap);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const loading = useVectorStore((s) => s.loading);
  const error = useVectorStore((s) => s.error);

  const computeSensitivityMap = useVectorStore((s) => s.computeSensitivityMap);
  const setVisualizationMode = useVectorStore((s) => s.setVisualizationMode);
  const observedCellCount = useMemo(
    () => countObservedCells(sensitivityMap?.observer_count ?? null),
    [sensitivityMap],
  );

  const metadata = useTerrainStore((s) => s.metadata);
  const history = useAnalysisStore((s) => s.history);
  
  const deployedRadars = useMemo(() => {
    const selected = history.filter(h => h.selected);
    return selected.map((h, idx) => ({
      id: h.timestamp + '-' + idx,
      modelId: h.radarId,
      position: h.position
    }));
  }, [history]);

  const handleComputeSensitivity = () => {
    if (metadata?.terrain_id) {
      computeSensitivityMap(metadata.terrain_id);
    }
  };

  return (
    <Section id="vector" title="Sensibilidad 3D" summary={visualizationMode === "QUALITY" ? "Incidencia superficial" : "Proyección del movimiento"} defaultOpen={false} storageKey="geotradar-collapse-vector">
      <div className="panel-fields">
        {deployedRadars.length < 1 ? (
          <div className="panel-muted">Sin radares seleccionados: selecciona al menos un análisis en Historial.</div>
        ) : <>
          <div className="panel-info-row">
            <span className="panel-muted">{deployedRadars.length === 1 ? "Una postura" : "Varias posturas"}</span>
            <details className="panel-info"><summary aria-label="Información de sensibilidad">i</summary>
              <div>Una postura: cuando el LOS individual es VISIBLE y el gradiente es calculable, el valor es |dot| entre la dirección de movimiento de máxima pendiente y la línea de vista del radar. Varias posturas: sensibilidad por celda √(Σ dot² / número de radares contribuyentes); solo aportan análisis con LOS individual VISIBLE y gradiente calculable.</div>
              <div>Incidencia superficial: alineación de la normal del terreno con el LOS; la distancia no multiplica el índice. Proyección del movimiento: vista geotécnica del movimiento — proyección escalar sobre la dirección de máxima pendiente (movimiento supuesto de máxima pendiente; no es una inversión de desplazamiento en 3 ejes).</div>
              <div>Sensibilidad geométrica: mide la proyección sobre la dirección de máxima pendiente usando solo radares con LOS individual VISIBLE y gradiente finito calculable. Sin contribuyentes, la celda queda transparente y es “Sin datos”; un cero con al menos un contribuyente sí es un valor medido. Es un índice geométrico, no SNR ni un modelo RF.</div>
            </details>
          </div>
          <span className="cs-label">Modo de capa del terreno</span>
          <div className="panel-segments field-row">
            <button type="button" onClick={() => setVisualizationMode("QUALITY")} className="btn-compact" aria-pressed={visualizationMode === "QUALITY"}>Incidencia superficial</button>
            <button type="button" onClick={() => setVisualizationMode("SENSITIVITY")} className="btn-compact" aria-pressed={visualizationMode === "SENSITIVITY"}>Proyección del movimiento</button>
          </div>
          <button onClick={handleComputeSensitivity} disabled={loading} className="btn-compact primary">{loading ? "Calculando…" : "Calcular mapa de sensibilidad"}</button>
          {error && <div className="error-text panel-status">Error: {error}</div>}
          {sensitivityMap && observedCellCount > 0 && <div role="status" className="panel-status">Mapa geométrico cargado — {observedCellCount} {observedCellCount === 1 ? "celda con observación contribuyente" : "celdas con observaciones contribuyentes"}.</div>}
          {sensitivityMap && observedCellCount === 0 && <div role="status" className="panel-status">Sin datos: no hay celdas con gradiente calculable y al menos un LOS individual VISIBLE.</div>}
        </>}
      </div>
    </Section>
  );
}
