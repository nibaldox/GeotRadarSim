/// <reference lib="webworker" />
import DxfParser from 'dxf-parser';
import type { DTMMetadata } from '../types/api';

export interface TerrainWorkerInput {
  fileData: ArrayBuffer;
  filename: string;
  resolution: number;
}

export interface TerrainWorkerOutput {
  grid?: number[][];
  metadata?: DTMMetadata;
  warnings?: string[];
  error?: string;
}

self.onmessage = async (e: MessageEvent<TerrainWorkerInput>) => {
  try {
    const { fileData, filename, resolution } = e.data;
    const isStl = filename.toLowerCase().endsWith('.stl');
    
    let points: Array<[number, number, number]> = [];
    
    if (isStl) {
      points = parseSTL(fileData);
    } else {
      // DXF requires a string
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(fileData);
      points = parseDXF(text);
    }
    
    if (points.length === 0) {
      throw new Error("No usable points found in file");
    }
    
    const result = generateDTM(points, resolution);
    self.postMessage(result);
  } catch (err: any) {
    self.postMessage({ error: err.message || String(err) });
  }
};

function parseSTL(buffer: ArrayBuffer): Array<[number, number, number]> {
  // Simple binary STL parser
  const view = new DataView(buffer);
  
  // Check if it's binary by reading the 80 byte header and the uint32 count
  // If count * 50 + 84 == byteLength, it's very likely binary.
  // We'll assume binary for now as ASCII is rare for large topo.
  if (buffer.byteLength < 84) {
    throw new Error("Invalid STL file size");
  }
  
  const numTriangles = view.getUint32(80, true);
  const points: Array<[number, number, number]> = [];
  
  // To avoid massive arrays for huge STLs, we'll subsample if > 1M points
  const step = numTriangles > 500000 ? Math.ceil(numTriangles / 500000) : 1;
  
  for (let i = 0; i < numTriangles; i += step) {
    const offset = 84 + i * 50;
    if (offset + 48 > buffer.byteLength) break;
    
    // Skip normal (12 bytes)
    for (let v = 0; v < 3; v++) {
      const vOffset = offset + 12 + v * 12;
      const x = view.getFloat32(vOffset, true);
      const y = view.getFloat32(vOffset + 4, true);
      const z = view.getFloat32(vOffset + 8, true);
      points.push([x, y, z]);
    }
  }
  
  return points;
}

function parseDXF(text: string): Array<[number, number, number]> {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  const points: Array<[number, number, number]> = [];
  
  if (!dxf || !dxf.entities) return points;
  
  for (const entity of dxf.entities) {
    const ent = entity as any;
    if (ent.type === 'POINT' || ent.type === '3DFACE') {
      if (ent.vertices) {
        for (const v of ent.vertices) {
          points.push([v.x, v.y, v.z || 0]);
        }
      }
    } else if (ent.type === 'LINE') {
      if (ent.vertices) {
        for (const v of ent.vertices) {
          points.push([v.x, v.y, v.z || 0]);
        }
      }
    } else if (ent.type === 'POLYLINE' || ent.type === 'LWPOLYLINE') {
      if (ent.vertices) {
        for (const v of ent.vertices) {
          points.push([v.x, v.y, v.z || 0]);
        }
      }
    }
  }
  
  return points;
}

function generateDTM(points: Array<[number, number, number]>, resolution: number): TerrainWorkerOutput {
  const warnings: string[] = [];
  
  if (points.length < 100) {
    warnings.push(`Sparse point cloud: ${points.length} points.`);
  }
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (const [x, y, z] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  
  const eps = resolution * 0.01;
  const gridCols = Math.max(1, Math.ceil((maxX - minX + eps) / resolution));
  const gridRows = Math.max(1, Math.ceil((maxY - minY + eps) / resolution));
  
  const grid: number[][] = Array(gridRows).fill(null).map(() => Array(gridCols).fill(0));
  
  // Spatial hashing for fast neighbor lookup (Inverse Distance Weighting)
  // Cell size for binning (e.g. 5x resolution)
  const binSize = resolution * 5;
  const maxBinX = Math.floor((maxX - minX) / binSize) + 1;
  const maxBinY = Math.floor((maxY - minY) / binSize) + 1;
  const numBins = maxBinX * maxBinY;

  // Pre-allocate a 1D array of bins for spatial indexing
  const bins: Array<Array<[number, number, number]>> = Array.from({ length: numBins }, () => []);

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const bx = Math.floor((p[0] - minX) / binSize);
    const by = Math.floor((p[1] - minY) / binSize);
    if (bx >= 0 && bx < maxBinX && by >= 0 && by < maxBinY) {
      const idx = by * maxBinX + bx;
      bins[idx]!.push(p);
    }
  }
  
  // IDW Interpolation
  const radius = resolution * 3;
  const radiusSq = radius * radius;
  
  for (let r = 0; r < gridRows; r++) {
    const cy = minY + r * resolution;
    const by = Math.floor((cy - minY) / binSize);
    
    for (let c = 0; c < gridCols; c++) {
      const cx = minX + c * resolution;
      const bx = Math.floor((cx - minX) / binSize);
      
      let sumWeight = 0;
      let sumZ = 0;
      let closestDistSq = Infinity;
      let closestZ = 0;
      
      // Check 3x3 neighboring bins
      for (let dy = -1; dy <= 1; dy++) {
        const ny = by + dy;
        if (ny < 0 || ny >= maxBinY) continue;
        const rowOffset = ny * maxBinX;

        for (let dx = -1; dx <= 1; dx++) {
          const nx = bx + dx;
          if (nx < 0 || nx >= maxBinX) continue;

          const idx = rowOffset + nx;
          const bin = bins[idx]!;
          const len = bin.length;
          
          for (let i = 0; i < len; i++) {
            const p = bin[i]!;
            const dxSq = p[0] - cx;
            const dySq = p[1] - cy;
            const dSq = dxSq * dxSq + dySq * dySq;
            
            if (dSq < closestDistSq) {
              closestDistSq = dSq;
              closestZ = p[2];
            }
            
            if (dSq < radiusSq) {
              // To avoid div by zero
              const w = 1.0 / (dSq + 0.001);
              sumWeight += w;
              sumZ += p[2] * w;
            }
          }
        }
      }
      
      if (sumWeight > 0) {
        grid[r]![c] = sumZ / sumWeight;
      } else if (closestDistSq !== Infinity) {
        // Fallback to nearest neighbor
        grid[r]![c] = closestZ;
      } else {
        grid[r]![c] = NaN; // Empty area, no points nearby
      }
    }
  }
  
  const terrainId = `dtm-${Math.floor(minX)}-${Math.floor(minY)}-${resolution}`;
  
  const metadata: DTMMetadata = {
    terrain_id: terrainId,
    bounds: { min_x: minX, min_y: minY, min_z: minZ, max_x: maxX, max_y: maxY, max_z: maxZ },
    resolution,
    grid_rows: gridRows,
    grid_cols: gridCols,
  };
  
  return { grid, metadata, warnings };
}
