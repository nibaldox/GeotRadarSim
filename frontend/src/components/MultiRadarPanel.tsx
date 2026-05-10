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
    <div className="glass-panel">
      <div
        className="flex-row"
        style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
      >
        <h3 style={{ margin: 0 }}>Radar Network</h3>
        {deployedRadars.length > 0 && (
          <button
            onClick={clearDeployedRadars}
            style={{
              background: "transparent",
              border: "none",
              color: "#ff5555",
              cursor: "pointer",
              fontSize: "10px",
              textTransform: "uppercase",
              fontWeight: "bold",
            }}
          >
            Clear All
          </button>
        )}
      </div>

      {/* Add current radar */}
      <button
        className="btn-primary"
        style={{ marginBottom: "10px" }}
        onClick={deployCurrentRadar}
        disabled={multiLoading}
      >
        + Add Current Radar to Network
      </button>

      {/* Deployed list */}
      {deployedRadars.length === 0 ? (
        <p className="text-sm" style={{ margin: "0 0 8px 0", opacity: 0.6 }}>
          Configure a radar, place it on terrain, then click Add.
        </p>
      ) : (
        <div className="flex-col" style={{ gap: "6px", marginBottom: "10px" }}>
          {deployedRadars.map((dr, idx) => (
            <div
              key={dr.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 8px",
                background: "rgba(255,255,255,0.05)",
                borderRadius: "4px",
                fontSize: "11px",
                borderLeft: `3px solid ${dr.color}`,
              }}
            >
              {/* Color dot */}
              <span
                style={{
                  display: "inline-block",
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  background: dr.color,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: "bold", fontSize: "10px" }}>
                  #{idx + 1} — {getDisplayName(dr.modelId)}
                </div>
                <div style={{ opacity: 0.6 }}>
                  X:{dr.position.x.toFixed(0)} Y:{dr.position.y.toFixed(0)} Z:{dr.position.z.toFixed(0)}
                </div>
                {dr.result && (
                  <div
                    style={{
                      color: dr.result.coverage_pct > 50 ? "#0adb21" : "#ffbb00",
                      fontSize: "10px",
                    }}
                  >
                    ✓ {dr.result.coverage_pct.toFixed(1)}%
                  </div>
                )}
              </div>
              <button
                onClick={() => removeDeployedRadar(dr.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#ff5555",
                  cursor: "pointer",
                  fontSize: "14px",
                  lineHeight: 1,
                  padding: "0 4px",
                }}
                title="Remove radar"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Run unified analysis */}
      <button
        className="btn-primary"
        onClick={() => terrainId && void runMultiAnalysis(terrainId)}
        disabled={multiLoading || deployedRadars.length === 0 || !terrainId}
        style={{
          background: multiLoading
            ? "rgba(100,100,100,0.3)"
            : "linear-gradient(135deg, #0f3460, #16213e)",
        }}
      >
        {multiLoading
          ? `⟳ Computing ${deployedRadars.length} radars...`
          : `▶ Run Network Analysis (${deployedRadars.length})`}
      </button>

      {/* Unified result summary */}
      {unifiedLos && (
        <div
          className="text-sm"
          style={{
            marginTop: "10px",
            padding: "8px",
            background: "rgba(10,219,33,0.08)",
            borderRadius: "4px",
            borderLeft: "3px solid #0adb21",
          }}
        >
          <div style={{ fontWeight: "bold", marginBottom: "4px", color: "#0adb21" }}>
            Unified Coverage
          </div>
          <div>
            <span className="text-value">Coverage:</span>{" "}
            {unifiedLos.coverage_pct.toFixed(1)}%
          </div>
          <div>
            <span className="text-value">Visible area:</span>{" "}
            {unifiedLos.visible_area_m2.toFixed(0)} m²
          </div>
          <div>
            <span className="text-value">Shadow zones:</span>{" "}
            {unifiedLos.shadow_zones.length}
          </div>
        </div>
      )}
    </div>
  );
}
