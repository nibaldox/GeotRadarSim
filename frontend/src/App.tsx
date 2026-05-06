/**
 * App — main application layout.
 *
 * Left sidebar: terrain controls (synthetic + DXF upload), radar controls, export panel
 * Center: 3D terrain viewer
 * State managed via Zustand stores.
 */

import { useState, useCallback, useRef } from "react";
import { TerrainViewer } from "./components/TerrainViewer";
import { RadarControls } from "./components/RadarControls";
import { ExportPanel } from "./components/ExportPanel";
import { useTerrainStore } from "./store/terrainStore";
import { useAnalysisStore } from "./store/analysisStore";

function App() {
  const [showShadowOverlay, setShowShadowOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generateSynthetic = useTerrainStore((s) => s.generateSynthetic);
  const loadGrid = useTerrainStore((s) => s.loadGrid);
  const uploadDXF = useTerrainStore((s) => s.uploadDXF);
  const uploadSTL = useTerrainStore((s) => s.uploadSTL);
  const terrainLoading = useTerrainStore((s) => s.loading);
  const terrainMetadata = useTerrainStore((s) => s.metadata);
  const terrainError = useTerrainStore((s) => s.error);
  const setRadarPosition = useAnalysisStore((s) => s.setRadarPosition);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);
  const analysisLoading = useAnalysisStore((s) => s.loading);

  const handleGenerateTerrain = useCallback(async () => {
    await generateSynthetic({ size_x: 200, size_y: 200, depth: 30, resolution: 2.0 });
    // After terrain generation, fetch grid data for 3D visualization
    const metadata = useTerrainStore.getState().metadata;
    if (metadata) {
      await loadGrid(metadata.terrain_id);
    }
  }, [generateSynthetic, loadGrid]);

  const handleFileUpload = useCallback(async () => {
    const fileInput = fileInputRef.current;
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) return;
    const file = fileInput.files[0];
    const ext = file.name.split('.').pop()?.toLowerCase();

    // Auto-detect format and call appropriate endpoint
    if (ext === 'stl') {
      await uploadSTL(file);
    } else {
      await uploadDXF(file);
    }
    // After upload, fetch grid data for 3D visualization
    const metadata = useTerrainStore.getState().metadata;
    if (metadata) {
      await loadGrid(metadata.terrain_id);
    }
  }, [uploadDXF, uploadSTL, loadGrid]);

  const handleTerrainClick = useCallback(
    (point: { x: number; y: number; z: number }) => {
      setRadarPosition(point);
      if (terrainMetadata) {
        void runAnalysis(terrainMetadata.terrain_id);
      }
    },
    [setRadarPosition, runAnalysis, terrainMetadata],
  );

  const handleToggleOverlay = useCallback(() => {
    setShowShadowOverlay((prev) => !prev);
  }, []);

  return (
    <div style={{
      display: "flex",
      width: "100vw",
      height: "100vh",
      backgroundColor: "#0f0f1a",
      color: "#e0e0e0",
    }}>
      {/* Sidebar */}
      <aside style={{
        width: "280px",
        padding: "12px",
        overflowY: "auto",
        borderRight: "1px solid #333",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}>
        <div style={{
          padding: "12px",
          backgroundColor: "#1e1e2e",
          borderRadius: "8px",
        }}>
          <h2 style={{ margin: "0 0 8px 0", color: "#fff", fontSize: "16px" }}>
            Terrain
          </h2>
          <button
            onClick={() => void handleGenerateTerrain()}
            disabled={terrainLoading}
            style={{
              width: "100%",
              padding: "8px",
              borderRadius: "4px",
              border: "none",
              cursor: terrainLoading ? "not-allowed" : "pointer",
              backgroundColor: terrainLoading ? "#333" : "#4a9eff",
              color: terrainLoading ? "#666" : "#fff",
              fontWeight: "bold",
              marginBottom: "8px",
            }}
          >
            {terrainLoading ? "Generating..." : "Generate Synthetic Terrain"}
          </button>

          {/* Terrain Upload */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".dxf,.stl"
              aria-label="Upload terrain file (DXF or STL)"
              style={{
                fontSize: "12px",
                color: "#aaa",
              }}
            />
            <button
              onClick={() => void handleFileUpload()}
              disabled={terrainLoading}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "4px",
                border: "none",
                cursor: terrainLoading ? "not-allowed" : "pointer",
                backgroundColor: terrainLoading ? "#333" : "#6c5ce7",
                color: terrainLoading ? "#666" : "#fff",
                fontWeight: "bold",
              }}
            >
              {terrainLoading ? "Uploading..." : "Upload Terrain (DXF/STL)"}
            </button>
          </div>

          {terrainMetadata && (
            <div style={{ marginTop: "8px", fontSize: "12px", color: "#aaa" }}>
              <div>ID: {terrainMetadata.terrain_id}</div>
              <div>Grid: {terrainMetadata.grid_rows}×{terrainMetadata.grid_cols}</div>
              <div>Resolution: {terrainMetadata.resolution}m</div>
            </div>
          )}

          {terrainError && (
            <div style={{ marginTop: "8px", fontSize: "12px", color: "#ff6b6b" }}>
              Error: {terrainError}
            </div>
          )}
        </div>

        <RadarControls />

        <div style={{
          padding: "12px",
          backgroundColor: "#1e1e2e",
          borderRadius: "8px",
        }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
            <input
              type="checkbox"
              checked={showShadowOverlay}
              onChange={handleToggleOverlay}
            />
            Show Shadow Overlay
          </label>
        </div>

        <ExportPanel />

        {analysisLoading && (
          <div style={{
            padding: "8px",
            textAlign: "center",
            color: "#4a9eff",
            fontSize: "13px",
          }}>
            Running analysis...
          </div>
        )}
      </aside>

      {/* Main viewer */}
      <main style={{ flex: 1 }}>
        <TerrainViewer
          showShadowOverlay={showShadowOverlay}
          onTerrainClick={handleTerrainClick}
        />
      </main>
    </div>
  );
}

export default App;
