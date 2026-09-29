/// <reference lib="webworker" />
import DxfParser from 'dxf-parser';
import type { DTMMetadata } from '../types/api';
import { gridNodeCountForSpan, MAX_TERRAIN_GRID_CELLS, validateTerrainGridDimensions, validateTerrainResolution } from '../utils/terrainLimits';

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

const MAX_STL_TRIANGLES = 500_000;
const STL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

type TerrainPoint = [number, number, number];

function parseSTL(buffer: ArrayBuffer): TerrainPoint[] {
  let asciiError: Error | undefined;

  try {
    const asciiPoints = parseAsciiSTL(buffer);
    if (asciiPoints !== null) return asciiPoints;
  } catch (err) {
    asciiError = err instanceof Error ? err : new Error(String(err));
  }

  try {
    return parseBinarySTL(buffer);
  } catch (binaryError) {
    if (asciiError) throw asciiError;
    throw binaryError;
  }
}

function parseAsciiSTL(buffer: ArrayBuffer): TerrainPoint[] | null {
  const prefix = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 256)));
  const firstNonEmptyPrefixLine = prefix.split(/\r\n|\n|\r/).find((line) => line.trim().length > 0);
  if (!firstNonEmptyPrefixLine || firstNonEmptyPrefixLine.trim().split(/\s+/, 1)[0]?.toLowerCase() !== 'solid') {
    return null;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('Invalid ASCII STL: file is not valid UTF-8 text');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const { triangleCount } = scanAsciiSTL(text, MAX_STL_TRIANGLES + 1);
  const step = triangleCount > MAX_STL_TRIANGLES
    ? Math.ceil(triangleCount / MAX_STL_TRIANGLES)
    : 1;
  return scanAsciiSTL(text, step).points;
}

function scanAsciiSTL(text: string, step: number): { triangleCount: number; points: TerrainPoint[] } {
  let cursor = 0;
  const readLine = (): string | null => {
    while (cursor < text.length) {
      const start = cursor;
      while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor++;
      const line = text.slice(start, cursor).trim();
      if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
      else if (cursor < text.length) cursor++;
      if (line) return line;
    }
    return null;
  };

  const invalid = (detail: string): Error => new Error(`Invalid ASCII STL: ${detail}`);
  const tokensOf = (line: string): string[] => line.split(/\s+/);
  const firstLine = readLine();
  if (!firstLine || tokensOf(firstLine)[0]?.toLowerCase() !== 'solid') {
    throw invalid("expected a 'solid' header");
  }

  const expectKeywordLine = (keyword: string, secondaryKeyword?: string): string[] => {
    const line = readLine();
    const tokens = line ? tokensOf(line) : [];
    const matches = tokens[0]?.toLowerCase() === keyword
      && (secondaryKeyword === undefined
        ? tokens.length === 1
        : tokens[1]?.toLowerCase() === secondaryKeyword && tokens.length === 2);
    if (!matches) throw invalid(`expected '${[keyword, secondaryKeyword].filter(Boolean).join(' ')}'`);
    return tokens;
  };
  const parseNumber = (token: string, context: string): number => {
    if (!STL_NUMBER_PATTERN.test(token)) throw invalid(`invalid ${context} value '${token}'`);
    const value = Number(token);
    if (!Number.isFinite(value)) throw invalid(`non-finite ${context} value '${token}'`);
    return value;
  };

  let triangleCount = 0;
  const points: TerrainPoint[] = [];
  let line = readLine();
  while (line !== null && tokensOf(line)[0]?.toLowerCase() !== 'endsolid') {
    const facetTokens = tokensOf(line);
    if (facetTokens.length !== 5
      || facetTokens[0]?.toLowerCase() !== 'facet'
      || facetTokens[1]?.toLowerCase() !== 'normal') {
      throw invalid("expected 'facet normal nx ny nz'");
    }
    parseNumber(facetTokens[2]!, 'normal');
    parseNumber(facetTokens[3]!, 'normal');
    parseNumber(facetTokens[4]!, 'normal');
    expectKeywordLine('outer', 'loop');

    const triangle: TerrainPoint[] = [];
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
      const vertexLine = readLine();
      const vertexTokens = vertexLine ? tokensOf(vertexLine) : [];
      if (vertexTokens.length !== 4 || vertexTokens[0]?.toLowerCase() !== 'vertex') {
        throw invalid('expected exactly three finite vertex coordinates');
      }
      triangle.push([
        parseNumber(vertexTokens[1]!, 'vertex'),
        parseNumber(vertexTokens[2]!, 'vertex'),
        parseNumber(vertexTokens[3]!, 'vertex'),
      ]);
    }
    expectKeywordLine('endloop');
    expectKeywordLine('endfacet');

    if (triangleCount % step === 0) points.push(...triangle);
    triangleCount++;
    line = readLine();
  }

  if (line === null) throw invalid("missing 'endsolid' footer");
  if (readLine() !== null) throw invalid('unexpected content after the solid footer');
  if (triangleCount === 0) throw invalid('no facets found');
  return { triangleCount, points };
}

function parseBinarySTL(buffer: ArrayBuffer): TerrainPoint[] {
  if (buffer.byteLength < 84) throw new Error('Invalid STL file size: binary header is truncated');

  const view = new DataView(buffer);
  const numTriangles = view.getUint32(80, true);
  const expectedLength = 84 + numTriangles * 50;
  if (expectedLength > buffer.byteLength) {
    throw new Error(`Truncated binary STL: expected ${expectedLength} bytes, received ${buffer.byteLength}`);
  }

  const points: TerrainPoint[] = [];
  const step = numTriangles > MAX_STL_TRIANGLES
    ? Math.ceil(numTriangles / MAX_STL_TRIANGLES)
    : 1;

  for (let triangleIndex = 0; triangleIndex < numTriangles; triangleIndex += step) {
    const offset = 84 + triangleIndex * 50;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
      const vertexOffset = offset + 12 + vertexIndex * 12;
      const x = view.getFloat32(vertexOffset, true);
      const y = view.getFloat32(vertexOffset + 4, true);
      const z = view.getFloat32(vertexOffset + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error('Invalid binary STL: vertex coordinates must be finite');
      }
      points.push([x, y, z]);
    }
  }

  return points;
}

type DxfCoordinate = { x?: unknown; y?: unknown; z?: unknown };
type DxfEntity = {
  type?: string;
  position?: DxfCoordinate;
  vertices?: DxfCoordinate[];
  elevation?: unknown;
};

function parseDXF(text: string): TerrainPoint[] {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  const points: TerrainPoint[] = [];

  if (!dxf || !dxf.entities) return points;

  const appendCoordinate = (
    coordinate: DxfCoordinate | undefined,
    entityElevation: unknown,
    context: string,
  ): void => {
    if (!coordinate) {
      throw new Error(`Invalid DXF: ${context} coordinates are missing`);
    }

    const z = coordinate.z === undefined ? entityElevation : coordinate.z;
    if (!Number.isFinite(coordinate.x) || !Number.isFinite(coordinate.y) || !Number.isFinite(z)) {
      throw new Error(`Invalid DXF: ${context} coordinates and Z elevation must be finite`);
    }

    points.push([coordinate.x as number, coordinate.y as number, z as number]);
  };

  for (const entity of dxf.entities) {
    const ent = entity as unknown as DxfEntity;
    switch (ent.type) {
      case 'POINT':
        appendCoordinate(ent.position, undefined, 'POINT');
        break;
      case '3DFACE':
      case 'LINE':
      case 'POLYLINE':
      case 'LWPOLYLINE':
        for (const vertex of ent.vertices ?? []) {
          const elevation = ent.type === 'POLYLINE' || ent.type === 'LWPOLYLINE'
            ? ent.elevation
            : undefined;
          appendCoordinate(vertex, elevation, `${ent.type} vertex`);
        }
        break;
    }
  }

  return points;
}

function generateDTM(points: Array<[number, number, number]>, resolution: number): TerrainWorkerOutput {
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
  
  const terrainId = `dtm-${Math.floor(minX)}-${Math.floor(minY)}-${resolution}`;
  
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
