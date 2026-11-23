/**
 * Coarse optimizer pass composed from the pure pieces, with an injected LOS.
 *
 * 1. Candidates on the full-resolution DEM (berms and edges, or the regular fallback).
 * 2. Integer decimation to ≤ `maxCoarseNodes` nodes.
 * 3. One LOS per fixed radar, then one per candidate, on the coarse grid; the coarse
 *    radar height is max(fine ground, coarse surface) + h when a coarse-surface sampler
 *    is injected (otherwise the fine ground is used and nothing is flagged).
 * 4. Greedy selection of k with separation, fixed radars and a per-step shortlist.
 *
 * All scalar arguments (k, objective, policy, separation, shortlist) are validated before
 * the first LOS, and so is fixed + k ≤ 10, the app history limit (R1C-WP7-2). Candidates are
 * restricted to the full-resolution extent the coarse grid represents, minus the border margin,
 * so every coarse LOS position lies on the coarse grid.
 *
 * Cancellation contract for the Worker (WP8): this loop is synchronous, so a `cancel`
 * message posted to the Worker is NOT observable while it runs (no SharedArrayBuffer: the
 * app is not cross-origin isolated). Real cancellation is `Worker.terminate()`. The
 * `isCancelled` hook is for a deadline with an injectable clock (`() => now() >= deadline`),
 * checked before every LOS evaluation.
 *
 * The full-resolution refinement, the time budget and the Worker belong to WP8.
 * The result is plain JSON (no typed arrays), and identical for identical input.
 *
 * WP14, area to monitor (`aoi`): the objective counts only AOI cells, on the coarse mask
 * derived from the fine one with the `coarsenGrid` rule; candidates must lie outside the AOI
 * and within [rangeMin, rangeMax] (horizontal) of the AOI polygon, filtered before thinning
 * (`aoiRangeFilter`, O(V) per node); with `edges_and_berms`, open ground joins berms and
 * edges under a quota (`generateCandidates` option `openGround`); every candidate is oriented
 * towards the fine AOI cells (`aoi.ts`) and its LOS request carries that `azimuthCenterDeg`.
 * Fixed radars keep their own orientation. If the best first-step gain is ≤ 0 the status is
 * `NO_COVERAGE` with a Spanish message. Without `aoi` the result is identical to the WP7
 * base (`aoi-regression.test.ts`).
 */

import type { QualityPolicy } from "../qualityMetrics";
import { DEFAULT_HEIGHT_ABOVE_GROUND_M, DEFAULT_MIN_SEPARATION_M, generateCandidates } from "./candidates";
import { assertGreedyArguments } from "./greedy";
import type { CandidateGenerationResult, CandidateParams } from "./candidates";
import { MAX_COARSE_NODES, chooseCoarsenFactor, coarseRadarZ, coarsenGrid, validateOptimizerGrid } from "./coarsen";
import type { CoarseGrid } from "./coarsen";
import { greedySelect } from "./greedy";
import type { GreedyCandidateInput, GreedyResult } from "./greedy";
import { scoreLosOutput } from "./objective";
import type { CoverageScore } from "./objective";
import { aoiPercent } from "../aoi/aoiCoverage";
import { aoiMaskForGrid } from "../aoi/aoiMask";
import { validateAoiPolygon } from "../aoi/aoiPolygon";
import { aoiRangeFilter, coarsenAoiMask, orientTowardsAoi, prepareAoiCells, validateAoiMaskForGrid, validateAoiProfile } from "./aoi";
import type { AoiOrientation, OptimizerAoiInput, OptimizerAoiProfile } from "./aoi";
import { DEFAULT_OPTIMIZER_OBJECTIVE } from "./types";
import type {
  Candidate,
  CandidateSet,
  LosCellOutput,
  LosScorer,
  LosSubject,
  OptimizerGrid,
  OptimizerObjective,
  RadarPosition,
} from "./types";

export interface OptimizerProgress {
  readonly phase: "coarse_los";
  readonly done: number;
  readonly total: number;
  /** Best standalone candidate value seen so far, or null before the first candidate. */
  readonly bestValue: number | null;
}

export interface CoarseOptimizationInput {
  /** Full-resolution DEM of the snapshot. */
  readonly source: OptimizerGrid;
  readonly k: number;
  readonly objective?: OptimizerObjective;
  readonly policy: QualityPolicy;
  readonly los: LosScorer;
  readonly candidateSet?: CandidateSet;
  readonly minSeparationM?: number;
  readonly heightAboveGroundM?: number;
  /** Fixed radars (keep_analysis_refs), absolute positions from their snapshots. */
  readonly fixed?: readonly RadarPosition[];
  readonly maxCoarseNodes?: number;
  /** Override the automatic factor (tests, budget reductions). */
  readonly coarseFactor?: number;
  /** Triangulated coarse-surface elevation at (x, y), or null outside the surface. */
  readonly sampleCoarseSurface?: (grid: CoarseGrid, x: number, y: number) => number | null;
  readonly candidateParams?: Partial<CandidateParams>;
  readonly shortlistPerStep?: number;
  readonly onProgress?: (progress: OptimizerProgress) => void;
  /**
   * Checked before every LOS evaluation; returning true stops with status CANCELLED.
   * Meant for a deadline with an injectable clock. A Worker `cancel` message cannot be
   * observed by this synchronous loop: real cancellation is `Worker.terminate()`.
   */
  readonly isCancelled?: () => boolean;
  /** WP14: area to monitor (fine mask on `source` plus the effective profile limits). */
  readonly aoi?: OptimizerAoiInput;
}

/**
 * `AOI_TOO_SMALL` (WP14): the AOI has cells on the fine grid but none on the coarse grid.
 * `NO_COVERAGE` (R14 WP14-1, AOI only): candidates were scored, but the best first-step gain is
 * ≤ 0 — no candidate adds AOI coverage with the chosen metric. `greedy` is kept for inspection.
 */
export type CoarseOptimizationStatus = "OK" | "CANCELLED" | "NO_CANDIDATES" | "AOI_TOO_SMALL" | "NO_COVERAGE";

/** Why an AOI run has no candidates. */
export type AoiNoCandidatesReason = "NO_ELIGIBLE_NODES" | "AOI_COVERS_ALL_ELIGIBLE_NODES" | "AOI_OUT_OF_RANGE";

export interface AoiCandidateInfo extends AoiOrientation {
  readonly index: number;
  /** Standalone objective of this candidate over the coarse AOI cells, percent (null unless OK). */
  readonly aoi_useful_pct: number | null;
}

export interface CoarseAoiResult {
  /** AOI cells on the full-resolution grid. */
  readonly fineCellCount: number;
  /** AOI cells on the coarse grid (the denominator of every `aoi_useful_pct`). */
  readonly coarseCellCount: number;
  readonly profile: OptimizerAoiProfile;
  /** Eligible nodes seen by the AOI filter, those outside the AOI, and those also within range. */
  readonly filter: Readonly<{ tested: number; outsideAoi: number; outsideAndInRange: number }>;
  /** Orientation (and, when OK, coarse AOI percentage) of every candidate, by index. */
  readonly candidates: AoiCandidateInfo[];
  /** Standalone coarse AOI percentage of every fixed radar (empty unless OK). */
  readonly fixed_aoi_useful_pct: Array<number | null>;
  readonly noCandidatesReason: AoiNoCandidatesReason | null;
  /** Spanish, user-facing explanation for NO_CANDIDATES, AOI_TOO_SMALL or NO_COVERAGE; null otherwise. */
  readonly message: string | null;
  /**
   * Spanish label of every `aoi_useful_pct` (R14 WP14-9): «Visible del área» for VISIBLE_AREA,
   * «Cobertura útil del área» otherwise, always «estimado en la grilla gruesa».
   */
  readonly pctLabel: string;
}

export interface CoarseOptimizationResult {
  readonly status: CoarseOptimizationStatus;
  readonly objective: OptimizerObjective;
  readonly candidateGeneration: Omit<CandidateGenerationResult, "candidates">;
  readonly candidates: Candidate[];
  readonly coarse: Readonly<{ factor: number; rows: number; cols: number; resolution: number }>;
  /** Radar height actually used for each candidate in the coarse pass. */
  readonly coarsePositions: Array<{ z: number; adjusted: boolean }>;
  /** Standalone coarse objective of each candidate (empty unless status is OK). */
  readonly candidateValues: number[];
  /** Standalone coarse objective of each fixed radar. */
  readonly fixedValues: number[];
  readonly greedy: GreedyResult | null;
  /** WP14, only with `aoi`. Labelled «estimado en la grilla gruesa» wherever it is shown. */
  readonly aoi?: CoarseAoiResult;
}

const AOI_MESSAGES: Readonly<Record<AoiNoCandidatesReason | "AOI_TOO_SMALL", string>> = {
  NO_ELIGIBLE_NODES: "No hay posiciones candidatas en este terreno (bermas, bordes ni grilla regular).",
  AOI_COVERS_ALL_ELIGIBLE_NODES: "Todas las posiciones candidatas quedan dentro del área a monitorear; el radar debe ubicarse fuera de ella.",
  AOI_OUT_OF_RANGE: "Ninguna posición candidata fuera del área queda dentro del alcance mínimo y máximo del perfil respecto del área.",
  AOI_TOO_SMALL: "El área a monitorear es más chica que la grilla gruesa del optimizador: no contiene ningún nodo de esa grilla.",
};
const NO_COVERAGE_MESSAGE = "Ninguna ubicación candidata ve el área con la métrica elegida.";
const NO_COVERAGE_WITH_FIXED_MESSAGE =
  "Ninguna ubicación candidata agrega cobertura del área a la de los radares fijos con la métrica elegida.";

function aoiPctLabel(objective: OptimizerObjective): string {
  const metric = objective === "VISIBLE_AREA" ? "Visible del área"
    : objective === "USEFUL_PROJECTION" ? "Cobertura útil del área (proyección del movimiento)"
      : "Cobertura útil del área (incidencia superficial)";
  return `${metric}, estimado en la grilla gruesa`;
}

function checkOutputSize(output: LosCellOutput, coarse: CoarseGrid, subject: LosSubject): void {
  const size = coarse.rows * coarse.cols;
  if (!(output.cell_states instanceof Uint8Array) || output.cell_states.length !== size) {
    throw new RangeError(`LOS output for ${subject.kind} ${subject.index} does not match the coarse grid (${size} cells)`);
  }
}

export function optimizeCoarse(input: CoarseOptimizationInput): CoarseOptimizationResult {
  const objective = input.objective ?? DEFAULT_OPTIMIZER_OBJECTIVE;
  const heightAboveGroundM = input.heightAboveGroundM ?? DEFAULT_HEIGHT_ABOVE_GROUND_M;
  const minSeparationM = input.minSeparationM ?? DEFAULT_MIN_SEPARATION_M;
  assertGreedyArguments({
    k: input.k, objective, policy: input.policy, minSeparationM, shortlistPerStep: input.shortlistPerStep,
    fixed: input.fixed,
  });
  const [rows, cols] = validateOptimizerGrid(input.source, "Optimizer DEM");
  if (typeof input.los !== "function") throw new TypeError("An LOS scorer must be injected");
  const fixed = input.fixed ?? [];
  for (const position of fixed) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      throw new RangeError("Fixed radar positions must be finite");
    }
  }

  const aoiInput = input.aoi;
  let fineAoiCount = 0;
  let aoiMask: Uint8Array | null = null;
  let inRange: ((x: number, y: number) => boolean) | null = null;
  if (aoiInput !== undefined) {
    if (!aoiInput || typeof aoiInput !== "object") throw new RangeError("AOI option must be an object");
    validateAoiProfile(aoiInput.profile);
    const polygon = validateAoiPolygon(aoiInput.polygon);
    const polygonMask = aoiMaskForGrid(input.source, polygon);
    if (aoiInput.mask !== undefined) {
      fineAoiCount = validateAoiMaskForGrid(aoiInput.mask, input.source);
      if (aoiInput.mask.some((value, idx) => value !== polygonMask[idx])) {
        throw new RangeError("AOI mask does not match aoiMaskForGrid(source, polygon)");
      }
    } else {
      fineAoiCount = validateAoiMaskForGrid(polygonMask, input.source);
    }
    aoiMask = polygonMask;
    inRange = aoiRangeFilter(polygon, aoiInput.profile.rangeMinM, aoiInput.profile.rangeMaxM);
  }

  const factor = input.coarseFactor ?? chooseCoarsenFactor(rows, cols, input.maxCoarseNodes ?? MAX_COARSE_NODES);
  const coarse = coarsenGrid(input.source, factor);
  const coarseAoiMask = aoiMask ? coarsenAoiMask(aoiMask, rows, cols, factor) : null;
  // AOI filter: outside the AOI and within range of it; tally what it saw for the reason.
  const tested = aoiInput ? new Uint8Array(rows * cols) : null;
  const { min_x: originX, min_y: originY } = input.source.bounds;
  const resolution = input.source.resolution;
  const nodeFilter = aoiMask && inRange ? (idx: number): boolean => {
    if (aoiMask[idx] === 1) {
      tested![idx] = 1;
      return false;
    }
    // Same node coordinates as the candidates (min + index·res).
    const ok = inRange(originX + (idx % cols) * resolution, originY + Math.floor(idx / cols) * resolution);
    tested![idx] = Math.max(tested![idx]!, ok ? 3 : 2);
    return ok;
  } : undefined;
  const generation = generateCandidates(input.source, {
    candidateSet: input.candidateSet,
    minSeparationM,
    heightAboveGroundM,
    params: input.candidateParams,
    // Last coarse node is the last multiple of f: nothing beyond it is represented.
    extentNodes: { rows: (coarse.rows - 1) * factor + 1, cols: (coarse.cols - 1) * factor + 1 },
    ...(nodeFilter ? {
      nodeFilter,
      openGround: true,
      nodeFilterFallbackReason: "Ninguna berma ni borde queda fuera del área a monitorear y dentro del alcance del perfil; " +
        "se usa una grilla regular de nodos con esa misma condición.",
      nodeFilterEmptyReason: "Ninguna berma, borde ni nodo de terreno abierto queda fuera del área a monitorear y dentro " +
        "del alcance del perfil.",
    } : {}),
  });
  const { candidates, ...candidateGeneration } = generation;
  const coarseInfo = { factor: coarse.factor, rows: coarse.rows, cols: coarse.cols, resolution: coarse.resolution };
  const coarsePositions = candidates.map((candidate) => coarseRadarZ(
    candidate.groundZ,
    input.sampleCoarseSurface ? input.sampleCoarseSurface(coarse, candidate.x, candidate.y) : null,
    heightAboveGroundM,
  ));
  const base = { objective, candidateGeneration, candidates, coarse: coarseInfo, coarsePositions };

  // WP14: AOI bookkeeping that does not need any LOS.
  let aoiBase: Omit<CoarseAoiResult, "candidates" | "fixed_aoi_useful_pct"> | null = null;
  let orientations: AoiOrientation[] = [];
  if (aoiInput && coarseAoiMask && tested) {
    let coarseCellCount = 0;
    for (let idx = 0; idx < coarseAoiMask.length; idx++) coarseCellCount += coarseAoiMask[idx]!;
    let testedCount = 0;
    let outside = 0;
    let outsideInRange = 0;
    for (let idx = 0; idx < tested.length; idx++) {
      const flag = tested[idx]!;
      if (flag === 0) continue;
      testedCount++;
      if (flag >= 2) outside++;
      if (flag === 3) outsideInRange++;
    }
    const noCandidatesReason: AoiNoCandidatesReason | null = candidates.length > 0 ? null
      : testedCount === 0 ? "NO_ELIGIBLE_NODES"
        : outside === 0 ? "AOI_COVERS_ALL_ELIGIBLE_NODES"
          : "AOI_OUT_OF_RANGE";
    aoiBase = {
      fineCellCount: fineAoiCount,
      coarseCellCount,
      profile: {
        rangeMinM: aoiInput.profile.rangeMinM,
        rangeMaxM: aoiInput.profile.rangeMaxM,
        azimuthWidthDeg: aoiInput.profile.azimuthWidthDeg,
      },
      filter: { tested: testedCount, outsideAoi: outside, outsideAndInRange: outsideInRange },
      noCandidatesReason,
      message: coarseCellCount === 0 ? AOI_MESSAGES.AOI_TOO_SMALL : noCandidatesReason ? AOI_MESSAGES[noCandidatesReason] : null,
      pctLabel: aoiPctLabel(objective),
    };
    if (coarseCellCount > 0 && candidates.length > 0) {
      const cells = prepareAoiCells(input.source, aoiMask!);
      orientations = candidates.map((candidate) =>
        orientTowardsAoi(cells, candidate.x, candidate.y, aoiInput.profile.azimuthWidthDeg));
    }
  }
  const aoiResult = (candidatePct: Array<number | null> | null, fixedPct: Array<number | null>): { aoi?: CoarseAoiResult } =>
    aoiBase === null ? {} : {
      aoi: {
        ...aoiBase,
        candidates: orientations.map((orientation, index) => ({
          index,
          ...orientation,
          aoi_useful_pct: candidatePct ? candidatePct[index]! : null,
        })),
        fixed_aoi_useful_pct: fixedPct,
      },
    };

  if (aoiBase !== null && aoiBase.coarseCellCount === 0) {
    return { ...base, status: "AOI_TOO_SMALL", candidateValues: [], fixedValues: [], greedy: null, ...aoiResult(null, []) };
  }
  if (candidates.length === 0) {
    return { ...base, status: "NO_CANDIDATES", candidateValues: [], fixedValues: [], greedy: null, ...aoiResult(null, []) };
  }
  const scoreAoi = coarseAoiMask ? { mask: coarseAoiMask } : undefined;

  const total = fixed.length + candidates.length;
  let done = 0;
  let bestValue: number | null = null;
  const evaluate = (subject: LosSubject, position: RadarPosition, azimuthCenterDeg?: number): CoverageScore | null => {
    if (input.isCancelled?.()) return null;
    const output = input.los(azimuthCenterDeg === undefined
      ? { subject, position, grid: coarse }
      : { subject, position, grid: coarse, azimuthCenterDeg });
    checkOutputSize(output, coarse, subject);
    const score = scoreLosOutput(output, objective, input.policy, scoreAoi);
    done++;
    if (subject.kind === "candidate" && (bestValue === null || score.value > bestValue)) bestValue = score.value;
    input.onProgress?.({ phase: "coarse_los", done, total, bestValue });
    return score;
  };
  const cancelled = (): CoarseOptimizationResult =>
    ({ ...base, status: "CANCELLED", candidateValues: [], fixedValues: [], greedy: null, ...aoiResult(null, []) });

  const fixedInputs: GreedyCandidateInput[] = [];
  for (let index = 0; index < fixed.length; index++) {
    const position = fixed[index]!;
    const score = evaluate({ kind: "fixed", index }, { x: position.x, y: position.y, z: position.z });
    if (!score) return cancelled();
    fixedInputs.push({ score, x: position.x, y: position.y });
  }
  const candidateInputs: GreedyCandidateInput[] = [];
  for (const candidate of candidates) {
    const z = coarsePositions[candidate.index]!.z;
    const score = evaluate({ kind: "candidate", index: candidate.index }, { x: candidate.x, y: candidate.y, z },
      aoiBase === null ? undefined : orientations[candidate.index]!.az_center_deg);
    if (!score) return cancelled();
    candidateInputs.push({ score, x: candidate.x, y: candidate.y });
  }

  const greedy = greedySelect(candidateInputs, {
    k: input.k,
    objective,
    policy: input.policy,
    minSeparationM,
    fixed: fixedInputs,
    shortlistPerStep: input.shortlistPerStep,
    ...(scoreAoi ? { aoi: scoreAoi } : {}),
  });
  const coarseCells = aoiBase?.coarseCellCount ?? 0;
  // R14 WP14-1: with an AOI, a best first-step gain ≤ 0 is not a result to show.
  const noCoverage = aoiBase !== null && greedy.steps.length === 0 && greedy.stopReason === "NO_IMPROVEMENT";
  if (noCoverage) {
    const anySees = candidateInputs.some((entry) => entry.score.value > 0);
    aoiBase = { ...aoiBase!, message: anySees && fixedInputs.length > 0 ? NO_COVERAGE_WITH_FIXED_MESSAGE : NO_COVERAGE_MESSAGE };
  }
  return {
    ...base,
    status: noCoverage ? "NO_COVERAGE" : "OK",
    candidateValues: candidateInputs.map((entry) => entry.score.value),
    fixedValues: fixedInputs.map((entry) => entry.score.value),
    greedy,
    ...aoiResult(
      candidateInputs.map((entry) => aoiPercent(entry.score.value, coarseCells)),
      fixedInputs.map((entry) => aoiPercent(entry.score.value, coarseCells)),
    ),
  };
}
