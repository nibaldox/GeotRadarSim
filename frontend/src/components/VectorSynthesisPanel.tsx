import { useMemo, useState, useCallback } from "react";
import { useVectorStore } from "../store/vectorStore";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

export function VectorSynthesisPanel() {
  const selectedCell = useVectorStore((s) => s.selectedCell);

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
  const trueSlideMagnitude = useVectorStore((s) => s.trueSlideMagnitude);
  const noiseLevel = useVectorStore((s) => s.noiseLevel);
  const reconstructionResult = useVectorStore((s) => s.reconstructionResult);
  const sensitivityGrid = useVectorStore((s) => s.sensitivityGrid);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const loading = useVectorStore((s) => s.loading);
  const error = useVectorStore((s) => s.error);

  const updateMagnitude = useVectorStore((s) => s.updateMagnitude);
  const updateNoise = useVectorStore((s) => s.updateNoise);
  const computeSensitivityMap = useVectorStore((s) => s.computeSensitivityMap);
  const setVisualizationMode = useVectorStore((s) => s.setVisualizationMode);
  const reset = useVectorStore((s) => s.reset);

  const grid = useTerrainStore((s) => s.grid);
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
  const activeRadarModel = useAnalysisStore((s) => s.selectedRadarId);

  const activeRadarName = useMemo(() => {
    if (!activeRadarModel) return "Radar Activo Principal";
    return useAnalysisStore.getState().radars.find(r => r.model_id === activeRadarModel)?.display_name ?? activeRadarModel;
  }, [activeRadarModel]);

  const handleMagnitudeChange = (val: number) => {
    if (grid && metadata) {
      updateMagnitude(val, grid, metadata.bounds, metadata.resolution);
    }
  };

  const handleNoiseChange = (val: number) => {
    if (grid && metadata) {
      updateNoise(val, grid, metadata.bounds, metadata.resolution);
    }
  };

  const handleComputeSensitivity = () => {
    if (metadata?.terrain_id) {
      computeSensitivityMap(metadata.terrain_id);
    }
  };

  const stats = useMemo(() => {
    if (!reconstructionResult) return null;
    const { trueVector, reconstructedVector, apparentSingleVector, determinant, sensitivity } = reconstructionResult;

    const magReal = Math.sqrt(trueVector[0]**2 + trueVector[1]**2 + trueVector[2]**2);
    const magApp = Math.sqrt(apparentSingleVector[0]**2 + apparentSingleVector[1]**2 + apparentSingleVector[2]**2);
    
    let magRec = 0;
    let errMag = 0;
    let errAng = 0;

    if (reconstructedVector) {
      magRec = Math.sqrt(reconstructedVector[0]**2 + reconstructedVector[1]**2 + reconstructedVector[2]**2);
      errMag = magRec - magReal;

      // Dot product for angle
      const dot = trueVector[0] * reconstructedVector[0] + trueVector[1] * reconstructedVector[1] + trueVector[2] * reconstructedVector[2];
      const cosTheta = Math.max(-1.0, Math.min(1.0, dot / (magReal * magRec || 1.0)));
      errAng = (Math.acos(cosTheta) * 180) / Math.PI;
    }

    const lossPct = magReal > 0 ? (1 - magApp / magReal) * 100 : 0;

    return {
      magReal,
      magApp,
      magRec,
      errMag,
      errAng,
      lossPct,
      determinant,
      sensitivity
    };
  }, [reconstructionResult]);

  const isSingular = stats && Math.abs(stats.determinant) < 1e-5;

  return (
    <div className="glass-panel flex-col">
      <div 
        onClick={toggleCollapse}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
      >
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Síntesis Vectorial 3D</h3>
          {selectedCell && (
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--danger)",
                cursor: "pointer",
                fontSize: "10px",
                textTransform: "uppercase",
                fontWeight: "bold",
                outline: "none"
              }}
            >
              Quitar Selección
            </button>
          )}
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
          <strong>⚠️ Red Incompleta:</strong> Selecciona al menos 2 análisis de radar en el panel de <strong>Historial</strong> (mediante sus casillas de verificación) para habilitar la reconstrucción vectorial 3D. Un solo radar solo capta movimientos 1D (en la línea de visión).
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
              border: "1px solid var(--panel-border)"
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

          {sensitivityGrid && (
            <div style={{ fontSize: "10px", color: "var(--success)", background: "hsla(125, 85%, 45%, 0.06)", padding: "6px 10px", borderRadius: "6px", border: "1px solid hsla(125, 85%, 45%, 0.15)", fontFamily: "var(--font-mono)" }}>
              ✓ Mapa de sensibilidad vectorial global cargado en el shader.
            </div>
          )}

          <hr style={{ border: "0", borderTop: "1px solid var(--panel-border)", margin: "4px 0" }} />

          {/* User inputs for vector simulator */}
          <div className="flex-col" style={{ gap: "10px" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "4px" }}>
                <span style={{ fontWeight: 500 }}>MAGNITUD REAL talud:</span>
                <span style={{ fontWeight: "bold", color: "hsl(207, 73%, 57%)", fontFamily: "var(--font-mono)" }}>{trueSlideMagnitude} mm</span>
              </div>
              <input
                type="range"
                min="5"
                max="200"
                value={trueSlideMagnitude}
                onChange={(e) => handleMagnitudeChange(Number(e.target.value))}
                style={{ width: "100%", accentColor: "hsl(207, 73%, 57%)", cursor: "pointer" }}
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "4px" }}>
                <span style={{ fontWeight: 500 }}>RUIDO Gaussiano:</span>
                <span style={{ fontWeight: "bold", color: "var(--danger)", fontFamily: "var(--font-mono)" }}>±{noiseLevel} mm</span>
              </div>
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={noiseLevel}
                onChange={(e) => handleNoiseChange(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--danger)", cursor: "pointer" }}
              />
            </div>
          </div>

          <hr style={{ border: "0", borderTop: "1px solid var(--panel-border)", margin: "4px 0" }} />

          {/* Active selected point or instructions */}
          {!selectedCell ? (
            <div style={{
              padding: "16px",
              background: "hsla(0, 0%, 100%, 0.01)",
              borderRadius: "8px",
              border: "1px dashed hsla(0, 0%, 100%, 0.12)",
              fontSize: "11px",
              textAlign: "center",
              color: "var(--text-secondary)",
              lineHeight: "1.6"
            }}>
              💡 <strong>Simular Deslizamiento local:</strong><br />
              Da <strong>doble clic</strong> en cualquier celda de la ladera del visor 3D para activar el resolvedor analítico e inducir un movimiento local.
            </div>
          ) : (
            <div className="flex-col" style={{ gap: "10px" }}>
              <div className="hud-card">
                <div style={{ fontWeight: "bold", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: "6px", fontSize: "9px", letterSpacing: "0.05em" }}>
                  📍 Coordenadas de Celda Seleccionada
                </div>
                <div className="hud-metric-row">
                  <span className="hud-metric-label">X (Easting)</span>
                  <span className="hud-metric-value">{selectedCell.x.toFixed(2)} m</span>
                </div>
                <div className="hud-metric-row">
                  <span className="hud-metric-label">Y (Northing)</span>
                  <span className="hud-metric-value">{selectedCell.y.toFixed(2)} m</span>
                </div>
                <div className="hud-metric-row">
                  <span className="hud-metric-label">Z (Elevación)</span>
                  <span className="hud-metric-value">{selectedCell.z.toFixed(2)} m</span>
                </div>
              </div>

              {loading && <div style={{ fontSize: "11px", textAlign: "center", opacity: 0.6, fontFamily: "var(--font-mono)" }}>⟳ Reconstruyendo vector por Mínimos Cuadrados...</div>}
              {error && <div className="error-text">❌ Error: {error}</div>}

              {stats && reconstructionResult && (
                <div className="flex-col" style={{ gap: "10px" }}>
                  
                  {/* True Vector (Real) */}
                  <div className="hud-card" style={{ borderLeft: "4px solid hsl(207, 73%, 57%)", background: "hsla(207, 73%, 57%, 0.03)" }}>
                    <div className="hud-metric-row" style={{ borderBottom: "none", padding: 0 }}>
                      <span style={{ fontWeight: "bold", color: "hsl(207, 73%, 57%)", fontSize: "10px", letterSpacing: "0.02em" }}>🔵 VECTOR REAL (Gravedad)</span>
                      <span className="hud-metric-value highlight-blue">{stats.magReal.toFixed(1)} mm</span>
                    </div>
                    <div style={{ fontSize: "10px", opacity: 0.7, marginTop: "6px", color: "var(--text-secondary)" }}>
                      Dirección: [{reconstructionResult.trueVector.map(v => v.toFixed(1)).join(", ")}]
                    </div>
                  </div>

                  {/* Apparent Vector */}
                  <div className="hud-card" style={{ borderLeft: "4px solid var(--danger)", background: "hsla(351, 100%, 60%, 0.03)" }}>
                    <div className="hud-metric-row" style={{ borderBottom: "none", padding: 0 }}>
                      <span style={{ fontWeight: "bold", color: "var(--danger)", fontSize: "10px", letterSpacing: "0.02em" }}>🔴 LECTURA APARENTE (1D)</span>
                      <span className="hud-metric-value highlight-red">{stats.magApp.toFixed(1)} mm</span>
                    </div>
                    <div style={{ fontSize: "9px", opacity: 0.5, fontStyle: "italic", marginTop: "2px" }}>
                      Basado en {activeRadarName}
                    </div>
                    <div className="hud-metric-row" style={{ borderTop: "1px dashed hsla(351, 100%, 60%, 0.15)", marginTop: "6px", paddingTop: "6px", borderBottom: "none" }}>
                      <span className="hud-metric-label" style={{ color: "hsl(351, 100%, 80%)" }}>⚠️ Pérdida de Medida</span>
                      <span className="hud-metric-value highlight-red">-{stats.lossPct.toFixed(1)}%</span>
                    </div>
                  </div>

                  {/* Reconstructed Multi-Radar Vector */}
                  <div className="hud-card" style={{
                    borderLeft: isSingular ? "4px solid var(--warning)" : "4px solid var(--success)",
                    background: isSingular ? "hsla(40, 100%, 55%, 0.03)" : "hsla(125, 85%, 45%, 0.03)"
                  }}>
                    <div className="hud-metric-row" style={{ borderBottom: "none", padding: 0 }}>
                      <span style={{ fontWeight: "bold", color: isSingular ? "var(--warning)" : "var(--success)", fontSize: "10px", letterSpacing: "0.02em" }}>🟢 VECTOR RECONSTRUIDO (3D)</span>
                      <span className={`hud-metric-value ${isSingular ? 'highlight-warning' : 'highlight-green'}`}>
                        {isSingular ? "ERROR" : `${stats.magRec.toFixed(1)} mm`}
                      </span>
                    </div>
                    
                    {isSingular ? (
                      <div style={{ fontSize: "9px", color: "var(--warning)", marginTop: "6px", lineHeight: "1.4" }}>
                        ⚠️ <strong>Geometría Singular:</strong> Radares alineados. Matriz no invertible. Determinante: {stats.determinant.toExponential(2)}
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: "10px", opacity: 0.7, marginTop: "6px", color: "var(--text-secondary)" }}>
                          Calculado: [{reconstructionResult.reconstructedVector?.map(v => v.toFixed(1)).join(", ")}]
                        </div>
                        <div className="hud-metric-row" style={{ borderTop: "1px dashed hsla(125, 85%, 45%, 0.15)", marginTop: "6px", paddingTop: "6px", borderBottom: "none" }}>
                          <span className="hud-metric-label">Error Angular</span>
                          <span className="hud-metric-value highlight-green">{stats.errAng.toFixed(2)}°</span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Sensitivity statistics */}
                  <div className="hud-card" style={{
                    background: stats.sensitivity < 0.2 ? "hsla(271, 76%, 53%, 0.08)" : "hsla(0, 0%, 0%, 0.25)",
                    border: stats.sensitivity < 0.2 ? "1px solid hsla(271, 76%, 53%, 0.3)" : "1px solid hsla(0, 0%, 100%, 0.04)"
                  }}>
                    <div className="hud-metric-row" style={{ borderBottom: "none", padding: 0 }}>
                      <span className="hud-metric-label" style={{ color: stats.sensitivity < 0.2 ? "hsl(271, 76%, 80%)" : "var(--text-secondary)", fontSize: "10px" }}>Índice de Sensibilidad Geométrica ($S_v$)</span>
                      <span className="hud-metric-value" style={{ color: stats.sensitivity < 0.2 ? "hsl(271, 76%, 70%)" : "#fff" }}>
                        {(stats.sensitivity * 100).toFixed(0)}%
                      </span>
                    </div>
                    {stats.sensitivity < 0.2 && (
                      <div style={{ fontSize: "9px", color: "hsl(271, 76%, 70%)", marginTop: "6px", lineHeight: "1.4" }}>
                        ⚠️ <strong>Zona Ciega Vectorial:</strong> El movimiento es ortogonal a la red de radares. Los datos son propensos a amplificar el ruido.
                      </div>
                    )}
                  </div>

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
                    📖 <strong>Lección de Física:</strong> Los radares reales de monitoreo geotécnico miden el movimiento exclusivamente en la dirección de su haz (1D Line-of-Sight). Al cruzar las mediciones de múltiples radares mediante la pseudoinversa de Moore-Penrose, podemos reconstruir el vector verdadero en 3D. Compara cómo la flecha verde (reconstruida) recupera la dirección de la flecha azul (deslizamiento real) a pesar de que el radar capta una lectura muy deficiente (flecha roja).
                  </div>

                </div>
              )}
            </div>
          )}
        </>
      )}
        </div>
      )}
    </div>
  );
}
