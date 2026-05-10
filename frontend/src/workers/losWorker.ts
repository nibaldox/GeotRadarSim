/// <reference lib="webworker" />

import type { RadarConfig } from "../types/api";

export interface LOSWorkerInput {
  grid: number[][]; // rows x cols
  bounds: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
  resolution: number;
  radar_position: [number, number, number];
  radar_config: RadarConfig;
}

export interface LOSWorkerOutput {
  shadow_grid: boolean[][];
  quality_grid: number[][];
  coverage_pct: number;
  visible_area_m2: number;
  shadow_zones: Array<{ zone_id: number; cell_count: number }>;
  coverage_polygon: Array<[number, number]>;
}

self.onmessage = (e: MessageEvent<LOSWorkerInput>) => {
  const data = e.data;
  
  try {
    const result = computeLOS(data);
    self.postMessage(result);
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};

function computeLOS(input: LOSWorkerInput): LOSWorkerOutput {
  const { grid, bounds, resolution, radar_position: [rx, ry, rz], radar_config } = input;
  const rows = grid.length;
  const cols = grid[0]!.length;
  
  const minRange = radar_config.min_range_m || 0.0;
  const maxRange = radar_config.max_range_m;
  const elMin = radar_config.elevation_min_deg;
  const elMax = radar_config.elevation_max_deg;
  
  let azStart = 0;
  let azEnd = 360;
  let hasAzimuthLimits = false;
  
  if (radar_config.scan_pattern !== "SAR360" && radar_config.azimuth_range_deg) {
    azStart = radar_config.azimuth_range_deg[0];
    azEnd = radar_config.azimuth_range_deg[1];
    hasAzimuthLimits = true;
  }
  
  const shadowGrid: boolean[][] = Array(rows).fill(null).map(() => Array(cols).fill(true));
  const qualityGrid: number[][] = Array(rows).fill(null).map(() => Array(cols).fill(0));
  
  let totalAnalyzable = 0;
  let visibleCount = 0;
  
  // 1. Raycasting
  for (let r = 0; r < rows; r++) {
    const cy = bounds.min_y + resolution / 2 + r * resolution;
    
    for (let c = 0; c < cols; c++) {
      const cx = bounds.min_x + resolution / 2 + c * resolution;
      
      const dx = cx - rx;
      const dy = cy - ry;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Check range
      if (dist < minRange || dist > maxRange) continue;
      
      // Check elevation
      const targetZ = grid[r]![c]!;
      const dz = targetZ - rz;
      const elevation = Math.atan2(dz, dist) * (180 / Math.PI);
      if (elevation < elMin || elevation > elMax) continue;
      
      // Check azimuth
      if (hasAzimuthLimits) {
        let azimuth = Math.atan2(dx, dy) * (180 / Math.PI);
        if (azimuth > 180) azimuth -= 360;
        if (azimuth < -180) azimuth += 360;
        
        let inSector = false;
        if (azStart <= azEnd) {
          inSector = azimuth >= azStart && azimuth <= azEnd;
        } else {
          inSector = azimuth >= azStart || azimuth <= azEnd;
        }
        if (!inSector) continue;
      }
      
      totalAnalyzable++;
      
      // Raycast to check LOS
      if (dist < resolution) {
        shadowGrid[r]![c] = false;
        visibleCount++;
        continue;
      }
      
      const nSamples = Math.max(2, Math.floor(dist / resolution)); // Step by resolution, not half
      let shadowed = false;
      
      for (let i = 1; i < nSamples; i++) {
        const t = i / nSamples;
        const rayZ = rz + t * dz;
        
        // Fast nearest-neighbor instead of bilinear
        const rayX = rx + t * dx;
        const rayY = ry + t * dy;
        
        const c0 = Math.max(0, Math.min(cols - 1, Math.round((rayX - bounds.min_x) / resolution - 0.5)));
        const r0 = Math.max(0, Math.min(rows - 1, Math.round((rayY - bounds.min_y) / resolution - 0.5)));
        
        const terrainAtSample = grid[r0]![c0]!;
          
        if (terrainAtSample > rayZ) {
          shadowed = true;
          break;
        }
      }
      
      shadowGrid[r]![c] = shadowed;
      if (!shadowed) visibleCount++;
    }
  }
  
  // 2. Quality Grid & Coverage Polygon
  const coveragePolygon: Array<[number, number]> = [];
  
  if (visibleCount > 0) {
    for (let r = 0; r < rows; r++) {
      const cy = bounds.min_y + resolution / 2 + r * resolution;
      
      for (let c = 0; c < cols; c++) {
        if (!shadowGrid[r]![c]) {
          const cx = bounds.min_x + resolution / 2 + c * resolution;
          
          coveragePolygon.push([cx, cy]);
          
          // Calculate surface normal (central differences)
          let gradX = 0;
          let gradY = 0;
          
          if (c > 0 && c < cols - 1) {
            gradX = (grid[r]![c+1]! - grid[r]![c-1]!) / (2 * resolution);
          }
          if (r > 0 && r < rows - 1) {
            gradY = (grid[r+1]![c]! - grid[r-1]![c]!) / (2 * resolution);
          }
          
          const norm = Math.sqrt(gradX*gradX + gradY*gradY + 1.0);
          const nx = -gradX / norm;
          const ny = -gradY / norm;
          const nz = 1.0 / norm;
          
          const dx = cx - rx;
          const dy = cy - ry;
          const dz = grid[r]![c]! - rz;
          const dist3d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.1;
          
          const vx = dx / dist3d;
          const vy = dy / dist3d;
          const vz = dz / dist3d;
          
          let dotProduct = -(vx * nx + vy * ny + vz * nz);
          dotProduct = Math.max(0.0, Math.min(1.0, dotProduct));
          
          const dist = Math.sqrt(dx*dx + dy*dy);
          const distFactor = Math.sqrt(Math.max(0, 1.0 - (dist / maxRange)));
          
          qualityGrid[r]![c] = dotProduct * distFactor;
        }
      }
    }
  }
  
  // We skip proper convex hull for now and just return bounding box of coverage to simplify,
  // or a subsampled set of boundary points. Actually, let's just return a few points to avoid massive payloads.
  // The frontend map overlay will use the quality grid anyway.
  
  // 3. Shadow Zones (BFS)
  const shadowZones: Array<{ zone_id: number; cell_count: number }> = [];
  const visited: boolean[][] = Array(rows).fill(null).map(() => Array(cols).fill(false));
  let zoneId = 0;
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (shadowGrid[r]![c] && !visited[r]![c]) {
        zoneId++;
        let count = 0;
        const queue: Array<[number, number]> = [[r, c]];
        let qHead = 0;
        visited[r]![c] = true;
        
        while (qHead < queue.length) {
          const [cr, cc] = queue[qHead++]!;
          count++;
          
          const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
          for (let i = 0; i < neighbors.length; i++) {
            const [dr, dc] = neighbors[i]!;
            const nr = cr + dr;
            const nc = cc + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr]![nc] && shadowGrid[nr]![nc]) {
              visited[nr]![nc] = true;
              queue.push([nr, nc]);
            }
          }
        }
        shadowZones.push({ zone_id: zoneId, cell_count: count });
      }
    }
  }
  
  const coveragePct = totalAnalyzable > 0 ? (visibleCount / totalAnalyzable) * 100.0 : 0.0;
  const cellArea = resolution * resolution;
  const visibleAreaM2 = visibleCount * cellArea;

  return {
    shadow_grid: shadowGrid,
    quality_grid: qualityGrid,
    coverage_pct: Number(coveragePct.toFixed(2)),
    visible_area_m2: Number(visibleAreaM2.toFixed(2)),
    shadow_zones: shadowZones,
    coverage_polygon: coveragePolygon.slice(0, 100), // simplified
  };
}
