/**
 * ShadowOverlay — semi-transparent overlay on terrain showing shadow/visible zones.
 *
 * Uses the LOS analysis result (shadow_grid) to color vertices:
 * - Visible: transparent (terrain color shows through)
 * - Shadowed: semi-transparent dark color
 *
 * Toggleable via prop without clearing computed data.
 */

import { useMemo } from "react";
import * as THREE from "three";
import { useAnalysisStore } from "../store/analysisStore";
import { normalizeGrid } from "../utils/terrain";

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

    const positions = normalizeGrid(grid, 0, 0, resolution);
    // Slightly above terrain to prevent z-fighting
    for (let i = 1; i < positions.length; i += 3) {
      positions[i]! += 0.5;
    }

    const colors = new Float32Array(vertexCount * 3);
    const shadowGrid = losResult.shadow_grid;

    let colorIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isShadowed = shadowGrid[r] ? shadowGrid[r]![c] ?? false : false;
        if (isShadowed) {
          // Dark semi-transparent: dark red
          colors[colorIdx++] = 0.6;
          colors[colorIdx++] = 0.0;
          colors[colorIdx++] = 0.0;
        } else {
          // Visible: green tint
          colors[colorIdx++] = 0.0;
          colors[colorIdx++] = 0.6;
          colors[colorIdx++] = 0.0;
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
        opacity={0.35}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}
