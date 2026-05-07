/**
 * ShadowOverlay — semi-transparent overlay on terrain showing monitoring window.
 *
 * Color coding:
 * - Green: visible zone (monitoring window — radar can "see" this area)
 * - Red/dark: shadow zone (obstructed — radar cannot monitor here)
 *
 * Overlay sits slightly above terrain to prevent z-fighting.
 */

import { useMemo } from "react";
import * as THREE from "three";
import { useAnalysisStore } from "../store/analysisStore";
import { getMinElevation } from "../utils/terrain";

interface ShadowOverlayProps {
  grid: number[][];
  resolution: number;
}

export function ShadowOverlay({ grid, resolution }: ShadowOverlayProps) {
  const losResult = useAnalysisStore((s) => s.losResult);

  const geometry = useMemo(() => {
    if (!losResult) return null;

    const rows = grid.length;
    const cols = grid[0]!.length;
    const vertexCount = rows * cols;
    const minElev = getMinElevation(grid);

    // Build positions with normalized elevation + slight offset above terrain
    const positions = new Float32Array(vertexCount * 3);
    let posIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        positions[posIdx++] = c * resolution;
        positions[posIdx++] = grid[r]![c]! - minElev + 1.0; // normalized + offset
        positions[posIdx++] = r * resolution;
      }
    }

    const colors = new Float32Array(vertexCount * 3);
    const shadowGrid = losResult.shadow_grid;

    let colorIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isShadowed = shadowGrid[r] ? shadowGrid[r]![c] ?? false : false;
        if (isShadowed) {
          // Shadow: red
          colors[colorIdx++] = 0.9;
          colors[colorIdx++] = 0.15;
          colors[colorIdx++] = 0.15;
        } else {
          // Visible (monitoring window): green
          colors[colorIdx++] = 0.1;
          colors[colorIdx++] = 0.85;
          colors[colorIdx++] = 0.2;
        }
      }
    }

    // Build indices
    const quadCount = (rows - 1) * (cols - 1);
    const indices = new Uint32Array(quadCount * 6);
    let iIdx = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = r * cols + c;
        const tr = tl + 1;
        const bl = tl + cols;
        const br = bl + 1;
        indices[iIdx++] = tl;
        indices[iIdx++] = bl;
        indices[iIdx++] = tr;
        indices[iIdx++] = tr;
        indices[iIdx++] = bl;
        indices[iIdx++] = br;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [grid, resolution, losResult]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        vertexColors
        transparent
        opacity={0.45}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}
