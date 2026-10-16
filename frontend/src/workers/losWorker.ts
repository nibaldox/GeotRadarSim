/// <reference lib="webworker" />

import { LOSCellState } from "../types/api";
import type { LOSResponse, RadarConfig } from "../types/api";
import { validateTerrainGridDimensions, validateTerrainResolution, validateTerrainTotalArea } from "../utils/terrainLimits";

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

export interface LOSWorkerOutput extends LOSResponse {
  error?: string;
}

self.onmessage = (e: MessageEvent<LOSWorkerInput>) => {
  try {
    const result = computeLOS(e.data);
    self.postMessage(result, [result.flat_quality_grid!.buffer]);
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};

// LOS is intentionally bounded before result buffers are allocated: no axis may exceed 16,384
// nodes and the output may contain at most 1,000,000 cells. This also rejects pathological
// skinny grids even when their total cell count alone would fit the memory cap.
//
// Traversal cost is not pre-estimated: an interval estimate only saw the grid geometry and
// rejected cheap filtered scenes it could not inspect. Instead every compute runs under a
// monotonic runtime deadline, checked periodically inside the real triangle traversal and the
// outer target/zone loops, so any input is bounded in wall-clock time.
export const LOS_RUNTIME_DEADLINE_MS = 120_000;
const LOS_RUNTIME_CHECK_INTERVAL = 1_024;

/** Per-compute monotonic deadline; one instance per computeLOS call, never shared across requests. */
interface LOSRuntimeDeadline {
  check: () => void;
}

function createLOSRuntimeDeadline(): LOSRuntimeDeadline {
  const startedAt = performance.now();
  return {
    check: (): void => {
      if (performance.now() - startedAt > LOS_RUNTIME_DEADLINE_MS) {
        throw new RangeError(
          `El cálculo de visibilidad LOS excedió el tiempo máximo de ejecución ` +
            `(${Math.round(LOS_RUNTIME_DEADLINE_MS / 1000)} segundos). ` +
            "Reduzca el área del terreno, aumente la resolución o disminuya el alcance del radar " +
            "y vuelva a intentarlo.",
        );
      }
    },
  };
}

type RayTraceState = typeof LOSCellState.VISIBLE | typeof LOSCellState.SHADOW | typeof LOSCellState.UNKNOWN_RAY;

interface SegmentParameterRange {
  start: number;
  end: number;
}

type TriangleVisitor = (
  row: number,
  col: number,
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
  secondTriangle: boolean,
) => void;

function snapGridCoordinate(coordinate: number): number {
  const nearestInteger = Math.round(coordinate);
  const roundingTolerance = Number.EPSILON * Math.max(1, Math.abs(nearestInteger));
  return Math.abs(coordinate - nearestInteger) <= roundingTolerance ? nearestInteger : coordinate;
}

/** Visit renderable triangles incident to a point, including exact shared mesh edges. */
function forEachIncidentTriangle(
  grid: number[][],
  rows: number,
  cols: number,
  x: number,
  y: number,
  visit: TriangleVisitor,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > cols - 1 || y < 0 || y > rows - 1) {
    return false;
  }
  const nearestCol = Math.round(x);
  const colOnGridLine = x === nearestCol;
  const firstCol = Math.max(0, colOnGridLine ? nearestCol - 1 : Math.floor(x));
  const lastCol = Math.min(cols - 2, colOnGridLine ? nearestCol : firstCol);
  const nearestRow = Math.round(y);
  const rowOnGridLine = y === nearestRow;
  const firstRow = Math.max(0, rowOnGridLine ? nearestRow - 1 : Math.floor(y));
  const lastRow = Math.min(rows - 2, rowOnGridLine ? nearestRow : firstRow);
  if (firstCol > lastCol || firstRow > lastRow) return false;

  let found = false;
  for (let row = firstRow; row <= lastRow; row++) {
    const localY = y - row;
    for (let col = firstCol; col <= lastCol; col++) {
      const localX = x - col;
      if (localX < 0 || localX > 1 || localY < 0 || localY > 1) continue;

      const topLeft = grid[row]![col]!;
      const topRight = grid[row]![col + 1]!;
      const bottomLeft = grid[row + 1]![col]!;
      const bottomRight = grid[row + 1]![col + 1]!;
      // TerrainViewer omits the whole quad unless all four vertices are renderable.
      if (!Number.isFinite(topLeft) || !Number.isFinite(topRight) ||
          !Number.isFinite(bottomLeft) || !Number.isFinite(bottomRight)) continue;

      const diagonalCoordinate = snapGridCoordinate(localX + localY);
      // Snap only machine-rounding-sized offsets; points farther off the diagonal stay on one side.
      if (diagonalCoordinate <= 1) {
        found = true;
        visit(row, col, topLeft, topRight, bottomLeft, bottomRight, false);
      }
      if (diagonalCoordinate >= 1) {
        found = true;
        visit(row, col, topLeft, topRight, bottomLeft, bottomRight, true);
      }
    }
  }
  return found;
}

function heightOnTriangle(
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
  localX: number,
  localY: number,
  secondTriangle: boolean,
): number {
  if (secondTriangle) {
    const weight0 = 1 - localY;
    const weight1 = localX + localY - 1;
    const weight2 = 1 - localX;
    if (localX >= 0 && localX <= 1 && localY >= 0 && localY <= 1 &&
        weight0 >= 0 && weight1 >= 0 && weight2 >= 0) {
      return topRight * weight0 + bottomRight * weight1 + bottomLeft * weight2;
    }
  } else {
    const weight0 = 1 - localX - localY;
    if (localX >= 0 && localX <= 1 && localY >= 0 && localY <= 1 && weight0 >= 0) {
      return topLeft * weight0 + topRight * localX + bottomLeft * localY;
    }
  }

  // Roundoff can put an intersection endpoint a few ulps beyond its selected triangle.
  // Project its barycentric weights into the simplex so interpolation never extrapolates.
  const x = Math.max(0, Math.min(1, localX));
  const y = Math.max(0, Math.min(1, localY));
  let weight0: number;
  let weight1: number;
  let weight2: number;
  if (secondTriangle) {
    weight0 = Math.max(0, 1 - y);
    weight1 = Math.max(0, x + y - 1);
    weight2 = Math.max(0, 1 - x);
  } else {
    weight0 = Math.max(0, 1 - x - y);
    weight1 = x;
    weight2 = y;
  }
  const totalWeight = weight0 + weight1 + weight2;
  if (totalWeight === 0) return Number.NaN;
  return secondTriangle
    ? (topRight * weight0 + bottomRight * weight1 + bottomLeft * weight2) / totalWeight
    : (topLeft * weight0 + topRight * weight1 + bottomLeft * weight2) / totalWeight;
}

function clipSegmentToGrid(
  startX: number,
  startY: number,
  deltaX: number,
  deltaY: number,
  cols: number,
  rows: number,
): SegmentParameterRange | null {
  const range: SegmentParameterRange = { start: 0, end: 1 };
  const clipAxis = (origin: number, delta: number, maximum: number): boolean => {
    if (delta === 0) return origin >= 0 && origin <= maximum;
    const first = -origin / delta;
    const second = (maximum - origin) / delta;
    range.start = Math.max(range.start, Math.min(first, second));
    range.end = Math.min(range.end, Math.max(first, second));
    return range.start <= range.end;
  };

  if (!clipAxis(startX, deltaX, cols - 1) || !clipAxis(startY, deltaY, rows - 1)) return null;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return null;
  return range;
}

/** Return the next strict crossing of the integer-line family without storing events. */
function nextCrossingParameter(startCoordinate: number, delta: number, afterParameter: number): number {
  if (delta === 0) return Infinity;
  const coordinate = startCoordinate + afterParameter * delta;
  if (!Number.isFinite(coordinate)) {
    throw new RangeError("LOS ray traversal left finite grid coordinates");
  }

  let line = delta > 0 ? Math.floor(coordinate) + 1 : Math.ceil(coordinate) - 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const parameter = (line - startCoordinate) / delta;
    if (parameter > afterParameter) return parameter;
    line += delta > 0 ? 1 : -1;
  }
  throw new RangeError("LOS ray traversal cannot advance at floating-point precision");
}

function traceVerticalRayAtPoint(
  grid: number[][],
  rows: number,
  cols: number,
  x: number,
  y: number,
  startParameter: number,
  endParameter: number,
  startZ: number,
  deltaZ: number,
): RayTraceState {
  x = snapGridCoordinate(x);
  y = snapGridCoordinate(y);
  let shadowed = false;
  const hasSurface = forEachIncidentTriangle(grid, rows, cols, x, y,
    (row, col, topLeft, topRight, bottomLeft, bottomRight, secondTriangle) => {
      const height = heightOnTriangle(
        topLeft, topRight, bottomLeft, bottomRight, x - col, y - row, secondTriangle,
      );
      const rayAtStart = startZ + startParameter * deltaZ;
      const rayAtEnd = startZ + endParameter * deltaZ;
      if (Number.isFinite(height) && (height > rayAtStart || height > rayAtEnd)) shadowed = true;
    });
  if (shadowed) return LOSCellState.SHADOW;
  return hasSurface ? LOSCellState.VISIBLE : LOSCellState.UNKNOWN_RAY;
}

/**
 * Compare the ray against every triangle it crosses. The integer grid lines and TerrainViewer's
 * x + y = integer diagonals form a monotone event stream, so only the next crossing is retained.
 */
function traceTerrainRay(
  grid: number[][],
  minX: number,
  minY: number,
  resolution: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  deadline: LOSRuntimeDeadline,
): RayTraceState {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows < 2 || cols < 2) return LOSCellState.UNKNOWN_RAY;

  const gridStartX = snapGridCoordinate((startX - minX) / resolution);
  const gridStartY = snapGridCoordinate((startY - minY) / resolution);
  const gridEndX = snapGridCoordinate((endX - minX) / resolution);
  const gridEndY = snapGridCoordinate((endY - minY) / resolution);
  const gridStartDiagonal = snapGridCoordinate(gridStartX + gridStartY);
  const gridEndDiagonal = snapGridCoordinate(gridEndX + gridEndY);
  const deltaX = gridEndX - gridStartX;
  const deltaY = gridEndY - gridStartY;
  const deltaDiagonal = gridEndDiagonal - gridStartDiagonal;
  const deltaZ = endZ - startZ;
  if (![gridStartX, gridStartY, gridEndX, gridEndY, deltaX, deltaY, deltaDiagonal, deltaZ].every(Number.isFinite)) {
    return LOSCellState.UNKNOWN_RAY;
  }

  const clip = clipSegmentToGrid(gridStartX, gridStartY, deltaX, deltaY, cols, rows);
  if (!clip) return LOSCellState.UNKNOWN_RAY;
  if (deltaX === 0 && deltaY === 0) {
    return traceVerticalRayAtPoint(
      grid, rows, cols, gridStartX, gridStartY, clip.start, clip.end, startZ, deltaZ,
    );
  }
  if (clip.start === clip.end) {
    const x = gridStartX + clip.start * deltaX;
    const y = gridStartY + clip.start * deltaY;
    return traceVerticalRayAtPoint(grid, rows, cols, x, y, clip.start, clip.end, startZ, deltaZ);
  }

  let rayUnknown = false;
  let intervalStart = clip.start;
  let intervalIndex = 0;
  while (intervalStart < clip.end) {
    // Clock is read only once per LOS_RUNTIME_CHECK_INTERVAL intervals, never per interval.
    if ((++intervalIndex & (LOS_RUNTIME_CHECK_INTERVAL - 1)) === 0) deadline.check();
    const intervalEnd = Math.min(
      clip.end,
      nextCrossingParameter(gridStartX, deltaX, intervalStart),
      nextCrossingParameter(gridStartY, deltaY, intervalStart),
      nextCrossingParameter(gridStartDiagonal, deltaDiagonal, intervalStart),
    );
    if (!(intervalEnd > intervalStart)) {
      throw new RangeError("LOS ray traversal did not advance to the next grid intersection");
    }

    const midpoint = intervalStart + (intervalEnd - intervalStart) / 2;
    const midpointX = gridStartX + midpoint * deltaX;
    const midpointY = gridStartY + midpoint * deltaY;
    let intervalShadowed = false;
    const intervalHasSurface = forEachIncidentTriangle(
      grid, rows, cols, midpointX, midpointY,
      (row, col, topLeft, topRight, bottomLeft, bottomRight, secondTriangle) => {
        const startLocalX = gridStartX + intervalStart * deltaX - col;
        const startLocalY = gridStartY + intervalStart * deltaY - row;
        const endLocalX = gridStartX + intervalEnd * deltaX - col;
        const endLocalY = gridStartY + intervalEnd * deltaY - row;
        const terrainAtStart = heightOnTriangle(
          topLeft, topRight, bottomLeft, bottomRight, startLocalX, startLocalY, secondTriangle,
        );
        const terrainAtEnd = heightOnTriangle(
          topLeft, topRight, bottomLeft, bottomRight, endLocalX, endLocalY, secondTriangle,
        );
        const rayAtStart = startZ + intervalStart * deltaZ;
        const rayAtEnd = startZ + intervalEnd * deltaZ;
        if (terrainAtStart > rayAtStart || terrainAtEnd > rayAtEnd) intervalShadowed = true;
      },
    );
    if (intervalShadowed) return LOSCellState.SHADOW;
    if (!intervalHasSurface) rayUnknown = true;
    intervalStart = intervalEnd;
  }

  return rayUnknown ? LOSCellState.UNKNOWN_RAY : LOSCellState.VISIBLE;
}

export function sampleTerrainAtCoordinates(
  grid: number[][],
  bounds: Pick<LOSWorkerInput["bounds"], "min_x" | "min_y">,
  resolution: number,
  x: number,
  y: number,
): number | null {
  if (!Array.isArray(grid) || grid.length < 2 || !Array.isArray(grid[0]) || grid[0].length < 2 ||
      grid.some((row) => !Array.isArray(row) || row.length !== grid[0]!.length) ||
      !Number.isFinite(resolution) || resolution <= 0 ||
      !Number.isFinite(bounds.min_x) || !Number.isFinite(bounds.min_y) ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const rows = grid.length;
  const cols = grid[0]!.length;
  const gridX = snapGridCoordinate((x - bounds.min_x) / resolution);
  const gridY = snapGridCoordinate((y - bounds.min_y) / resolution);
  if (gridX < 0 || gridY < 0 || gridX > cols - 1 || gridY > rows - 1) return null;

  let height: number | null = null;
  forEachIncidentTriangle(grid, rows, cols, gridX, gridY,
    (row, col, topLeft, topRight, bottomLeft, bottomRight, secondTriangle) => {
      if (height !== null) return;
      const sample = heightOnTriangle(
        topLeft, topRight, bottomLeft, bottomRight, gridX - col, gridY - row, secondTriangle,
      );
      if (Number.isFinite(sample)) height = sample;
    });
  return height;
}

function terrainGradient(
  before: number | undefined,
  after: number | undefined,
  center: number,
  resolution: number,
): number {
  const hasBefore = before !== undefined && Number.isFinite(before);
  const hasAfter = after !== undefined && Number.isFinite(after);
  if (hasBefore && hasAfter) return (after - before) / (2 * resolution);
  if (hasAfter) return (after - center) / resolution;
  if (hasBefore) return (center - before) / resolution;
  return 0;
}

function computeLOS(input: LOSWorkerInput): LOSWorkerOutput {
  const { grid, bounds, resolution, radar_position: [rx, ry, rz], radar_config } = input;
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0) {
    throw new Error("LOS grid must be non-empty and rectangular");
  }
  const rows = grid.length;
  const cols = grid[0].length;
  const cellCount = validateTerrainGridDimensions(rows, cols, "LOS");
  if (grid.some((row) => !Array.isArray(row) || row.length !== cols)) {
    throw new Error("LOS grid must be rectangular");
  }
  const cellArea = validateTerrainResolution(resolution, "LOS");
  validateTerrainTotalArea(cellArea, cellCount, "LOS");
  if (![bounds.min_x, bounds.min_y, rx, ry, rz].every(Number.isFinite)) {
    throw new RangeError("LOS bounds and radar position must be finite");
  }

  const minRange = radar_config.min_range_m ?? 0;
  const maxRange = radar_config.max_range_m;
  if (!Number.isFinite(minRange) || !Number.isFinite(maxRange) || minRange < 0 || minRange > maxRange) {
    throw new RangeError("LOS range limits must be finite, non-negative, and ordered");
  }
  const minElevation = radar_config.elevation_min_deg;
  const maxElevation = radar_config.elevation_max_deg;
  if (!Number.isFinite(minElevation) || !Number.isFinite(maxElevation) ||
      minElevation < -90 || maxElevation > 90 || minElevation > maxElevation) {
    throw new RangeError("LOS elevation limits must be finite, within [-90, 90], and ordered");
  }

  // Every compute owns a fresh monotonic deadline. Start timing before allocating the
  // memory-bounded result buffers; feasibility is checked during execution, not estimated.
  const deadline = createLOSRuntimeDeadline();

  const cell_states = new Uint8Array(cellCount);
  const shadow_grid: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const quality_grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  const flat_quality_grid = new Float32Array(rows * cols);
  flat_quality_grid.fill(-1);
  const coverage_polygon: Array<[number, number]> = [];

  let visibleCount = 0;
  let shadowCount = 0;
  let unknownRayCount = 0;

  const isInsideAzimuth = (dx: number, dy: number): boolean => {
    const range = radar_config.azimuth_range_deg;
    if (radar_config.scan_pattern === "SAR360" || !range) return true;
    const [start, end] = range;
    const azimuth = Math.atan2(dx, dy) * (180 / Math.PI);
    return start <= end
      ? azimuth >= start && azimuth <= end
      : azimuth >= start || azimuth <= end;
  };

  // LOS targets use the same node coordinates as terrainWorker and TerrainViewer (no half-cell offset).
  for (let r = 0; r < rows; r++) {
    deadline.check();
    const cy = bounds.min_y + r * resolution;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const targetZ = grid[r]![c]!;
      if (!Number.isFinite(targetZ)) {
        cell_states[idx] = LOSCellState.NODATA;
        continue;
      }

      const cx = bounds.min_x + c * resolution;
      const dx = cx - rx;
      const dy = cy - ry;
      const distance = Math.hypot(dx, dy);
      if (distance < minRange || distance > maxRange || !Number.isFinite(distance)) {
        cell_states[idx] = LOSCellState.OUT_OF_RANGE;
        continue;
      }

      const elevation = Math.atan2(targetZ - rz, distance) * (180 / Math.PI);
      if (elevation < minElevation || elevation > maxElevation || !Number.isFinite(elevation)) {
        cell_states[idx] = LOSCellState.OUTSIDE_FOV;
        continue;
      }
      if (!isInsideAzimuth(dx, dy)) {
        cell_states[idx] = LOSCellState.OUTSIDE_FOV;
        continue;
      }

      const rayState = traceTerrainRay(
        grid, bounds.min_x, bounds.min_y, resolution, rx, ry, rz, cx, cy, targetZ, deadline,
      );
      if (rayState === LOSCellState.SHADOW) {
        cell_states[idx] = LOSCellState.SHADOW;
        shadow_grid[r]![c] = true;
        shadowCount++;
        continue;
      }
      if (rayState === LOSCellState.UNKNOWN_RAY) {
        cell_states[idx] = LOSCellState.UNKNOWN_RAY;
        unknownRayCount++;
        continue;
      }

      cell_states[idx] = LOSCellState.VISIBLE;
      visibleCount++;
      if (coverage_polygon.length < 100) coverage_polygon.push([cx, cy]);

      const left = c > 0 ? grid[r]![c - 1]! : undefined;
      const right = c + 1 < cols ? grid[r]![c + 1]! : undefined;
      const down = r > 0 ? grid[r - 1]![c]! : undefined;
      const up = r + 1 < rows ? grid[r + 1]![c]! : undefined;
      const gradX = terrainGradient(left, right, targetZ, resolution);
      const gradY = terrainGradient(down, up, targetZ, resolution);
      const normalLength = Math.hypot(gradX, gradY, 1);
      const nx = -gradX / normalLength;
      const ny = -gradY / normalLength;
      const nz = 1 / normalLength;
      const distance3d = Math.hypot(dx, dy, targetZ - rz) || 0.1;
      const dotProduct = Math.max(0, Math.min(1, -((dx / distance3d) * nx + (dy / distance3d) * ny + ((targetZ - rz) / distance3d) * nz)));
      const distanceFactor = Number.isFinite(maxRange) && maxRange > 0
        ? Math.sqrt(Math.max(0, 1 - distance / maxRange))
        : 1;
      const quality = Number.isFinite(dotProduct * distanceFactor) ? dotProduct * distanceFactor : 0;
      quality_grid[r]![c] = quality;
      flat_quality_grid[idx] = quality;
    }
  }

  const shadow_zones: Array<{ zone_id: number; cell_count: number }> = [];
  const visited = new Uint8Array(rows * cols);
  let zoneId = 0;
  for (let r = 0; r < rows; r++) {
    deadline.check();
    for (let c = 0; c < cols; c++) {
      const startIndex = r * cols + c;
      if (cell_states[startIndex] !== LOSCellState.SHADOW || visited[startIndex]) continue;
      zoneId++;
      let cellCount = 0;
      const queue: number[] = [startIndex];
      visited[startIndex] = 1;
      for (let head = 0; head < queue.length; head++) {
        if ((head & (LOS_RUNTIME_CHECK_INTERVAL - 1)) === LOS_RUNTIME_CHECK_INTERVAL - 1) {
          deadline.check();
        }
        const index = queue[head]!;
        const row = Math.floor(index / cols);
        const col = index % cols;
        cellCount++;
        const neighbors: Array<[number, number]> = [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
        for (const [nextRow, nextCol] of neighbors) {
          if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols) continue;
          const nextIndex = nextRow * cols + nextCol;
          if (!visited[nextIndex] && cell_states[nextIndex] === LOSCellState.SHADOW) {
            visited[nextIndex] = 1;
            queue.push(nextIndex);
          }
        }
      }
      shadow_zones.push({ zone_id: zoneId, cell_count: cellCount });
    }
  }

  const candidateCount = visibleCount + shadowCount + unknownRayCount;
  const coverage_pct = candidateCount > 0 ? Number(((visibleCount / candidateCount) * 100).toFixed(2)) : null;
  const completeness_pct = candidateCount > 0
    ? Number((((visibleCount + shadowCount) / candidateCount) * 100).toFixed(2))
    : null;

  return {
    shadow_grid,
    cell_states,
    grid_rows: rows,
    grid_cols: cols,
    resolution,
    quality_grid,
    flat_quality_grid,
    coverage_pct,
    completeness_pct,
    visible_area_m2: visibleCount * cellArea,
    shadow_zones,
    coverage_polygon: coverage_polygon.slice(0, 100),
  };
}
