/**
 * Greedy selection of k radar positions over precomputed coverage scores.
 *
 * Plain (non-lazy) greedy: every step evaluates the exact marginal gain of every
 * feasible candidate. Gains are integer cell counts, so the result does not depend
 * on floating-point accumulation order; ties go to the lower candidate index.
 * Lazy evaluation would select the same set for monotone objectives; it is left out
 * because the step shortlist needs exact gains and the cost (k·N·cells/32 word
 * operations) is negligible next to the LOS evaluations.
 *
 * Guarantee: for VISIBLE_AREA / USEFUL_INCIDENCE without a separation constraint the
 * objective is monotone submodular and greedy reaches ≥ (1 − 1/e)·OPT (Nemhauser,
 * Wolsey & Fisher, 1978), also relative to fixed radars. With `min_separation_m` > 0
 * it is a heuristic. USEFUL_PROJECTION is not monotone: no guarantee, and the search
 * stops before k when no addition improves.
 *
 * Scope of the guarantee (`guaranteeScope: "coarse_thinned_candidates"`): it is relative
 * to the optimum over the given (thinned) candidates, on the grid the scores were computed
 * on (the coarse grid), without separation. It is never a guarantee about the
 * full-resolution result nor about the optimum over unthinned positions.
 *
 * Union order (matters only for USEFUL_PROJECTION, whose RMS is not associative): the app
 * unions its history from the newest entry to the oldest. So the fixed radars enter first,
 * in the order given — which must be their history order, newest first — and every chosen
 * candidate is **prepended**: after choosing c1, c2, …, the union is [ck, …, c2, c1, fixed…],
 * exactly the history the app shows when the candidates are run in selection order.
 */

import type { QualityPolicy } from "../qualityMetrics";
import { aoiPercent } from "../aoi/aoiCoverage";
import { UnionState, assertOptimizerObjective, assertQualityPolicy } from "./objective";
import type { CoverageScore } from "./objective";
import type { OptimizerAoiMask, OptimizerObjective } from "./types";

export interface GreedyCandidateInput {
  readonly score: CoverageScore;
  /** Horizontal position used by the separation constraint, metres. */
  readonly x: number;
  readonly y: number;
}

export interface GreedyOptions {
  readonly k: number;
  readonly objective: OptimizerObjective;
  readonly policy: QualityPolicy;
  /** Candidates strictly closer than this (horizontal) to a chosen or fixed radar are excluded. */
  readonly minSeparationM?: number;
  /** Radars kept as they are, in app history order (newest first); they close the union order. */
  readonly fixed?: readonly GreedyCandidateInput[];
  /** Best candidates recorded per step for the full-resolution refinement (default 3). */
  readonly shortlistPerStep?: number;
  /** Most radars in the union (fixed + k), default {@link MAX_UNION_RADARS}. */
  readonly maxUnion?: number;
  /**
   * WP14: AOI mask of the score grid. Every score (candidates and fixed) must have been
   * scored with this same mask; the result then carries `aoi_useful_pct` per step, per step
   * top entry and for the final union (objective value / AOI cells × 100).
   */
  readonly aoi?: OptimizerAoiMask;
}

export type GreedyGuarantee = "1-1/e" | "heuristic" | "none";
/** What the guarantee is relative to: the thinned candidates on the coarse grid. */
export type GreedyGuaranteeScope = "coarse_thinned_candidates";
export const GREEDY_GUARANTEE_SCOPE: GreedyGuaranteeScope = "coarse_thinned_candidates";
/**
 * Most radars one union may hold: fixed + k. The app keeps 10 history entries
 * (`analysisStore.ts` runAnalysis, `.slice(0, 10)`), so a larger union cannot be shown (R1C-WP7-2).
 */
export const MAX_UNION_RADARS = 10;
export type UnionMember = { readonly kind: "candidate" | "fixed"; readonly index: number };
export type GreedyStopReason = "K_REACHED" | "NO_IMPROVEMENT" | "NO_FEASIBLE_CANDIDATE";

export interface GreedyStep {
  readonly step: number;
  readonly selected: number;
  readonly marginalGain: number;
  /** Union value (fixed + chosen so far, in app union order) after this step. */
  readonly unionValue: number;
  /**
   * Feasible candidates with the highest gains at this step (gain desc, index asc). With an
   * AOI each entry also carries the `aoi_useful_pct` of the union it would give.
   */
  readonly top: ReadonlyArray<{ readonly index: number; readonly gain: number; readonly aoi_useful_pct?: number | null }>;
  /** WP14, with an AOI only: `unionValue` as a percentage of the AOI cells (coarse estimate). */
  readonly aoi_useful_pct?: number | null;
}

export interface GreedyResult {
  readonly objective: OptimizerObjective;
  readonly k: number;
  /** Chosen candidate indices, in selection order (= union order after the fixed radars). */
  readonly selected: number[];
  readonly steps: GreedyStep[];
  /** Objective of the fixed radars alone. */
  readonly baseValue: number;
  /** Objective of fixed + selected, in app union order (`unionOrder`). */
  readonly value: number;
  readonly stopReason: GreedyStopReason;
  readonly guarantee: GreedyGuarantee;
  readonly guaranteeScope: GreedyGuaranteeScope;
  /** The union as the app will merge it: chosen candidates newest first, then the fixed radars. */
  readonly unionOrder: UnionMember[];
  /** Unique candidates for refinement: selected first, then the step tops; at most shortlistPerStep·k. */
  readonly shortlist: number[];
  /** WP14, with an AOI only: AOI cells of the score grid (the percentage denominator). */
  readonly aoiCellCount?: number;
  /** WP14, with an AOI only: `baseValue` as a percentage of the AOI cells. */
  readonly base_aoi_useful_pct?: number | null;
  /** WP14, with an AOI only: `value` as a percentage of the AOI cells (coarse estimate). */
  readonly aoi_useful_pct?: number | null;
}

function assertPosition(entry: GreedyCandidateInput, label: string): void {
  if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) throw new RangeError(`${label} position must be finite`);
}

/**
 * Validate the scalar greedy arguments (also used up front by `optimizeCoarse`, before any LOS).
 * `fixed` is only counted: fixed + k must fit in the union limit (`maxUnion`, default 10), or the
 * app history would truncate the union and the reported value would not be shown (R1C-WP7-2).
 */
export function assertGreedyArguments(options: Pick<GreedyOptions, "k" | "objective" | "policy" | "minSeparationM" | "shortlistPerStep" | "maxUnion"> & { readonly fixed?: readonly unknown[] }): void {
  const { k } = options;
  if (!Number.isInteger(k) || k < 1) throw new RangeError("k must be a positive integer");
  const maxUnion = options.maxUnion ?? MAX_UNION_RADARS;
  if (!Number.isInteger(maxUnion) || maxUnion < 1) throw new RangeError("maxUnion must be a positive integer");
  const fixedCount = options.fixed?.length ?? 0;
  if (fixedCount + k > maxUnion) {
    throw new RangeError(`Fixed radars (${fixedCount}) + k (${k}) must be at most ${maxUnion}: the app history keeps ${maxUnion} entries, so the union would be truncated`);
  }
  assertOptimizerObjective(options.objective);
  assertQualityPolicy(options.policy);
  const minSeparationM = options.minSeparationM ?? 0;
  if (!Number.isFinite(minSeparationM) || minSeparationM < 0) {
    throw new RangeError("min_separation_m must be finite and non-negative");
  }
  const shortlistPerStep = options.shortlistPerStep ?? 3;
  if (!Number.isInteger(shortlistPerStep) || shortlistPerStep < 1) {
    throw new RangeError("shortlistPerStep must be a positive integer");
  }
}

export function greedySelect(candidates: readonly GreedyCandidateInput[], options: GreedyOptions): GreedyResult {
  assertGreedyArguments(options);
  const { k, objective, policy } = options;
  const minSeparationM = options.minSeparationM ?? 0;
  const fixed = options.fixed ?? [];
  const shortlistPerStep = options.shortlistPerStep ?? 3;
  candidates.forEach((candidate, index) => assertPosition(candidate, `Candidate ${index}`));
  fixed.forEach((entry, index) => assertPosition(entry, `Fixed radar ${index}`));

  const guarantee: GreedyGuarantee = objective === "USEFUL_PROJECTION"
    ? "none"
    : minSeparationM > 0 ? "heuristic" : "1-1/e";
  const fixedOrder: UnionMember[] = fixed.map((_, index) => ({ kind: "fixed", index }));
  const all = [...fixed, ...candidates];
  if (all.length === 0) {
    const empty: GreedyResult = {
      objective, k, selected: [], steps: [], baseValue: 0, value: 0, stopReason: "NO_FEASIBLE_CANDIDATE",
      guarantee, guaranteeScope: GREEDY_GUARANTEE_SCOPE, unionOrder: fixedOrder, shortlist: [],
    };
    if (options.aoi === undefined) return empty;
    if (!(options.aoi?.mask instanceof Uint8Array)) throw new RangeError("AOI mask must be a Uint8Array");
    const cells = new UnionState(objective, policy, options.aoi.mask.length, options.aoi).aoiCellCount!;
    return { ...empty, aoiCellCount: cells, base_aoi_useful_pct: aoiPercent(0, cells), aoi_useful_pct: aoiPercent(0, cells) };
  }

  const union = new UnionState(objective, policy, all[0]!.score.size, options.aoi);
  const aoiCells = union.aoiCellCount;
  const pct = (value: number): number | null => aoiPercent(value, aoiCells!);
  for (const entry of fixed) union.add(entry.score);
  // Validate every candidate against the union up front (objective and grid size).
  for (const candidate of candidates) union.gainOfPrepend(candidate.score);
  const baseValue = union.value;

  const separation2 = minSeparationM * minSeparationM;
  const excluded = new Uint8Array(candidates.length);
  const excludeNear = (x: number, y: number) => {
    if (separation2 === 0) return;
    candidates.forEach((candidate, index) => {
      const dx = candidate.x - x;
      const dy = candidate.y - y;
      if (dx * dx + dy * dy < separation2) excluded[index] = 1;
    });
  };
  for (const entry of fixed) excludeNear(entry.x, entry.y);

  const selected: number[] = [];
  const steps: GreedyStep[] = [];
  let stopReason: GreedyStopReason = "K_REACHED";
  for (let step = 0; step < k; step++) {
    const gains: Array<{ index: number; gain: number }> = [];
    candidates.forEach((candidate, index) => {
      if (!excluded[index]) gains.push({ index, gain: union.gainOfPrepend(candidate.score) });
    });
    if (gains.length === 0) {
      stopReason = "NO_FEASIBLE_CANDIDATE";
      break;
    }
    gains.sort((a, b) => b.gain - a.gain || a.index - b.index);
    const best = gains[0]!;
    if (best.gain <= 0) {
      stopReason = "NO_IMPROVEMENT";
      break;
    }
    const chosen = candidates[best.index]!;
    union.prepend(chosen.score);
    selected.push(best.index);
    excluded[best.index] = 1;
    excludeNear(chosen.x, chosen.y);
    const before = union.value - best.gain;
    const baseStep: GreedyStep = {
      step: step + 1,
      selected: best.index,
      marginalGain: best.gain,
      unionValue: union.value,
      top: gains.slice(0, shortlistPerStep).map(({ index, gain }) =>
        aoiCells === null ? { index, gain } : { index, gain, aoi_useful_pct: pct(before + gain) }),
    };
    steps.push(aoiCells === null ? baseStep : { ...baseStep, aoi_useful_pct: pct(union.value) });
  }

  const shortlist: number[] = [];
  const seen = new Set<number>();
  const limit = shortlistPerStep * k;
  for (const index of [...selected, ...steps.flatMap((s) => s.top.map((t) => t.index))]) {
    if (shortlist.length >= limit) break;
    if (seen.has(index)) continue;
    seen.add(index);
    shortlist.push(index);
  }
  const unionOrder: UnionMember[] = [
    ...[...selected].reverse().map((index): UnionMember => ({ kind: "candidate", index })),
    ...fixedOrder,
  ];
  const result: GreedyResult = {
    objective, k, selected, steps, baseValue, value: union.value, stopReason, guarantee,
    guaranteeScope: GREEDY_GUARANTEE_SCOPE, unionOrder, shortlist,
  };
  if (aoiCells === null) return result;
  return { ...result, aoiCellCount: aoiCells, base_aoi_useful_pct: pct(baseValue), aoi_useful_pct: pct(union.value) };
}
