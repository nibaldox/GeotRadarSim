/**
 * Candidate radar positions on berms and edges of the pit (full resolution, O(cells)).
 *
 * Rules (design `optimizador.md` §2; thresholds are initial design values, not calibrated):
 * 1. Interior node: finite elevation, its four incident quads renderable (all corners
 *    finite, the TerrainViewer/LOS triangulation rule), at least `marginNodes` rows/cols
 *    from the grid border and at Chebyshev distance ≥ `marginNodes` from any NODATA node.
 * 2. Slope θ = atan(‖∇z‖) with `terrainGradientAt` (central or one-sided differences).
 * 3. BERM: θ ≤ flat threshold and some node with θ ≥ face threshold within
 *    `faceRadiusM` (Euclidean, exact squared distance transform).
 * 4. Edges: CREST = a BERM node at or above the elevation percentile (nearest rank);
 *    PERIMETER = flat node at Chebyshev distance m … m + band from the NODATA limit.
 *    The rectangular raster border is not a valid-data limit (it is the extent of the
 *    raster, not a physical edge), so it only enforces the margin.
 * 5. z = node elevation + height_above_ground_m (a node samples exactly its elevation).
 * 6. Deterministic thinning: boxes of side max(`min_separation_m`, resolution) from the grid
 *    origin keep the node nearest to the box centre (ties: lower row-major index); the side
 *    grows ×1.25 until at most `maxCandidates` remain. Sides that provably cannot fit are
 *    skipped without a pass over the pool, and the number of passes is capped.
 * 7. Fallback: without berms or edges, a regular grid of interior nodes with θ ≤ 25°.
 */

import { terrainGradientAt } from "../sensitivity";
import { validateOptimizerGrid } from "./coarsen";
import type { Candidate, CandidateKind, CandidateSet, OptimizerGrid } from "./types";

export interface CandidateParams {
  /** m: nodes kept clear of the grid border and of NODATA. */
  readonly marginNodes: number;
  /** θ_plano: maximum slope of a berm/edge node, degrees. */
  readonly flatMaxSlopeDeg: number;
  /** θ_talud: minimum slope of a face node, degrees. */
  readonly faceMinSlopeDeg: number;
  /** r: maximum horizontal distance from a berm node to a face node, metres. */
  readonly faceRadiusM: number;
  /** Elevation percentile (integer, nearest rank) at or above which a berm node is a crest. */
  readonly crestPercentile: number;
  /** Width of the perimeter band beyond the margin, nodes. */
  readonly perimeterBandNodes: number;
  /** Maximum slope of a regular-grid fallback node, degrees. */
  readonly regularMaxSlopeDeg: number;
  /** N_max after thinning. */
  readonly maxCandidates: number;
  /** Box-side growth factor while more than N_max candidates remain. */
  readonly thinningGrowth: number;
}

export const CANDIDATE_DEFAULTS: CandidateParams = Object.freeze({
  marginNodes: 2,
  flatMaxSlopeDeg: 12,
  faceMinSlopeDeg: 35,
  faceRadiusM: 10,
  crestPercentile: 80,
  perimeterBandNodes: 3,
  regularMaxSlopeDeg: 25,
  maxCandidates: 160,
  thinningGrowth: 1.25,
});

export const DEFAULT_MIN_SEPARATION_M = 50;
/** Allowed box-side growth per thinning pass (bounds the number of passes). */
export const MIN_THINNING_GROWTH = 1.05;
export const MAX_THINNING_GROWTH = 4;
/** Hard cap on full thinning passes over the pool; reaching it is an error, never a silent result. */
export const MAX_THINNING_PASSES = 256;
export const DEFAULT_HEIGHT_ABOVE_GROUND_M = 2;

function resolveParams(overrides: Partial<CandidateParams> | undefined): CandidateParams {
  const params = { ...CANDIDATE_DEFAULTS, ...(overrides ?? {}) };
  const integerAtLeast = (value: number, min: number) => Number.isInteger(value) && value >= min;
  const angle = (value: number) => Number.isFinite(value) && value >= 0 && value <= 90;
  if (!integerAtLeast(params.marginNodes, 0) || !integerAtLeast(params.perimeterBandNodes, 0) ||
      !integerAtLeast(params.maxCandidates, 1) || !integerAtLeast(params.crestPercentile, 0) ||
      params.crestPercentile > 100 || !angle(params.flatMaxSlopeDeg) || !angle(params.faceMinSlopeDeg) ||
      !angle(params.regularMaxSlopeDeg) || !Number.isFinite(params.faceRadiusM) || params.faceRadiusM < 0 ||
      !Number.isFinite(params.thinningGrowth) || params.thinningGrowth < MIN_THINNING_GROWTH ||
      params.thinningGrowth > MAX_THINNING_GROWTH) {
    throw new RangeError("Invalid candidate parameters");
  }
  return params;
}

/** Slope in degrees per node (row-major), NaN where `terrainGradientAt` has no gradient. */
export function slopeDegreesGrid(grid: readonly (readonly number[])[], resolution: number): Float64Array {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0]!.length : 0;
  const slope = new Float64Array(rows * cols).fill(Number.NaN);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gradient = terrainGradientAt(grid, r, c, resolution);
      if (gradient) slope[r * cols + c] = (Math.atan(Math.hypot(gradient.gradX, gradient.gradY)) * 180) / Math.PI;
    }
  }
  return slope;
}

/** Exact Chebyshev (chessboard) distance, in nodes, to the nearest non-finite node; Infinity if none. */
function chebyshevDistanceToNodata(grid: readonly (readonly number[])[], rows: number, cols: number): Float64Array {
  const dist = new Float64Array(rows * cols).fill(Number.POSITIVE_INFINITY);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (!Number.isFinite(grid[r]![c]!)) dist[r * cols + c] = 0;
  }
  const relax = (idx: number, r: number, c: number) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    const candidate = dist[r * cols + c]! + 1;
    if (candidate < dist[idx]!) dist[idx] = candidate;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      relax(idx, r - 1, c - 1); relax(idx, r - 1, c); relax(idx, r - 1, c + 1); relax(idx, r, c - 1);
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const idx = r * cols + c;
      relax(idx, r + 1, c + 1); relax(idx, r + 1, c); relax(idx, r + 1, c - 1); relax(idx, r, c + 1);
    }
  }
  return dist;
}

const FAR = 1e20;

/** 1D squared distance transform (Felzenszwalb–Huttenlocher), in place over a strided view. */
function distanceTransform1d(values: Float64Array, offset: number, stride: number, n: number,
  f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array): void {
  for (let q = 0; q < n; q++) f[q] = values[offset + q * stride]!;
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const delta = q - v[k]!;
    d[q] = delta * delta + f[v[k]!]!;
  }
  for (let q = 0; q < n; q++) values[offset + q * stride] = d[q]!;
}

/** Exact squared Euclidean distance (in nodes²) to the nearest masked node; ≥ 1e20 when none. */
export function squaredDistanceToMask(mask: Uint8Array, rows: number, cols: number): Float64Array {
  const values = new Float64Array(rows * cols);
  for (let idx = 0; idx < values.length; idx++) values[idx] = mask[idx] ? 0 : FAR;
  const n = Math.max(rows, cols);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let c = 0; c < cols; c++) distanceTransform1d(values, c, cols, rows, f, d, v, z);
  for (let r = 0; r < rows; r++) distanceTransform1d(values, r * cols, 1, cols, f, d, v, z);
  return values;
}

/** Nearest-rank percentile (integer percent) of the finite elevations, or null without data. */
function elevationPercentile(grid: readonly (readonly number[])[], percent: number): number | null {
  const values: number[] = [];
  for (const row of grid) for (const value of row) if (Number.isFinite(value)) values.push(value);
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  const rank = Math.max(1, Math.ceil((values.length * percent) / 100));
  return sorted[rank - 1]!;
}

export interface NodeClassification {
  readonly rows: number;
  readonly cols: number;
  /** Row-major node indices, ascending. Kinds are exclusive: CREST > BERM > PERIMETER. */
  readonly berm: number[];
  readonly crest: number[];
  readonly perimeter: number[];
  /** Interior nodes with θ ≤ regular threshold (fallback pool; overlaps the others). */
  readonly regular: number[];
  /** Elevation percentile used for crests (null without finite data). */
  readonly crestElevation: number | null;
  readonly slopeDeg: Float64Array;
}

/**
 * Effective full-resolution extent, in nodes, that the coarse pass can represent: the
 * nodes up to the last coarse multiple, ((coarse nodes − 1)·f + 1) per axis.
 */
export interface ExtentNodes {
  readonly rows: number;
  readonly cols: number;
}

function validateExtent(extent: ExtentNodes | undefined, rows: number, cols: number): void {
  if (extent === undefined) return;
  if (!Number.isInteger(extent.rows) || !Number.isInteger(extent.cols) || extent.rows < 1 || extent.cols < 1 ||
      extent.rows > rows || extent.cols > cols) {
    throw new RangeError("Candidate extent must be integer node counts within the grid");
  }
}

/**
 * Raw (unthinned) classification of every node. With `extentNodes`, nodes beyond that
 * extent are not candidates and the border margin is measured from its last row/column.
 */
export function classifyCandidateNodes(
  source: OptimizerGrid,
  overrides?: Partial<CandidateParams>,
  extentNodes?: ExtentNodes,
): NodeClassification {
  const [rows, cols] = validateOptimizerGrid(source, "Candidate grid");
  validateExtent(extentNodes, rows, cols);
  const lastRow = (extentNodes?.rows ?? rows) - 1;
  const lastCol = (extentNodes?.cols ?? cols) - 1;
  const params = resolveParams(overrides);
  const { grid, resolution } = source;
  const slope = slopeDegreesGrid(grid, resolution);
  const nodataDistance = chebyshevDistanceToNodata(grid, rows, cols);
  const steep = new Uint8Array(rows * cols);
  for (let idx = 0; idx < steep.length; idx++) {
    const value = slope[idx]!;
    if (Number.isFinite(value) && value >= params.faceMinSlopeDeg) steep[idx] = 1;
  }
  const faceDistance2 = squaredDistanceToMask(steep, rows, cols);
  const faceRadius2 = params.faceRadiusM * params.faceRadiusM;
  const crestElevation = elevationPercentile(grid, params.crestPercentile);
  const m = params.marginNodes;
  const border = Math.max(m, 1); // all four incident quads must exist
  const berm: number[] = [];
  const crest: number[] = [];
  const perimeter: number[] = [];
  const regular: number[] = [];

  for (let r = border; r <= lastRow - border; r++) {
    for (let c = border; c <= lastCol - border; c++) {
      const idx = r * cols + c;
      // Distance < 2 means a NaN inside the 3 × 3 neighbourhood: some incident quad is not renderable.
      if (nodataDistance[idx]! < Math.max(m, 2)) continue;
      const theta = slope[idx]!;
      if (!Number.isFinite(theta)) continue;
      if (theta <= params.regularMaxSlopeDeg) regular.push(idx);
      if (theta > params.flatMaxSlopeDeg) continue;
      if (faceDistance2[idx]! * resolution * resolution <= faceRadius2) {
        if (crestElevation !== null && grid[r]![c]! >= crestElevation) crest.push(idx);
        else berm.push(idx);
      } else if (nodataDistance[idx]! <= m + params.perimeterBandNodes) {
        perimeter.push(idx);
      }
    }
  }
  return { rows, cols, berm, crest, perimeter, regular, crestElevation, slopeDeg: slope };
}

/**
 * Deterministic box thinning (see module doc, rule 6).
 *
 * The side starts at max(min_separation_m, resolution): a box smaller than one node
 * spacing thins nothing. The resolution must have a finite, positive cell area (res² > 0,
 * the same condition as `validateOptimizerGrid`): with a subnormal resolution the side
 * never grows (side × growth rounds back to side) and the skip loop would never end
 * (R1C-WP7-1).
 * A box of side s holds at most (⌊s/res⌋ + 1)² nodes, so any side with
 * pool > N_max·(⌊s/res⌋ + 1)² cannot fit; those sides (≈ below res·√(pool/N_max)) are
 * skipped arithmetically. The first fitting side of the ×growth sequence is therefore the
 * same as with one pass per side; only the wasted passes disappear. `passes` counts the
 * full passes over the pool, capped at `maxPasses`.
 */
export function thinNodes(
  nodes: readonly number[],
  cols: number,
  resolution: number,
  minSeparationM: number,
  maxCandidates: number = CANDIDATE_DEFAULTS.maxCandidates,
  growth: number = CANDIDATE_DEFAULTS.thinningGrowth,
  maxPasses: number = MAX_THINNING_PASSES,
): { nodes: number[]; boxSideM: number; passes: number } {
  const cellArea = resolution * resolution;
  if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(cellArea) || cellArea <= 0) {
    throw new RangeError(`Thinning resolution must be finite and positive with a finite, positive cell area (res² = ${cellArea})`);
  }
  if (!Number.isInteger(cols) || cols < 1 ||
      !Number.isFinite(minSeparationM) || minSeparationM < 0 || !Number.isInteger(maxCandidates) ||
      maxCandidates < 1 || !Number.isFinite(growth) || growth < MIN_THINNING_GROWTH ||
      growth > MAX_THINNING_GROWTH || !Number.isInteger(maxPasses) || maxPasses < 1) {
    throw new RangeError("Invalid thinning parameters");
  }
  const sorted = [...new Set(nodes)].sort((a, b) => a - b);
  let side = Math.max(minSeparationM, resolution);
  while (sorted.length > maxCandidates * (Math.floor(side / resolution) + 1) ** 2) side *= growth;
  for (let passes = 1; passes <= maxPasses; passes++) {
    const boxesPerRow = Math.floor(((cols - 1) * resolution) / side) + 1;
    const best = new Map<number, { idx: number; d2: number }>();
    for (const idx of sorted) {
      const x = (idx % cols) * resolution;
      const y = Math.floor(idx / cols) * resolution;
      const bx = Math.floor(x / side);
      const by = Math.floor(y / side);
      const dx = x - (bx + 0.5) * side;
      const dy = y - (by + 0.5) * side;
      const d2 = dx * dx + dy * dy;
      const key = by * boxesPerRow + bx;
      const current = best.get(key);
      if (!current || d2 < current.d2) best.set(key, { idx, d2 });
    }
    const kept = [...best.values()].map((entry) => entry.idx).sort((a, b) => a - b);
    if (kept.length <= maxCandidates) return { nodes: kept, boxSideM: side, passes };
    side *= growth;
  }
  throw new RangeError(`Thinning did not reach ${maxCandidates} candidates within ${maxPasses} passes`);
}

export interface CandidateGenerationOptions {
  readonly candidateSet?: CandidateSet;
  readonly minSeparationM?: number;
  readonly heightAboveGroundM?: number;
  readonly params?: Partial<CandidateParams>;
  /** Restrict candidates to the extent the coarse pass represents (see {@link ExtentNodes}). */
  readonly extentNodes?: ExtentNodes;
  /**
   * WP14: extra eligibility rule over full-resolution node indices (row-major), applied to
   * every pool (berms, edges and the regular fallback) before thinning. The AOI run uses it
   * for "outside the AOI and within range of it". Absent = every classified node.
   */
  readonly nodeFilter?: (idx: number) => boolean;
  /** WP14: Spanish fallback reason to use when `nodeFilter` empties the berm/edge pool. */
  readonly nodeFilterFallbackReason?: string;
  /** R14 WP14-9: Spanish reason when `nodeFilter` leaves no candidate at all (no fallback is claimed). */
  readonly nodeFilterEmptyReason?: string;
  /**
   * R14 WP14-1 (AOI runs): add open ground to `edges_and_berms`. The open-ground pool is the
   * regular pool (interior nodes with θ ≤ `regularMaxSlopeDeg` that pass `nodeFilter`) minus the
   * berm/crest/perimeter nodes. Quota over N = `maxCandidates`: berms and edges get ⌈N/2⌉ and
   * open ground ⌊N/2⌋, each group thinned on its own with the same box rule; when a group
   * cannot fill its quota (its thinned pool is smaller), the other group is thinned again with
   * the remaining slots. The total stays ≤ N. Separation between the two groups is left to the
   * greedy (`min_separation_m` there). Without berms or edges the regular fallback applies.
   */
  readonly openGround?: boolean;
}

export interface CandidateGenerationResult {
  readonly candidates: Candidate[];
  readonly candidateSetRequested: CandidateSet;
  readonly candidateSetUsed: CandidateSet;
  /** Spanish, user-facing reason for a fallback to `regular_grid`; null otherwise. */
  readonly fallbackReason: string | null;
  readonly boxSideM: number;
  /** Extent the candidates were restricted to, or null for the whole grid. */
  readonly extentNodes: ExtentNodes | null;
  readonly rawCounts: Readonly<{ berm: number; crest: number; perimeter: number; regular: number }>;
  /** WP14, only with `nodeFilter`: counts that pass the filter, per pool. */
  readonly filteredCounts?: Readonly<{ berm: number; crest: number; perimeter: number; regular: number }>;
  /** R14 WP14-1, only when the open-ground quota applied: candidates per group. */
  readonly openGroundQuota?: Readonly<{ edges: number; openGround: number }>;
  /** R14 WP14-1, only when the open-ground quota applied: box side of the open-ground thinning. */
  readonly openGroundBoxSideM?: number;
  readonly params: CandidateParams;
}

/** Candidate list in ascending row-major node order; `index` is the list position. */
export function generateCandidates(source: OptimizerGrid, options: CandidateGenerationOptions = {}): CandidateGenerationResult {
  const candidateSetRequested = options.candidateSet ?? "edges_and_berms";
  if (candidateSetRequested !== "edges_and_berms" && candidateSetRequested !== "regular_grid") {
    throw new RangeError("Unknown candidate set");
  }
  const minSeparationM = options.minSeparationM ?? DEFAULT_MIN_SEPARATION_M;
  const heightAboveGroundM = options.heightAboveGroundM ?? DEFAULT_HEIGHT_ABOVE_GROUND_M;
  if (!Number.isFinite(minSeparationM) || minSeparationM < 0) {
    throw new RangeError("min_separation_m must be finite and non-negative");
  }
  if (!Number.isFinite(heightAboveGroundM) || heightAboveGroundM < 0) {
    throw new RangeError("height_above_ground_m must be finite and non-negative");
  }
  const params = resolveParams(options.params);
  const raw = classifyCandidateNodes(source, params, options.extentNodes);
  const nodeFilter = options.nodeFilter;
  if (nodeFilter !== undefined && typeof nodeFilter !== "function") throw new TypeError("nodeFilter must be a function");
  const classification: NodeClassification = nodeFilter === undefined ? raw : {
    ...raw,
    berm: raw.berm.filter((idx) => nodeFilter(idx)),
    crest: raw.crest.filter((idx) => nodeFilter(idx)),
    perimeter: raw.perimeter.filter((idx) => nodeFilter(idx)),
    regular: raw.regular.filter((idx) => nodeFilter(idx)),
  };
  const kinds = new Map<number, CandidateKind>();
  for (const idx of classification.perimeter) kinds.set(idx, "PERIMETER");
  for (const idx of classification.berm) kinds.set(idx, "BERM");
  for (const idx of classification.crest) kinds.set(idx, "CREST");

  let candidateSetUsed: CandidateSet = candidateSetRequested;
  let fallbackReason: string | null = null;
  let pool: number[];
  if (candidateSetRequested === "edges_and_berms" && kinds.size > 0) {
    pool = [...kinds.keys()];
  } else {
    if (candidateSetRequested === "edges_and_berms" && nodeFilter !== undefined &&
        raw.berm.length + raw.crest.length + raw.perimeter.length > 0) {
      candidateSetUsed = "regular_grid";
      fallbackReason = options.nodeFilterFallbackReason ??
        `Ninguna berma ni borde cumple la condición pedida; se usa una grilla regular de nodos con pendiente ≤ ${params.regularMaxSlopeDeg}°.`;
    } else if (candidateSetRequested === "edges_and_berms") {
      candidateSetUsed = "regular_grid";
      fallbackReason = `No hay bermas ni bordes con los umbrales actuales (plano ≤ ${params.flatMaxSlopeDeg}°, ` +
        `talud ≥ ${params.faceMinSlopeDeg}° a ≤ ${params.faceRadiusM} m, sin límite de datos válidos cercano); ` +
        `se usa una grilla regular de nodos con pendiente ≤ ${params.regularMaxSlopeDeg}°.`;
    }
    kinds.clear();
    pool = classification.regular;
  }

  const { cols } = classification;
  const thin = (nodes: readonly number[], cap: number) =>
    thinNodes(nodes, cols, source.resolution, minSeparationM, cap, params.thinningGrowth);
  let thinned: { nodes: number[]; boxSideM: number };
  let quota: { edges: number; openGround: number } | null = null;
  let openGroundBoxSideM = 0;
  const openPool = options.openGround === true && kinds.size > 0
    ? classification.regular.filter((idx) => !kinds.has(idx))
    : null;
  if (openPool !== null) {
    const total = params.maxCandidates;
    const edgeCap = openPool.length > 0 ? Math.ceil(total / 2) : total;
    const openCap = total - edgeCap;
    let edges = thin(pool, edgeCap);
    let open = openCap > 0 ? thin(openPool, openCap) : { nodes: [] as number[], boxSideM: 0 };
    if (openCap > 0 && edges.nodes.length < edgeCap) open = thin(openPool, total - edges.nodes.length);
    else if (openCap > 0 && open.nodes.length < openCap) edges = thin(pool, total - open.nodes.length);
    for (const idx of open.nodes) kinds.set(idx, "OPEN_GROUND");
    thinned = { nodes: [...edges.nodes, ...open.nodes].sort((a, b) => a - b), boxSideM: edges.boxSideM };
    quota = { edges: edges.nodes.length, openGround: open.nodes.length };
    openGroundBoxSideM = open.boxSideM;
  } else {
    thinned = thin(pool, params.maxCandidates);
  }
  if (thinned.nodes.length === 0 && nodeFilter !== undefined && fallbackReason !== null) {
    fallbackReason = options.nodeFilterEmptyReason ?? "Ninguna berma, borde ni nodo de la grilla regular cumple la condición pedida.";
  }
  const candidates: Candidate[] = thinned.nodes.map((idx, index) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const groundZ = source.grid[row]![col]!;
    return {
      index,
      row,
      col,
      x: source.bounds.min_x + col * source.resolution,
      y: source.bounds.min_y + row * source.resolution,
      groundZ,
      z: groundZ + heightAboveGroundM,
      kind: kinds.get(idx) ?? "REGULAR",
      slopeDeg: classification.slopeDeg[idx]!,
    };
  });
  return {
    candidates,
    candidateSetRequested,
    candidateSetUsed,
    fallbackReason,
    boxSideM: thinned.boxSideM,
    extentNodes: options.extentNodes ? { rows: options.extentNodes.rows, cols: options.extentNodes.cols } : null,
    rawCounts: {
      berm: raw.berm.length,
      crest: raw.crest.length,
      perimeter: raw.perimeter.length,
      regular: raw.regular.length,
    },
    ...(nodeFilter === undefined ? {} : {
      filteredCounts: {
        berm: classification.berm.length,
        crest: classification.crest.length,
        perimeter: classification.perimeter.length,
        regular: classification.regular.length,
      },
    }),
    ...(quota === null ? {} : { openGroundQuota: quota, openGroundBoxSideM }),
    params,
  };
}
