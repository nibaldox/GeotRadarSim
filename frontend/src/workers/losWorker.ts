/// <reference lib="webworker" />

import { LOSCellState } from "../types/api";
import type { LOSResponse, RadarConfig } from "../types/api";
import { resolveWorkerComputeEngine, type ComputeEngine } from "../services/computeEngine";
import { flattenGridForWasm, loadRadarWasm } from "../wasm/loader";
import { terrainGradientAt } from "../utils/sensitivity";
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
  /** Compute engine; missing means "ts". Any other value is rejected. */
  engine?: ComputeEngine;
}

export interface LOSWorkerOutput extends LOSResponse {
  error?: string;
}

function postLOSResult(result: LOSWorkerOutput): void {
  // Same Transferables for both engines, so an A/B measures only the engine.
  self.postMessage(result, [result.flat_quality_grid!.buffer, result.flat_projection_grid!.buffer]);
}

function postLOSError(err: unknown, engine?: ComputeEngine): void {
  const message = err instanceof Error ? err.message : String(err);
  self.postMessage(engine === undefined ? { error: message } : { error: message, engine_used: engine });
}

/**
 * The "ts" engine posts synchronously, exactly as before. The "wasm" engine returns the
 * promise of its asynchronous run (WASM initialisation is asynchronous), which resolves once
 * the result or the error has been posted.
 */
self.onmessage = (e: MessageEvent<LOSWorkerInput>): void | Promise<void> => {
  let engine: ComputeEngine;
  try {
    engine = resolveWorkerComputeEngine((e.data as { engine?: unknown } | null | undefined)?.engine, "LOS");
  } catch (err) {
    postLOSError(err);
    return;
  }
  if (engine === "wasm") {
    // Like the "ts" try/catch, a failure while posting the result is also reported as an error.
    return computeLOSWithWasm(e.data).then(postLOSResult).catch((err: unknown) => postLOSError(err, "wasm"));
  }
  try {
    postLOSResult(computeLOS(e.data));
  } catch (err) {
    postLOSError(err, "ts");
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

interface ValidatedLOSInput {
  grid: number[][];
  bounds: LOSWorkerInput["bounds"];
  resolution: number;
  rx: number;
  ry: number;
  rz: number;
  radar_config: RadarConfig;
  rows: number;
  cols: number;
  cellCount: number;
  cellArea: number;
  minRange: number;
  maxRange: number;
  minElevation: number;
  maxElevation: number;
}

/** Every guard of computeLOS, in its original order; shared by both engines. */
function validateLOSInput(input: LOSWorkerInput): ValidatedLOSInput {
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
  return {
    grid, bounds, resolution, rx, ry, rz, radar_config, rows, cols, cellCount, cellArea,
    minRange, maxRange, minElevation, maxElevation,
  };
}

/** Coverage and completeness percentages from the candidate counts (shared by both engines). */
function coveragePercentages(
  visibleCount: number,
  shadowCount: number,
  unknownRayCount: number,
): { coverage_pct: number | null; completeness_pct: number | null } {
  const candidateCount = visibleCount + shadowCount + unknownRayCount;
  const coverage_pct = candidateCount > 0 ? Number(((visibleCount / candidateCount) * 100).toFixed(2)) : null;
  const completeness_pct = candidateCount > 0
    ? Number((((visibleCount + shadowCount) / candidateCount) * 100).toFixed(2))
    : null;
  return { coverage_pct, completeness_pct };
}

function computeLOS(input: LOSWorkerInput): LOSWorkerOutput {
  const {
    grid, bounds, resolution, rx, ry, rz, radar_config, rows, cols, cellCount, cellArea,
    minRange, maxRange, minElevation, maxElevation,
  } = validateLOSInput(input);

  // Every compute owns a fresh monotonic deadline. Start timing before allocating the
  // memory-bounded result buffers; feasibility is checked during execution, not estimated.
  const deadline = createLOSRuntimeDeadline();

  const cell_states = new Uint8Array(cellCount);
  const shadow_grid: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const quality_grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  const flat_quality_grid = new Float32Array(rows * cols);
  flat_quality_grid.fill(-1);
  const flat_projection_grid = new Float32Array(rows * cols);
  flat_projection_grid.fill(Number.NaN);
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

      // Geometric quality v2: angular incidence and slope-motion projection.
      // The incidence score is clamp(dot(surface normal, terrain→radar), 0, 1);
      // distance is NOT a multiplier — maximum range only gates LOS eligibility.
      const gradient = terrainGradientAt(grid, r, c, resolution);
      if (gradient === null) {
        // Strict no-data: a missing gradient axis yields no index, never a measured zero.
        quality_grid[r]![c] = Number.NaN;
        flat_quality_grid[idx] = Number.NaN;
        continue;
      }
      const normalLength = Math.hypot(gradient.gradX, gradient.gradY, 1);
      const nx = -gradient.gradX / normalLength;
      const ny = -gradient.gradY / normalLength;
      const nz = 1 / normalLength;
      const dz = targetZ - rz;
      const distance3d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
      const ux = dx / distance3d;
      const uy = dy / distance3d;
      const uz = dz / distance3d;
      const incidence = Math.max(0, Math.min(1, -(ux * nx + uy * ny + uz * nz)));
      quality_grid[r]![c] = incidence;
      flat_quality_grid[idx] = incidence;

      // Slope-motion projection: |dot| of the unit LOS against the normalized
      // downhill tangent, with the downward-vertical fallback on flat terrain.
      // The exact vectorWorker convention keeps merged RMS values consistent.
      let tx = -gradient.gradX;
      let ty = -gradient.gradY;
      let tz = -(gradient.gradX * gradient.gradX + gradient.gradY * gradient.gradY);
      const tangentNorm = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tangentNorm > 1e-4) {
        tx /= tangentNorm;
        ty /= tangentNorm;
        tz /= tangentNorm;
      } else {
        tx = 0;
        ty = 0;
        tz = -1;
      }
      flat_projection_grid[idx] = Math.abs(ux * tx + uy * ty + uz * tz);
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

  const { coverage_pct, completeness_pct } = coveragePercentages(visibleCount, shadowCount, unknownRayCount);

  return {
    shadow_grid,
    cell_states,
    grid_rows: rows,
    grid_cols: cols,
    resolution,
    quality_grid,
    flat_quality_grid,
    quality_model: "geometric-v2",
    flat_projection_grid,
    coverage_pct,
    completeness_pct,
    visible_area_m2: visibleCount * cellArea,
    shadow_zones,
    coverage_polygon: coverage_polygon.slice(0, 100),
    engine_used: "ts",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// "wasm" engine: the Rust core (rust/radar-core, binding rust/radar-wasm).
// ─────────────────────────────────────────────────────────────────────────────

/** Shape returned by `compute_los_analysis` in rust/radar-wasm/src/lib.rs. */
interface WasmLOSAnalysis {
  cell_states: Uint8Array;
  quality: Float32Array;
  projection: Float32Array;
  incidence: Float64Array;
  visible_count: number;
  shadow_count: number;
  unknown_ray_count: number;
  coverage_points: Float64Array;
  shadow_zone_cell_counts: Uint32Array;
}

/**
 * A WASM initialisation failure is reported as an error of this job. It deliberately does
 * NOT fall back to the TypeScript engine: a silent fallback would mix both engines in an A/B
 * and hide a broken deployment. End-user protection is decided when the default changes.
 */
async function loadLOSWasm(): Promise<Awaited<ReturnType<typeof loadRadarWasm>>> {
  try {
    return await loadRadarWasm();
  } catch (err) {
    throw new Error(`LOS WASM engine failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isNumberOrMissing(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

/**
 * computeLOS through the Rust core. The validation is the same TS code as the "ts" engine
 * (same messages and order); Rust revalidates everything at its boundary. The single 120 s
 * deadline window lives in Rust and covers the per-cell phase and the shadow-zone BFS with the
 * same clock reads as createLOSRuntimeDeadline(). Only the O(1) percentage formatting and the
 * nested boolean[][]/number[][] views are built here, from the Rust buffers.
 */
async function computeLOSWithWasm(input: LOSWorkerInput): Promise<LOSWorkerOutput> {
  const {
    grid, bounds, resolution, rx, ry, rz, radar_config, rows, cols, cellArea,
    minRange, maxRange, minElevation, maxElevation,
  } = validateLOSInput(input);

  // azimuth_limited = scan_pattern !== "SAR360" && !!azimuth_range_deg (isInsideAzimuth).
  const range = radar_config.azimuth_range_deg;
  const azimuthLimited = radar_config.scan_pattern !== "SAR360" && !!range;
  let azimuthStart = Number.NaN;
  let azimuthEnd = Number.NaN;
  if (azimuthLimited) {
    // The TS destructures `[start, end]` and compares with JS coercion (string pairs compare
    // lexicographically); the f64 boundary cannot reproduce that, so non-numeric ranges are
    // rejected instead of silently diverging. Missing entries behave as NaN in both engines.
    if (!Array.isArray(range) || !isNumberOrMissing(range[0]) || !isNumberOrMissing(range[1])) {
      throw new RangeError("LOS azimuth range must be null or a [start, end] pair of numbers for the WASM engine");
    }
    azimuthStart = range[0] ?? Number.NaN;
    azimuthEnd = range[1] ?? Number.NaN;
  }

  const wasm = await loadLOSWasm();
  const values = flattenGridForWasm(grid);
  const out = wasm.compute_los_analysis(
    values, rows, cols, bounds.min_x, bounds.min_y, resolution, rx, ry, rz,
    minRange, maxRange, minElevation, maxElevation,
    azimuthLimited, azimuthStart, azimuthEnd, LOS_RUNTIME_DEADLINE_MS,
  ) as WasmLOSAnalysis;

  const { cell_states, incidence } = out;
  // Same construction as computeLOS: false/0 everywhere, then SHADOW and VISIBLE cells.
  const shadow_grid: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const quality_grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    const shadowRow = shadow_grid[r]!;
    const qualityRow = quality_grid[r]!;
    const rowOffset = r * cols;
    for (let c = 0; c < cols; c++) {
      const state = cell_states[rowOffset + c];
      if (state === LOSCellState.SHADOW) shadowRow[c] = true;
      else if (state === LOSCellState.VISIBLE) qualityRow[c] = incidence[rowOffset + c]!;
    }
  }

  const shadow_zones = Array.from(out.shadow_zone_cell_counts, (cell_count, index) => ({
    zone_id: index + 1,
    cell_count,
  }));
  const coverage_polygon: Array<[number, number]> = [];
  for (let i = 0; i + 1 < out.coverage_points.length; i += 2) {
    coverage_polygon.push([out.coverage_points[i]!, out.coverage_points[i + 1]!]);
  }
  const { coverage_pct, completeness_pct } = coveragePercentages(
    out.visible_count, out.shadow_count, out.unknown_ray_count,
  );

  return {
    shadow_grid,
    cell_states,
    grid_rows: rows,
    grid_cols: cols,
    resolution,
    quality_grid,
    flat_quality_grid: out.quality,
    quality_model: "geometric-v2",
    flat_projection_grid: out.projection,
    coverage_pct,
    completeness_pct,
    visible_area_m2: out.visible_count * cellArea,
    shadow_zones,
    coverage_polygon: coverage_polygon.slice(0, 100),
    engine_used: "wasm",
  };
}
