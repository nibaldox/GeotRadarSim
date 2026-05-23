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
import { VectorSynthesisPanel } from "./components/VectorSynthesisPanel";
import { AnalysisHistory } from "./components/AnalysisHistory";
import { ExportPanel } from "./components/ExportPanel";
import { useTerrainStore } from "./store/terrainStore";
import { useAnalysisStore } from "./store/analysisStore";

function App() {
  const [showShadowOverlay, setShowShadowOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Collapsible Terrain Panel State
  const [isTerrainCollapsed, setIsTerrainCollapsed] = useState<boolean>(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      return localStorage.getItem("geotradar-collapse-terrain") === "true";
    }
    return false;
  });

  const toggleTerrainCollapse = useCallback(() => {
    setIsTerrainCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== "undefined" && localStorage.setItem) {
        localStorage.setItem("geotradar-collapse-terrain", String(next));
      }
      return next;
    });
  }, []);
  
  // Minimalist Theme, Sidebar Resize & Collapse States
  const [theme, setTheme] = useState<"dark" | "light">(
    () => {
      if (typeof localStorage !== "undefined" && localStorage.getItem) {
        return (localStorage.getItem("geotradar-theme") as "dark" | "light") || "dark";
      }
      return "dark";
    }
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    () => {
      if (typeof localStorage !== "undefined" && localStorage.getItem) {
        return Number(localStorage.getItem("geotradar-sidebar-width")) || 320;
      }
      return 320;
    }
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [isResizing, setIsResizing] = useState(false);

  // Sync theme with Document Body
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light", "theme-slate", "theme-charcoal", "theme-amber");
    root.classList.add(`theme-${theme}`);
    if (typeof localStorage !== "undefined" && localStorage.setItem) {
      localStorage.setItem("geotradar-theme", theme);
    }
  }, [theme]);

  // Drag resizer interaction handler
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Limit sidebar width between 260px and 500px to ensure visual integrity
      const newWidth = Math.max(260, Math.min(500, e.clientX));
      setSidebarWidth(newWidth);
      if (typeof localStorage !== "undefined" && localStorage.setItem) {
        localStorage.setItem("geotradar-sidebar-width", String(newWidth));
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

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
      <aside 
        className={`sidebar ${!isSidebarOpen ? 'collapsed' : ''}`}
        style={{
          width: isSidebarOpen ? `${sidebarWidth}px` : '0px',
          minWidth: isSidebarOpen ? `${sidebarWidth}px` : '0px'
        }}
      >
        {/* Console Header: Selector de temas y cierres */}
        <div className="sidebar-header">
          <button 
            className="theme-toggle-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? "Cambiar a Tema Claro" : "Cambiar a Tema Oscuro"}
          >
            {theme === 'dark' ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="var(--accent-color)" />
                </svg>
                <span className="theme-toggle-text" style={{ color: "var(--text-primary)" }}>Oscuro</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" fill="var(--accent-color)" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </svg>
                <span className="theme-toggle-text" style={{ color: "var(--text-primary)" }}>Claro</span>
              </>
            )}
          </button>
          
          <button 
            className="close-sidebar-btn" 
            style={{ display: "flex" }} 
            onClick={() => setIsSidebarOpen(false)}
            title="Collapse Sidebar"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>

        <div className="glass-panel" style={{ display: "flex", flexDirection: "column" }}>
          <div 
            onClick={toggleTerrainCollapse}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
          >
            <h2 style={{ margin: 0 }}>Terrain</h2>
            <svg 
              viewBox="0 0 24 24" 
              width="18" 
              height="18" 
              fill="none" 
              stroke="var(--text-secondary)" 
              strokeWidth="2.5" 
              strokeLinecap="round" 
              strokeLinejoin="round"
              style={{ 
                transform: isTerrainCollapsed ? "rotate(-90deg)" : "rotate(0deg)", 
                transition: "transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)" 
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>

          {!isTerrainCollapsed && (
            <div className="flex-col" style={{ marginTop: "12px" }}>
              <button
                className="btn-primary"
                onClick={() => void handleGenerateTerrain()}
                disabled={terrainLoading}
              >
                {terrainLoading ? "Generating..." : "Generate Synthetic Terrain"}
              </button>

              {/* Resolution Selector */}
              <div className="hud-card flex-col" style={{ gap: "6px" }}>
                <label className="text-sm" style={{ fontWeight: 500, fontSize: "11px", opacity: 0.8 }}>
                  Grid Resolution: <span className="text-value" style={{ color: "var(--accent-hover)" }}>{preferredResolution}m</span>
                </label>
                <input 
                  type="range" 
                  min="0.5" 
                  max="5.0" 
                  step="0.5" 
                  value={preferredResolution}
                  onChange={(e) => setPreferredResolution(Number(e.target.value))}
                  style={{ cursor: "pointer", accentColor: "var(--accent-color)" }}
                />
                <div className="flex-row" style={{ justifyContent: "space-between", fontSize: "9px", opacity: 0.5, fontFamily: "var(--font-mono)" }}>
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
                  aria-label="Upload Terrain"
                />
                <button
                  className="btn-primary"
                  onClick={handleUploadClick}
                  disabled={terrainLoading}
                >
                  {terrainLoading ? "Uploading..." : "Upload DXF / STL"}
                </button>
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
          )}
        </div>

        <RadarControls />
        <VectorSynthesisPanel />
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

        {/* Tirador táctil para redimensionamiento (Resizer Splitter) */}
        <div 
          className={`sidebar-resizer ${isResizing ? 'active' : ''}`} 
          onMouseDown={handleMouseDown} 
        />
      </aside>

      {/* Main viewer */}
      <main className="main-content">
        {/* Botón flotante técnico para reabrir la consola cuando está colapsada */}
        {!isSidebarOpen && (
          <button 
            className="sidebar-toggle" 
            onClick={() => setIsSidebarOpen(true)}
            aria-label="Open Console"
            title="Open Console"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        <TerrainViewer
          showShadowOverlay={showShadowOverlay}
          onTerrainClick={handleTerrainClick}
        />
      </main>
    </div>
  );
}

export default App;
