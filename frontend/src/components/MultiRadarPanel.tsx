/**
 * MultiRadarPanel — manage multiple deployed radars and run unified analysis.
 *
 * Workflow:
 * 1. Configure a radar in RadarControls (model + position + overrides)
 * 2. Click "Add to Network" to deploy it to the list
 * 3. Repeat for as many radars as needed
 * 4. Click "Run Network Analysis" to compute unified coverage
 */

import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";

function formatPercent(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Sin datos";
}

export function MultiRadarPanel() {
  const deployedRadars = useAnalysisStore((s) => s.deployedRadars);
  const multiLoading = useAnalysisStore((s) => s.multiLoading);
  const unifiedLos = useAnalysisStore((s) => s.unifiedLos);
  const deployCurrentRadar = useAnalysisStore((s) => s.deployCurrentRadar);
  const removeDeployedRadar = useAnalysisStore((s) => s.removeDeployedRadar);
  const clearDeployedRadars = useAnalysisStore((s) => s.clearDeployedRadars);
  const runMultiAnalysis = useAnalysisStore((s) => s.runMultiAnalysis);
  const terrainId = useTerrainStore((s) => s.metadata?.terrain_id);
  const radars = useAnalysisStore((s) => s.radars);

  const getDisplayName = (modelId: string) =>
    radars.find((r) => r.model_id === modelId)?.display_name ?? modelId;

  return (
    <div className="glass-panel flex-col">
      <div className="flex-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
        <h3 style={{ margin: 0 }}>Radar Network</h3>
        {deployedRadars.length > 0 && (
          <button
            onClick={clearDeployedRadars}
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
            Clear All
          </button>
        )}
      </div>

      {/* Add current radar */}
      <button
        className="btn-primary"
        style={{ marginBottom: "2px" }}
        onClick={deployCurrentRadar}
        disabled={multiLoading}
      >
        + Add Current Radar to Network
      </button>

      {/* Deployed list */}
      {deployedRadars.length === 0 ? (
        <p className="text-sm" style={{ margin: "0 0 4px 0", opacity: 0.6 }}>
          Configure a radar, place it on terrain, then click Add.
        </p>
      ) : (
        <div className="flex-col" style={{ gap: "8px", marginBottom: "4px" }}>
          {deployedRadars.map((dr, idx) => (
            <div
              key={dr.id}
              className="hud-card flex-row"
              style={{
                alignItems: "center",
                gap: "10px",
                borderLeft: `3px solid ${dr.color}`,
                background: "hsla(0, 0%, 100%, 0.02)"
              }}
            >
              {/* Color dot */}
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: dr.color,
                  flexShrink: 0,
                  boxShadow: `0 0 8px ${dr.color}`
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: "bold", fontSize: "11px", color: "#fff" }}>
                  #{idx + 1} — {getDisplayName(dr.modelId)}
                </div>
                <div style={{ opacity: 0.6, fontSize: "10px", marginTop: "2px" }}>
                  X:{dr.position.x.toFixed(0)} Y:{dr.position.y.toFixed(0)} Z:{dr.position.z.toFixed(0)}
                </div>
                {dr.result && (
                  <div style={{ fontSize: "10px", fontWeight: "bold", marginTop: "3px" }}>
                    <div style={{ color: dr.result.coverage_pct === null ? "var(--text-secondary)" : dr.result.coverage_pct > 50 ? "var(--success)" : "var(--warning)" }}>
                      ✓ Cobertura: {formatPercent(dr.result.coverage_pct)}
                    </div>
                    <div style={{ color: "var(--text-secondary)", marginTop: "2px" }}>
                      Completitud: {formatPercent(dr.result.completeness_pct)}
                    </div>
                  </div>
                )}
              </div>
              <button
                onClick={() => removeDeployedRadar(dr.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--danger)",
                  cursor: "pointer",
                  fontSize: "16px",
                  fontWeight: "bold",
                  lineHeight: 1,
                  padding: "0 4px",
                  outline: "none"
                }}
                title="Remove radar"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Run unified analysis or Loading state */}
      {multiLoading ? (
        <div className="radar-loading-indicator">
          <span className="flex-row" style={{ gap: "10px", alignItems: "center", justifyContent: "center" }}>
            <span className="spinner-neon" /> Procesando Red...
          </span>
        </div>
      ) : (
        <button
          className="btn-primary"
          onClick={() => terrainId && void runMultiAnalysis(terrainId)}
          disabled={deployedRadars.length === 0 || !terrainId}
          style={{
            background: deployedRadars.length === 0 || !terrainId
              ? "var(--disabled-bg)"
              : "linear-gradient(135deg, var(--accent-color), hsl(210, 100%, 65%))",
          }}
        >
          ▶ Run Network Analysis ({deployedRadars.length})
        </button>
      )}

      {/* Unified result summary */}
      {unifiedLos && (
        <div className="hud-card" style={{ borderLeft: "4px solid var(--success)", background: "hsla(125, 85%, 45%, 0.03)" }}>
          <div style={{ fontWeight: "bold", marginBottom: "6px", color: "var(--success)", fontSize: "11px", letterSpacing: "0.02em" }}>
            🛡️ UNIFIED RADAR COVERAGE
          </div>
          <div className="hud-metric-row">
            <span className="hud-metric-label">Cobertura Global</span>
            <span className="hud-metric-value highlight-green">{formatPercent(unifiedLos.coverage_pct)}</span>
          </div>
          <div className="hud-metric-row">
            <span className="hud-metric-label">Completitud Global</span>
            <span className="hud-metric-value">{formatPercent(unifiedLos.completeness_pct)}</span>
          </div>
          <div className="hud-metric-row">
            <span className="hud-metric-label">Área Visible</span>
            <span className="hud-metric-value">{Number.isFinite(unifiedLos.visible_area_m2) ? `${unifiedLos.visible_area_m2.toFixed(0)} m²` : "Sin datos"}</span>
          </div>
          <div className="hud-metric-row">
            <span className="hud-metric-label">Zonas de Sombra</span>
            <span className="hud-metric-value highlight-red">{unifiedLos.shadow_zones.length} celdas</span>
          </div>
        </div>
      )}
    </div>
  );
}
