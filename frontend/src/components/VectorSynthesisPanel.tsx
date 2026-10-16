import { useMemo, useState, useCallback } from "react";
import { useVectorStore } from "../store/vectorStore";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

function countObservedCells(counts: Uint16Array | null): number {
  if (!counts) return 0;
  let observed = 0;
  for (const count of counts) if (count > 0) observed++;
  return observed;
}

export function VectorSynthesisPanel() {
  // Collapsible state
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      return localStorage.getItem("geotradar-collapse-vector") === "true";
    }
    return false;
  });

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== "undefined" && localStorage.setItem) {
        localStorage.setItem("geotradar-collapse-vector", String(next));
      }
      return next;
    });
  }, []);

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
    <div className="glass-panel flex-col">
      <div 
        onClick={toggleCollapse}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
      >
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Sensibilidad Geométrica 3D</h3>
        </div>
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
        <div className="flex-col" style={{ marginTop: "10px" }}>

          {deployedRadars.length < 1 ? (
            <div style={{
              padding: "12px",
              background: "hsla(351, 100%, 60%, 0.08)",
              borderRadius: "8px",
              borderLeft: "4px solid var(--danger)",
              fontSize: "11px",
              color: "hsl(351, 100%, 80%)",
              lineHeight: "1.5"
            }}>
              <strong>⚠️ Sin radares seleccionados:</strong> Selecciona al menos 1 análisis de radar en el panel de <strong>Historial</strong> (mediante sus casillas de verificación) para habilitar el análisis de sensibilidad.
            </div>
          ) : (
            <>
              {/* Dynamic warning/info badge based on posture count */}
              <div style={{
                padding: "10px 12px",
                background: deployedRadars.length === 1 ? "hsla(38, 90%, 45%, 0.08)" : "hsla(125, 85%, 45%, 0.08)",
                borderRadius: "8px",
                borderLeft: deployedRadars.length === 1 ? "4px solid var(--warning)" : "4px solid var(--success)",
                fontSize: "11px",
                color: deployedRadars.length === 1 ? "var(--text-primary)" : "hsl(125, 85%, 80%)",
                lineHeight: "1.5",
                marginBottom: "12px"
              }}>
                {deployedRadars.length === 1 ? (
                  <>
                    <strong>💡 Una postura:</strong> cuando el LOS individual es VISIBLE y el gradiente es calculable, el valor es <strong>|dot|</strong> entre la dirección de movimiento de máxima pendiente y la línea de vista del radar.
                  </>
                ) : (
                  <>
                    <strong>✓ Varias posturas:</strong> sensibilidad por celda <strong>√(Σ dot² / número de radares contribuyentes)</strong>; solo aportan análisis con LOS individual VISIBLE y gradiente calculable.
                  </>
                )}
              </div>
              {/* Visual Overlay Mode Selection */}
              <div className="flex-col" style={{ gap: "6px" }}>
                <span style={{ fontSize: "10px", textTransform: "uppercase", fontWeight: "bold", opacity: 0.8, letterSpacing: "0.05em" }}>
                  Modo de Capa del Terreno:
                </span>
                <div className="flex-row" style={{ gap: "8px" }}>
                  <button
                    onClick={() => setVisualizationMode("QUALITY")}
                    className="btn-primary"
                    style={{
                      flex: 1,
                      padding: "8px",
                      fontSize: "11px",
                      background: visualizationMode === "QUALITY" 
                        ? "linear-gradient(135deg, var(--success), hsl(125, 85%, 35%))" 
                        : "hsla(0, 0%, 100%, 0.03)",
                      border: visualizationMode === "QUALITY" ? "none" : "1px solid var(--panel-border)",
                      boxShadow: visualizationMode === "QUALITY" ? "0 0 10px hsla(125, 85%, 45%, 0.3)" : "none"
                    }}
                  >
                    Calidad LOS (1D)
                  </button>
                  <button
                    onClick={() => setVisualizationMode("SENSITIVITY")}
                    className="btn-primary"
                    style={{
                      flex: 1,
                      padding: "8px",
                      fontSize: "11px",
                      background: visualizationMode === "SENSITIVITY"
                        ? "linear-gradient(135deg, hsl(271, 76%, 53%), hsl(271, 76%, 40%))" 
                        : "hsla(0, 0%, 100%, 0.03)",
                      border: visualizationMode === "SENSITIVITY" ? "none" : "1px solid var(--panel-border)",
                      boxShadow: visualizationMode === "SENSITIVITY" ? "0 0 10px hsla(271, 76%, 53%, 0.3)" : "none"
                    }}
                  >
                    Sensibilidad (3D)
                  </button>
                </div>
              </div>

              {/* Trigger global map computation */}
              <button
                onClick={handleComputeSensitivity}
                disabled={loading}
                className="btn-primary"
                style={{
                  padding: "10px",
                  fontSize: "11px",
                  background: "linear-gradient(135deg, hsl(230, 20%, 15%), hsl(230, 20%, 8%))",
                  border: "1px solid var(--panel-border)",
                  cursor: "pointer"
                }}
              >
                {loading ? (
                  <span className="flex-row" style={{ gap: "8px", alignItems: "center" }}>
                    <span className="spinner-neon" /> Calculando...
                  </span>
                ) : (
                  "🗺️ Calcular Mapa de Sensibilidad 3D"
                )}
              </button>

              {error && <div className="error-text">❌ Error: {error}</div>}

              {sensitivityMap && observedCellCount > 0 && (
                <div role="status" style={{ fontSize: "10px", color: "var(--success)", background: "hsla(125, 85%, 45%, 0.06)", padding: "6px 10px", borderRadius: "6px", border: "1px solid hsla(125, 85%, 45%, 0.15)", fontFamily: "var(--font-mono)" }}>
                  ✓ Mapa geométrico cargado — {observedCellCount} {observedCellCount === 1 ? "celda con observación contribuyente" : "celdas con observaciones contribuyentes"}.
                </div>
              )}
              {sensitivityMap && observedCellCount === 0 && (
                <div role="status" style={{ fontSize: "10px", color: "var(--text-secondary)", background: "hsla(0, 0%, 100%, 0.03)", padding: "6px 10px", borderRadius: "6px" }}>
                  Sin datos: no hay celdas con gradiente calculable y al menos un LOS individual VISIBLE.
                </div>
              )}

              {/* Educational explanation */}
              <div style={{
                padding: "10px 12px",
                background: "hsla(0, 0%, 100%, 0.01)",
                borderRadius: "6px",
                border: "1px solid hsla(0, 0%, 100%, 0.03)",
                fontSize: "10px",
                color: "var(--text-secondary)",
                lineHeight: "1.5",
                marginTop: "2px"
              }}>
                📖 <strong>Sensibilidad geométrica:</strong> mide la proyección sobre la dirección de máxima pendiente usando solo radares con LOS individual VISIBLE y gradiente finito calculable. Sin contribuyentes, la celda queda transparente y es “Sin datos”; un cero con al menos un contribuyente sí es un valor medido. Es un índice geométrico, no SNR ni un modelo RF.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
