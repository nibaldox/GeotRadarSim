/**
 * Cross-worker consistency: the merged per-cell slope-motion projection from
 * individual LOS jobs must agree with the vectorWorker RMS map (Float32
 * precision), cell by cell, including the measured-zero / no-data distinctions.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisSnapshot, LOSResponse, SensitivityObservation } from "../types/api";
import { mergeResults } from "../store/analysisStore";

const globalSelf = globalThis as unknown as {
  self: {
    postMessage: (message: unknown) => void;
    onmessage: ((event: MessageEvent) => void) | null;
  };
};
let vectorMessages: Array<{
  flat_sensitivity_grid?: Float32Array;
  observer_count?: Uint16Array;
  error?: string;
}> = [];

beforeAll(async () => {
  globalSelf.self = {
    postMessage: (message: unknown) => {
      vectorMessages.push(message as (typeof vectorMessages)[number]);
    },
    onmessage: null,
  };
  await import("./vectorWorker");
});

beforeEach(() => {
  vectorMessages = [];
});

async function runLOSHarness(input: {
  grid: number[][];
  radarPosition: [number, number, number];
  maxRange?: number;
}): Promise<LOSResponse> {
  const { vi } = await import("vitest");
  vi.resetModules();
  const scope: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  } = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./losWorker");
  if (!scope.onmessage) throw new Error("LOS worker did not register its message handler");
  scope.onmessage({
    data: {
      grid: input.grid,
      bounds: { min_x: 0, min_y: 0, max_x: 3, max_y: 2 },
      resolution: 1,
      radar_position: input.radarPosition,
      radar_config: {
        model_id: "test-radar",
        display_name: "Test radar",
        manufacturer: "Test",
        min_range_m: 0,
        max_range_m: input.maxRange ?? 100,
        h_beam_width_deg: 360,
        v_beam_width_deg: 180,
        elevation_min_deg: -90,
        elevation_max_deg: 90,
        scan_pattern: "SAR360",
        azimuth_range_deg: null,
      },
    },
  } as MessageEvent);
  const output = scope.postMessage.mock.calls[0]![0] as LOSResponse & { error?: string };
  if (output.error) throw new Error(output.error);
  vi.unstubAllGlobals();
  return output;
}

const terrainKey = { terrain_id: "terrain-projection-consistency", epoch: 1 };

function observation(analysisId: string, position: { x: number; y: number; z: number }, result: LOSResponse): SensitivityObservation {
  const snapshot: AnalysisSnapshot = {
    terrainKey,
    analysisId,
    sourceAnalysisIds: [analysisId],
    generation: 1,
    radars: [{
      radarId: `radar-${analysisId}`,
      radarModelId: "test-radar",
      position,
      overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
    }],
  };
  return {
    analysisId,
    snapshot,
    grid_rows: result.grid_rows,
    grid_cols: result.grid_cols,
    resolution: result.resolution,
    cell_states: result.cell_states,
  };
}

describe("merged projection agrees with the vectorWorker RMS output", () => {
  it("matches cell by cell across two real LOS observations on a tilted plane", async () => {
    // Plane z = x + y: constant downhill tangent shared by every cell.
    const grid = [
      [0, 1, 2, 3],
      [1, 2, 3, 4],
      [2, 3, 4, 5],
    ];
    const resultA = await runLOSHarness({ grid, radarPosition: [0, 0, 6] });
    const resultB = await runLOSHarness({ grid, radarPosition: [3, 2, 6], maxRange: 4 });

    const observations = [
      observation("job-a", { x: 0, y: 0, z: 6 }, resultA),
      observation("job-b", { x: 3, y: 2, z: 6 }, resultB),
    ];
    globalSelf.self.onmessage!({
      data: {
        type: "SENSITIVITY",
        terrainKey,
        grid,
        grid_rows: grid.length,
        grid_cols: grid[0]!.length,
        resolution: 1,
        bounds: { min_x: 0, min_y: 0, max_x: 3, max_y: 2 },
        observations,
      },
    } as MessageEvent);
    const map = vectorMessages[vectorMessages.length - 1]!;
    expect(map.error).toBeUndefined();

    const merged = mergeResults([resultA, resultB]);
    expect(merged.quality_model).toBe("geometric-v2");

    const size = grid.length * grid[0]!.length;
    let comparedWithContributors = 0;
    for (let idx = 0; idx < size; idx++) {
      const contributors = map.observer_count![idx]!;
      const mergedProjection = merged.flat_projection_grid![idx]!;
      if (contributors === 0) {
        expect(Number.isNaN(mergedProjection), `cell ${idx} must keep no-data`).toBe(true);
        expect(Number.isNaN(map.flat_sensitivity_grid![idx]!)).toBe(true);
      } else {
        comparedWithContributors++;
        expect(mergedProjection, `cell ${idx} RMS projection`)
          .toBeCloseTo(map.flat_sensitivity_grid![idx]!, 5);
      }
    }
    expect(comparedWithContributors).toBeGreaterThan(0);
  });
});
