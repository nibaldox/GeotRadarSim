/**
 * App — main application layout (compact console).
 *
 * Left sidebar, top to bottom: header, Terreno, Radar, Sensibilidad 3D,
 * Historial, Resultados, Sugerir ubicación, Ajustes, and a sticky export foot.
 * Center: 3D terrain viewer with the KPI bar on top.
 * State managed via Zustand stores.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { TerrainViewer } from "./components/TerrainViewer";
import { RadarControls } from "./components/RadarControls";
import { VectorSynthesisPanel } from "./components/VectorSynthesisPanel";
import { AnalysisHistory } from "./components/AnalysisHistory";
import { QualityDashboard } from "./components/QualityDashboard";
import { QualityPolicyControl } from "./components/QualityPolicyControl";
import { ExportPanel } from "./components/ExportPanel";
import { UploadTerrainDialog } from "./components/UploadTerrainDialog";
import { SuggestPositionsPanel } from "./components/SuggestPositionsPanel";
import { KpiBar, formatKpiPercent } from "./components/KpiBar";
import { Section } from "./components/ui/Section";
import { useGlobalSummary } from "./hooks/useGlobalQuality";
import { useTerrainStore } from "./store/terrainStore";
import { useAnalysisStore } from "./store/analysisStore";
import { useQualityPolicyStore } from "./store/qualityPolicyStore";
import { formatQualityThreshold } from "./utils/qualityMetrics";

/** Default sidebar width of the compact console (drag range stays 260–500 px). */
const DEFAULT_SIDEBAR_WIDTH = 300;

function App() {
  const [showShadowOverlay, setShowShadowOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        return Number(localStorage.getItem("geotradar-sidebar-width")) || DEFAULT_SIDEBAR_WIDTH;
      }
      return DEFAULT_SIDEBAR_WIDTH;
    }
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [isResizing, setIsResizing] = useState(false);

  // Sync theme with Document Body
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light");
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

  const loadSamplePit = useTerrainStore((s) => s.loadSamplePit);
  const startUploadPreview = useTerrainStore((s) => s.startUploadPreview);
  const terrainLoading = useTerrainStore((s) => s.loading);
  const terrainMetadata = useTerrainStore((s) => s.metadata);
  const terrainError = useTerrainStore((s) => s.error);
  const preferredResolution = useTerrainStore((s) => s.preferredResolution);
  const setPreferredResolution = useTerrainStore((s) => s.setPreferredResolution);
  const setRadarPosition = useAnalysisStore((s) => s.setRadarPosition);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);
  const losResult = useAnalysisStore((s) => s.losResult);
  const analysisLoading = useAnalysisStore((s) => s.loading);
  const multiLoading = useAnalysisStore((s) => s.multiLoading);
  const radarCatalogReady = useAnalysisStore((s) => s.radars.length > 0);
  const cancelAnalysis = useAnalysisStore((s) => s.cancelAnalysis);
  const analysisError = useAnalysisStore((s) => s.error);
  const policy = useQualityPolicyStore((s) => s.policy);
  const { summary: globalSummary, guarded: globalGuarded } = useGlobalSummary();

  const terrainSummary = terrainMetadata
    ? `${terrainMetadata.grid_cols} × ${terrainMetadata.grid_rows} · ${terrainMetadata.resolution} m`
    : "Sin terreno";
  const resultsSummary = globalSummary && !globalGuarded
    ? `útil ${formatKpiPercent(globalSummary.usefulCoveragePct)}`
    : "Sin análisis";
  const settingsSummary = `bandas ${formatQualityThreshold(policy.mediumMin)} / ${formatQualityThreshold(policy.highMin)}`;

  // Auto-show the overlay as soon as any analysis result arrives
  useEffect(() => {
    if (losResult) setShowShadowOverlay(true);
  }, [losResult]);

  const handleGenerateTerrain = useCallback(async () => {
    await loadSamplePit();
  }, [loadSamplePit]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Clear input so same file can be selected again if needed
    e.target.value = '';

    // Hand off to the upload preview flow — the actual uploadDXF/uploadSTL
    // happens after the user confirms a resolution in UploadTerrainDialog.
    await startUploadPreview(file);
  }, [startUploadPreview]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleTerrainClick = useCallback(
    async (point: { x: number; y: number; z: number }) => {
      const analysisState = useAnalysisStore.getState();
      if (analysisState.loading || analysisState.terrainTransitioning || useTerrainStore.getState().loading) return;
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
        {/* Cabecera de la consola: nombre, tema y ocultar */}
        <div className="sidebar-header">
          <span className="sidebar-brand">GeotRadarSim</span>
          <div className="sidebar-header-actions">
            <button
              type="button"
              className="theme-toggle-btn"
              data-theme={theme}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
              aria-label={theme === 'dark' ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
            >
              {/* Los dos íconos quedan montados y superpuestos; compact.css anima cuál se ve según data-theme. */}
              <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="var(--accent-color)" />
              </svg>
              <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" fill="var(--accent-color)" />
                <path className="theme-sun-rays" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            </button>

            <button
              type="button"
              className="close-sidebar-btn"
              style={{ display: "flex" }}
              onClick={() => setIsSidebarOpen(false)}
              title="Ocultar panel"
              aria-label="Ocultar panel"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </div>
        </div>

        <Section
          id="terrain"
          title="Terreno"
          summary={terrainSummary}
          defaultOpen
          storageKey="geotradar-collapse-terrain"
        >
          <div className="terrain-actions field-row">
          <button
            type="button"
            className="btn-compact primary"
            onClick={() => void handleGenerateTerrain()}
            disabled={terrainLoading}
            title="Carga un rajo sintético de ejemplo (≈1,4 × 1,1 km) para probar la app"
          >
            {terrainLoading ? "Generando…" : "Terreno sintético"}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".dxf,.stl"
            style={{ display: "none" }}
            onChange={(e) => void handleFileChange(e)}
            aria-label="Cargar terreno"
          />
          <button
            type="button"
            className="btn-compact"
            onClick={handleUploadClick}
            disabled={terrainLoading}
          >
            {terrainLoading ? "Cargando…" : "Cargar STL / DXF"}
          </button>
          </div>

          {/* Resolución de la próxima importación */}
          <div className="terrain-resolution">
            <label className="cs-label" htmlFor="terrain-resolution">
              Resolución de importación: <span className="cs-value">{preferredResolution} m</span>
            </label>
            <input
              id="terrain-resolution"
              type="range"
              min="0.5"
              max="5.0"
              step="0.5"
              value={preferredResolution}
              onChange={(e) => setPreferredResolution(Number(e.target.value))}
              className="cs-range"
              title="Más detalle (0,5 m) · Más rápido (5 m)"
            />
          </div>

          {terrainError && (
            <div className="error-text" role="alert">
              Error: {terrainError}
            </div>
          )}
        </Section>

        <RadarControls />
        <VectorSynthesisPanel />
        <AnalysisHistory />

        <Section
          id="results"
          title="Resultados"
          summary={resultsSummary}
          defaultOpen
          storageKey="geotradar-collapse-results"
        >
          <QualityDashboard />
        </Section>

        <SuggestPositionsPanel />

        <Section
          id="settings"
          title="Ajustes"
          summary={settingsSummary}
          defaultOpen={false}
          storageKey="geotradar-collapse-settings"
        >
          <QualityPolicyControl />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showShadowOverlay}
              onChange={handleToggleOverlay}
            />
            Mostrar capa de cobertura
          </label>
        </Section>

        {(analysisLoading || multiLoading) && (
          <div className="loading-banner">
            Calculando cobertura…
            {radarCatalogReady && (
              <button
                type="button"
                className="btn-compact loading-cancel"
                onClick={cancelAnalysis}
              >
                Cancelar análisis
              </button>
            )}
          </div>
        )}

        {analysisError && (
          <div className="error-text analysis-error" role="alert">
            Error en el análisis: {analysisError}
          </div>
        )}

        {/* Pie fijo: exportación */}
        <div className="sidebar-footer">
          <ExportPanel />
        </div>

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
            aria-label="Mostrar panel"
            title="Mostrar panel"
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
        <KpiBar />
      </main>

      <UploadTerrainDialog />
    </div>
  );
}

export default App;
