/**
 * The LOS ray's endpoint is the target node itself, which lies on the terrain surface, so a
 * target can never occlude itself. Before the fix, `startZ + 1 * deltaZ` (e.g. 20 + 1 * -27.05 =
 * -7.050000000000001) and `gridStart + 1 * delta - col` did not reproduce the endpoint exactly,
 * so the interpolated terrain at the target node rose 1–2 ulps above the ray and the cell was
 * marked as a false SHADOW. Real occlusion, including occlusion detected at the entry of the
 * triangle incident to the target, must still be reported. Both engines must agree byte for byte.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOSCellState, type RadarConfig } from "../types/api";
import { listRadars } from "../services/api";
import { generateSyntheticTerrain } from "../services/terrainEngine";
import type { LOSWorkerInput, LOSWorkerOutput } from "./losWorker";

type Handler = (event: MessageEvent) => void | Promise<void>;
type Sample = (
  grid: number[][],
  bounds: { min_x: number; min_y: number },
  resolution: number,
  x: number,
  y: number,
) => number | null;

let handler: Handler;
let sample: Sample;
let catalog: RadarConfig[];

const openRadar: RadarConfig = {
  model_id: "open",
  display_name: "Open",
  manufacturer: "Test",
  min_range_m: 0,
  max_range_m: 1e6,
  h_beam_width_deg: 360,
  v_beam_width_deg: 180,
  elevation_min_deg: -90,
  elevation_max_deg: 90,
  scan_pattern: "SAR360",
  azimuth_range_deg: null,
};

beforeAll(async () => {
  vi.resetModules();
  const scope: { onmessage: Handler | null; postMessage: () => void } = { onmessage: null, postMessage: () => undefined };
  vi.stubGlobal("self", scope);
  const module = await import("./losWorker");
  vi.unstubAllGlobals();
  if (!scope.onmessage) throw new Error("LOS worker did not register its message handler");
  handler = scope.onmessage;
  sample = module.sampleTerrainAtCoordinates;
  catalog = await listRadars();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function run(input: LOSWorkerInput, engine: "ts" | "wasm"): Promise<LOSWorkerOutput & { error?: string }> {
  const posted: unknown[] = [];
  vi.stubGlobal("self", { onmessage: null, postMessage: (message: unknown) => posted.push(message) });
  try {
    await handler({ data: { ...input, engine, engine_explicit: true } } as MessageEvent);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(posted).toHaveLength(1);
  const result = posted[0] as LOSWorkerOutput & { error?: string };
  expect(result.error, `${engine} error`).toBeUndefined();
  expect(result.engine_used).toBe(engine);
  return result;
}

/** Run both engines, require byte-identical cell states, and return the TS result. */
async function runBoth(input: LOSWorkerInput): Promise<LOSWorkerOutput> {
  const ts = await run(input, "ts");
  const wasm = await run(input, "wasm");
  expect(Array.from(wasm.cell_states), "TS ≡ WASM cell_states").toEqual(Array.from(ts.cell_states));
  expect(wasm.coverage_pct).toBe(ts.coverage_pct);
  return ts;
}

function counts(states: Uint8Array): { visible: number; shadow: number; unknown: number } {
  let visible = 0;
  let shadow = 0;
  let unknown = 0;
  for (const state of states) {
    if (state === LOSCellState.VISIBLE) visible++;
    else if (state === LOSCellState.SHADOW) shadow++;
    else if (state === LOSCellState.UNKNOWN_RAY) unknown++;
  }
  return { visible, shadow, unknown };
}

function inputFor(
  grid: number[][],
  minX: number,
  minY: number,
  resolution: number,
  position: [number, number, number],
  radar: RadarConfig,
): LOSWorkerInput {
  const rows = grid.length;
  const cols = grid[0]!.length;
  return {
    grid,
    bounds: { min_x: minX, min_y: minY, max_x: minX + (cols - 1) * resolution, max_y: minY + (rows - 1) * resolution },
    resolution,
    radar_position: position,
    radar_config: radar,
  };
}

describe("LOS target endpoint is exact (no self-occlusion by rounding)", () => {
  it("keeps the rounding premise of the minimal case", () => {
    // The endpoint of the old parametrisation is one ulp below the target elevation.
    expect(20 + 1 * (-7.05 - 20)).toBe(-7.050000000000001);
    expect(20 + 1 * (-7.05 - 20)).toBeLessThan(-7.05);
  });

  it("sees every node of a flat surface at -7.05 from a radar at z = 20 (radar on a node and off-node)", async () => {
    const grid = Array.from({ length: 9 }, () => Array<number>(11).fill(-7.05));
    for (const position of [[4, 4, 20], [4.3, 3.7, 20]] as Array<[number, number, number]>) {
      const result = await runBoth(inputFor(grid, 0, 0, 1, position, openRadar));
      expect(counts(result.cell_states), `radar ${position.join(",")}`).toEqual({ visible: 99, shadow: 0, unknown: 0 });
      expect(result.coverage_pct).toBe(100);
    }
  });

  it("sees every node of a simple slope through -7.05 from a radar at z = 20", async () => {
    const grid = Array.from({ length: 9 }, (_, r) => Array.from({ length: 11 }, (__, c) => -7.05 + 0.35 * c - 0.15 * r));
    const result = await runBoth(inputFor(grid, 0, 0, 1, [4.3, 3.7, 20], openRadar));
    expect(counts(result.cell_states)).toEqual({ visible: 99, shadow: 0, unknown: 0 });
  });

  it("sees every node of the flat -7.05 surface at a shifted origin (min 1000.1 / 2000.3)", async () => {
    const grid = Array.from({ length: 9 }, () => Array<number>(11).fill(-7.05));
    const result = await runBoth(inputFor(grid, 1000.1, 2000.3, 1, [1000.1 + 4.3, 2000.3 + 3.7, 20], openRadar));
    expect(counts(result.cell_states)).toEqual({ visible: 99, shadow: 0, unknown: 0 });
  });

  it("gives 0 SHADOW and 100 % visibility on the W2b synthetic terrain (radar 60, 45, 20)", async () => {
    const gp = catalog.find((radar) => radar.model_id === "groundprobe-ssr-fx")!;
    const synth = generateSyntheticTerrain(200, 200, 30, 1.0);
    const result = await runBoth({
      grid: synth.grid, bounds: synth.metadata.bounds, resolution: synth.metadata.resolution,
      radar_position: [60, 45, 20], radar_config: gp,
    });
    const tally = counts(result.cell_states);
    expect(tally.shadow).toBe(0);
    expect(tally.unknown).toBe(0);
    expect(tally.visible).toBe(24856);
    expect(result.coverage_pct).toBe(100);
    expect(result.shadow_zones).toEqual([]);
  }, 60_000);

  it("gives 0 SHADOW on the W2b synthetic terrain shifted to min 1000.1 / 2000.3", async () => {
    const gp = catalog.find((radar) => radar.model_id === "groundprobe-ssr-fx")!;
    const synth = generateSyntheticTerrain(200, 200, 30, 1.0);
    const result = await runBoth(inputFor(synth.grid, 1000.1, 2000.3, 1, [1000.1 + 60, 2000.3 + 45, 20], gp));
    const tally = counts(result.cell_states);
    expect(tally.shadow).toBe(0);
    expect(tally.unknown).toBe(0);
    expect(tally.visible).toBe(24855);
    expect(result.coverage_pct).toBe(100);
  }, 60_000);

  it("keeps the 5505 oracle-confirmed real shadows of the synthetic south-rim case", async () => {
    const gp = catalog.find((radar) => radar.model_id === "groundprobe-ssr-fx")!;
    const synth = generateSyntheticTerrain(200, 200, 30, 1.0);
    const bounds = synth.metadata.bounds;
    const z = sample(synth.grid, bounds, 1, 100, 5)! + 2;
    const result = await runBoth({
      grid: synth.grid, bounds, resolution: synth.metadata.resolution, radar_position: [100, 5, z], radar_config: gp,
    });
    expect(counts(result.cell_states)).toEqual({ visible: 27821, shadow: 5505, unknown: 0 });
  }, 60_000);

  it("still shadows every node behind a wall", async () => {
    const grid = Array.from({ length: 5 }, () => Array.from({ length: 9 }, (_, c) => (c === 4 ? 30 : -7.05)));
    const result = await runBoth(inputFor(grid, 0, 0, 1, [0.5, 2.2, 20], openRadar));
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 9; c++) {
        const state = result.cell_states[r * 9 + c];
        if (c >= 5) expect(state, `${r},${c}`).toBe(LOSCellState.SHADOW);
        if (c <= 3) expect(state, `${r},${c}`).toBe(LOSCellState.VISIBLE);
      }
    }
  });

  it("still shadows a target right behind a crest when only the triangle incident to the target occludes at its entry", async () => {
    // Ray from (0.5, 1.4) to the target node (row 1, col 4). Quads (row 1, col 1..2) are not
    // renderable (NaN at node 2,2), so the interval that would end on the crest has no surface.
    // The last interval lies in triangle 1 of quad (row 1, col 3) = (1,3), (1,4)=target, (2,3):
    // the crest nodes (1,3) and (2,3) = 10 m are above the ray at its entry (x = 3).
    const grid = Array.from({ length: 4 }, () => Array<number>(6).fill(0));
    grid[2]![2] = Number.NaN;
    grid[1]![3] = 10;
    grid[2]![3] = 10;
    const result = await runBoth(inputFor(grid, 0, 0, 1, [0.5, 1.4, 5], openRadar));
    expect(result.cell_states[1 * 6 + 4]).toBe(LOSCellState.SHADOW);
    // The crest node's own ray ends in the unrenderable quad (row 1, col 2): unknown, not shadow.
    expect(result.cell_states[1 * 6 + 3]).toBe(LOSCellState.UNKNOWN_RAY);
  });
});
