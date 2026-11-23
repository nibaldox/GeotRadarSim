/**
 * TerrainViewer — R3F component for rendering terrain mesh.
 *
 * Renders the DTM grid as a colored mesh with elevation gradient.
 * Supports click-to-place radar via raycasting.
 * Uses OrbitControls for camera manipulation.
 */

import { useRef, useMemo, useEffect, useState, useId } from "react";
import "../styles/legend.css";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import * as THREE from "three";
import { getTerrainExtent, getMinElevation } from "../utils/terrain";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore, RADAR_COLORS } from "../store/analysisStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { formatBandRange } from "../utils/qualityMetrics";
import type { QualityBand, QualityPolicy } from "../utils/qualityMetrics";
import { ShadowOverlay } from "./ShadowOverlay";
import { AoiOverlay } from "./AoiOverlay";
import { useAoiStore } from "../store/aoiStore";
import type { Point3D } from "../types/api";
import type { TerrainKey } from "../store/analysisStore";
import { LOCAL_NORTH, VIEWER_AXIS_LABELS } from "../utils/localFrame";
import { CameraPresetCoordinator, type PresetControls } from "./cameraPreset";

interface TerrainMeshProps {
  grid: number[][];
  resolution: number;
  showShadowOverlay: boolean;
  onTerrainClick?: (point: { x: number; y: number; z: number }) => void;
  activeTool: "PAN" | "ADD_RADAR" | "AOI";
}

/** Band swatch colors shared by both layers: low/red, medium/yellow, high/green. */
const BAND_SWATCH: Record<QualityBand, string> = {
  low: "hsl(351, 80%, 50%)",
  medium: "hsl(38, 90%, 45%)",
  high: "hsl(140, 90%, 45%)",
};

/** Compact configured category, with its policy range available on hover. */
function legendBandRow(band: QualityBand, policy: QualityPolicy, label: string) {
  return (
    <div className="hud-legend-row" key={band} title={`${label} (${formatBandRange(band, policy)})`}>
      <div className="hud-legend-color" style={{ background: BAND_SWATCH[band] }} />
      <span className="hud-legend-label">{label}</span>
    </div>
  );
}

/** Local X/Z of a DEM node: (col * resolution, -row * resolution). */
export function buildTerrainMeshGeometry(
  grid: number[][],
  resolution: number,
  minElev = getMinElevation(grid),
): THREE.BufferGeometry {
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
      positions[posIdx++] = (Number.isFinite(val) ? val : 0) - minElev;
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

      // Skip the whole quad whenever one of its DEM nodes is missing.
      if (!Number.isFinite(valTL) || !Number.isFinite(valTR) ||
          !Number.isFinite(valBL) || !Number.isFinite(valBR)) {
        continue;
      }

      const tl = r * cols + c;
      const tr = tl + 1;
      const bl = tl + cols;
      const br = bl + 1;
      indices.push(tl, tr, bl, tr, br, bl);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** Center of the rendered DEM sample vertices, not the outer half-cell margin. */
export function getTerrainMeshCenter(
  grid: number[][],
  resolution: number,
): { centerX: number; centerZ: number } {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  return {
    centerX: Math.max(0, cols - 1) * resolution / 2,
    centerZ: -Math.max(0, rows - 1) * resolution / 2,
  };
}

export type TerrainCameraView = "HOME" | "TOP" | "FRONT" | "SIDE";

export interface TerrainCameraPose {
  extent: ReturnType<typeof getTerrainExtent>;
  target: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
}

/** Compute a finite camera target and position for auto-fit or a preset view. */
export function buildTerrainCameraPose(
  grid: number[][],
  resolution: number,
  view: TerrainCameraView | null = null,
): TerrainCameraPose | null {
  const extent = getTerrainExtent(grid, resolution);
  const maxDim = Math.max(extent.width, extent.depth);
  if (!Number.isFinite(maxDim) || maxDim <= 0 || !Number.isFinite(extent.height)) return null;

  const center = getTerrainMeshCenter(grid, resolution);
  const target = { x: center.centerX, y: extent.height / 2, z: center.centerZ };
  let position: TerrainCameraPose["position"];

  switch (view) {
    case "HOME":
      position = { x: target.x + maxDim * 1.2, y: target.y + maxDim, z: target.z + maxDim * 1.2 };
      break;
    case "TOP":
      // Straight down, nudged a hair to the south so the screen's up is terrain North
      // and East lands on the right (a nudge to the north turned the plan 180°).
      position = {
        x: target.x - LOCAL_NORTH.x * 0.01,
        y: target.y + maxDim * 1.8,
        z: target.z - LOCAL_NORTH.z * 0.01,
      };
      break;
    case "FRONT":
      position = { x: target.x, y: target.y, z: target.z + maxDim * 1.8 };
      break;
    case "SIDE":
      position = { x: target.x + maxDim * 1.8, y: target.y, z: target.z };
      break;
    default:
      position = { x: target.x + maxDim * 1.2, y: maxDim, z: target.z + maxDim * 1.2 };
  }

  if (![target.x, target.y, target.z, position.x, position.y, position.z].every(Number.isFinite)) {
    return null;
  }
  return { extent, target, position };
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

  const geometry = useMemo(
    () => buildTerrainMeshGeometry(grid, resolution, minElev),
    [grid, resolution, minElev],
  );

  return (
    <group>
      <mesh
        ref={meshRef}
        name="aoi-terrain-mesh"
        geometry={geometry}
        castShadow
        receiveShadow
        onClick={(e) => {
          if (activeTool !== "AOI" || e.delta > 5) return;
          e.stopPropagation();
          const state = useAoiStore.getState();
          const metadata = useTerrainStore.getState().metadata;
          if (state.drawing && metadata && e.nativeEvent.detail < 2) {
            state.addVertex({ x: e.point.x + metadata.bounds.min_x, y: metadata.bounds.min_y - e.point.z });
          }
        }}
        onDoubleClick={(e) => {
          if (activeTool === "AOI") { e.stopPropagation(); useAoiStore.getState().closePolygon(); }
        }}
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

interface RadarMarker {
  key: string;
  name: string;
  position: Point3D;
  color: string;
  kind: "placed" | "analysis";
}

export interface RadarMarkerRadii {
  core: number;
}

/**
 * Core icon radius in local metres, scaled by the horizontal map extent (the
 * larger of the E-W and N-S spans — never the elevation range, which is
 * relief, not map width). QA baseline f8 metadata (1365 m extent): core ≈
 * 11.0 m. Clamped to 6–40 m so a 200 m synthetic terrain keeps a small
 * readable icon and huge terrains do not get giant icons.
 */
export function radarMarkerRadii(
  bounds: { min_x: number; max_x: number; min_y: number; max_y: number },
): RadarMarkerRadii {
  const extent = Math.max(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y);
  return { core: Math.min(Math.max(extent * 0.0168, 6), 40) * 0.48 };
}

const sameTerrainKey = (left: TerrainKey | null, right: TerrainKey | null): boolean =>
  !!left && !!right && left.terrain_id === right.terrain_id && left.epoch === right.epoch;

const positionKey = (position: Point3D): string =>
  `${position.x}:${position.y}:${position.z}`;

const isFinitePosition = (position: Point3D): boolean =>
  Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);

/** The visible analysis snapshot is authoritative; fallback markers are placement/history only. */
function RadarMarkers() {
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const history = useAnalysisStore((s) => s.history);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const losResult = useAnalysisStore((s) => s.losResult);
  const analysisTerrainKey = useAnalysisStore((s) => s.terrainKey);
  const terrainTransitioning = useAnalysisStore((s) => s.terrainTransitioning);
  const metadata = useTerrainStore((s) => s.metadata);
  const terrainKey = useTerrainStore((s) => s.terrainKey);
  const terrainEpoch = useTerrainStore((s) => s.terrainEpoch);

  const currentTerrainKey = useMemo<TerrainKey | null>(() => {
    if (!metadata) return null;
    return terrainKey ?? { terrain_id: metadata.terrain_id, epoch: terrainEpoch };
  }, [metadata, terrainKey, terrainEpoch]);
  const terrainMatches = !!metadata && !!currentTerrainKey &&
    currentTerrainKey.terrain_id === metadata.terrain_id &&
    !terrainTransitioning &&
    (analysisTerrainKey
      ? sameTerrainKey(analysisTerrainKey, currentTerrainKey)
      : currentTerrainKey.epoch === 0);
  const snapshotIsVisible = !!activeSnapshot && !!losResult && terrainMatches &&
    sameTerrainKey(activeSnapshot.terrainKey, currentTerrainKey) &&
    sameTerrainKey(activeSnapshot.terrainKey, analysisTerrainKey ?? (currentTerrainKey?.epoch === 0 ? currentTerrainKey : null));

  const markers = useMemo<RadarMarker[]>(() => {
    if (!metadata || !terrainMatches || !currentTerrainKey) return [];
    const seenPositions = new Set<string>();
    const resolved: RadarMarker[] = [];
    const addMarker = (marker: RadarMarker) => {
      if (!isFinitePosition(marker.position)) return;
      const positionId = positionKey(marker.position);
      if (seenPositions.has(positionId)) return;
      seenPositions.add(positionId);
      resolved.push(marker);
    };

    if (activeSnapshot) {
      if (!snapshotIsVisible) return [];
      activeSnapshot.radars.forEach((radar, index) => {
        addMarker({
          key: `${radar.radarId}-${index}`,
          name: `radar-snapshot-${radar.radarId}`,
          position: radar.position,
          color: RADAR_COLORS[index % RADAR_COLORS.length] || "#ff4444",
          kind: "analysis",
        });
      });
      return resolved;
    }

    if (radarPosition) {
      addMarker({
        key: "placed-radar",
        name: "radar-current-marker",
        position: radarPosition,
        color: "white",
        kind: "placed",
      });
    }
    history.forEach((entry, index) => {
      if (!entry.selected || !isFinitePosition(entry.position)) return;
      const entryMatchesTerrain = entry.terrain_id === currentTerrainKey.terrain_id &&
        entry.terrain_epoch === currentTerrainKey.epoch;
      const legacyEpochZero = entry.terrain_id === undefined && entry.terrain_epoch === undefined &&
        currentTerrainKey.epoch === 0;
      if (!entryMatchesTerrain && !legacyEpochZero) return;
      addMarker({
        key: `history-${entry.timestamp}-${index}`,
        name: `radar-history-${entry.timestamp}-${index}`,
        position: entry.position,
        color: RADAR_COLORS[index % RADAR_COLORS.length] || "#ff4444",
        kind: "analysis",
      });
    });
    return resolved;
  }, [activeSnapshot, currentTerrainKey, history, metadata, radarPosition, snapshotIsVisible, terrainMatches]);

  if (!metadata || markers.length === 0) return null;
  const bounds = metadata.bounds;
  const radii = radarMarkerRadii(bounds);
  const toLocal = (position: Point3D): [number, number, number] => [
    position.x - bounds.min_x,
    position.z - bounds.min_z,
    bounds.min_y - position.y,
  ];

  return (
    <>
      {markers.map((marker) => {
        const position = toLocal(marker.position);
        if (marker.kind === "placed") {
          return (
            <mesh key={marker.key} name={marker.name} position={position}>
              <sphereGeometry args={[radii.core, 16, 16]} />
              <meshStandardMaterial color="white" emissive="white" emissiveIntensity={0.5} />
            </mesh>
          );
        }
        return (
          <group key={marker.key} name={marker.name} position={position}>
            <mesh>
              <sphereGeometry args={[radii.core, 16, 16]} />
              <meshStandardMaterial color={marker.color} emissive={marker.color} emissiveIntensity={0.4} />
            </mesh>
            <mesh position={[0, radii.core * 1.5, 0]}>
              <cylinderGeometry args={[radii.core / 8, radii.core / 8, radii.core * 3, 8]} />
              <meshStandardMaterial color={marker.color} />
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
  const hasAoiVertices = useAoiStore(s => s.vertices.length > 0);
  const controlsRef = useRef<any>(null);
  const coordinator = useMemo(
    () => new CameraPresetCoordinator(camera, () => controlsRef.current as PresetControls | null),
    [camera],
  );

  // Auto-fit camera to terrain extent on first load
  useEffect(() => {
    if (!grid || grid.length === 0 || !grid[0]) return;

    const pose = buildTerrainCameraPose(grid, resolution);
    if (!pose) return;
    const { extent } = pose;
    coordinator.applyPreset(pose);
    camera.far = Math.max(10000, Math.max(extent.width, extent.depth) * 10);
    camera.updateProjectionMatrix();
  }, [grid, resolution, coordinator]);

  // Listen to cameraView changes from AutoCAD toolbar
  useEffect(() => {
    if (!cameraView || !grid || grid.length === 0 || !grid[0]) return;

    const pose = buildTerrainCameraPose(grid, resolution, cameraView);
    if (!pose) return;
    // Cancels orbit inertia and wins over a running gizmo tween (cameraPreset.ts).
    coordinator.applyPreset(pose);
    camera.updateProjectionMatrix();

    // Reset parent cameraView selection once applied
    onCameraViewApplied();
  }, [cameraView, grid, resolution, camera, coordinator, onCameraViewApplied]);

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
      {hasAoiVertices && <AoiOverlay active={activeTool === "AOI"} />}
      <RadarMarkers />
      <OrbitControls ref={controlsRef} makeDefault enabled={activeTool !== "AOI"} />
      
      <GizmoHelper
        alignment="bottom-right"
        margin={[60, 60]}
        onTarget={() => coordinator.gizmoTweenStarted()}
        onUpdate={() => coordinator.gizmoTweenFrame()}
      >
        <GizmoViewport
          axisColors={['#ff3653', '#0adb21', '#2c8fdf']}
          labelColor="white"
          labels={[...VIEWER_AXIS_LABELS]}
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
  const [activeTool, setActiveTool] = useState<"PAN" | "ADD_RADAR" | "AOI">("PAN");
  const [cameraView, setCameraView] = useState<"HOME" | "TOP" | "FRONT" | "SIDE" | null>(null);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const policy = useQualityPolicyStore((s) => s.policy);

  const aoi = useAoiStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && useAoiStore.getState().drawing) { useAoiStore.getState().clear(); setActiveTool("PAN"); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const legendInfoId = useId();
  useEffect(() => {
    if (!legendOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!legendRef.current?.contains(event.target as Node)) setLegendOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLegendOpen(false);
        infoButtonRef.current?.focus();
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [legendOpen]);

  if (!grid || grid.length === 0) {
    return (
      <div style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--sidebar-bg)",
        color: "var(--text-secondary)",
      }}>
        <p>Sin terreno. Carga un STL o DXF, o genera un terreno sintético.</p>
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
      <div className="autocad-toolbar" aria-label="Controles del visor">
        {/* Interaction Tools Section */}
        <div className="toolbar-section">
          <div className="toolbar-section-title">Herramientas</div>
          <button
            className={`toolbar-btn ${activeTool === "PAN" ? "active" : ""}`}
            onClick={() => { if (useAoiStore.getState().drawing) useAoiStore.getState().clear(); setActiveTool("PAN"); }}
            aria-label="Navegar"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5 9 2 12 5 15" />
              <polyline points="9 5 12 2 15 5" />
              <polyline points="15 19 12 22 9 19" />
              <polyline points="19 9 22 12 19 15" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <line x1="12" y1="2" x2="12" y2="22" />
            </svg>
            <span className="tooltip">Navegar (mover y orbitar)</span>
          </button>
          <button
            className={`toolbar-btn ${activeTool === "ADD_RADAR" ? "active" : ""}`}
            onClick={() => { if (useAoiStore.getState().drawing) useAoiStore.getState().clear(); setActiveTool("ADD_RADAR"); }}
            aria-label="Agregar radar"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 13v7" />
              <path d="M8 20h8" />
              <path d="M5 12a7 7 0 0 1 14 0" />
              <polyline points="12 12 12 7" />
              <path d="M8 6a5 5 0 0 1 8 0" strokeDasharray="2,2" />
              <path d="M6 3a9 9 0 0 1 12 0" />
            </svg>
            <span className="tooltip">Agregar radar (clic en el terreno)</span>
          </button>
          <button className={`toolbar-btn ${activeTool === "AOI" ? "active" : ""}`} aria-label="Área a monitorear" onClick={() => { setActiveTool("AOI"); if (!useAoiStore.getState().polygon) useAoiStore.getState().startDrawing(); }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 18L6 5l12-2 3 13-9 5z"/><circle cx="6" cy="5" r="2"/></svg><span className="tooltip">Área a monitorear</span>
          </button>
          {(aoi.polygon || aoi.drawing) && <button className="toolbar-btn aoi-clear" aria-label="Borrar área" title="Borrar área" onClick={() => { aoi.clear(); setActiveTool("PAN"); }}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></svg><span className="tooltip">Borrar área</span></button>}
        </div>

        <div className="toolbar-divider" />

        {/* Camera Preset Angles Section */}
        <div className="toolbar-section">
          <div className="toolbar-section-title">Vistas</div>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("HOME")}
            aria-label="Vista isométrica"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 7v10l10 5V12L2 7z" />
              <path d="M22 7v10l-10 5V12l10-5z" />
            </svg>
            <span className="tooltip">Vista isométrica</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("TOP")}
            aria-label="Vista en planta"
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
            <span className="tooltip">Vista en planta</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("FRONT")}
            aria-label="Vista frontal"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="2" y1="20" x2="22" y2="20" />
              <path d="M4 20l5-9 4 4 5-8 4 13" />
              <line x1="12" y1="2" x2="12" y2="6" strokeWidth="2" />
              <polyline points="9 4 12 6 15 4" strokeWidth="2" />
            </svg>
            <span className="tooltip">Vista frontal</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setCameraView("SIDE")}
            aria-label="Vista lateral"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16V6L4 20z" fill="rgba(255,255,255,0.05)" />
              <path d="M4 20h16M20 20V6M4 20L20 6" />
              <path d="M8 20a4 4 0 0 0 4-4" stroke="var(--accent-color)" />
            </svg>
            <span className="tooltip">Vista lateral</span>
          </button>
        </div>
      </div>

      {activeTool === "AOI" && <div className="aoi-help" role="status">{aoi.error || (aoi.drawing ? "Haz clic para agregar vértices; doble clic o clic en el primero para cerrar. Esc cancela." : "Arrastra los vértices para editar el área.")}</div>}

      {showShadowOverlay && (
        <div className="geotechnical-hud-legend compact-legend" ref={legendRef}>
          <div className="compact-legend-header">
            <div className="hud-legend-title">{visualizationMode === "SENSITIVITY" ? "Proyección del movimiento" : "Incidencia superficial"}</div>
            <button ref={infoButtonRef} type="button" className="legend-info-button" aria-label="Información de la leyenda" aria-expanded={legendOpen} aria-controls={legendInfoId} onClick={() => setLegendOpen((open) => !open)}>i</button>
          </div>
          {visualizationMode === "SENSITIVITY" ? (
            <div className="legend-projection-stops">
              {[["0", "rgb(128, 0, 128)"], ["0.2", "rgb(26, 51, 204)"], ["0.6", "rgb(0, 204, 204)"], ["1", "rgb(0, 230, 51)"]].map(([stop, color]) => (
                <div className="hud-legend-row" key={stop} title={`Corte del degradado: ${stop}`}>
                  <div className="hud-legend-color" style={{ background: color }} />
                  <span className="hud-legend-label">{stop}</span>
                </div>
              ))}
            </div>
          ) : (
            <div data-testid="incidence-gradient" aria-label="Gradiente de incidencia superficial" className="legend-gradient"
              style={{ background: `linear-gradient(to right, ${policy.mediumMin === 0 ? "rgb(242, 115, 13)" : "rgb(230, 26, 26)"} ${policy.mediumMin * 50}%, rgb(242, 115, 13) ${policy.mediumMin * 100}%, rgb(255, 204, 0) ${(policy.mediumMin + policy.highMin) * 50}%, rgb(128, 217, 26) ${policy.highMin * 100}%, ${policy.highMin === 1 ? "rgb(128, 217, 26)" : "rgb(0, 230, 51)"} ${(policy.highMin + 1) * 50}%)` }} />
          )}
          <div className="legend-marks"><span>0</span><span>{policy.mediumMin}</span><span>{policy.highMin}</span><span>1</span></div>
          <div className="legend-bands">
            {legendBandRow("low", policy, "baja")}
            {legendBandRow("medium", policy, "media")}
            {legendBandRow("high", policy, "alta")}
          </div>
          <div className="legend-note">Sin color = no visible</div>
          {legendOpen && <div id={legendInfoId} className="legend-popover" role="region" aria-label="Información de la leyenda">
            {visualizationMode === "SENSITIVITY" ? <>
              <p>Transparente significa que no hay observación contribuyente: ningún LOS individual es VISIBLE con un gradiente del terreno calculable. Puede deberse a NODATA, un estado de rayo desconocido, fuera de alcance/FOV, sombra o una celda VISIBLE sin gradiente calculable; la transparencia por sí sola no identifica la sombra.</p>
              <p>Los colores del mapa usan un degradado continuo con cortes fijos en 0.2 y 0.6. Las bandas baja/media/alta del dashboard, las tarjetas y las exportaciones usan los umbrales configurables (actualmente {policy.mediumMin} / {policy.highMin}).</p>
              <p>Con un contribuyente: |dot| entre la dirección de máxima pendiente y la línea de vista (LOS) del radar; con varios contribuyentes: RMS(dotᵢ) entre ellos. Un cero medido tiene al menos un contribuyente; sin contribuyentes no hay datos, no un cero. Son intervalos de un índice geométrico, no umbrales de detección ni rendimiento RF/SNR.</p>
              <p>La capa 3D pinta una proyección escalar sobre la superficie del terreno bajo el movimiento supuesto de máxima pendiente; no es una reconstrucción volumétrica ni una inversión completa de desplazamiento en 3 ejes.</p>
            </> : <>
              <p>NODATA, UNKNOWN_RAY, OUT_OF_RANGE, OUTSIDE_FOV y SHADOW no tienen un índice mostrado y aparecen transparentes, mostrando el terreno base; la transparencia por sí sola no identifica la causa.</p>
              <p>SHADOW indica una obstrucción del terreno en el rayo LOS; es distinto de OUT_OF_RANGE y OUTSIDE_FOV.</p>
              <p>Los colores cambian de forma continua. Los cortes configurables ({policy.mediumMin} / {policy.highMin}) quedan en el punto medio de cada transición de color y siguen definiendo las bandas baja/media/alta del dashboard, las tarjetas y las exportaciones.</p>
              <p>El índice geométrico se calcula solo para celdas VISIBLE. Un valor mostrado de 0.0 es medido; los datos ausentes son transparentes.</p>
              <p>Para celdas VISIBLE, el valor de 0-1 es la alineación de la normal superficial del terreno con la dirección LOS desde el terreno hacia el radar. La distancia no es un multiplicador: el alcance máximo configurado solo delimita qué celdas son elegibles para el LOS y no puede cambiar el puntaje de una celda que sigue siendo VISIBLE. Es un índice geométrico, no una estimación de la señal del sensor ni de la fiabilidad de los datos.</p>
            </>}
            <p>Las bandas son una política compartida configurable copiada de la leyenda anterior (provisional); no son umbrales de detección certificados por equipo.</p>
          </div>}
        </div>
      )}
    </div>
  );
}
