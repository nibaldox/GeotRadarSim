/**
 * TerrainViewer — R3F component for rendering terrain mesh.
 *
 * Renders the DTM grid as a colored mesh with elevation gradient.
 * Supports click-to-place radar via raycasting.
 * Uses OrbitControls for camera manipulation.
 */

import { useRef, useMemo, useCallback } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { buildVertexData } from "../utils/terrain";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";
import { ShadowOverlay } from "./ShadowOverlay";

interface TerrainMeshProps {
  grid: number[][];
  resolution: number;
  showShadowOverlay: boolean;
  onTerrainClick?: (point: { x: number; y: number; z: number }) => void;
}

function TerrainMesh({
  grid,
  resolution,
  showShadowOverlay,
  onTerrainClick,
}: TerrainMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  const { positions, colors, indices } = useMemo(
    () => buildVertexData(grid, 0, 0, resolution),
    [grid, resolution],
  );

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [positions, colors, indices]);

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      if (!onTerrainClick) return;

      const point = event.point;
      onTerrainClick({
        x: point.x,
        y: point.y,
        z: point.z,
      });
    },
    [onTerrainClick],
  );

  return (
    <group>
      <mesh
        ref={meshRef}
        geometry={geometry}
        onClick={handleClick}
      >
        <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
      {showShadowOverlay && <ShadowOverlay grid={grid} resolution={resolution} />}
    </group>
  );
}

/** Radar marker sphere placed at the radar position */
function RadarMarker() {
  const radarPosition = useAnalysisStore((s) => s.radarPosition);

  if (!radarPosition) return null;

  return (
    <mesh position={[radarPosition.x, radarPosition.y, radarPosition.z]}>
      <sphereGeometry args={[2, 16, 16]} />
      <meshStandardMaterial color="red" />
    </mesh>
  );
}

/** Scene setup: lighting, camera position, controls */
function Scene({ grid, resolution, showShadowOverlay, onTerrainClick }: TerrainMeshProps) {
  const { camera } = useThree();

  // Position camera above center of terrain
  useMemo(() => {
    const rows = grid.length;
    const cols = grid[0]!.length;
    const centerX = (cols * resolution) / 2;
    const centerZ = (rows * resolution) / 2;
    camera.position.set(centerX, 200, centerZ + 100);
    camera.lookAt(centerX, 0, centerZ);
  }, [grid, resolution, camera]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[100, 200, 100]} intensity={0.8} />
      <TerrainMesh
        grid={grid}
        resolution={resolution}
        showShadowOverlay={showShadowOverlay}
        onTerrainClick={onTerrainClick}
      />
      <RadarMarker />
      <OrbitControls makeDefault />
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
    <div style={{ width: "100%", height: "100%" }}>
      <Canvas camera={{ fov: 50, near: 0.1, far: 10000 }}>
        <Scene
          grid={grid}
          resolution={resolution}
          showShadowOverlay={showShadowOverlay}
          onTerrainClick={onTerrainClick}
        />
      </Canvas>
    </div>
  );
}
