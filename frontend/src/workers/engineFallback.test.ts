/**
 * A WASM initialisation failure is reported as the job's error by both workers. It never
 * falls back silently to the TypeScript engine (that would contaminate an A/B), and the "ts"
 * engine of the same worker keeps working.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => vi.fn());

vi.mock("../wasm/loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wasm/loader")>()),
  loadRadarWasm: loader,
}));

type Handler = (event: MessageEvent) => void | Promise<void>;
interface Posted {
  message: Record<string, unknown>;
  transfer: readonly unknown[];
}

async function handlerOf(path: "./losWorker" | "./vectorWorker"): Promise<Handler> {
  vi.resetModules();
  const scope: { onmessage: Handler | null; postMessage: () => void } = { onmessage: null, postMessage: () => undefined };
  vi.stubGlobal("self", scope);
  await import(path);
  vi.unstubAllGlobals();
  return scope.onmessage!;
}

async function run(handler: Handler, data: unknown): Promise<Posted[]> {
  const posted: Posted[] = [];
  vi.stubGlobal("self", {
    onmessage: null,
    postMessage: (message: Record<string, unknown>, transfer?: readonly unknown[]) => posted.push({ message, transfer: transfer ?? [] }),
  });
  try {
    await handler({ data } as MessageEvent);
  } finally {
    vi.unstubAllGlobals();
  }
  return posted;
}

afterEach(() => vi.unstubAllGlobals());

const radar = {
  model_id: "open", display_name: "Open", manufacturer: "Test", min_range_m: 0, max_range_m: 100,
  h_beam_width_deg: 360, v_beam_width_deg: 180, elevation_min_deg: -90, elevation_max_deg: 90,
  scan_pattern: "SAR360", azimuth_range_deg: null,
};
const losInput = {
  grid: [[0, 1, 2], [1, 2, 3]],
  bounds: { min_x: 0, min_y: 0, max_x: 2, max_y: 1 },
  resolution: 1,
  radar_position: [0, 0, 10],
  radar_config: radar,
};
const terrainKey = { terrain_id: "init-failure", epoch: 1 };
const sensitivityInput = {
  type: "SENSITIVITY",
  terrainKey,
  grid: [[0, 1, 2], [1, 2, 3]],
  grid_rows: 2,
  grid_cols: 3,
  resolution: 1,
  bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 2, max_y: 1, max_z: 3 },
  observations: [{
    analysisId: "a",
    snapshot: {
      terrainKey, analysisId: "a", sourceAnalysisIds: ["a"], generation: 1,
      radars: [{ radarId: "r", radarModelId: "m", position: { x: 0, y: 0, z: 10 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }],
    },
    grid_rows: 2, grid_cols: 3, resolution: 1, cell_states: new Uint8Array(6).fill(5),
  }],
};

describe("implicit WASM initialization fallback", () => {
  it.each([["./losWorker", losInput], ["./vectorWorker", sensitivityInput]] as const)("falls back once for %s and fails when explicit", async (path, input) => {
    loader.mockRejectedValue(new Error("init unavailable"));
    const handler = await handlerOf(path);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const expected = await run(handler, { ...input, engine: "ts" });
      for (let i = 0; i < 2; i++) {
        const request = i === 0 ? { ...input, engine: "wasm" } : { ...input, engine: "wasm", engine_explicit: false };
        const result = await run(handler, request);
        expect(result[0]!.message.engine_used).toBe("ts");
        expect(result[0]!.message.engine_fallback).toContain("init unavailable");
        const { engine_fallback, ...withoutFallback } = result[0]!.message;
        expect(engine_fallback).toBeTruthy();
        expect(withoutFallback).toEqual(expected[0]!.message);
        expect(result[0]!.transfer).toHaveLength(2);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      const result = await run(handler, { ...input, engine: "wasm", engine_explicit: true });
      expect(result[0]!.message.engine_used).toBe("wasm");
      expect(result[0]!.message.error).toContain("init unavailable");
    } finally { warn.mockRestore(); }
  });
  it.each([["./losWorker", losInput], ["./vectorWorker", sensitivityInput]] as const)("does not fall back on domain error for %s", async (path, input) => {
    loader.mockResolvedValue({ compute_los_analysis: () => { throw new Error("domain failure"); }, sensitivity: () => { throw new Error("domain failure"); } });
    const handler = await handlerOf(path);
    const result = await run(handler, { ...input, engine: "wasm", engine_explicit: false });
    expect(result[0]!.message.engine_used).toBe("wasm");
    expect(result[0]!.message.error).toContain("domain failure");
    expect(result[0]!.message.engine_fallback).toBeUndefined();
  });
});
