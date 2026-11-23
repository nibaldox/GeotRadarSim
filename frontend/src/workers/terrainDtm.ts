import type { DTMMetadata } from '../types/api';
import { gridNodeCountForSpan, MAX_TERRAIN_GRID_CELLS, validateTerrainGridDimensions, validateTerrainResolution } from '../utils/terrainLimits';

/**
 * Point-cloud rasterizer of the STL/DXF importer (IDW within 3 × resolution, nearest point in the
 * 3 × 3 neighbouring bins as fallback, NaN when no point is near). The terrain Worker calls it for
 * every import; the sample-terrain build script and the sample resampler call the same function,
 * so the bundled example is exactly what an import of its source STL produces.
 */

export interface DTMResult {
  grid: number[][];
  metadata: DTMMetadata;
  warnings: string[];
}

/** Source envelope used instead of the points' own min/max (see {@link generateDTM}). */
export interface TerrainPointExtent {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export function generateDTM(
  points: Array<[number, number, number]>,
  resolution: number,
  extent?: TerrainPointExtent,
  terrainIdPrefix = "dtm",
): DTMResult {
  const warnings: string[] = [];

  validateTerrainResolution(resolution, "Terrain");

  if (points.length < 100) {
    warnings.push(`Sparse point cloud: ${points.length} points.`);
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const [x, y, z] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('Terrain contains non-finite coordinates');
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (extent) {
    // Resampling a stored grid: keep the original source envelope so node counts and bounds match
    // an import of the source file at this resolution. Every point must lie inside it.
    if (minX < extent.minX || maxX > extent.maxX || minY < extent.minY || maxY > extent.maxY) {
      throw new RangeError('Terrain points fall outside the given extent');
    }
    ({ minX, maxX, minY, maxY, minZ, maxZ } = extent);
  }

  const gridCols = gridNodeCountForSpan(maxX - minX, resolution, "Terrain width");
  const gridRows = gridNodeCountForSpan(maxY - minY, resolution, "Terrain height");
  validateTerrainGridDimensions(gridRows, gridCols, "Terrain");

  // Spatial hashing for fast neighbor lookup (Inverse Distance Weighting)
  // Cell size for binning (e.g. 5x resolution)
  const binSize = resolution * 5;
  if (!Number.isFinite(binSize) || binSize <= 0) {
    throw new Error('Resolution is out of range for spatial indexing');
  }
  const maxBinX = Math.floor((maxX - minX) / binSize) + 1;
  const maxBinY = Math.floor((maxY - minY) / binSize) + 1;
  const numBins = maxBinX * maxBinY;
  if (!Number.isSafeInteger(maxBinX) || !Number.isSafeInteger(maxBinY)
    || !Number.isSafeInteger(numBins) || numBins > MAX_TERRAIN_GRID_CELLS) {
    throw new Error('Terrain bounds produce an invalid spatial index size');
  }

  const grid: number[][] = Array(gridRows).fill(null).map(() => Array(gridCols).fill(0));

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

  // Grid values are node samples: first location is (minX, minY), then index * resolution.
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

  const terrainId = `${terrainIdPrefix}-${Math.floor(minX)}-${Math.floor(minY)}-${resolution}`;

  const metadata: DTMMetadata = {
    terrain_id: terrainId,
    bounds: {
      min_x: minX,
      min_y: minY,
      min_z: minZ,
      // Keep bounds on the same sampled lattice as min + index * resolution; decimal endpoints can round by 1 ULP.
      max_x: minX + (gridCols - 1) * resolution,
      max_y: minY + (gridRows - 1) * resolution,
      max_z: maxZ,
    },
    resolution,
    grid_rows: gridRows,
    grid_cols: gridCols,
  };

  return { grid, metadata, warnings };
}
