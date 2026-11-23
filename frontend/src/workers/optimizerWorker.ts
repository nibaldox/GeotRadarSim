/**
 * Optimizer Worker (WP8): the coarse LOS pass of the position optimizer on the real WASM
 * engine (`compute_los`), with progress, a time budget and cancellation.
 *
 * Contract (optimizador.md §6–§7, DESIGN §4):
 * - WASM only. If the module does not initialize, the Worker answers `NOT_AVAILABLE`; there is
 *   no TS fallback (the TS LOS only lives in `losWorker.ts`'s `onmessage`).
 * - The greedy loop is synchronous: a `cancel` message is never seen while it runs. Real
 *   cancellation is `Worker.terminate()` from the page (`runOptimizerInWorker`, signal abort);
 *   the injected clock only enforces the deadline, checked before every LOS.
 * - Budget: one calibration LOS (t_c), estimate N·t_c + |shortlist|·t_c·f³, and when it exceeds
 *   the budget reduce, in this order, N (stronger thinning), the shortlist (3 → 2 per step) and
 *   finally raise f. Every reduction is reported under `reduced`.
 * - `result` is plain JSON and identical for identical input and identical reductions; wall
 *   times live apart, under `timing`.
 * - The module installs `onmessage` only inside a real Worker scope, so tests import it freely.
 */

import { loadRadarWasm, flattenGridForWasm } from "../wasm/loader";
import { sampleTerrainAtCoordinates } from "../utils/terrainSample";
import { optimizeCoarse } from "../utils/optimizer/optimize";
import type { CoarseOptimizationResult, OptimizerProgress } from "../utils/optimizer/optimize";
import type { CoarseGrid } from "../utils/optimizer/coarsen";
import type { CandidateSet, LosCellOutput, LosRequest, OptimizerObjective, RadarPosition } from "../utils/optimizer/types";
import type { OptimizerAoiProfile } from "../utils/optimizer/aoi";
import type { AoiPolygon } from "../utils/aoi/aoiPolygon";
import type { QualityPolicy } from "../utils/qualityMetrics";

/** The radar fields the LOS engine reads, already with the app's overrides applied. */
export interface OptimizerRadar {
  readonly min_range_m: number;
  readonly max_range_m: number;
  readonly elevation_min_deg: number;
  readonly elevation_max_deg: number;
  readonly h_beam_width_deg: number;
  readonly scan_pattern: "RAR" | "SAR360";
  readonly azimuth_range_deg: readonly [number, number] | null;
}

export interface OptimizerJobRequest {
  /** Row-major DEM (`flattenGridForWasm`), NaN = NODATA. Transferred, never shared. */
  readonly values: Float64Array;
  readonly rows: number;
  readonly cols: number;
  readonly min_x: number;
  readonly min_y: number;
  readonly resolution: number;
  /** Effective profile of the candidates (profile + overrides, as `runLOSAnalysis` builds it). */
  readonly radar: OptimizerRadar;
  /** AOI runs: `azWidthOverride ?? h_beam_width_deg`, used for the orientation of candidates. */
  readonly azimuthWidthDeg: number;
  readonly fixed: ReadonlyArray<{ readonly position: RadarPosition; readonly radar: OptimizerRadar }>;
  readonly k: number;
  readonly objective: OptimizerObjective;
  readonly policy: QualityPolicy;
  readonly candidateSet: CandidateSet;
  readonly minSeparationM: number;
  readonly heightAboveGroundM: number;
  readonly timeBudgetS: number;
  readonly aoi?: { readonly polygon: AoiPolygon; readonly profile: OptimizerAoiProfile };
  /** Tests only: force the coarse factor. */
  readonly coarseFactor?: number;
  /** R8-FIX C4: echoed in every progress message so a listener can tell runs apart. */
  readonly runId?: string;
}

export interface OptimizerJobProgress {
  readonly phase: "calibration" | "coarse_los";
  readonly done: number;
  readonly total: number;
  readonly bestValue: number | null;
}

export interface OptimizerReductions {
  max_candidates?: { from: number; to: number };
  shortlist_per_step?: { from: number; to: number };
  coarse_factor?: { from: number; to: number };
}

export type OptimizerJobStatus = CoarseOptimizationResult["status"] | "BUDGET_EXCEEDED";

export interface OptimizerJobResult {
  readonly status: OptimizerJobStatus;
  readonly coarse: CoarseOptimizationResult | null;
  readonly reduced: OptimizerReductions;
  readonly shortlistPerStep: number;
  /** Spanish explanation of the reductions (empty when none). */
  readonly reductionNote: string;
  readonly timing: { calibration_ms: number; estimated_s: number; elapsed_s: number };
}

/** Minimal surface of the WASM module the Worker uses (so tests can inject a failing one). */
export interface OptimizerWasm {
  compute_los(
    values: Float64Array, rows: number, cols: number, min_x: number, min_y: number, resolution: number,
    rx: number, ry: number, rz: number, min_range_m: number, max_range_m: number,
    elevation_min_deg: number, elevation_max_deg: number, azimuth_limited: boolean,
    azimuth_start_deg: number, azimuth_end_deg: number, deadline_ms: number,
  ): unknown;
}

export interface OptimizerJobDeps {
  readonly wasm: OptimizerWasm;
  /** Milliseconds; injectable for the budget tests. */
  readonly now: () => number;
  readonly onProgress?: (progress: OptimizerJobProgress) => void;
}

export const DEFAULT_SHORTLIST_PER_STEP = 3;
export const REDUCED_SHORTLIST_PER_STEP = 2;
export const MAX_LOS_DEADLINE_MS = 120_000;
/** Raising f stops once the coarse grid would fall under this many nodes per axis. */
const MIN_COARSE_AXIS_NODES = 8;

/** Copy of `services/api.ts` normalizeAzimuthRange (importing api.ts would pull its Workers in). Differential test in optimizerWorker.test.ts. */
export function normalizeAzimuthRangeForWorker(center: number, width: number): [number, number] | null {
  if (!Number.isFinite(center)) throw new RangeError("El centro del azimut debe ser un número finito.");
  if (!Number.isFinite(width) || width <= 0) throw new RangeError("La apertura del azimut debe ser un número finito mayor que 0.");
  if (width >= 360) return null;
  const normalizeAngle = (angle: number): number => {
    const normalized = ((angle % 360) + 360) % 360;
    return normalized > 180 ? normalized - 360 : normalized;
  };
  const normalizedCenter = normalizeAngle(center);
  const halfWidth = width / 2;
  return [normalizeAngle(normalizedCenter - halfWidth), normalizeAngle(normalizedCenter + halfWidth)];
}

/** Candidate radar with an AOI azimuth centre, exactly as the app applies `azCenterOverride`. */
export function radarWithAzimuthCenter(radar: OptimizerRadar, center: number, width: number): OptimizerRadar {
  return { ...radar, azimuth_range_deg: normalizeAzimuthRangeForWorker(center, width), scan_pattern: "RAR" };
}

interface WasmLosOut {
  cell_states: Uint8Array;
  quality: Float32Array;
  projection: Float32Array;
}

function unflatten(values: Float64Array, rows: number, cols: number): number[][] {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || values.length !== rows * cols) {
    throw new RangeError("Optimizer DEM dimensions do not match its values");
  }
  const grid: number[][] = new Array(rows);
  for (let r = 0; r < rows; r++) grid[r] = Array.from(values.subarray(r * cols, (r + 1) * cols));
  return grid;
}

/** LOS of one radar on one grid through WASM `compute_los` (the app's engine). */
export function wasmLos(
  wasm: OptimizerWasm,
  flat: Float64Array,
  grid: { rows: number; cols: number; min_x: number; min_y: number; resolution: number },
  position: RadarPosition,
  radar: OptimizerRadar,
  deadlineMs: number,
): LosCellOutput {
  // azimuth_limited = scan_pattern !== "SAR360" && !!azimuth_range_deg (same rule as losWorker).
  const range = radar.azimuth_range_deg;
  const limited = radar.scan_pattern !== "SAR360" && !!range;
  const out = wasm.compute_los(
    flat, grid.rows, grid.cols, grid.min_x, grid.min_y, grid.resolution, position.x, position.y, position.z,
    radar.min_range_m, radar.max_range_m, radar.elevation_min_deg, radar.elevation_max_deg,
    limited, limited ? range![0] : Number.NaN, limited ? range![1] : Number.NaN, deadlineMs,
  ) as WasmLosOut;
  return { cell_states: out.cell_states, flat_quality_grid: out.quality, flat_projection_grid: out.projection };
}

/** The engine's error for a deadline hit inside `compute_los` (`rust/radar-core` DeadlineExceeded). */
export function isLosDeadlineError(error: unknown): boolean {
  return error instanceof RangeError && (error as { code?: unknown }).code === "LOS_DEADLINE_EXCEEDED";
}

/**
 * R8-FIX C3: a deadline that expires inside one LOS ends the run as BUDGET_EXCEEDED (retryable,
 * with the reductions note), exactly like a deadline seen between two LOS.
 */
export function runOptimizerJob(request: OptimizerJobRequest, deps: OptimizerJobDeps): OptimizerJobResult {
  const started = deps.now();
  try {
    return runOptimizerJobInner(request, deps, started);
  } catch (error) {
    if (!(error instanceof BudgetStop) && !isLosDeadlineError(error)) throw error;
    const note = error instanceof BudgetStop ? error.reductionNote : "";
    return {
      status: "BUDGET_EXCEEDED", coarse: null, reduced: error instanceof BudgetStop ? error.reduced : {},
      shortlistPerStep: error instanceof BudgetStop ? error.shortlist : DEFAULT_SHORTLIST_PER_STEP, reductionNote: note,
      timing: { calibration_ms: error instanceof BudgetStop ? error.tc : 0, estimated_s: error instanceof BudgetStop ? error.estimatedS : 0, elapsed_s: (deps.now() - started) / 1000 },
    };
  }
}

class BudgetStop extends Error {
  constructor(
    readonly reduced: OptimizerReductions, readonly shortlist: number, readonly reductionNote: string,
    readonly tc: number, readonly estimatedS: number,
  ) {
    super("budget");
  }
}

function runOptimizerJobInner(request: OptimizerJobRequest, deps: OptimizerJobDeps, started: number): OptimizerJobResult {
  const source = {
    grid: unflatten(request.values, request.rows, request.cols),
    bounds: { min_x: request.min_x, min_y: request.min_y },
    resolution: request.resolution,
  };
  if (!Number.isFinite(request.timeBudgetS) || request.timeBudgetS <= 0) throw new RangeError("Time budget must be > 0");
  const budgetMs = request.timeBudgetS * 1000;
  const flatCache = new WeakMap<object, Float64Array>();
  const flatOf = (grid: CoarseGrid | typeof source): Float64Array => {
    let flat = flatCache.get(grid.grid);
    if (!flat) {
      flat = grid.grid === source.grid ? request.values : flattenGridForWasm(grid.grid);
      flatCache.set(grid.grid, flat);
    }
    return flat;
  };
  let deadline = Number.POSITIVE_INFINITY;
  const scorer = (req: LosRequest): LosCellOutput => {
    const grid = req.grid as CoarseGrid;
    const rows = grid.grid.length;
    const cols = grid.grid[0]!.length;
    const radar = req.subject.kind === "fixed"
      ? request.fixed[req.subject.index]!.radar
      : req.azimuthCenterDeg === undefined ? request.radar : radarWithAzimuthCenter(request.radar, req.azimuthCenterDeg, request.azimuthWidthDeg);
    const remaining = Number.isFinite(deadline) ? Math.max(1, Math.floor(deadline - deps.now())) : MAX_LOS_DEADLINE_MS;
    return wasmLos(deps.wasm, flatOf(grid), {
      rows, cols, min_x: grid.bounds.min_x, min_y: grid.bounds.min_y, resolution: grid.resolution,
    }, req.position, radar, Math.min(remaining, MAX_LOS_DEADLINE_MS));
  };
  const sampleCoarseSurface = (grid: CoarseGrid, x: number, y: number): number | null =>
    sampleTerrainAtCoordinates(grid.grid, grid.bounds, grid.resolution, x, y);
  const base = {
    source,
    k: request.k,
    objective: request.objective,
    policy: request.policy,
    candidateSet: request.candidateSet,
    minSeparationM: request.minSeparationM,
    heightAboveGroundM: request.heightAboveGroundM,
    fixed: request.fixed.map((f) => f.position),
    sampleCoarseSurface,
    ...(request.aoi ? { aoi: { polygon: request.aoi.polygon, profile: request.aoi.profile } } : {}),
  };

  // 1. Calibration: the first LOS of the run (fixed radars come first), then stop.
  let calls = 0;
  let calibrationMs = 0;
  const calibration = optimizeCoarse({
    ...base,
    ...(request.coarseFactor ? { coarseFactor: request.coarseFactor } : {}),
    los: (req) => {
      const t0 = deps.now();
      const out = scorer(req);
      calibrationMs = deps.now() - t0;
      calls++;
      return out;
    },
    isCancelled: () => calls >= 1,
  });
  deps.onProgress?.({ phase: "calibration", done: calls, total: 1, bestValue: null });
  if (calibration.status !== "CANCELLED") {
    // No LOS was needed (no candidates, AOI too small): that is already the answer.
    return {
      status: calibration.status, coarse: calibration, reduced: {}, shortlistPerStep: DEFAULT_SHORTLIST_PER_STEP,
      reductionNote: "", timing: { calibration_ms: 0, estimated_s: 0, elapsed_s: (deps.now() - started) / 1000 },
    };
  }

  // 2. Estimate and reduce (optimizador.md §6.2).
  const tc = Math.max(calibrationMs, 0);
  const n0 = calibration.candidates.length;
  const f0 = calibration.coarse.factor;
  const nFixed = request.fixed.length;
  const estimate = (n: number, shortlist: number, f: number) =>
    (nFixed + n) * tc * (f0 / f) ** 3 + Math.min(n, shortlist * request.k) * tc * f0 ** 3;
  let n = n0;
  let shortlist = DEFAULT_SHORTLIST_PER_STEP;
  let f = f0;
  const reduced: OptimizerReductions = {};
  if (estimate(n, shortlist, f) > budgetMs) {
    const fullCost = Math.min(n, shortlist * request.k) * tc * f0 ** 3;
    const perCandidate = tc;
    const fit = perCandidate > 0 ? Math.floor((budgetMs - fullCost) / perCandidate) - nFixed : n;
    const floor = Math.max(request.k, 1);
    const nNext = Math.max(floor, Math.min(n, fit));
    if (nNext < n) {
      reduced.max_candidates = { from: n, to: nNext };
      n = nNext;
    }
  }
  if (estimate(n, shortlist, f) > budgetMs) {
    reduced.shortlist_per_step = { from: shortlist, to: REDUCED_SHORTLIST_PER_STEP };
    shortlist = REDUCED_SHORTLIST_PER_STEP;
  }
  const maxFactor = Math.max(f0, Math.floor((Math.min(request.rows, request.cols) - 1) / (MIN_COARSE_AXIS_NODES - 1)));
  while (estimate(n, shortlist, f) > budgetMs && f < maxFactor) f++;
  if (f !== f0) reduced.coarse_factor = { from: f0, to: f };
  const estimatedS = estimate(n, shortlist, f) / 1000;

  // 3. The real run, with the deadline checked before every LOS.
  deadline = started + budgetMs;
  const onProgress = deps.onProgress
    ? (p: OptimizerProgress) => deps.onProgress!({ phase: p.phase, done: p.done, total: p.total, bestValue: p.bestValue })
    : undefined;
  const notes: string[] = [];
  if (reduced.max_candidates) notes.push(`se redujeron los candidatos de ${reduced.max_candidates.from} a ${reduced.max_candidates.to}`);
  if (reduced.shortlist_per_step) notes.push("la lista corta pasó de 3 a 2 candidatos por paso");
  if (reduced.coarse_factor) notes.push(`la grilla gruesa pasó del factor ${reduced.coarse_factor.from} al ${reduced.coarse_factor.to}`);
  const reductionNote = notes.length > 0 ? `Para respetar el presupuesto de tiempo, ${notes.join("; ")}.` : "";
  let coarse: CoarseOptimizationResult;
  try {
    coarse = optimizeCoarse({
      ...base,
      coarseFactor: request.coarseFactor ?? f,
      candidateParams: n !== n0 ? { maxCandidates: n } : undefined,
      shortlistPerStep: shortlist,
      los: scorer,
      isCancelled: () => deps.now() >= deadline,
      ...(onProgress ? { onProgress } : {}),
    });
  } catch (error) {
    if (isLosDeadlineError(error)) throw new BudgetStop(reduced, shortlist, reductionNote, tc, estimatedS);
    throw error;
  }
  const elapsed = (deps.now() - started) / 1000;
  if (coarse.status === "CANCELLED") {
    return { status: "BUDGET_EXCEEDED", coarse: null, reduced, shortlistPerStep: shortlist, reductionNote, timing: { calibration_ms: tc, estimated_s: estimatedS, elapsed_s: elapsed } };
  }
  return { status: coarse.status, coarse, reduced, shortlistPerStep: shortlist, reductionNote, timing: { calibration_ms: tc, estimated_s: estimatedS, elapsed_s: elapsed } };
}

// ---------------------------------------------------------------------------
// Worker protocol

export type OptimizerWorkerMessage =
  | { type: "progress"; runId: string | null; progress: OptimizerJobProgress }
  | { type: "result"; result: OptimizerJobResult }
  | { type: "error"; code: "NOT_AVAILABLE" | "OPTIMIZER_FAILED"; message: string };

export const WASM_NOT_AVAILABLE_MESSAGE = "El motor de cálculo WebAssembly no se pudo iniciar; el optimizador de posiciones no está disponible.";

/** Message handler (exported for tests); `post` is the Worker's `postMessage`. */
export async function handleOptimizerMessage(
  request: OptimizerJobRequest,
  post: (message: OptimizerWorkerMessage) => void,
  loadWasm: () => Promise<OptimizerWasm> = loadRadarWasm as unknown as () => Promise<OptimizerWasm>,
  now: () => number = () => performance.now(),
): Promise<void> {
  let wasm: OptimizerWasm;
  try {
    wasm = await loadWasm();
  } catch {
    post({ type: "error", code: "NOT_AVAILABLE", message: WASM_NOT_AVAILABLE_MESSAGE });
    return;
  }
  try {
    let lastPost = Number.NEGATIVE_INFINITY;
    const result = runOptimizerJob(request, {
      wasm,
      now,
      onProgress: (progress) => {
        const t = now();
        if (progress.done === progress.total || t - lastPost >= 200) {
          lastPost = t;
          post({ type: "progress", runId: request.runId ?? null, progress });
        }
      },
    });
    post({ type: "result", result });
  } catch (error) {
    post({ type: "error", code: "OPTIMIZER_FAILED", message: error instanceof RangeError ? "Los datos de entrada del optimizador no son válidos." : "El optimizador falló." });
  }
}

declare const WorkerGlobalScope: { new (): unknown } | undefined;
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof (WorkerGlobalScope as unknown as typeof Object)) {
  const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
  scope.onmessage = (event: MessageEvent) => {
    void handleOptimizerMessage(event.data as OptimizerJobRequest, (m) => scope.postMessage(m));
  };
}
