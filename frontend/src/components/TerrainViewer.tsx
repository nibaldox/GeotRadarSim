/**
 * TerrainViewer — R3F component for rendering terrain mesh.
 *
 * Renders the DTM grid as a colored mesh with elevation gradient.
 * Supports click-to-place radar via raycasting.
 * Uses OrbitControls for camera manipulation.
 */

import { useRef, useMemo, useEffect, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import * as THREE from "three";
import { getTerrainExtent, getMinElevation } from "../utils/terrain";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore, RADAR_COLORS } from "../store/analysisStore";
import { useVectorStore } from "../store/vectorStore";
import { ShadowOverlay } from "./ShadowOverlay";

interface TerrainMeshProps {
  grid: number[][];
  resolution: number;
  showShadowOverlay: boolean;
  onTerrainClick?: (point: { x: number; y: number; z: number }) => void;
  activeTool: "PAN" | "ADD_RADAR";
}

function TerrainMesh({
  grid,
  resolution,
  showShadowOverlay,
  onTerrainClick,
  activeTool,
}: TerrainMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const minElev = useMemo(() => getMinElevation(grid), [grid]);
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);

  const geometry = useMemo(() => {
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    const vertexCount = rows * cols;

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    
    let posIdx = 0;
    let uvIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const val = grid[r]![c]!;
        positions[posIdx++] = c * resolution;
        positions[posIdx++] = (isNaN(val) ? 0 : val) - minElev;
        positions[posIdx++] = -(r * resolution);
        
        uvs[uvIdx++] = c / (cols - 1);
        uvs[uvIdx++] = r / (rows - 1);
      }
    }

    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const valTL = grid[r]![c]!;
        const valTR = grid[r]![c + 1]!;
        const valBL = grid[r + 1]![c]!;
        const valBR = grid[r + 1]![c + 1]!;

        // Skip triangles if any vertex is NaN (empty data)
        if (isNaN(valTL) || isNaN(valTR) || isNaN(valBL) || isNaN(valBR)) {
          continue;
        }

        const tl = r * cols + c;
        const tr = tl + 1;
        const bl = tl + cols;
        const br = bl + 1;
        indices.push(tl, tr, bl, tr, br, bl);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geo.computeVertexNormals();
    return geo;
  }, [grid, resolution, minElev]);

  return (
    <group>
      <mesh
        ref={meshRef}
        geometry={geometry}
        castShadow
        receiveShadow
        onPointerDown={(e) => {
          e.stopPropagation();
          pointerDownPos.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (!pointerDownPos.current) return;
          const dx = e.nativeEvent.clientX - pointerDownPos.current.x;
          const dy = e.nativeEvent.clientY - pointerDownPos.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Drag protection: if user moved mouse more than 5px during down->up, consider it camera orbit/drag
          if (dist > 5) return;

          if (activeTool === "ADD_RADAR") {
            if (onTerrainClick) onTerrainClick(e.point);
          }
        }}
      >
        <meshStandardMaterial color="#cccccc" side={THREE.DoubleSide} />
      </mesh>
      {showShadowOverlay && <ShadowOverlay grid={grid} resolution={resolution} />}
    </group>
  );
}

/** All radar markers: current single + all deployed radars */
function RadarMarkers() {
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const history = useAnalysisStore((s) => s.history);
  const metadata = useTerrainStore((s) => s.metadata);

  const deployedRadars = useMemo(() => {
    const selected = history.filter(h => h.selected);
    return selected.map((h, idx) => ({
      id: h.timestamp + '-' + idx,
      position: h.position,
      color: RADAR_COLORS[idx % RADAR_COLORS.length] || "#ff4444"
    }));
  }, [history]);

  if (!metadata) return null;
  const bounds = metadata.bounds;

  const toLocal = (pos: { x: number; y: number; z: number }) => ({
    lx: pos.x - bounds.min_x,
    ly: pos.z - bounds.min_z,
    lz: bounds.min_y - pos.y,
  });

  return (
    <>
      {/* Current placement marker (white) */}
      {radarPosition && (() => {
        const { lx, ly, lz } = toLocal(radarPosition);
        return (
          <mesh position={[lx, ly, lz]}>
            <sphereGeometry args={[3, 16, 16]} />
            <meshStandardMaterial color="white" emissive="white" emissiveIntensity={0.5} />
          </mesh>
        );
      })()}

      {/* Deployed radar markers (colored) */}
      {deployedRadars.map((dr) => {
        const { lx, ly, lz } = toLocal(dr.position);
        return (
          <group key={dr.id} position={[lx, ly, lz]}>
            {/* Body sphere */}
            <mesh>
              <sphereGeometry args={[4, 16, 16]} />
              <meshStandardMaterial color={dr.color} emissive={dr.color} emissiveIntensity={0.4} />
            </mesh>
            {/* Vertical antenna pole */}
            <mesh position={[0, 6, 0]}>
              <cylinderGeometry args={[0.5, 0.5, 12, 8]} />
              <meshStandardMaterial color={dr.color} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

interface SceneProps extends TerrainMeshProps {
  cameraView: "HOME" | "TOP" | "FRONT" | "SIDE" | null;
  onCameraViewApplied: () => void;
}

/** Scene setup: lighting, camera auto-fit, controls */
function Scene({
  grid,
  resolution,
  showShadowOverlay,
  onTerrainClick,
  activeTool,
  cameraView,
  onCameraViewApplied,
}: SceneProps) {
  const { camera } = useThree();
  const controlsRef = useRef<any>(null);
 
  // Auto-fit camera to terrain extent on first load
  useEffect(() => {
    if (!grid || grid.length === 0 || !grid[0]) return;
    
    const extent = getTerrainExtent(grid, resolution);
    const maxDim = Math.max(extent.width, extent.depth);
    
    // Si los datos son inválidos, no movemos la cámara
    if (isNaN(maxDim) || maxDim <= 0) return;

    const targetX = extent.centerX;
    const targetY = extent.height / 2;
    const targetZ = extent.centerZ;

    // Posición de la cámara: 
    // Elevada y a una distancia proporcional al tamaño del terreno
    camera.position.set(
      targetX + maxDim * 1.2,
      maxDim * 1.0,
      targetZ + maxDim * 1.2
    );
    
    if (controlsRef.current) {
      controlsRef.current.target.set(targetX, targetY, targetZ);
      controlsRef.current.update();
    }
    
    camera.lookAt(targetX, targetY, targetZ);
    camera.far = Math.max(10000, maxDim * 10);
    camera.updateProjectionMatrix();
  }, [grid, resolution]);

  // Listen to cameraView changes from AutoCAD toolbar
  useEffect(() => {
    if (!cameraView || !grid || grid.length === 0 || !grid[0]) return;

    const extent = getTerrainExtent(grid, resolution);
    const maxDim = Math.max(extent.width, extent.depth);
    if (isNaN(maxDim) || maxDim <= 0) return;

    const targetX = extent.centerX;
    const targetY = extent.height / 2;
    const targetZ = extent.centerZ;

    let posX = targetX;
    let posY = targetY;
    let posZ = targetZ;

    switch (cameraView) {
      case "HOME":
        // Isometric angle view
        posX = targetX + maxDim * 1.2;
        posY = targetY + maxDim * 1.0;
        posZ = targetZ + maxDim * 1.2;
        break;
      case "TOP":
        // Orthogonal 2D plan view from top (slight Z offset to prevent OrbitControls gimbal lock)
        posX = targetX;
        posY = targetY + maxDim * 1.8;
        posZ = targetZ - 0.01;
        break;
      case "FRONT":
        // Front elevation view
        posX = targetX;
        posY = targetY;
        posZ = targetZ + maxDim * 1.8;
        break;
      case "SIDE":
        // Side profile view
        posX = targetX + maxDim * 1.8;
        posY = targetY;
        posZ = targetZ;
        break;
    }

    camera.position.set(posX, posY, posZ);
    
    if (controlsRef.current) {
      controlsRef.current.target.set(targetX, targetY, targetZ);
      controlsRef.current.update();
    }
    
    camera.lookAt(targetX, targetY, targetZ);
    camera.updateProjectionMatrix();

    // Reset parent cameraView selection once applied
    onCameraViewApplied();
  }, [cameraView, grid, resolution, camera, onCameraViewApplied]);

  return (
    <>
      <color attach="background" args={["#111111"]} />
      {/* Luz ambiental baja para que las sombras sean visibles */}
      <ambientLight intensity={0.25} />
      {/* Luz principal en ángulo rasante: revela el relieve */}
      <directionalLight position={[1, 0.6, 0.5]} intensity={1.2} />
      {/* Luz de relleno desde el lado opuesto para evitar sombras totalmente negras */}
      <directionalLight position={[-1, 0.4, -0.5]} intensity={0.4} />
      <gridHelper args={[10000, 100, "#333", "#222"]} position={[0, -1, 0]} />
      
      <TerrainMesh
        grid={grid}
        resolution={resolution}
        showShadowOverlay={showShadowOverlay}
        onTerrainClick={onTerrainClick}
        activeTool={activeTool}
      />
      <RadarMarkers />
      <OrbitControls ref={controlsRef} makeDefault />
      
      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport
          axisColors={['#ff3653', '#0adb21', '#2c8fdf']}
          labelColor="white"
          labels={['E', 'Y', 'N']}
        />
      </GizmoHelper>
    </>
  );
}

/** Main exported component */
interface TerrainViewerProps {
  showShadowOverlay?: boolean;
  onTerrainClick?: (point: { x: number; y: number; z: number }) => void;
}

export function TerrainViewer({
  showShadowOverlay = false,
  onTerrainClick,
}: TerrainViewerProps) {
  const grid = useTerrainStore((s) => s.grid);
  const resolution = useTerrainStore((s) => s.metadata?.resolution ?? 2.0);

  // Tools state (PAN is safe, ADD_RADAR places radars, SELECT_CELL simulates vector landslides)
  const [activeTool, setActiveTool] = useState<"PAN" | "ADD_RADAR">("PAN");
  const [cameraView, setCameraView] = useState<"HOME" | "TOP" | "FRONT" | "SIDE" | null>(null);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);

  // Tool explanations mapping
  const toolExplanations = {
    PAN: {
      title: "Safe Navigation Mode",
      desc: "Rotación libre y encuadre seguro de cámara. Clic izquierdo para orbitar, Clic derecho para encuadre (Pan), Scroll para Zoom."
    },
    ADD_RADAR: {
      title: "Radar Placement Mode",
      desc: "Haz clic izquierdo sobre cualquier celda del terreno 3D para desplegar un radar y proyectar su raycasting inmediatamente."
    }
  };

  if (!grid || grid.length === 0) {
    return (
      <div style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#1a1a2e",
        color: "#aaa",
      }}>
        <p>No terrain loaded. Generate synthetic terrain or upload a DXF file.</p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <Canvas
        camera={{ fov: 50, near: 0.1, far: 500000 }}
        gl={{ preserveDrawingBuffer: true }}
      >
        <Scene
          grid={grid}
          resolution={resolution}
          showShadowOverlay={showShadowOverlay}
          onTerrainClick={onTerrainClick}
          activeTool={activeTool}
          cameraView={cameraView}
          onCameraViewApplied={() => setCameraView(null)}
        />
      </Canvas>

      {/* AutoCAD-Style Floating Toolbar */}
      <div className="autocad-toolbar" aria-label="AutoCAD Navigation Controls">
        {/* Interaction Tools Section */}
        <div className="toolbar-section">
          <div className="toolbar-section-title">Tools</div>
          <button
            className={`toolbar-btn ${activeTool === "PAN" ? "active" : ""}`}
            onClick={() => setActiveTool("PAN")}
            aria-label="Safe Navigation Mode"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5 9 2 12 5 15" />
              <polyline points="9 5 12 2 15 5" />
              <polyline points="15 19 12 22 9 19" />
              <polyline points="19 9 22 12 19 15" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <line x1="12" y1="2" x2="12" y2="22" />
            </svg>
            <span className="tooltip">Navigate (Safe Pan/Orbit)</span>
          </button>
          <button
            className={`toolbar-btn ${activeTool === "ADD_RADAR" ? "active" : ""}`}
            onClick={() => setActiveTool("ADD_RADAR")}
            aria-label="Radar Placement Mode"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 13v7" />
              <path d="M8 20h8" />
              <path d="M5 12a7 7 0 0 1 14 0" />
              <polyline points="12 12 12 7" />
              <path d="M8 6a5 5 0 0 1 8 0" strokeDasharray="2,2" />
              <path d="M6 3a9 9 0 0 1 12 0" />
            </svg>
            <span className="tooltip">Place Radar (Click terrain)</span>
          </button>
        </div>

        <div className="toolbar-divider" />

        {/* Camera Preset Angles Section */}
        <div className="toolbar-section">
          <div className="toolbar-section-title">Views</div>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("HOME")}
            aria-label="Isometric Home View"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 7v10l10 5V12L2 7z" />
              <path d="M22 7v10l-10 5V12l10-5z" />
            </svg>
            <span className="tooltip">Home View (Isometric)</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("TOP")}
            aria-label="Top Plan View"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" strokeOpacity="0.3" />
              <line x1="15" y1="3" x2="15" y2="21" strokeOpacity="0.3" />
              <line x1="3" y1="9" x2="21" y2="9" strokeOpacity="0.3" />
              <line x1="3" y1="15" x2="21" y2="15" strokeOpacity="0.3" />
              <line x1="12" y1="17" x2="12" y2="7" stroke="var(--accent-color)" strokeWidth="2.5" />
              <polyline points="9 10 12 7 15 10" stroke="var(--accent-color)" strokeWidth="2.5" />
            </svg>
            <span className="tooltip">Top View (Plan/North)</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("FRONT")}
            aria-label="Front Elevation View"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="2" y1="20" x2="22" y2="20" />
              <path d="M4 20l5-9 4 4 5-8 4 13" />
              <line x1="12" y1="2" x2="12" y2="6" strokeWidth="2" />
              <polyline points="9 4 12 6 15 4" strokeWidth="2" />
            </svg>
            <span className="tooltip">Front View (Elevation)</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("SIDE")}
            aria-label="Side Profile View"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16V6L4 20z" fill="rgba(255,255,255,0.05)" />
              <path d="M4 20h16M20 20V6M4 20L20 6" />
              <path d="M8 20a4 4 0 0 0 4-4" stroke="var(--accent-color)" />
            </svg>
            <span className="tooltip">Side View (Profile)</span>
          </button>
        </div>
      </div>

      {/* Geotechnical Tactical HUD Legend Panel */}
      {showShadowOverlay && (
        <div className="geotechnical-hud-legend">
          <div className="hud-legend-title">
            {visualizationMode === "SENSITIVITY"
              ? "Geometric Sensitivity Legend"
              : "LOS Quality Legend"}
          </div>

          {visualizationMode === "SENSITIVITY" ? (
            <>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(0, 0%, 50%)" }} />
                <div>
                  <span className="hud-legend-label">Obstructed Zone (Shadow)</span>
                  <div className="hud-legend-desc">Obstructed by topography or out of range. Rendered transparent.</div>
                </div>
              </div>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(300, 100%, 25%)" }} />
                <div>
                  <span className="hud-legend-label">Critical Blind Zone (0.0 - 0.2)</span>
                  <div className="hud-legend-desc">Displacement is perpendicular to radar LOS. Complete detection failure.</div>
                </div>
              </div>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(220, 80%, 45%)" }} />
                <div>
                  <span className="hud-legend-label">Low/Medium Sensitivity (0.2 - 0.6)</span>
                  <div className="hud-legend-desc">Oblique angle. Signal detects partial motion vector components.</div>
                </div>
              </div>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(140, 90%, 45%)" }} />
                <div>
                  <span className="hud-legend-label">Optimal Sensitivity (0.6 - 1.0)</span>
                  <div className="hud-legend-desc">Aligned direction. Radar visual is parallel to slope movement direction.</div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(0, 0%, 50%)" }} />
                <div>
                  <span className="hud-legend-label">Shadowed Zone (Obstructed)</span>
                  <div className="hud-legend-desc">No line of sight (LOS) to any active radar. Obstructed or out of range.</div>
                </div>
              </div>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(351, 80%, 50%)" }} />
                <div>
                  <span className="hud-legend-label">Poor Quality (0.0 - 0.3)</span>
                  <div className="hud-legend-desc">Suboptimal signal angle or long distance. Hard to monitor.</div>
                </div>
              </div>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(38, 90%, 45%)" }} />
                <div>
                  <span className="hud-legend-label">Medium Quality (0.3 - 0.7)</span>
                  <div className="hud-legend-desc">Adequate signal. Reliable geotechnical data collection.</div>
                </div>
              </div>
              <div className="hud-legend-row">
                <div className="hud-legend-color" style={{ background: "hsl(140, 90%, 45%)" }} />
                <div>
                  <span className="hud-legend-label">Excellent Quality (0.7 - 1.0)</span>
                  <div className="hud-legend-desc">Perfect angle of incidence and short distance. Ideal SNR.</div>
                </div>
              </div>
            </>
          )}

          {/* Active Tool Help Box */}
          <div className="hud-tool-info">
            <div className="hud-tool-info-title">Active Tool Status</div>
            <div style={{ fontSize: "10.5px", fontWeight: "bold", color: "var(--text-primary)" }}>
              {toolExplanations[activeTool].title}
            </div>
            <div className="hud-tool-info-text">
              {toolExplanations[activeTool].desc}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
