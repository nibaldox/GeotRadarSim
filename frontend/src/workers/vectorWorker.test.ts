/** Tests for geometry sensitivity using the real worker message handler. */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { LOSCellState, type AnalysisSnapshot, type Point3D } from "../types/api";

const globalSelf = globalThis as any;
let messagesSent: any[] = [];
const terrainKey = { terrain_id: "terrain-sensitivity", epoch: 7 };
const resolution = 1;
const bounds = { min_x: 10, min_y: 20, max_x: 20, max_y: 30 };

beforeAll(async () => {
  globalSelf.self = {
    postMessage: (message: any) => messagesSent.push(message),
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  await import("./vectorWorker");
});

beforeEach(() => {
  messagesSent = [];
});

function makeObservation(
  analysisId: string,
  position: Point3D,
  cellStates: number[],
  overrides: Partial<{ terrainKey: typeof terrainKey; grid_rows: number; grid_cols: number; resolution: number }> = {},
) {
  const snapshot: AnalysisSnapshot = {
    terrainKey: overrides.terrainKey ?? terrainKey,
    analysisId,
    sourceAnalysisIds: [analysisId],
    generation: 1,
    radars: [{
      radarId: `radar-${analysisId}`,
      radarModelId: "test-radar-model",
      position,
      overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
    }],
  };
  return {
    analysisId,
    snapshot,
    grid_rows: overrides.grid_rows ?? cellStates.length,
    grid_cols: overrides.grid_cols ?? 1,
    resolution: overrides.resolution ?? resolution,
    cell_states: new Uint8Array(cellStates),
  };
}

function dispatchSensitivity({
  grid,
  observations,
  inputTerrainKey = terrainKey,
  rows = grid.length,
  cols = grid[0]?.length ?? 0,
  inputResolution = resolution,
}: {
  grid: number[][];
  observations: ReturnType<typeof makeObservation>[];
  inputTerrainKey?: typeof terrainKey;
  rows?: number;
  cols?: number;
  inputResolution?: number;
}) {
  globalSelf.self.onmessage({ data: {
    type: "SENSITIVITY",
    terrainKey: inputTerrainKey,
    grid,
    grid_rows: rows,
    grid_cols: cols,
    resolution: inputResolution,
    bounds,
    observations,
  } } as MessageEvent);
  return messagesSent[messagesSent.length - 1];
}

describe("vectorWorker — per-cell geometric sensitivity", () => {
  it("computes one visible posture against its own LOS mask", () => {
    const grid = [[5, 5, 5], [5, 5, 5]];
    const observation = makeObservation("analysis-one", { x: 10, y: 20, z: 15 }, [5, 0, 0, 0, 0, 0], { grid_rows: 2, grid_cols: 3 });

    const result = dispatchSensitivity({ grid, observations: [observation] });

    expect(result.error).toBeUndefined();
    expect(result.flat_sensitivity_grid).toBeInstanceOf(Float32Array);
    expect(result.observer_count).toBeInstanceOf(Uint16Array);
    expect(result.flat_sensitivity_grid).toHaveLength(6);
    expect(result.flat_sensitivity_grid[0]).toBeCloseTo(1);
    expect(result.observer_count).toEqual(new Uint16Array([1, 0, 0, 0, 0, 0]));
    expect(Number.isNaN(result.flat_sensitivity_grid[1])).toBe(true);
    expect(result.sourceAnalysisIds).toEqual(["analysis-one"]);
  });

  it("uses a one-sided derivative at a 2x2 DEM corner instead of a flat fallback", () => {
    const result = dispatchSensitivity({
      grid: [[0, 0], [1, 1]],
      observations: [makeObservation(
        "analysis-ramp-corner",
        { x: 10, y: 19, z: 1 },
        [LOSCellState.VISIBLE, 0, 0, 0],
        { grid_rows: 2, grid_cols: 2 },
      )],
    });

    expect(result.observer_count[0]).toBe(1);
    expect(result.flat_sensitivity_grid[0]).toBeCloseTo(0, 6);
  });

  it("uses one-sided slopes on every edge and corner of a 3x3 planar DEM", () => {
    const grid = [[0, 2, 4], [1, 3, 5], [2, 4, 6]];
    const radar = { x: 8, y: 18, z: 8 };
    const result = dispatchSensitivity({
      grid,
      observations: [makeObservation("analysis-planar-edges", radar, new Array(9).fill(LOSCellState.VISIBLE), {
        grid_rows: 3,
        grid_cols: 3,
      })],
    });
    const failureNorm = Math.sqrt(30); // grad=(2,1), unchanged geometric failure direction=(-2,-1,-5)

    expect(result.observer_count).toEqual(new Uint16Array(9).fill(1));
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const index = row * 3 + col;
        const dx = 10 + col - radar.x;
        const dy = 20 + row - radar.y;
        const dz = grid[row]![col]! - radar.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const expected = Math.abs(
          (dx / distance) * (-2 / failureNorm) +
          (dy / distance) * (-1 / failureNorm) +
          (dz / distance) * (-5 / failureNorm),
        );
        expect(result.flat_sensitivity_grid[index]).toBeCloseTo(expected, 6);
      }
    }
  });

  it("uses the available finite neighbor when the opposite DEM neighbor is NaN or Infinity", () => {
    const grid = [[Number.NaN, 4, Number.POSITIVE_INFINITY], [Number.NaN, 5, 7], [Number.POSITIVE_INFINITY, Number.NaN, 9]];
    const result = dispatchSensitivity({
      grid,
      observations: [makeObservation("analysis-invalid-neighbor", { x: 6, y: 21, z: 7 }, [0, 0, 0, 0, LOSCellState.VISIBLE, 0, 0, 0, 0], {
        grid_rows: 3,
        grid_cols: 3,
      })],
    });

    expect(result.observer_count[4]).toBe(1);
    expect(result.flat_sensitivity_grid[4]).toBeCloseTo(0, 6);
  });

  it("returns no-data for an isolated finite VISIBLE cell with no neighbors on either axis", () => {
    const result = dispatchSensitivity({
      grid: [[Number.NaN, Number.NaN, Number.NaN], [Number.NaN, 5, Number.NaN], [Number.NaN, Number.NaN, Number.NaN]],
      observations: [makeObservation(
        "analysis-isolated-visible",
        { x: 10, y: 20, z: 15 },
        [0, 0, 0, 0, LOSCellState.VISIBLE, 0, 0, 0, 0],
        { grid_rows: 3, grid_cols: 3 },
      )],
    });

    expect(result.observer_count[4]).toBe(0);
    expect(Number.isNaN(result.flat_sensitivity_grid[4])).toBe(true);
  });

  it("returns no-data instead of inventing a flat slope when an axis has no finite neighbor", () => {
    const grid = [[Number.NaN, 4, Number.POSITIVE_INFINITY], [Number.NaN, 5, Number.POSITIVE_INFINITY], [Number.NaN, 6, Number.POSITIVE_INFINITY]];
    const result = dispatchSensitivity({
      grid,
      observations: [makeObservation("analysis-unreliable-normal", { x: 11, y: 21, z: 15 }, [0, 0, 0, 0, LOSCellState.VISIBLE, 0, 0, 0, 0], {
        grid_rows: 3,
        grid_cols: 3,
      })],
    });

    expect(result.observer_count[4]).toBe(0);
    expect(Number.isNaN(result.flat_sensitivity_grid[4])).toBe(true);
  });

  it("uses RMS for two orthogonal visible look directions", () => {
    const grid = [[9, 10, 11], [9, 10, 11], [9, 10, 11]];
    const states = [0, 0, 0, 0, LOSCellState.VISIBLE, 0, 0, 0, 0];
    const target = { x: 11, y: 21, z: 10 };
    const observations = [
      makeObservation("analysis-aligned", { x: target.x + 1 / Math.sqrt(2), y: target.y, z: target.z + 1 / Math.sqrt(2) }, states, { grid_rows: 3, grid_cols: 3 }),
      makeObservation("analysis-orthogonal", { x: target.x - 1 / Math.sqrt(2), y: target.y, z: target.z + 1 / Math.sqrt(2) }, states, { grid_rows: 3, grid_cols: 3 }),
    ];

    const result = dispatchSensitivity({ grid, observations });

    expect(result.observer_count[4]).toBe(2);
    expect(result.flat_sensitivity_grid[4]).toBeCloseTo(Math.sqrt(0.5), 6);
  });

  it("does not count two VISIBLE radars when the finite cell has no computable gradient", () => {
    const grid = [[Number.NaN, Number.NaN, Number.NaN], [Number.NaN, 5, Number.NaN], [Number.NaN, Number.NaN, Number.NaN]];
    const states = [0, 0, 0, 0, LOSCellState.VISIBLE, 0, 0, 0, 0];
    const observations = [
      makeObservation("analysis-isolated-first", { x: 10, y: 20, z: 15 }, states, { grid_rows: 3, grid_cols: 3 }),
      makeObservation("analysis-isolated-second", { x: 11, y: 20, z: 15 }, states, { grid_rows: 3, grid_cols: 3 }),
    ];

    const result = dispatchSensitivity({ grid, observations });

    expect(result.observer_count[4]).toBe(0);
    expect(Number.isNaN(result.flat_sensitivity_grid[4])).toBe(true);
  });

  it("excludes a second radar whose own cell state is OUT_OF_RANGE", () => {
    const grid = [[5, 5], [5, 5]];
    const first = makeObservation("visible", { x: 10, y: 20, z: 15 }, [LOSCellState.VISIBLE, 0, 0, 0], { grid_rows: 2, grid_cols: 2 });
    const second = makeObservation("out-of-range", { x: 100, y: 200, z: 15 }, [LOSCellState.OUT_OF_RANGE, 0, 0, 0], { grid_rows: 2, grid_cols: 2 });

    const result = dispatchSensitivity({ grid, observations: [first, second] });

    expect(result.observer_count[0]).toBe(1);
    expect(result.flat_sensitivity_grid[0]).toBeCloseTo(1);
  });

  it.each([
    ["SHADOW", LOSCellState.SHADOW],
    ["NODATA", LOSCellState.NODATA],
    ["UNKNOWN_RAY", LOSCellState.UNKNOWN_RAY],
    ["OUT_OF_RANGE", LOSCellState.OUT_OF_RANGE],
    ["OUTSIDE_FOV", LOSCellState.OUTSIDE_FOV],
  ])("does not count %s as an observer", (_label, state) => {
    const result = dispatchSensitivity({
      grid: [[5]],
      observations: [makeObservation(`analysis-${state}`, { x: 10, y: 20, z: 15 }, [state])],
    });

    expect(result.observer_count[0]).toBe(0);
    expect(Number.isNaN(result.flat_sensitivity_grid[0])).toBe(true);
  });

  it("returns no-data rather than a zero when no selected radar sees a finite cell", () => {
    const result = dispatchSensitivity({
      grid: [[5]],
      observations: [makeObservation("analysis-shadow", { x: 10, y: 20, z: 15 }, [LOSCellState.SHADOW])],
    });

    expect(result.observer_count[0]).toBe(0);
    expect(Number.isNaN(result.flat_sensitivity_grid[0])).toBe(true);
  });

  it("returns no-data for a VISIBLE state when its DEM elevation is non-finite", () => {
    const result = dispatchSensitivity({
      grid: [[Number.NaN]],
      observations: [makeObservation("analysis-nodata-terrain", { x: 10, y: 20, z: 15 }, [LOSCellState.VISIBLE])],
    });

    expect(result.observer_count[0]).toBe(0);
    expect(Number.isNaN(result.flat_sensitivity_grid[0])).toBe(true);
  });

  it("preserves a legitimate measured zero with one visible observer", () => {
    const result = dispatchSensitivity({
      grid: [[5, 5], [5, 5]],
      observations: [makeObservation("analysis-zero", { x: 11, y: 20, z: 5 }, [LOSCellState.VISIBLE, 0, 0, 0], { grid_rows: 2, grid_cols: 2 })],
    });

    expect(result.observer_count[0]).toBe(1);
    expect(result.flat_sensitivity_grid[0]).toBe(0);
  });

  it("uses DEM node coordinates on a rectangular grid with a nonzero origin", () => {
    const result = dispatchSensitivity({
      grid: [[5, 5, 5], [5, 5, 5]],
      observations: [makeObservation("analysis-origin", { x: 10, y: 20, z: 15 }, [5, 0, 0, 0, 0, 0], { grid_rows: 2, grid_cols: 3 })],
    });

    expect(result.grid_rows).toBe(2);
    expect(result.grid_cols).toBe(3);
    expect(result.flat_sensitivity_grid).toHaveLength(6);
    expect(result.flat_sensitivity_grid[0]).toBeCloseTo(1, 6);
  });

  it("rejects an observation from a different epoch of the same terrain", () => {
    const stale = makeObservation("analysis-old-epoch", { x: 10, y: 20, z: 15 }, [5], {
      terrainKey: { terrain_id: terrainKey.terrain_id, epoch: terrainKey.epoch - 1 },
    });

    const result = dispatchSensitivity({ grid: [[5]], observations: [stale] });

    expect(result.error).toMatch(/terrain/i);
  });

  it("rejects malformed observation dimensions and cell-state lengths", () => {
    const malformed = makeObservation("analysis-malformed", { x: 10, y: 20, z: 15 }, [5]);
    malformed.grid_cols = 2;

    const result = dispatchSensitivity({ grid: [[5]], observations: [malformed] });

    expect(result.error).toMatch(/dimension|cell-state|grid/i);
  });
});
