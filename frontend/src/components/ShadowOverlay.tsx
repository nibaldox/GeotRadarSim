/**
 * ShadowOverlay — semi-transparent overlay on terrain showing monitoring window.
 *
 * Color coding:
 * - Transparent: cells without a contributing observation (NODATA, OUT_OF_RANGE,
 *   OUTSIDE_FOV, UNKNOWN_RAY and SHADOW) leave the base terrain unchanged.
 * - Red → yellow → green: observed (VISIBLE) cells colored by the geometric LOS
 *   index; a measured 0.0 is data and stays painted red.
 *
 * Overlay sits slightly above terrain to prevent z-fighting.
 */

import { useMemo, useEffect, useRef } from "react";
import * as THREE from "three";
import { useAnalysisStore } from "../store/analysisStore";
import { useVectorStore } from "../store/vectorStore";
import { getMinElevation } from "../utils/terrain";
import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, SensitivityMapResponse } from "../types/api";

export type OverlayCellKind = "ignored" | "shadow" | "visible";

export function classifyOverlayCellState(state: number): OverlayCellKind {
  if (state === LOSCellState.VISIBLE) return "visible";
  if (state === LOSCellState.SHADOW) return "shadow";
  return "ignored";
}

export function sensitivityMapMatchesSnapshot(
  map: SensitivityMapResponse | null,
  snapshot: AnalysisSnapshot | null,
  rows: number,
  cols: number,
  resolution: number,
): boolean {
  return !!map && !!snapshot &&
    map.terrainKey.terrain_id === snapshot.terrainKey.terrain_id &&
    map.terrainKey.epoch === snapshot.terrainKey.epoch &&
    map.grid_rows === rows && map.grid_cols === cols && map.resolution === resolution &&
    map.sourceAnalysisIds.length === snapshot.sourceAnalysisIds.length &&
    map.sourceAnalysisIds.every((id, index) => id === snapshot.sourceAnalysisIds[index]) &&
    map.flat_sensitivity_grid instanceof Float32Array && map.flat_sensitivity_grid.length === rows * cols &&
    map.observer_count instanceof Uint16Array && map.observer_count.length === rows * cols;
}

/** Null denotes no measurement; a finite measured value of zero is preserved. */
export function sensitivityValueForCell(map: SensitivityMapResponse, index: number): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= map.observer_count.length ||
      map.observer_count[index] === 0) return null;
  const value = map.flat_sensitivity_grid[index];
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

/** Keep exact CPU counts, but upload as R32F for the shader's floating-point sampler2D. */
export function createObserverCountTexture(counts: Uint16Array, rows: number, cols: number): THREE.DataTexture {
  // RedFormat + UnsignedShortType is not a valid sized WebGL2 texture format.
  // Float32 represents every Uint16 count exactly, including zero (no observation).
  const texture = new THREE.DataTexture(
    Float32Array.from(counts), cols, rows, THREE.RedFormat, THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D qualityTexture;
  uniform sampler2D cellStateTexture;
  uniform sampler2D observerCountTexture;
  uniform float opacity;
  uniform float mapMode; // 0.0 = LOS, 1.0 = per-cell geometric sensitivity
  varying vec2 vUv;

  void main() {
    vec3 finalColor;
    if (mapMode < 0.5) {
      float cellState = floor(texture2D(cellStateTexture, vUv).r * 255.0 + 0.5);
      // Only observed (VISIBLE) cells are painted. SHADOW and every other
      // unobserved state leaves the base terrain unchanged.
      if (cellState != 5.0) discard;

      float q = texture2D(qualityTexture, vUv).r;
      vec3 colorLow  = vec3(0.9, 0.1, 0.1);
      vec3 colorMid  = vec3(1.0, 0.8, 0.0);
      vec3 colorHigh = vec3(0.0, 0.9, 0.2);
      if (q < 0.5) finalColor = mix(colorLow, colorMid, q / 0.5);
      else finalColor = mix(colorMid, colorHigh, (q - 0.5) / 0.5);
    } else {
      // The selected individual LOS masks are reduced to observer_count per cell.
      // Do not use the merged LOS cell state as a sensitivity visibility proxy.
      float observerCount = texture2D(observerCountTexture, vUv).r;
      if (observerCount <= 0.0) discard;
      float q = texture2D(qualityTexture, vUv).r;
      vec3 colorBlind = vec3(0.5, 0.0, 0.5);
      vec3 colorLow   = vec3(0.1, 0.2, 0.8);
      vec3 colorMid   = vec3(0.0, 0.8, 0.8);
      vec3 colorHigh  = vec3(0.0, 0.9, 0.2);
      if (q < 0.2) finalColor = mix(colorBlind, colorLow, q / 0.2);
      else if (q < 0.6) finalColor = mix(colorLow, colorMid, (q - 0.2) / 0.4);
      else finalColor = mix(colorMid, colorHigh, (q - 0.6) / 0.4);
    }
    gl_FragColor = vec4(finalColor, opacity);
  }
`;

interface ShadowOverlayProps {
  grid: number[][];
  resolution: number;
}

export function ShadowOverlay({ grid, resolution }: ShadowOverlayProps) {
  const losResult = useAnalysisStore((s) => s.losResult);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);
  const visualizationMode = useVectorStore((s) => s.visualizationMode);
  const sensitivityMap = useVectorStore((s) => s.sensitivityMap);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const sensitivityMapIsCurrent = sensitivityMapMatchesSnapshot(sensitivityMap, activeSnapshot, rows, cols, resolution);

  // 1. Static Geometry (only rebuilds when terrain changes)
  const geometry = useMemo(() => {
    const rows = grid.length;
    const cols = grid[0]!.length;
    const vertexCount = rows * cols;
    const minElev = getMinElevation(grid);

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    
    let posIdx = 0;
    let uvIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const val = grid[r]![c]!;
        positions[posIdx++] = c * resolution;
        positions[posIdx++] = (isNaN(val) ? 0 : val) - minElev + 1.1;
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
  }, [grid, resolution]);

  // 2. Individual observation-count, LOS state, and value textures.
  const cellStateTexture = useMemo(() => {
    if (!losResult || losResult.grid_rows !== rows || losResult.grid_cols !== cols ||
        losResult.resolution !== resolution || losResult.cell_states.length !== rows * cols) return null;
    const texture = new THREE.DataTexture(
      losResult.cell_states,
      cols,
      rows,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }, [losResult, grid, resolution, rows, cols]);

  const observerCountTexture = useMemo(() => {
    if (!sensitivityMapIsCurrent || !sensitivityMap) return null;
    return createObserverCountTexture(sensitivityMap.observer_count, rows, cols);
  }, [sensitivityMapIsCurrent, sensitivityMap, rows, cols]);

  const qualityTexture = useMemo(() => {
    if (!losResult || rows === 0 || cols === 0 || rows > 8192 || cols > 8192 ||
        losResult.grid_rows !== rows || losResult.grid_cols !== cols ||
        losResult.resolution !== resolution || losResult.cell_states.length !== rows * cols) return null;

    const isSensitivity = visualizationMode === "SENSITIVITY";
    if (isSensitivity && (!sensitivityMapIsCurrent || !sensitivityMap)) return null;
    const data = new Float32Array(rows * cols);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        if (isSensitivity) {
          const measuredValue = sensitivityValueForCell(sensitivityMap!, idx);
          if (measuredValue === null) continue;
          data[idx] = measuredValue;
          continue;
        }
        if (classifyOverlayCellState(losResult.cell_states[idx]!) !== "visible") continue;
        const rawValue = losResult.flat_quality_grid?.[idx] ?? losResult.quality_grid?.[row]?.[col];
        const safeValue = rawValue !== undefined && Number.isFinite(rawValue) ? rawValue : 0;
        data[idx] = Math.max(0, Math.min(1, safeValue));
      }
    }

    const texture = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.FloatType);
    texture.minFilter = isSensitivity ? THREE.NearestFilter : THREE.LinearFilter;
    texture.magFilter = isSensitivity ? THREE.NearestFilter : THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }, [losResult, rows, cols, resolution, visualizationMode, sensitivityMapIsCurrent, sensitivityMap]);

  useEffect(() => {
    if (materialRef.current && qualityTexture) {
      const uniforms = (materialRef.current as any).uniforms;
      uniforms.qualityTexture.value = qualityTexture;
      if (cellStateTexture) uniforms.cellStateTexture.value = cellStateTexture;
      if (observerCountTexture) uniforms.observerCountTexture.value = observerCountTexture;
      uniforms.mapMode.value = visualizationMode === "SENSITIVITY" ? 1.0 : 0.0;
      materialRef.current.needsUpdate = true;
    }
  }, [qualityTexture, cellStateTexture, observerCountTexture, visualizationMode]);

  // Unique react key for overlay re-mount
  const overlayKey = useMemo(() => {
    if (!losResult) return "empty";
    const sensitivityKey = sensitivityMap?.sourceAnalysisIds.join(",") ?? "no-sensitivity";
    return `${losResult.coverage_pct}_${losResult.visible_area_m2}_${losResult.shadow_zones.length}_${sensitivityKey}_${visualizationMode}`;
  }, [losResult, sensitivityMap, visualizationMode]);

  if (!losResult || !qualityTexture) return null;
  if (visualizationMode === "SENSITIVITY" && !observerCountTexture) return null;
  if (visualizationMode === "QUALITY" && !cellStateTexture) return null;

  return (
    <mesh key={overlayKey} geometry={geometry}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        uniforms={{
          qualityTexture: { value: qualityTexture },
          cellStateTexture: { value: cellStateTexture },
          observerCountTexture: { value: observerCountTexture },
          opacity: { value: 0.6 },
          mapMode: { value: visualizationMode === "SENSITIVITY" ? 1.0 : 0.0 }
        }}
      />
    </mesh>
  );
}
