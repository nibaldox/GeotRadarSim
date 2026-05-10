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
    
    vec3 colorLow  = vec3(0.9, 0.1, 0.1);    // Rojo  (Pobre)
    vec3 colorMid  = vec3(1.0, 0.8, 0.0);    // Amarillo (Medio)
    vec3 colorHigh = vec3(0.0, 0.9, 0.2);    // Verde (Excelente)
    
    vec3 finalColor;
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
        indices[iIdx++] = tr;
        indices[iIdx++] = bl;
        indices[iIdx++] = tr;
        indices[iIdx++] = br;
        indices[iIdx++] = bl;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
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

    const shadowGrid = losResult.shadow_grid;
    const qualityGrid = losResult.quality_grid;
    if (!shadowGrid) return null;

    const data = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      if (!grid[r]) continue;
      for (let c = 0; c < cols; c++) {
        const isShadowed = shadowGrid[r] ? shadowGrid[r]![c] ?? true : true;
        const quality    = qualityGrid && qualityGrid[r] ? qualityGrid[r]![c] ?? 0 : 0;
        const idx = r * cols + c;

        if (isShadowed) {
          data[idx] = -1.0;  // Sentinel: zona en sombra → el shader descarta
        } else {
          // Visible: garantizamos mínimo 0.001 para distinguir de sombra
          data[idx] = Math.max(0.001, isNaN(quality) ? 0.001 : quality);
        }
      }
    }

    const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }, [losResult, grid]);

  // 3. Actualizar el uniform directamente en el material via ref
  //    Esto garantiza que Three.js suba la textura a la GPU en el próximo frame
  useEffect(() => {
    if (materialRef.current && qualityTexture) {
      materialRef.current.uniforms.qualityTexture.value = qualityTexture;
      materialRef.current.needsUpdate = true;
    }
  }, [qualityTexture]);

  if (!losResult) return null;

  return (
    <mesh geometry={geometry}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        uniforms={{
          qualityTexture: { value: null },
          opacity: { value: 0.6 },
        }}
      />
    </mesh>
  );
}
