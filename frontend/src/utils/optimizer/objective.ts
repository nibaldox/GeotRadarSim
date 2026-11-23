/**
 * Optimizer objective, defined to agree exactly with what the app reports.
 *
 * The app's union (`mergeResults`) marks a cell NODATA when any radar says NODATA,
 * otherwise VISIBLE when any radar sees it; it takes the maximum incidence and the RMS
 * of the VISIBLE finite projections. `computeQualitySummary` then counts VISIBLE cells
 * and "useful" cells, i.e. VISIBLE cells whose Float32 index is ≥ Float32(mediumMin)
 * (`classifyQualityValue`).
 *
 * - VISIBLE_AREA     → `summary.visibleCount`
 * - USEFUL_INCIDENCE → `summary.usefulCount` with metric INCIDENCE. Because Float32
 *   rounding is monotone, "useful in the union (max)" ⇔ "useful for some radar",
 *   so the objective is the size of a set union: monotone and submodular, and
 *   independent of the union order.
 * - USEFUL_PROJECTION → `summary.usefulCount` with metric PROJECTION. The union is
 *   an RMS, so adding a radar can lower a cell below the threshold: not monotone.
 *   The sum of squares is accumulated in double from left to right, like
 *   `mergeResults`, and double addition is not associative: the value is exact **for
 *   the given union order only**. `evaluateUnion` and `UnionState.add` use the order
 *   given; `UnionState.prepend` puts a radar first. The app unions its history from the
 *   newest entry to the oldest, so the greedy selection prepends each chosen radar
 *   (see `greedy.ts`).
 *
 * All values are integer cell counts. Every score carries the quality policy it was
 * computed with and its VISIBLE/NODATA masks; mixing policies, or a radar seeing a cell
 * another radar marks NODATA, is rejected. geometric-v2 indices live in [0, 1]; a VISIBLE
 * finite incidence above 1 or projection outside [0, 1] is rejected rather than guessed,
 * because the union and the per-radar view would disagree on it.
 */

import { LOSCellState } from "../../types/api";
import { classifyQualityValue, isValidQualityPolicy } from "../qualityMetrics";
import type { QualityMetric, QualityPolicy, QualitySummary } from "../qualityMetrics";
import { aoiMaskCellCount, aoiMaskFingerprint } from "../aoi/aoiMask";
import type { AoiCoverage } from "../aoi/aoiCoverage";
import type { LosCellOutput, OptimizerAoiMask, OptimizerObjective } from "./types";

const OBJECTIVES: ReadonlySet<string> = new Set(["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"]);
const KNOWN_CELL_STATES: ReadonlySet<number> = new Set(Object.values(LOSCellState));

export interface CoverageScore {
  readonly objective: OptimizerObjective;
  /** Policy the score was computed with (exact thresholds). */
  readonly policy: Readonly<QualityPolicy>;
  /** Cells of the grid the score was computed on. */
  readonly size: number;
  /**
   * Bitset over cells: VISIBLE (VISIBLE_AREA), useful (USEFUL_INCIDENCE), or
   * VISIBLE with a finite projection, i.e. an RMS contributor (USEFUL_PROJECTION).
   */
  readonly mask: Uint32Array;
  /** Bitset of the VISIBLE cells. */
  readonly visible: Uint32Array;
  /** Bitset of the NODATA cells. */
  readonly nodata: Uint32Array;
  /** USEFUL_PROJECTION only: Float32 projection per cell (meaningful on mask bits). */
  readonly projection: Float32Array | null;
  /** Objective value of this radar alone (integer). */
  readonly value: number;
  /**
   * WP14, only present when scored with an AOI: the mask identity and its cell count. The
   * objective bits (`mask`) and `value` then cover AOI cells only; `visible` and `nodata`
   * still cover the whole grid (they only guard union coherence).
   */
  readonly aoi?: Readonly<{ key: string; cellCount: number }>;
}

/** Validate an AOI mask for a grid of `size` cells; returns its identity and cell count. */
export function resolveAoiMask(aoi: OptimizerAoiMask, size: number): { mask: Uint8Array; key: string; cellCount: number } {
  if (!aoi || !(aoi.mask instanceof Uint8Array)) throw new RangeError("AOI mask must be a Uint8Array");
  if (aoi.mask.length !== size) {
    throw new RangeError(`AOI mask has ${aoi.mask.length} cells but the grid has ${size}`);
  }
  const cellCount = aoiMaskCellCount(aoi.mask);
  return { mask: aoi.mask, key: aoiMaskFingerprint(aoi.mask), cellCount };
}

export function assertOptimizerObjective(objective: OptimizerObjective): void {
  if (!OBJECTIVES.has(objective)) throw new RangeError(`Unknown optimizer objective: ${String(objective)}`);
}

export function assertQualityPolicy(policy: QualityPolicy): void {
  if (!isValidQualityPolicy(policy)) throw new RangeError("Invalid quality policy");
}

const samePolicy = (left: QualityPolicy, right: QualityPolicy): boolean =>
  left.mediumMin === right.mediumMin && left.highMin === right.highMin;

/** Same band test as the summary's useful numerator (medium or high, Float32). */
function isUseful(value: number, policy: QualityPolicy): boolean {
  const band = classifyQualityValue(value, policy);
  return band === "medium" || band === "high";
}

export function popcount32(word: number): number {
  let x = word - ((word >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

const wordsFor = (size: number): number => Math.ceil(size / 32);
const setBit = (bits: Uint32Array, idx: number): void => {
  bits[idx >>> 5] = bits[idx >>> 5]! | (1 << (idx & 31));
};

/**
 * Turn one LOS output into the per-candidate data the greedy selection needs. With `aoi`,
 * only AOI cells count (the same cells `computeAoiCoverage` counts); an AOI cell marked
 * NODATA is rejected, because the mask says it has valid terrain.
 */
export function scoreLosOutput(
  output: LosCellOutput,
  objective: OptimizerObjective,
  policy: QualityPolicy,
  aoi?: OptimizerAoiMask,
): CoverageScore {
  assertOptimizerObjective(objective);
  assertQualityPolicy(policy);
  const states = output.cell_states;
  if (!(states instanceof Uint8Array) || states.length === 0) {
    throw new RangeError("LOS output must carry a non-empty Uint8Array of cell states");
  }
  const size = states.length;
  if (!(output.flat_quality_grid instanceof Float32Array) || output.flat_quality_grid.length !== size ||
      !(output.flat_projection_grid instanceof Float32Array) || output.flat_projection_grid.length !== size) {
    throw new RangeError("LOS quality/projection grids must be Float32Array with one value per cell");
  }
  const resolvedAoi = aoi === undefined ? null : resolveAoiMask(aoi, size);
  const aoiCells = resolvedAoi?.mask ?? null;
  const words = wordsFor(size);
  const mask = new Uint32Array(words);
  const visible = new Uint32Array(words);
  const nodata = new Uint32Array(words);
  const projection = objective === "USEFUL_PROJECTION" ? new Float32Array(size).fill(Number.NaN) : null;
  let value = 0;
  for (let idx = 0; idx < size; idx++) {
    const state = states[idx]!;
    if (!KNOWN_CELL_STATES.has(state)) throw new RangeError(`Unknown LOS cell state ${state} at cell ${idx}`);
    if (state === LOSCellState.NODATA) {
      if (aoiCells !== null && aoiCells[idx] === 1) throw new RangeError(`AOI cell ${idx} is NODATA in the LOS output`);
      setBit(nodata, idx);
    }
    if (state !== LOSCellState.VISIBLE) continue;
    setBit(visible, idx);
    if (aoiCells !== null && aoiCells[idx] !== 1) continue;
    let set = false;
    if (objective === "VISIBLE_AREA") {
      set = true;
      value++;
    } else if (objective === "USEFUL_INCIDENCE") {
      const q = output.flat_quality_grid[idx]!;
      if (Number.isFinite(q) && q > 1) throw new RangeError(`Incidence ${q} above 1 at VISIBLE cell ${idx}`);
      if (isUseful(q, policy)) {
        set = true;
        value++;
      }
    } else {
      const p = output.flat_projection_grid[idx]!;
      if (Number.isFinite(p)) {
        if (p < 0 || p > 1) throw new RangeError(`Projection ${p} outside [0, 1] at VISIBLE cell ${idx}`);
        set = true;
        projection![idx] = p;
        if (isUseful(p, policy)) value++;
      }
    }
    if (set) setBit(mask, idx);
  }
  const score: CoverageScore = {
    objective,
    policy: { mediumMin: policy.mediumMin, highMin: policy.highMin },
    size,
    mask,
    visible,
    nodata,
    projection,
    value,
  };
  return resolvedAoi === null ? score : { ...score, aoi: { key: resolvedAoi.key, cellCount: resolvedAoi.cellCount } };
}

function forEachSetBit(bits: Uint32Array, visit: (idx: number) => void): void {
  for (let w = 0; w < bits.length; w++) {
    let word = bits[w]!;
    while (word !== 0) {
      const bit = 31 - Math.clz32(word & -word);
      word &= word - 1;
      visit((w << 5) + bit);
    }
  }
}

/**
 * Incremental union of scores with an explicit order; `value` is always the exact
 * objective of that ordered union. `add` appends at the end, `prepend` inserts first.
 */
export class UnionState {
  readonly objective: OptimizerObjective;
  readonly policy: Readonly<QualityPolicy>;
  readonly size: number;
  private readonly union: Uint32Array;
  private readonly visible: Uint32Array;
  private readonly nodata: Uint32Array;
  /** USEFUL_PROJECTION: per-cell squares in union order, `capacity` slots per cell. */
  private squares: Float64Array | null;
  private capacity: number;
  private readonly contributors: Uint32Array | null;
  private readonly useful: Uint8Array | null;
  private current = 0;
  /** WP14: identity of the AOI every score must carry (null = no AOI). */
  readonly aoiKey: string | null;
  /** WP14: AOI cells of the union grid (null = no AOI). */
  readonly aoiCellCount: number | null;

  constructor(objective: OptimizerObjective, policy: QualityPolicy, size: number, aoi?: OptimizerAoiMask) {
    assertOptimizerObjective(objective);
    assertQualityPolicy(policy);
    if (!Number.isInteger(size) || size < 1) throw new RangeError("Union size must be a positive integer");
    const resolvedAoi = aoi === undefined ? null : resolveAoiMask(aoi, size);
    this.aoiKey = resolvedAoi?.key ?? null;
    this.aoiCellCount = resolvedAoi?.cellCount ?? null;
    this.objective = objective;
    this.policy = { mediumMin: policy.mediumMin, highMin: policy.highMin };
    this.size = size;
    const words = wordsFor(size);
    this.union = new Uint32Array(words);
    this.visible = new Uint32Array(words);
    this.nodata = new Uint32Array(words);
    const rms = objective === "USEFUL_PROJECTION";
    this.capacity = rms ? 4 : 0;
    this.squares = rms ? new Float64Array(size * this.capacity) : null;
    this.contributors = rms ? new Uint32Array(size) : null;
    this.useful = rms ? new Uint8Array(size) : null;
  }

  get value(): number {
    return this.current;
  }

  private check(score: CoverageScore): void {
    if (score.objective !== this.objective) {
      throw new RangeError(`Score objective ${score.objective} does not match union objective ${this.objective}`);
    }
    if (!score.policy || !samePolicy(score.policy, this.policy)) {
      throw new RangeError("Score quality policy does not match the union policy");
    }
    if (score.size !== this.size || score.mask.length !== this.union.length ||
        score.visible.length !== this.union.length || score.nodata.length !== this.union.length) {
      throw new RangeError("Score grid size does not match the union grid");
    }
    if (this.objective === "USEFUL_PROJECTION" && (!score.projection || score.projection.length !== this.size)) {
      throw new RangeError("Projection score is missing its projection values");
    }
    if ((score.aoi?.key ?? null) !== this.aoiKey) {
      throw new RangeError("Score AOI does not match the union AOI");
    }
    for (let w = 0; w < this.union.length; w++) {
      if ((score.visible[w]! & this.nodata[w]!) !== 0 || (score.nodata[w]! & this.visible[w]!) !== 0) {
        throw new RangeError("A radar marks VISIBLE a cell that another radar marks NODATA");
      }
    }
  }

  /** Double sum of squares exactly as `mergeResults` folds it, with p² inserted first or last. */
  private projectionUsefulWith(idx: number, p: number, first: boolean): boolean {
    const count = this.contributors![idx]!;
    const base = idx * this.capacity;
    let sum = 0;
    if (first) sum += p * p;
    for (let j = 0; j < count; j++) sum += this.squares![base + j]!;
    if (!first) sum += p * p;
    return isUseful(Math.fround(Math.sqrt(sum / (count + 1))), this.policy);
  }

  private projectionGain(score: CoverageScore, first: boolean): number {
    let gain = 0;
    forEachSetBit(score.mask, (idx) => {
      const after = this.projectionUsefulWith(idx, score.projection![idx]!, first) ? 1 : 0;
      gain += after - this.useful![idx]!;
    });
    return gain;
  }

  private ensureCapacity(): void {
    let needed = 0;
    for (let idx = 0; idx < this.size; idx++) needed = Math.max(needed, this.contributors![idx]!);
    if (needed < this.capacity) return;
    const capacity = this.capacity * 2;
    const squares = new Float64Array(this.size * capacity);
    for (let idx = 0; idx < this.size; idx++) {
      squares.set(this.squares!.subarray(idx * this.capacity, idx * this.capacity + this.contributors![idx]!), idx * capacity);
    }
    this.squares = squares;
    this.capacity = capacity;
  }

  private insert(score: CoverageScore, first: boolean): void {
    this.check(score);
    for (let w = 0; w < this.union.length; w++) {
      this.visible[w] = this.visible[w]! | score.visible[w]!;
      this.nodata[w] = this.nodata[w]! | score.nodata[w]!;
    }
    if (this.objective !== "USEFUL_PROJECTION") {
      let value = 0;
      for (let w = 0; w < this.union.length; w++) {
        this.union[w] = this.union[w]! | score.mask[w]!;
        value += popcount32(this.union[w]!);
      }
      this.current = value;
      return;
    }
    this.ensureCapacity();
    forEachSetBit(score.mask, (idx) => {
      const p = score.projection![idx]!;
      const after = this.projectionUsefulWith(idx, p, first) ? 1 : 0;
      this.current += after - this.useful![idx]!;
      this.useful![idx] = after;
      const base = idx * this.capacity;
      const count = this.contributors![idx]!;
      if (first) {
        for (let j = count; j > 0; j--) this.squares![base + j] = this.squares![base + j - 1]!;
        this.squares![base] = p * p;
      } else {
        this.squares![base + count] = p * p;
      }
      this.contributors![idx] = count + 1;
    });
  }

  /** Exact change of the objective if `score` were appended (may be negative for projection). */
  gainOf(score: CoverageScore): number {
    this.check(score);
    if (this.objective !== "USEFUL_PROJECTION") {
      let gain = 0;
      for (let w = 0; w < this.union.length; w++) gain += popcount32(score.mask[w]! & ~this.union[w]!);
      return gain;
    }
    return this.projectionGain(score, false);
  }

  /** Exact change of the objective if `score` were inserted first in the union order. */
  gainOfPrepend(score: CoverageScore): number {
    if (this.objective !== "USEFUL_PROJECTION") return this.gainOf(score);
    this.check(score);
    return this.projectionGain(score, true);
  }

  /** Append `score` at the end of the union order. */
  add(score: CoverageScore): void {
    this.insert(score, false);
  }

  /** Insert `score` first in the union order (the app's newest history entry). */
  prepend(score: CoverageScore): void {
    this.insert(score, true);
  }
}

/**
 * Objective value of the union of `scores` in the given order (0 for an empty list). With
 * `aoi`, every score must have been computed with the same AOI mask.
 */
export function evaluateUnion(
  scores: readonly CoverageScore[],
  objective: OptimizerObjective,
  policy: QualityPolicy,
  aoi?: OptimizerAoiMask,
): number {
  assertOptimizerObjective(objective);
  assertQualityPolicy(policy);
  if (scores.length === 0) return 0;
  const union = new UnionState(objective, policy, scores[0]!.size, aoi);
  for (const score of scores) union.add(score);
  return union.value;
}

/** Summary metric whose numbers the objective reproduces. */
export function objectiveQualityMetric(objective: OptimizerObjective): QualityMetric {
  assertOptimizerObjective(objective);
  return objective === "USEFUL_PROJECTION" ? "PROJECTION" : "INCIDENCE";
}

/**
 * The objective value as read from a `computeQualitySummary` result. The summary must
 * have been computed with exactly `policy` (the optimizer's policy) and, for USEFUL_*,
 * with the objective's metric.
 */
export function objectiveValueFromSummary(summary: QualitySummary, objective: OptimizerObjective, policy: QualityPolicy): number {
  assertOptimizerObjective(objective);
  assertQualityPolicy(policy);
  if (!samePolicy(summary.policy, policy)) {
    throw new RangeError("Summary quality policy does not match the optimizer policy");
  }
  if (objective === "VISIBLE_AREA") return summary.visibleCount;
  if (summary.metric !== objectiveQualityMetric(objective)) {
    throw new RangeError(`Summary metric ${summary.metric} does not match objective ${objective}`);
  }
  return summary.usefulCount;
}

/**
 * WP14: the objective value as read from a `computeAoiCoverage` result, the AOI analogue of
 * {@link objectiveValueFromSummary}. Same policy and metric rules.
 */
export function objectiveValueFromAoiCoverage(coverage: AoiCoverage, objective: OptimizerObjective, policy: QualityPolicy): number {
  assertOptimizerObjective(objective);
  assertQualityPolicy(policy);
  if (!samePolicy(coverage.policy, policy)) {
    throw new RangeError("AOI coverage quality policy does not match the optimizer policy");
  }
  if (objective === "VISIBLE_AREA") return coverage.visibleCount;
  if (coverage.metric !== objectiveQualityMetric(objective)) {
    throw new RangeError(`AOI coverage metric ${coverage.metric} does not match objective ${objective}`);
  }
  return coverage.usefulCount;
}
