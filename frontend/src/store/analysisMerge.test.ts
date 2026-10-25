/**
 * Merged LOS quality semantics (geometric-v2):
 * incidence = max over individual VISIBLE finite values,
 * projection = RMS over individual VISIBLE finite projections only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mergeResults, useAnalysisStore } from "./analysisStore";
import type { HistoryEntry } from "./analysisStore";
import { LOSCellState } from "../types/api";
import type { LOSResponse } from "../types/api";

beforeEach(() => {
  useAnalysisStore.setState({
    terrainKey: null,
    terrainTransitioning: false,
    history: [],
    losResult: null,
    activeSnapshot: null,
  });
});

function v2Result(
  states: number[],
  incidence: Array<number | null>,
  projection: Array<number | null>,
  qualityModel: string | undefined = "geometric-v2",
): LOSResponse {
  return {
    cell_states: Uint8Array.from(states),
    grid_rows: 1,
    grid_cols: states.length,
    resolution: 2,
    shadow_grid: [states.map((state) => state === LOSCellState.SHADOW)],
    quality_grid: [incidence.map((value) => value ?? Number.NaN)],
    flat_quality_grid: Float32Array.from(incidence.map((value) => value ?? Number.NaN)),
    ...(qualityModel ? { quality_model: qualityModel as "geometric-v2" } : {}),
    flat_projection_grid: Float32Array.from(projection.map((value) => value ?? Number.NaN)),
    coverage_polygon: [],
    coverage_pct: 50,
    completeness_pct: 100,
    visible_area_m2: states.filter((state) => state === LOSCellState.VISIBLE).length * 4,
    shadow_zones: [],
  } as unknown as LOSResponse;
}

function legacyResult(states: number[], incidence: number[]): LOSResponse {
  return {
    cell_states: Uint8Array.from(states),
    grid_rows: 1,
    grid_cols: states.length,
    resolution: 2,
    shadow_grid: [states.map((state) => state === LOSCellState.SHADOW)],
    quality_grid: [incidence.slice()],
    flat_quality_grid: Float32Array.from(incidence),
    coverage_polygon: [],
    coverage_pct: 50,
    completeness_pct: 100,
    visible_area_m2: states.filter((state) => state === LOSCellState.VISIBLE).length * 4,
    shadow_zones: [],
  } as unknown as LOSResponse;
}

function mergeViaSelection(first: LOSResponse, second: LOSResponse): LOSResponse {
  const entry = (id: string, result: LOSResponse, selected: boolean): HistoryEntry => ({
    position: { x: 0, y: 0, z: 1 },
    coveragePct: result.coverage_pct,
    timestamp: id,
    result,
    radarId: id,
    selected,
    terrain_id: "terrain-merge-v2",
    terrain_epoch: 4,
  });
  useAnalysisStore.setState({
    terrainKey: { terrain_id: "terrain-merge-v2", epoch: 4 },
    terrainTransitioning: false,
    history: [entry("a", first, true), entry("b", second, false)],
    losResult: first,
  });
  useAnalysisStore.getState().toggleHistoryEntrySelection(1);
  return useAnalysisStore.getState().losResult!;
}

describe("merged geometric quality (v2)", () => {
  it("combines incidence by max and projection by RMS over the contributing individuals", () => {
    const first = v2Result(
      [5, 5, 5, 5, 5],
      [0.5, 0.25, 0.5, Number.NaN, 0.25],
      [0.25, 0, 0.75, Number.NaN, Number.NaN],
    );
    const second = v2Result(
      [5, 5, 5, 4, 5],
      [0.25, 0.75, 0.5, -1, 0.25],
      [0.5, 0, Number.NaN, Number.NaN, 0.25],
    );

    const merged = mergeResults([first, second]);

    const incidence = merged.flat_quality_grid!;
    expect(incidence[0]).toBe(0.5);    // max(0.5, 0.25)
    expect(incidence[1]).toBe(0.75);   // max(0.25, 0.75)
    expect(incidence[2]).toBe(0.5);
    expect(incidence[4]).toBe(0.25);   // union: the single visible contributor
    expect(Number.isNaN(incidence[3]!)).toBe(true); // missing index, never a fabricated zero

    const projection = merged.flat_projection_grid!;
    expect(projection[0]).toBeCloseTo(Math.sqrt((0.25 * 0.25 + 0.5 * 0.5) / 2), 6);
    expect(projection[1]).toBe(0);     // RMS of two measured zeros stays a measured zero
    expect(projection[2]).toBe(0.75);  // only the finite contributor enters the RMS
    expect(Number.isNaN(projection[3]!)).toBe(true);
    expect(projection[4]).toBe(0.25);  // one contributor: RMS equals its own value
    expect(merged.quality_model).toBe("geometric-v2");
  });

  it("keeps legacy projection unavailable and refuses to tag a mixed merge as v2", () => {
    const legacy = legacyResult([5, 5, 5], [0.75, 0.75, -1]);
    const v2 = v2Result([5, 5, 4], [0.25, 0.25, -1], [0.5, Number.NaN, Number.NaN]);

    const merged = mergeResults([legacy, v2]);

    // Legacy heuristic values may join the max, but the merge can no longer claim v2.
    expect(merged.quality_model).toBeUndefined();
    expect(merged.flat_quality_grid![0]).toBe(0.75);
    expect(merged.flat_quality_grid![1]).toBe(0.75);
    expect(merged.flat_projection_grid![0]).toBe(0.5); // only the v2 contributor counts
    expect(Number.isNaN(merged.flat_projection_grid![1]!)).toBe(true); // legacy projection missing
    expect(Number.isNaN(merged.flat_projection_grid![2]!)).toBe(true);
  });

  it("is wired through history selection merges", () => {
    const first = v2Result([5, 5], [0.25, 0.25], [0.25, 0.25]);
    const second = v2Result([5, 5], [0.5, 0.25], [0.5, 0.25]);

    const merged = mergeViaSelection(first, second);

    expect(merged.flat_quality_grid![0]).toBe(0.5);
    expect(merged.flat_projection_grid![0]).toBeCloseTo(Math.sqrt((0.25 * 0.25 + 0.5 * 0.5) / 2), 6);
    expect(merged.quality_model).toBe("geometric-v2");
  });
});
