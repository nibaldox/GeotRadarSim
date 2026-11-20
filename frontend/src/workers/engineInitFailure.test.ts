/**
 * A WASM initialisation failure is reported as the job's error by both workers. It never
 * falls back silently to the TypeScript engine (that would contaminate an A/B), and the "ts"
 * engine of the same worker keeps working.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../wasm/loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wasm/loader")>()),
  loadRadarWasm: vi.fn(() => Promise.reject(new Error("CompileError: WebAssembly.instantiate(): expected magic word"))),
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

describe("WASM initialisation failure", () => {
  it("fails the LOS job clearly instead of falling back to TS", async () => {
    const handler = await handlerOf("./losWorker");
    const posted = await run(handler, { ...losInput, engine: "wasm" });
    expect(posted).toEqual([{
      message: {
        error: "LOS WASM engine failed to initialize: CompileError: WebAssembly.instantiate(): expected magic word",
        engine_used: "wasm",
      },
      transfer: [],
    }]);
    // The TS engine of the same worker is unaffected.
    const ts = await run(handler, { ...losInput, engine: "ts" });
    expect(ts).toHaveLength(1);
    expect(ts[0]!.message.error).toBeUndefined();
    expect(ts[0]!.message.engine_used).toBe("ts");
  });

  it("still reports validation errors before touching the WASM module", async () => {
    const handler = await handlerOf("./losWorker");
    const posted = await run(handler, { ...losInput, resolution: 0, engine: "wasm" });
    expect(posted.map((entry) => entry.message)).toEqual([{ error: "LOS resolution must be finite and positive", engine_used: "wasm" }]);
  });

  it("fails the sensitivity job clearly instead of falling back to TS", async () => {
    const handler = await handlerOf("./vectorWorker");
    const posted = await run(handler, { ...sensitivityInput, engine: "wasm" });
    expect(posted).toEqual([{
      message: {
        error: "Sensitivity WASM engine failed to initialize: CompileError: WebAssembly.instantiate(): expected magic word",
        engine_used: "wasm",
      },
      transfer: [],
    }]);
    const ts = await run(handler, { ...sensitivityInput, engine: "ts" });
    expect(ts).toHaveLength(1);
    expect(ts[0]!.message.error).toBeUndefined();
    expect(ts[0]!.message.engine_used).toBe("ts");
  });
});
