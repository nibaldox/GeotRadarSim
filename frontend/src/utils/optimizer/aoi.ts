/**
 * WP14: the AOI inside the optimizer (coarse mask, candidate range filter, orientation).
 *
 * - Coarse mask: the same subsampling rule as `coarsenGrid` — coarse node (r, c) is fine
 *   node (r·f, c·f) — so `coarse[r·C + c] = fine[(r·f)·cols + c·f]`. Only the objective (the
 *   coarse estimate) uses it.
 * - Range filter (R14 WP14-3, WP14-7): O(V) per node, from the AOI polygon. With
 *   [dmin, dmax] the horizontal distance range from the node to the closed polygon
 *   (`aoiPolygonDistanceRange`: 0 inside, nearest edge outside; farthest vertex), a node
 *   qualifies when [dmin, dmax] meets [rangeMin, rangeMax], inclusive with a relative
 *   tolerance of 1e-9 · max(1, limit) on each limit. The polygon is connected, so every
 *   distance in [dmin, dmax] is reached by a point of it; every AOI cell lies in the closed
 *   polygon, so a node from which the engine accepts some AOI cell
 *   (`!(hypot < min || hypot > max)`) is never rejected. False positives (a band met only
 *   between nodes) are allowed: the real LOS decides.
 * - Orientation and fit (R14 WP14-2, WP14-6), on the FINE AOI cells with the exact bearings of
 *   the LOS engine: dx = (min_x + c·res) − x, dy = (min_y + r·res) − y, atan2(dx, dy)·180/π
 *   (`workers/losWorker.ts` L518 and L527-537). From the sorted bearings:
 *   - the minimal arc is the complement of the largest circular gap (ties: the first gap in
 *     ascending order); `aoi_spread_deg` is its length;
 *   - if the arc fits in the width, `az_center_deg` is the arc midpoint;
 *   - otherwise, among the width-wide windows that start at a bearing, the one holding the
 *     most bearings is chosen (ties: the smallest starting bearing in (−180, 180], so the
 *     choice does not depend on the cell order), and `az_center_deg` is the midpoint of the
 *     bearings it holds (the slack is split on both sides);
 *   - bearings are handled relative to the first cell's bearing (a rotation, same gaps); when
 *     they span less than 180° the most populated window is found with bucketed counts and
 *     lazily sorted buckets instead of a full sort (same result, tested against the sort);
 *   - `aoi_in_azimuth_pct` and `aoi_fits_azimuth` are then counted exactly with the app's
 *     window `normalizeAzimuthRange(az_center_deg, width)` and the engines' inclusive test
 *     over every fine AOI cell. So `aoi_fits_azimuth: true` ⇔ the full-resolution LOS with
 *     that centre puts no AOI cell in OUTSIDE_FOV (the TS engine computes the same doubles;
 *     the WASM engine matches it through the existing TS↔WASM parity).
 *   A width ≥ 360 is the full circle (always fits). A candidate that does not fit is kept.
 */

import { aoiAzimuthWindow, bearingDeg, isBearingInWindow } from "../aoi/aoiAzimuth";
import { aoiPercent } from "../aoi/aoiCoverage";
import { aoiMaskCellCount } from "../aoi/aoiMask";
import { aoiPolygonDistanceRange } from "../aoi/aoiPolygon";
import type { AoiPolygon, ValidatedAoiPolygon } from "../aoi/aoiPolygon";
import { coarseNodeCount } from "./coarsen";
import type { OptimizerGrid } from "./types";

/** Effective radar limits the AOI logic needs (from the app's effective profile). */
export interface OptimizerAoiProfile {
  /** Effective minimum horizontal range, metres (`range_min_m` override or model value). */
  readonly rangeMinM: number;
  /** Effective maximum horizontal range, metres. */
  readonly rangeMaxM: number;
  /**
   * Effective azimuth width the app uses with an `az_center_deg` override:
   * `azWidthOverride ?? h_beam_width_deg` (≥ 360 = full circle).
   */
  readonly azimuthWidthDeg: number;
}

/** AOI option of `optimizeCoarse`. */
export interface OptimizerAoiInput {
  /** The polygon the user drew (same frame as `radarPosition`); drives the range filter. */
  readonly polygon: AoiPolygon;
  /**
   * Optional `aoiMaskForGrid(source, polygon)` (one byte per node of `source`). When given it
   * must equal the mask of `polygon`; when absent it is computed.
   */
  readonly mask?: Uint8Array;
  readonly profile: OptimizerAoiProfile;
}

export function validateAoiProfile(profile: OptimizerAoiProfile): void {
  if (!profile || typeof profile !== "object") throw new RangeError("AOI profile is required");
  const { rangeMinM, rangeMaxM, azimuthWidthDeg } = profile;
  if (!Number.isFinite(rangeMinM) || !Number.isFinite(rangeMaxM) || rangeMinM < 0 || rangeMinM > rangeMaxM) {
    throw new RangeError("AOI profile range limits must be finite, non-negative and ordered");
  }
  if (!Number.isFinite(azimuthWidthDeg) || azimuthWidthDeg <= 0) {
    throw new RangeError("AOI profile azimuth width must be finite and greater than 0");
  }
}

/** Validate a fine AOI mask against its DEM: size, 0/1 bytes, AOI cells on finite nodes. Returns the cell count. */
export function validateAoiMaskForGrid(mask: Uint8Array, source: OptimizerGrid): number {
  const rows = source.grid.length;
  const cols = source.grid[0]!.length;
  if (!(mask instanceof Uint8Array) || mask.length !== rows * cols) {
    throw new RangeError(`AOI mask must be a Uint8Array with one byte per DEM node (${rows * cols})`);
  }
  const count = aoiMaskCellCount(mask);
  if (count === 0) throw new RangeError("AOI mask has no cells");
  for (let idx = 0; idx < mask.length; idx++) {
    if (mask[idx] === 1 && !Number.isFinite(source.grid[Math.floor(idx / cols)]![idx % cols]!)) {
      throw new RangeError(`AOI cell ${idx} is NODATA in the DEM`);
    }
  }
  return count;
}

/** Subsample a fine mask with the `coarsenGrid` rule (coarse (r, c) = fine (r·f, c·f)). */
export function coarsenAoiMask(mask: Uint8Array, rows: number, cols: number, factor: number): Uint8Array {
  if (!(mask instanceof Uint8Array) || !Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 ||
      mask.length !== rows * cols) {
    throw new RangeError("AOI mask must be a Uint8Array with rows × cols bytes");
  }
  const coarseRows = coarseNodeCount(rows, factor);
  const coarseCols = coarseNodeCount(cols, factor);
  const coarse = new Uint8Array(coarseRows * coarseCols);
  for (let r = 0; r < coarseRows; r++) {
    for (let c = 0; c < coarseCols; c++) coarse[r * coarseCols + c] = mask[r * factor * cols + c * factor]!;
  }
  return coarse;
}

/** Relative tolerance of the range filter: it never rejects what the engine accepts at a limit. */
export const AOI_RANGE_RELATIVE_TOLERANCE = 1e-9;

/**
 * Range predicate over horizontal positions (x, y): [dmin, dmax] to the polygon meets
 * [rangeMin, rangeMax], inclusive with tolerance 1e-9 · max(1, limit). O(V) per call.
 */
export function aoiRangeFilter(polygon: ValidatedAoiPolygon, rangeMinM: number, rangeMaxM: number): (x: number, y: number) => boolean {
  if (!Number.isFinite(rangeMinM) || !Number.isFinite(rangeMaxM) || rangeMinM < 0 || rangeMinM > rangeMaxM) {
    throw new RangeError("Range limits must be finite, non-negative and ordered");
  }
  const lo = rangeMinM - AOI_RANGE_RELATIVE_TOLERANCE * Math.max(1, rangeMinM);
  const hi = rangeMaxM + AOI_RANGE_RELATIVE_TOLERANCE * Math.max(1, rangeMaxM);
  return (x: number, y: number): boolean => {
    const { min, max } = aoiPolygonDistanceRange(polygon, x, y);
    return min <= hi && max >= lo;
  };
}

/** Engine coordinates of the fine AOI cells, in row-major order. */
export interface AoiCells {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
}

/** Node coordinates of every AOI cell, computed like the LOS engine (min + index·res). */
export function prepareAoiCells(source: OptimizerGrid, mask: Uint8Array): AoiCells {
  const cols = source.grid[0]!.length;
  if (!(mask instanceof Uint8Array) || mask.length !== source.grid.length * cols) {
    throw new RangeError("AOI mask must have one byte per DEM node");
  }
  const count = aoiMaskCellCount(mask);
  if (count === 0) throw new RangeError("AOI mask has no cells");
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const { bounds, resolution } = source;
  let k = 0;
  for (let idx = 0; idx < mask.length; idx++) {
    if (mask[idx] !== 1) continue;
    xs[k] = bounds.min_x + (idx % cols) * resolution;
    ys[k] = bounds.min_y + Math.floor(idx / cols) * resolution;
    k++;
  }
  return { xs, ys };
}

export interface AoiOrientation {
  /** Azimuth centre for this candidate, degrees (engine convention). */
  readonly az_center_deg: number;
  /** Every fine AOI cell lies inside the app's azimuth window centred at `az_center_deg`. */
  readonly aoi_fits_azimuth: boolean;
  /** Share of fine AOI cells inside that window, percent (exact, engine test). */
  readonly aoi_in_azimuth_pct: number;
  /** Smallest arc containing every bearing to a fine AOI cell, degrees. */
  readonly aoi_spread_deg: number;
}

/** Relative bearings to the first cell, in (−180, 180]: a rotation of the circle (same gaps). */
function relativeBearings(bearings: Float64Array): Float64Array {
  const ref = bearings[0]!;
  const rel = new Float64Array(bearings.length);
  for (let i = 0; i < bearings.length; i++) {
    let r = bearings[i]! - ref;
    if (r > 180) r -= 360;
    else if (r <= -180) r += 360;
    rel[i] = r;
  }
  return rel;
}

interface ArcChoice {
  /** Centre relative to the first cell's bearing. */
  readonly centerRel: number;
  readonly spread: number;
}

/**
 * Reference choice over the fully sorted relative bearings (any configuration):
 * minimal arc from the largest circular gap, or the most populated width-wide window.
 */
const normalizeBearing = (value: number): number => {
  let v = value;
  while (v > 180) v -= 360;
  while (v <= -180) v += 360;
  return v;
};

export function chooseArcSorted(rel: Float64Array, width: number, ref: number): ArcChoice {
  const n = rel.length;
  const sorted = Float64Array.from(rel).sort();
  let gapIndex = n - 1;
  let largestGap = sorted[0]! + 360 - sorted[n - 1]!;
  for (let i = 0; i + 1 < n; i++) {
    const gap = sorted[i + 1]! - sorted[i]!;
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = i;
    }
  }
  const spread = n === 1 ? 0 : 360 - largestGap;
  const at = (k: number): number => (k < n ? sorted[k]! : sorted[k - n]! + 360);
  if (width >= 360 || spread <= width) return { centerRel: at(gapIndex + 1 === n ? 0 : gapIndex + 1) + spread / 2, spread };
  let best = -1;
  let bestStart = 0;
  let bestEnd = 0;
  let bestAbs = Infinity;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const end = sorted[i]! + width;
    if (j < i) j = i;
    while (j + 1 < i + n && at(j + 1) <= end) j++;
    const count = j - i + 1;
    const abs = normalizeBearing(ref + sorted[i]!);
    if (count > best || (count === best && abs < bestAbs)) {
      best = count;
      bestStart = i;
      bestEnd = j;
      bestAbs = abs;
    }
  }
  return { centerRel: (sorted[bestStart]! + at(bestEnd)) / 2, spread };
}

/**
 * Same choice as {@link chooseArcSorted} when every relative bearing lies in an arc shorter
 * than 180° (min..max < 180), without a full sort: the wrap gap is then the largest gap, and
 * the most populated window is found exactly with bucketed counts and lazily sorted buckets.
 */
function chooseArcBucketed(rel: Float64Array, minRel: number, maxRel: number, width: number, ref: number): ArcChoice {
  const n = rel.length;
  const spread = n === 1 ? 0 : 360 - (minRel + 360 - maxRel);
  if (width >= 360 || spread <= width) return { centerRel: minRel + spread / 2, spread };
  const buckets = Math.max(1, Math.min(4096, n));
  const scale = buckets / (maxRel - minRel);
  const bin = (v: number): number => Math.min(buckets - 1, Math.max(0, Math.floor((v - minRel) * scale)));
  const counts = new Int32Array(buckets);
  const binOf = new Int32Array(n);
  const binMin = new Float64Array(buckets).fill(Infinity);
  const binMax = new Float64Array(buckets).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const v = rel[i]!;
    const k = bin(v);
    binOf[i] = k;
    counts[k] = counts[k]! + 1;
    if (v < binMin[k]!) binMin[k] = v;
    if (v > binMax[k]!) binMax[k] = v;
  }
  const prefix = new Int32Array(buckets + 1);
  for (let k = 0; k < buckets; k++) prefix[k + 1] = prefix[k]! + counts[k]!;
  const grouped = new Float64Array(n);
  const fill = prefix.slice(0, buckets);
  for (let i = 0; i < n; i++) {
    const k = binOf[i]!;
    grouped[fill[k]!] = rel[i]!;
    fill[k] = fill[k]! + 1;
  }
  const sortedBucket = new Uint8Array(buckets);
  const segment = (k: number): Float64Array => {
    const seg = grouped.subarray(prefix[k]!, prefix[k + 1]!);
    if (!sortedBucket[k]) {
      seg.sort();
      sortedBucket[k] = 1;
    }
    return seg;
  };
  // Number of values ≤ x and < x (bucket assignment is monotone in the value).
  const countLE = (x: number): number => {
    if (x >= maxRel) return n;
    if (x < minRel) return 0;
    const k = bin(x);
    const seg = segment(k);
    let lo = 0;
    let hi = seg.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seg[mid]! <= x) lo = mid + 1; else hi = mid; }
    return prefix[k]! + lo;
  };
  const countLT = (x: number): number => {
    if (x <= minRel) return 0;
    if (x > maxRel) return n;
    const k = bin(x);
    const seg = segment(k);
    let lo = 0;
    let hi = seg.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seg[mid]! < x) lo = mid + 1; else hi = mid; }
    return prefix[k]! + lo;
  };
  const valueAt = (position: number): number => {
    let lo = 0;
    let hi = buckets - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (prefix[mid]! <= position) lo = mid; else hi = mid - 1; }
    return segment(lo)[position - prefix[lo]!]!;
  };
  // Lower bound achieved by starting at a bucket's smallest value; upper bound for any start in it.
  let bestLower = 0;
  const upper = new Int32Array(buckets);
  for (let k = 0; k < buckets; k++) {
    if (counts[k] === 0) continue;
    const endMax = binMax[k]! + width;
    upper[k] = (endMax >= maxRel ? n : prefix[bin(endMax) + 1]!) - prefix[k]!;
    const endMin = binMin[k]! + width;
    const kEnd = endMin >= maxRel ? buckets : bin(endMin);
    bestLower = Math.max(bestLower, 1 + Math.max(0, prefix[kEnd]! - prefix[Math.min(k + 1, kEnd)]!));
  }
  let bestCount = 0;
  let bestStart = minRel;
  let bestAbs = Infinity;
  for (let k = 0; k < buckets; k++) {
    if (counts[k] === 0 || upper[k]! < bestLower || upper[k]! < bestCount) continue;
    const seg = segment(k);
    for (let i = 0; i < seg.length; i++) {
      const v = seg[i]!;
      if (i > 0 && seg[i - 1] === v) continue;
      const count = countLE(v + width) - countLT(v);
      const abs = normalizeBearing(ref + v);
      if (count > bestCount || (count === bestCount && abs < bestAbs)) {
        bestCount = count;
        bestStart = v;
        bestAbs = abs;
      }
    }
  }
  const last = valueAt(countLE(bestStart + width) - 1);
  return { centerRel: (bestStart + last) / 2, spread };
}

/** Orientation of one radar at (x, y) towards the fine AOI cells (see the module doc). */
export function orientTowardsAoi(cells: AoiCells, x: number, y: number, azimuthWidthDeg: number): AoiOrientation {
  return orientWith(cells, x, y, azimuthWidthDeg, false);
}

/** Test hook: `forceSorted` uses the full-sort reference choice for every configuration. */
export function orientWith(cells: AoiCells, x: number, y: number, azimuthWidthDeg: number, forceSorted: boolean): AoiOrientation {
  const n = cells.xs.length;
  if (n === 0) throw new RangeError("AOI has no cells");
  if (!Number.isFinite(azimuthWidthDeg) || azimuthWidthDeg <= 0) {
    throw new RangeError("Azimuth width must be finite and greater than 0");
  }
  const bearings = new Float64Array(n);
  for (let i = 0; i < n; i++) bearings[i] = bearingDeg(cells.xs[i]! - x, cells.ys[i]! - y);
  const rel = relativeBearings(bearings);
  let minRel = Infinity;
  let maxRel = -Infinity;
  for (let i = 0; i < n; i++) {
    minRel = Math.min(minRel, rel[i]!);
    maxRel = Math.max(maxRel, rel[i]!);
  }
  const choice = !forceSorted && maxRel - minRel < 180
    ? chooseArcBucketed(rel, minRel, maxRel, azimuthWidthDeg, bearings[0]!)
    : chooseArcSorted(rel, azimuthWidthDeg, bearings[0]!);
  const center = normalizeBearing(bearings[0]! + choice.centerRel);
  const window = aoiAzimuthWindow(center, azimuthWidthDeg);
  let inside = 0;
  for (let i = 0; i < n; i++) if (isBearingInWindow(bearings[i]!, window)) inside++;
  return {
    az_center_deg: center,
    aoi_fits_azimuth: inside === n,
    aoi_in_azimuth_pct: aoiPercent(inside, n)!,
    aoi_spread_deg: choice.spread,
  };
}
