/**
 * App — main application layout.
 *
 * Left sidebar: terrain controls (synthetic + DXF upload), radar controls, export panel
 * Center: 3D terrain viewer
 * State managed via Zustand stores.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { TerrainViewer } from "./components/TerrainViewer";
import { RadarControls } from "./components/RadarControls";
import { MultiRadarPanel } from "./components/MultiRadarPanel";
import { AnalysisHistory } from "./components/AnalysisHistory";
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
  const preferredResolution = useTerrainStore((s) => s.preferredResolution);
  const setPreferredResolution = useTerrainStore((s) => s.setPreferredResolution);
  const setRadarPosition = useAnalysisStore((s) => s.setRadarPosition);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);
  const losResult = useAnalysisStore((s) => s.losResult);
  const analysisLoading = useAnalysisStore((s) => s.loading);

  // Auto-show the overlay as soon as any analysis result arrives
  useEffect(() => {
    if (losResult) setShowShadowOverlay(true);
  }, [losResult]);

  const handleGenerateTerrain = useCallback(async () => {
    await generateSynthetic({ size_x: 200, size_y: 200, depth: 30, resolution: 2.0 });
    const metadata = useTerrainStore.getState().metadata;
    if (metadata) {
      await loadGrid(metadata.terrain_id);
    }
  }, [generateSynthetic, loadGrid]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Clear input so same file can be selected again if needed
    e.target.value = '';
    
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'stl') {
      await uploadSTL(file);
    } else {
      await uploadDXF(file);
    }
    const metadata = useTerrainStore.getState().metadata;
    if (metadata) {
      await loadGrid(metadata.terrain_id);
    }
  }, [uploadDXF, uploadSTL, loadGrid]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleTerrainClick = useCallback(
    async (point: { x: number; y: number; z: number }) => {
      if (useAnalysisStore.getState().loading) return;
      if (!terrainMetadata) return;
      
      const bounds = terrainMetadata.bounds;
      
      // Mapeo: 
      // X = Easting (X local + min_x)
      // Y = Northing (min_y - Z local, porque Z avanza hacia negativo al ir al norte)
      // Z = Elevación (Y local + min_z)
      setRadarPosition({
        x: point.x + bounds.min_x,
        y: bounds.min_y - point.z,
        z: point.y + bounds.min_z + 2.0,
      });

      // Fire and forget — the useEffect above will show the overlay when done
      void runAnalysis(terrainMetadata.terrain_id);
    },
    [setRadarPosition, runAnalysis, terrainMetadata],
  );

  const handleToggleOverlay = useCallback(() => {
    setShowShadowOverlay((prev) => !prev);
  }, []);

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="glass-panel">
          <h2>Terrain</h2>
          <div className="flex-col">
            <button
              className="btn-primary"
              onClick={() => void handleGenerateTerrain()}
              disabled={terrainLoading}
            >
              {terrainLoading ? "Generating..." : "Generate Synthetic Terrain"}
            </button>

            {/* Resolution Selector */}
            <div className="flex-col mt-4 p-2" style={{ background: "rgba(255,255,255,0.05)", borderRadius: "4px" }}>
              <label className="text-xs" style={{ opacity: 0.7, marginBottom: "4px" }}>
                Grid Resolution: <span className="text-value">{preferredResolution}m</span>
              </label>
              <input 
                type="range" 
                min="0.5" 
                max="5.0" 
                step="0.5" 
                value={preferredResolution}
                onChange={(e) => setPreferredResolution(Number(e.target.value))}
                style={{ cursor: "pointer" }}
              />
              <div className="flex-row" style={{ justifyContent: "space-between", fontSize: "9px", opacity: 0.5 }}>
                <span>High Detail (0.5m)</span>
                <span>Performance (5m)</span>
              </div>
            </div>

            {/* Terrain Upload */}
            <div className="flex-col mt-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".dxf,.stl"
                style={{ display: "none" }}
                onChange={(e) => void handleFileChange(e)}
              />
              <button
                className="btn-primary"
                onClick={handleUploadClick}
                disabled={terrainLoading}
              >
                {terrainLoading ? "Uploading..." : "Upload DXF / STL"}
              </button>
            </div>
          </div>

          {terrainMetadata && (
            <div className="text-sm mt-4">
              <div><span className="text-value">ID:</span> {terrainMetadata.terrain_id}</div>
              <div><span className="text-value">Grid:</span> {terrainMetadata.grid_rows}×{terrainMetadata.grid_cols}</div>
              <div><span className="text-value">Resolution:</span> {terrainMetadata.resolution}m</div>
            </div>
          )}

          {terrainError && (
            <div className="error-text">
              Error: {terrainError}
            </div>
          )}
        </div>

        <RadarControls />
        <MultiRadarPanel />
        <AnalysisHistory />

        <div className="glass-panel">
          <label className="checkbox-label">
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
          <div className="loading-banner">
            Running analysis...
          </div>
        )}
      </aside>

      {/* Main viewer */}
      <main className="main-content">
        <TerrainViewer
          showShadowOverlay={showShadowOverlay}
          onTerrainClick={handleTerrainClick}
        />
      </main>
    </div>
  );
}

export default App;
