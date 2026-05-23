import { useMemo, useState, useCallback } from "react";
import { useVectorStore } from "../store/vectorStore";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

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

  const sensitivityGrid = useVectorStore((s) => s.sensitivityGrid);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const loading = useVectorStore((s) => s.loading);
  const error = useVectorStore((s) => s.error);

  const computeSensitivityMap = useVectorStore((s) => s.computeSensitivityMap);
  const setVisualizationMode = useVectorStore((s) => s.setVisualizationMode);

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

          {deployedRadars.length < 2 ? (
            <div style={{
              padding: "12px",
              background: "hsla(351, 100%, 60%, 0.08)",
              borderRadius: "8px",
              borderLeft: "4px solid var(--danger)",
              fontSize: "11px",
              color: "hsl(351, 100%, 80%)",
              lineHeight: "1.5"
            }}>
              <strong>⚠️ Red Incompleta:</strong> Selecciona al menos 2 análisis de radar en el panel de <strong>Historial</strong> (mediante sus casillas de verificación) para habilitar el análisis de sensibilidad geométrica 3D.
            </div>
          ) : (
            <>
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

              {sensitivityGrid && (
                <div style={{ fontSize: "10px", color: "var(--success)", background: "hsla(125, 85%, 45%, 0.06)", padding: "6px 10px", borderRadius: "6px", border: "1px solid hsla(125, 85%, 45%, 0.15)", fontFamily: "var(--font-mono)" }}>
                  ✓ Mapa de sensibilidad vectorial global cargado en el shader.
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
                📖 <strong>Sensibilidad Geométrica:</strong> Muestra qué tan bien la red actual de radares es capaz de detectar movimientos en la dirección de máxima pendiente del talud. El color púrpura indica zonas ciegas (movimiento ortogonal a la red), mientras que el verde indica zonas con sensibilidad óptima.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
