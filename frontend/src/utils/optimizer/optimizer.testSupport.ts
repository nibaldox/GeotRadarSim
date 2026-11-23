/** Deterministic helpers shared by the optimizer tests (no Workers, no WASM). */

import { LOSCellState } from "../../types/api";
import type { LOSResponse } from "../../types/api";
import { QUALITY_MODEL_V2 } from "../qualityMetrics";
import type { LosCellOutput } from "./types";

/** mulberry32: small, fixed-seed PRNG so property tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Build a LOS output from explicit per-cell arrays (non-visible cells get the v2 sentinels). */
export function losOutput(
  states: readonly number[],
  quality?: readonly number[],
  projection?: readonly number[],
): LosCellOutput {
  const size = states.length;
  const cellStates = Uint8Array.from(states);
  const flatQuality = new Float32Array(size).fill(-1);
  const flatProjection = new Float32Array(size).fill(Number.NaN);
  for (let idx = 0; idx < size; idx++) {
    if (cellStates[idx] !== LOSCellState.VISIBLE) continue;
    flatQuality[idx] = quality?.[idx] ?? 1;
    flatProjection[idx] = projection?.[idx] ?? 1;
  }
  return { cell_states: cellStates, flat_quality_grid: flatQuality, flat_projection_grid: flatProjection };
}

/** A LOS output that is VISIBLE with quality/projection 1 exactly on the given cells, OUT_OF_RANGE elsewhere. */
export function visibleOn(size: number, cells: readonly number[], value = 1): LosCellOutput {
  const states = new Array<number>(size).fill(LOSCellState.OUT_OF_RANGE);
  const values = new Array<number>(size).fill(value);
  for (const cell of cells) states[cell] = LOSCellState.VISIBLE;
  return losOutput(states, values, values);
}

/** Wrap a LOS output as the LOSResponse consumed by mergeResults/computeQualitySummary. */
export function asLOSResponse(output: LosCellOutput, rows: number, cols: number, resolution: number): LOSResponse {
  return {
    shadow_grid: [],
    cell_states: output.cell_states,
    grid_rows: rows,
    grid_cols: cols,
    resolution,
    coverage_polygon: [],
    coverage_pct: null,
    completeness_pct: null,
    visible_area_m2: 0,
    shadow_zones: [],
    flat_quality_grid: output.flat_quality_grid,
    quality_model: QUALITY_MODEL_V2,
    flat_projection_grid: output.flat_projection_grid,
  };
}

/** Flat terrain of the given size with optional NaN cells (row-major indices). */
export function flatTerrain(rows: number, cols: number, z = 0, nodata: readonly number[] = []): number[][] {
  const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(z));
  for (const idx of nodata) grid[Math.floor(idx / cols)]![idx % cols] = Number.NaN;
  return grid;
}
