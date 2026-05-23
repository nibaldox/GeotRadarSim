/**
 * ShadowOverlay — semi-transparent overlay on terrain showing monitoring window.
 *
 * Color coding:
 * - Green: visible zone (monitoring window — radar can "see" this area)
 * - Red/dark: shadow zone (obstructed — radar cannot monitor here)
 *
 * Overlay sits slightly above terrain to prevent z-fighting.
 */

import { useMemo, useEffect, useRef } from "react";
import * as THREE from "three";
import { useAnalysisStore } from "../store/analysisStore";
import { getMinElevation } from "../utils/terrain";

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D qualityTexture;
  uniform float opacity;
  varying vec2 vUv;

  void main() {
    float q = texture2D(qualityTexture, vUv).r;
    
    // q < 0.0 = zona en sombra (sentinel -1.0) → transparente
    if (q < 0.0) {
      discard; 
    }
    
    vec3 finalColor;
    // Modo Calidad LOS: Rojo -> Amarillo -> Verde
    vec3 colorLow  = vec3(0.9, 0.1, 0.1);    // Rojo  (Pobre)
    vec3 colorMid  = vec3(1.0, 0.8, 0.0);    // Amarillo (Medio)
    vec3 colorHigh = vec3(0.0, 0.9, 0.2);    // Verde (Excelente)
    
    if (q < 0.5) {
      finalColor = mix(colorLow, colorMid, q / 0.5);
    } else {
      finalColor = mix(colorMid, colorHigh, (q - 0.5) / 0.5);
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
  const materialRef = useRef<THREE.ShaderMaterial>(null);

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

  // 2. Dynamic Texture
  const qualityTexture = useMemo(() => {
    if (!losResult || !grid || grid.length === 0 || !grid[0]) return null;

    const rows = grid.length;
    const cols = grid[0].length;

    if (rows > 8192 || cols > 8192) {
      console.warn("Terrain resolution too high for GPU overlay, skipping.");
      return null;
    }

    let data: Float32Array | null = null;

    if (losResult.flat_quality_grid) {
      data = losResult.flat_quality_grid;
    } else if (losResult.shadow_grid && losResult.quality_grid) {
      data = new Float32Array(rows * cols);
      const shadowGrid = losResult.shadow_grid;
      const qualityGrid = losResult.quality_grid;
      for (let r = 0; r < rows; r++) {
        if (!grid[r]) continue;
        for (let c = 0; c < cols; c++) {
          const isShadowed = shadowGrid[r] ? shadowGrid[r]![c] ?? true : true;
          const idx = r * cols + c;
          if (isShadowed) {
            data[idx] = -1.0;
          } else {
            const quality = qualityGrid[r] ? qualityGrid[r]![c] ?? 0 : 0;
            data[idx] = Math.max(0.001, isNaN(quality) ? 0.001 : quality);
          }
        }
      }
    }

    if (!data) return null;

    const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }, [losResult, grid]);

  // 3. Update the uniform directly in the material via ref if it changes
  useEffect(() => {
    if (materialRef.current && qualityTexture) {
      (materialRef.current as any).uniforms.qualityTexture.value = qualityTexture;
      materialRef.current.needsUpdate = true;
    }
  }, [qualityTexture]);

  // Unique react key for overlay re-mount
  const overlayKey = useMemo(() => {
    if (!losResult) return "empty";
    return `${losResult.coverage_pct}_${losResult.visible_area_m2}_${losResult.shadow_zones.length}`;
  }, [losResult]);

  if (!losResult) return null;

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
          opacity: { value: 0.6 }
        }}
      />
    </mesh>
  );
}
