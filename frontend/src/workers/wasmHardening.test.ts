import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loader: vi.fn(), budget: 5 }));
vi.mock("../wasm/loader", async (original) => ({
  ...(await original<typeof import("../wasm/loader")>()), loadRadarWasm: mocks.loader,
}));
vi.mock("../utils/terrainLimits", async (original) => ({
  ...(await original<typeof import("../utils/terrainLimits")>()),
  get WASM_SENSITIVITY_MASK_BUDGET_BYTES() { return mocks.budget; },
}));

type Handler = (event: MessageEvent) => void | Promise<void>;
async function handlerOf(path: "./losWorker" | "./vectorWorker"): Promise<Handler> {
  vi.resetModules();
  const scope = { onmessage: null as Handler | null, postMessage: () => {} };
  vi.stubGlobal("self", scope);
  await import(path);
  return scope.onmessage!;
}
async function run(handler: Handler, data: unknown) {
  const messages: Record<string, unknown>[] = [];
  vi.stubGlobal("self", { postMessage: (message: Record<string, unknown>) => messages.push(message) });
  await handler({ data } as MessageEvent);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.budget = 5; });

const terrainKey = { terrain_id: "terrain", epoch: 1 };
const sensitivity = { type: "SENSITIVITY", terrainKey, grid: [[0, 1, 2], [1, 2, 3]], grid_rows: 2, grid_cols: 3,
  resolution: 1, bounds: { min_x: 0, min_y: 0, max_x: 2, max_y: 1 }, observations: [{ analysisId: "a",
    snapshot: { terrainKey, analysisId: "a", sourceAnalysisIds: ["a"], generation: 1,
      radars: [{ radarId: "r", radarModelId: "m", position: { x: 0, y: 0, z: 10 } }] },
    grid_rows: 2, grid_cols: 3, resolution: 1, cell_states: new Uint8Array(6).fill(5) }] };
const los = { grid: sensitivity.grid, bounds: sensitivity.bounds, resolution: 1, radar_position: [0, 0, 10],
  radar_config: { min_range_m: 0, max_range_m: 100, elevation_min_deg: -90, elevation_max_deg: 90, scan_pattern: "SAR360" } };

describe("WASM memory protection", () => {
  it("falls back to the exact TS result before initializing WASM when the mask budget is exceeded", async () => {
    const handler = await handlerOf("./vectorWorker");
    const expected = await run(handler, { ...sensitivity, engine: "ts" });
    const actual = await run(handler, { ...sensitivity, engine: "wasm" });
    expect(actual).toEqual({ ...expected, engine_fallback: "mask-budget" });
    expect(mocks.loader).not.toHaveBeenCalled();
  });
  it("reports size and limit for explicit WASM instead of falling back", async () => {
    const handler = await handlerOf("./vectorWorker");
    const actual = await run(handler, { ...sensitivity, engine: "wasm", engine_explicit: true });
    expect(actual.engine_used).toBe("wasm");
    expect(actual.error).toMatch(/6.*5/);
    expect(actual.engine_fallback).toBeUndefined();
    expect(mocks.loader).not.toHaveBeenCalled();
  });
  it.each([["./losWorker", los], ["./vectorWorker", sensitivity]] as const)("translates a trap in %s without TS retry", async (path, input) => {
    mocks.budget = 6;
    const trap = vi.fn(() => { throw new WebAssembly.RuntimeError("unreachable"); });
    mocks.loader.mockResolvedValue({ sensitivity: trap, compute_los_analysis: trap });
    const handler = await handlerOf(path);
    const actual = await run(handler, { ...input, engine: "wasm", engine_explicit: false });
    expect(actual.engine_used).toBe("wasm");
    expect(actual.error).toMatch(/WebAssembly.*memoria.*internamente/);
    expect(actual.engine_fallback).toBeUndefined();
    expect(trap).toHaveBeenCalledTimes(1);
  });
});
