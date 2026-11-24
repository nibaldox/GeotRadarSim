/**
 * Engine parity at the Worker boundary: the real `losWorker` and `vectorWorker` message
 * handlers run with `engine: "ts"` and `engine: "wasm"` on the same inputs, and their COMPLETE
 * posted messages are compared:
 * - objects and arrays in depth, with identical keys in identical order;
 * - typed arrays by constructor, length and bits (Float32/Float64 through integer views; any
 *   NaN equals any NaN, while +0 and -0 differ);
 * - plain numbers with Object.is (any NaN equals any NaN);
 * - the Transferable list, by the fields whose buffers it carries;
 * - `engine_used`, which must be "ts" and "wasm" respectively.
 * Errors must carry the identical message.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOSCellState, type AnalysisSnapshot, type RadarConfig, type SensitivityObservation } from "../types/api";
import { listRadars, normalizeAzimuthRange } from "../services/api";
import { generateSyntheticTerrain } from "../services/terrainEngine";
import { loadRadarWasm } from "../wasm/loader";
import type { LOSWorkerInput, LOSWorkerOutput } from "./losWorker";
import type { SensitivityWorkerInput, SensitivityWorkerOutput } from "./vectorWorker";

type Engine = "ts" | "wasm";
type Handler = (event: MessageEvent) => void | Promise<void>;
interface Posted {
  message: Record<string, unknown>;
  transfer: readonly unknown[];
}

let losHandler: Handler;
let sensitivityHandler: Handler;
let deadlineMs: number;
let catalog: RadarConfig[];
let wasm: Awaited<ReturnType<typeof loadRadarWasm>>;
const summary = { losPairs: 0, losCells: 0, losErrorPairs: 0, sensitivityPairs: 0, sensitivityCells: 0, sensitivityErrorPairs: 0, shadowZones: 0, states: [0, 0, 0, 0, 0, 0] };

beforeAll(async () => {
  wasm = await loadRadarWasm();
  vi.resetModules();
  const scope: { onmessage: Handler | null; postMessage: () => void } = { onmessage: null, postMessage: () => undefined };
  vi.stubGlobal("self", scope);
  const losModule = await import("./losWorker");
  losHandler = scope.onmessage!;
  scope.onmessage = null;
  await import("./vectorWorker");
  sensitivityHandler = scope.onmessage!;
  vi.unstubAllGlobals();
  if (!losHandler || !sensitivityHandler) throw new Error("Workers did not register their message handlers");
  deadlineMs = losModule.LOS_RUNTIME_DEADLINE_MS;
  catalog = await listRadars();
});

afterAll(() => {
  vi.unstubAllGlobals();
  console.info(`[engineParity] ${JSON.stringify(summary)}`);
});

/** Run a real handler exactly as its Worker would, awaiting the asynchronous "wasm" path. */
async function runHandler(handler: Handler, data: unknown): Promise<Posted> {
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
  expect(posted, "exactly one posted message").toHaveLength(1);
  return posted[0]!;
}

function hex(value: number | bigint, width: number): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

/** First difference between two values, or null. See the file header for the rules. */
function firstDifference(a: unknown, b: unknown, path = "$"): string | null {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return `${path}: typed array vs non-typed array`;
    if (a.constructor !== b.constructor) return `${path}: ${a.constructor.name} vs ${b.constructor.name}`;
    const left = a as unknown as ArrayLike<number> & ArrayBufferView;
    const right = b as unknown as ArrayLike<number> & ArrayBufferView;
    if (left.length !== right.length) return `${path}: length ${left.length} vs ${right.length}`;
    if (a instanceof Float32Array || a instanceof Float64Array) {
      const wide = a instanceof Float64Array;
      const leftBits = wide ? new BigUint64Array(left.buffer, left.byteOffset, left.length) : new Uint32Array(left.buffer, left.byteOffset, left.length);
      const rightBits = wide ? new BigUint64Array(right.buffer, right.byteOffset, right.length) : new Uint32Array(right.buffer, right.byteOffset, right.length);
      for (let i = 0; i < left.length; i++) {
        if (Number.isNaN(left[i]) && Number.isNaN(right[i])) continue;
        if (leftBits[i] !== rightBits[i]) {
          return `${path}[${i}]: ${left[i]} (${hex(leftBits[i]!, wide ? 16 : 8)}) vs ${right[i]} (${hex(rightBits[i]!, wide ? 16 : 8)})`;
        }
      }
      return null;
    }
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return `${path}[${i}]: ${left[i]} vs ${right[i]}`;
    }
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      if ((i in a) !== (i in b)) return `${path}[${i}]: hole vs value`;
      const difference = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return null;
    return Object.is(a, b) ? null : `${path}: ${Object.is(a, -0) ? "-0" : a} vs ${Object.is(b, -0) ? "-0" : b}`;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${path}: different prototypes`;
    const leftKeys = Object.keys(a);
    const rightKeys = Object.keys(b);
    if (leftKeys.join("\u0000") !== rightKeys.join("\u0000")) return `${path}: keys [${leftKeys}] vs [${rightKeys}]`;
    for (const key of leftKeys) {
      const difference = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

/** Names of the top-level fields whose buffers were transferred, in transfer order. */
function transferredFields(posted: Posted): string[] {
  return posted.transfer.map((buffer) => {
    const entry = Object.entries(posted.message).find(([, value]) => ArrayBuffer.isView(value) && value.buffer === buffer);
    return entry ? entry[0] : "<unknown buffer>";
  });
}

/** Compare the complete posted messages of both engines; returns the "ts" message. */
function expectSamePosted(label: string, ts: Posted, rs: Posted): Record<string, unknown> {
  expect(ts.message.engine_used, `${label}: ts engine_used`).toBe("ts");
  expect(rs.message.engine_used, `${label}: wasm engine_used`).toBe("wasm");
  const difference = firstDifference({ ...ts.message, engine_used: "*" }, { ...rs.message, engine_used: "*" });
  expect(difference, `${label}: first difference`).toBeNull();
  expect(transferredFields(rs), `${label}: transferables`).toEqual(transferredFields(ts));
  return ts.message;
}

async function compareLOS(label: string, input: LOSWorkerInput): Promise<LOSWorkerOutput> {
  const ts = await runHandler(losHandler, { ...input, engine: "ts" });
  const rs = await runHandler(losHandler, { ...input, engine: "wasm" });
  const message = expectSamePosted(label, ts, rs) as unknown as LOSWorkerOutput;
  if (message.error !== undefined) {
    summary.losErrorPairs++;
    expect(Object.keys(ts.message), label).toEqual(["error", "engine_used"]);
    expect(ts.transfer, label).toEqual([]);
  } else {
    summary.losPairs++;
    summary.losCells += message.cell_states.length;
    summary.shadowZones += message.shadow_zones.length;
    for (const state of message.cell_states) summary.states[state]!++;
    expect(transferredFields(ts), label).toEqual(["flat_quality_grid", "flat_projection_grid"]);
  }
  return message;
}

async function compareSensitivity(label: string, input: SensitivityWorkerInput): Promise<SensitivityWorkerOutput> {
  const ts = await runHandler(sensitivityHandler, { ...input, engine: "ts" });
  const rs = await runHandler(sensitivityHandler, { ...input, engine: "wasm" });
  const message = expectSamePosted(label, ts, rs) as unknown as SensitivityWorkerOutput;
  if (message.error !== undefined) {
    summary.sensitivityErrorPairs++;
    expect(Object.keys(ts.message), label).toEqual(["error", "engine_used"]);
  } else {
    summary.sensitivityPairs++;
    summary.sensitivityCells += message.observer_count.length;
    expect(transferredFields(ts), label).toEqual(["flat_sensitivity_grid", "observer_count"]);
  }
  return message;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function losInput(
  grid: number[][],
  minX: number,
  minY: number,
  resolution: number,
  position: [number, number, number],
  radar: RadarConfig,
): LOSWorkerInput {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  return {
    grid,
    bounds: { min_x: minX, min_y: minY, max_x: minX + (cols - 1) * resolution, max_y: minY + (rows - 1) * resolution },
    resolution,
    radar_position: position,
    radar_config: radar,
  };
}

/** The api.ts override mapping (range/elevation patches and RAR azimuth). */
function withOverrides(radar: RadarConfig, overrides: { rangeMax?: number; elMin?: number; azCenter?: number; azWidth?: number }): RadarConfig {
  const effective: RadarConfig = { ...radar };
  if (overrides.rangeMax !== undefined) effective.max_range_m = overrides.rangeMax;
  if (overrides.elMin !== undefined) effective.elevation_min_deg = overrides.elMin;
  if (overrides.azCenter !== undefined || overrides.azWidth !== undefined) {
    effective.azimuth_range_deg = normalizeAzimuthRange(overrides.azCenter ?? 0, overrides.azWidth ?? radar.h_beam_width_deg);
    effective.scan_pattern = "RAR";
  }
  return effective;
}

function seededTerrain(random: () => number, caseIndex: number): { grid: number[][]; rows: number; cols: number } {
  let rows = 2 + Math.floor(random() * 40);
  let cols = 2 + Math.floor(random() * 40);
  if (rows === cols) cols++;
  if (caseIndex % 8 === 0) rows = 2;
  const amplitude = [0, 3, 12, 40][Math.floor(random() * 4)]!;
  const holeRate = [0, 0.03, 0.12][Math.floor(random() * 3)]!;
  const freqA = 0.1 + random() * 0.6;
  const freqB = 0.1 + random() * 0.6;
  const phase = random() * 6;
  const quantize = random() < 0.3;
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      let z = amplitude * (Math.sin(c * freqA + phase) * Math.cos(r * freqB) + 0.3 * (random() - 0.5));
      if (quantize) z = Math.round(z);
      row.push(random() < holeRate ? Number.NaN : z);
    }
    grid.push(row);
  }
  if (rows > 3 && cols > 3 && random() < 0.4) {
    const r0 = Math.floor(random() * (rows - 2));
    const c0 = Math.floor(random() * (cols - 2));
    for (let r = r0; r < r0 + 2; r++) for (let c = c0; c < c0 + 2; c++) grid[r]![c] = Number.NaN;
  }
  return { grid, rows, cols };
}

const sensitivityTerrainKey = { terrain_id: "engine-parity", epoch: 3 };

function observationFrom(analysisId: string, position: [number, number, number], output: LOSWorkerOutput): SensitivityObservation {
  const snapshot: AnalysisSnapshot = {
    terrainKey: sensitivityTerrainKey,
    analysisId,
    sourceAnalysisIds: [analysisId],
    generation: 1,
    radars: [{
      radarId: `radar-${analysisId}`,
      radarModelId: "groundprobe-ssr-fx",
      position: { x: position[0], y: position[1], z: position[2] },
      overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
    }],
  };
  return { analysisId, snapshot, grid_rows: output.grid_rows, grid_cols: output.grid_cols, resolution: output.resolution, cell_states: output.cell_states };
}

function sensitivityInput(grid: number[][], minX: number, minY: number, resolution: number, observations: SensitivityObservation[]): SensitivityWorkerInput {
  return {
    type: "SENSITIVITY",
    terrainKey: { ...sensitivityTerrainKey },
    grid,
    grid_rows: grid.length,
    grid_cols: grid[0]?.length ?? 0,
    resolution,
    bounds: { min_x: minX, min_y: minY, min_z: 0, max_x: 0, max_y: 0, max_z: 0 },
    observations,
  };
}

describe("LOS worker: ts ↔ wasm complete-response parity", () => {
  it("matches on rectangular terrainEngine pits with the 4 catalog radars at several positions", async () => {
    expect(catalog.map((radar) => radar.model_id)).toEqual(["groundprobe-ssr-fx", "ibis-arcsar360", "reutech-msr", "chcnav-ps-2000"]);
    let visibleCases = 0;
    let fullPolygons = 0;
    for (const [sizeX, sizeY, depth, resolution] of [[300, 180, 60, 2], [1200, 640, 140, 8]] as const) {
      const { grid, metadata } = generateSyntheticTerrain(sizeX, sizeY, depth, resolution);
      expect(metadata.grid_rows).not.toBe(metadata.grid_cols);
      const { min_x, min_y, max_x, max_y } = metadata.bounds;
      const positions: Array<[number, number, number]> = [
        [min_x + 0.1 * (max_x - min_x), min_y + 0.05 * (max_y - min_y), 6],
        [(min_x + max_x) / 2, max_y, 25],
        [min_x + 0.37 * (max_x - min_x), min_y + 0.61 * (max_y - min_y), -10],
        [(min_x + max_x) / 2, (min_y + max_y) / 2, 0],
      ];
      for (const radar of catalog) {
        for (const [index, position] of positions.entries()) {
          const config = index === 3 ? withOverrides(radar, { rangeMax: 0.4 * (max_x - min_x), azCenter: 200, azWidth: 300 }) : radar;
          const output = await compareLOS(`${metadata.grid_rows}x${metadata.grid_cols} ${radar.model_id} #${index}`,
            { grid, bounds: metadata.bounds, resolution: metadata.resolution, radar_position: position, radar_config: config });
          expect(output.error).toBeUndefined();
          if (output.cell_states.includes(LOSCellState.VISIBLE)) visibleCases++;
          if (output.coverage_polygon.length === 100) fullPolygons++;
        }
      }
    }
    expect(visibleCases).toBeGreaterThan(12);
    expect(fullPolygons, "coverage_polygon truncated at 100 points").toBeGreaterThan(0);
  }, 30_000);

  it("matches on 24 seeded pseudo-random terrains with NaN holes, radar overrides and azimuth sectors", async () => {
    const random = mulberry32(0x2b_e9_1120);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const states = [0, 0, 0, 0, 0, 0];
    let zones = 0;
    for (let caseIndex = 0; caseIndex < 24; caseIndex++) {
      const { grid, rows, cols } = seededTerrain(random, caseIndex);
      const resolution = pick([0.5, 1, 2, 2.5, 3.7, 10]);
      const minX = pick([0, -50.25, 92_008.875, 100_000.1]);
      const minY = pick([0, 17.5, 20_288.2734375, -3_000.3]);
      const gx = pick(["node", "inside", "outside"] as const) === "outside" ? -0.5 * cols + random() * 2 * cols : random() * (cols - 1);
      const gy = random() * (rows - 1);
      const ground = grid[Math.min(rows - 1, Math.max(0, Math.round(gy)))]?.[Math.min(cols - 1, Math.max(0, Math.round(gx)))];
      const position: [number, number, number] = [minX + gx * resolution, minY + gy * resolution, (Number.isFinite(ground) ? ground! : 0) + pick([-5, 0, 2, 15, 60])];
      let radar: RadarConfig = catalog[caseIndex % catalog.length]!;
      if (caseIndex % 2 === 1) {
        const extent = Math.hypot(cols, rows) * resolution;
        const elMin = -90 + random() * 80;
        radar = {
          ...radar,
          min_range_m: random() < 0.5 ? 0 : random() * 0.2 * extent,
          max_range_m: extent * (0.3 + random() * 1.2),
          elevation_min_deg: elMin,
          elevation_max_deg: Math.min(90, elMin + 10 + random() * 150),
        };
        if (random() < 0.7) {
          radar.azimuth_range_deg = normalizeAzimuthRange(-200 + random() * 560, 10 + random() * 360);
          radar.scan_pattern = "RAR";
        }
      }
      const output = await compareLOS(`seeded #${caseIndex} ${rows}x${cols} ${radar.model_id}`, losInput(grid, minX, minY, resolution, position, radar));
      expect(output.error).toBeUndefined();
      for (const state of output.cell_states) states[state]!++;
      zones += output.shadow_zones.length;
    }
    for (const state of Object.values(LOSCellState)) expect(states[state], `state ${state}`).toBeGreaterThan(0);
    expect(zones).toBeGreaterThan(0);
  });

  it("matches with many shadow zones, zones larger than 1024 cells and grids with no candidates", async () => {
    // Ridges across a slope: many separate shadow zones behind each ridge.
    const rows = 60;
    const cols = 90;
    const ridges = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (c % 15 === 7 ? 25 : 0.2 * Math.sin(r / 3 + c / 5))));
    const many = await compareLOS("ridges", losInput(ridges, 0, 0, 1, [0, 30, 3], openRadar));
    // F-ACNE: with the radar at z = 3 the oracle's 4920 real shadows form ONE zone; the other
    // 50 zones of the old expectation (> 3) were made only of false endpoint-rounding shadows.
    expect(many.shadow_zones.length).toBe(1);
    // A higher radar sees between the ridges: 6 zones, all oracle-confirmed real shadows.
    const high = await compareLOS("ridges-high", losInput(ridges, 0, 0, 1, [0, 30, 40], openRadar));
    expect(high.shadow_zones.length).toBeGreaterThan(3);
    // One wall: a single shadow zone of several thousand cells.
    const wall = Array.from({ length: 80 }, (_, r) => Array.from({ length: 120 }, (_, c) => (c === 10 && r > 2 && r < 77 ? 80 : 0)));
    const big = await compareLOS("wall", losInput(wall, 0, 0, 1, [0, 40, 5], openRadar));
    expect(Math.max(...big.shadow_zones.map((zone) => zone.cell_count))).toBeGreaterThan(2_048);
    // Everything out of range: no candidates, null percentages.
    const none = await compareLOS("out-of-range", losInput(wall, 0, 0, 1, [1e5, 1e5, 5], { ...openRadar, max_range_m: 10 }));
    expect(none.coverage_pct).toBeNull();
    expect(none.completeness_pct).toBeNull();
    // All NODATA.
    await compareLOS("all-nodata", losInput([[Number.NaN, Number.NaN], [Number.NaN, Number.NaN]], 0, 0, 1, [0, 0, 1], openRadar));
  });

  it("treats non-number DEM entries exactly like the TS engine (null, undefined, strings, booleans, holes)", async () => {
    const grid = Array.from({ length: 6 }, (_, r) => Array.from({ length: 7 }, (_, c) => (r + c) % 4 - 1)) as unknown[][];
    grid[1]![2] = null;
    grid[2]![4] = "5";
    grid[3]![1] = true;
    grid[4]![5] = undefined;
    grid[0]![3] = -0;
    delete grid[5]![6];
    const output = await compareLOS("loose entries", losInput(grid as number[][], 3, -4, 2, [7, -1, 9], openRadar));
    expect(output.cell_states[2 * 7 + 4]).toBe(LOSCellState.NODATA);
    expect(output.cell_states[1 * 7 + 2]).toBe(LOSCellState.NODATA);
  });

  it("reproduces every validation and traversal error with the identical message", async () => {
    const flat = [[0, 0], [0, 0]];
    const cases: Array<[string, unknown]> = [
      ["empty", losInput([], 0, 0, 1, [0, 0, 1], openRadar)],
      ["grid-null", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), grid: null }],
      ["grid-object", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), grid: { length: 2 } }],
      ["first-row-not-array", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), grid: [1, 2] }],
      ["first-row-empty", losInput([[]], 0, 0, 1, [0, 0, 1], openRadar)],
      ["row-not-array", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), grid: [[0, 0], null] }],
      ["row-typed-array", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), grid: [[0, 0], new Float64Array(2)] }],
      ["ragged-short", losInput([[0, 0], [0]], 0, 0, 1, [0, 0, 1], openRadar)],
      ["ragged-long", losInput([[0, 0], [0, 0, 0]], 0, 0, 1, [0, 0, 1], openRadar)],
      ["axis-limit", losInput([Array(16_385).fill(0)], 0, 0, 1, [0, 0, 1], openRadar)],
      ["cell-limit", losInput(Array.from({ length: 1_001 }, () => new Array<number>(1_000).fill(0)), 0, 0, 1, [0, 0, 1], openRadar)],
      ["resolution-zero", losInput(flat, 0, 0, 0, [0, 0, 1], openRadar)],
      ["resolution-nan", losInput(flat, 0, 0, Number.NaN, [0, 0, 1], openRadar)],
      ["resolution-string", losInput(flat, 0, 0, "1" as unknown as number, [0, 0, 1], openRadar)],
      ["area-underflow", losInput(flat, 0, 0, 1e-200, [0, 0, 1], openRadar)],
      ["total-area", losInput(flat, 0, 0, 1e154, [0, 0, 1], openRadar)],
      ["bounds-nan", losInput(flat, Number.NaN, 0, 1, [0, 0, 1], openRadar)],
      ["position-infinite", losInput(flat, 0, 0, 1, [0, Infinity, 1], openRadar)],
      ["position-short", losInput(flat, 0, 0, 1, [0, 0] as unknown as [number, number, number], openRadar)],
      ["range-negative", losInput(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, min_range_m: -1 })],
      ["range-string", losInput(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, max_range_m: "9" as unknown as number })],
      ["range-unordered", losInput(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, min_range_m: 5, max_range_m: 4 })],
      ["elevation-low", losInput(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_min_deg: -91 })],
      ["elevation-unordered", losInput(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_min_deg: 5, elevation_max_deg: 4 })],
      ["elevation-nan", losInput(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_max_deg: Number.NaN })],
      ["precision-stall", losInput([new Array<number>(16_384).fill(0), new Array<number>(16_384).fill(0)], 0, 0, 1,
        [2 ** 60, 0.5, 1e6], { ...openRadar, max_range_m: 1e300 })],
    ];
    const messages = new Set<string>();
    for (const [label, input] of cases) {
      const output = await compareLOS(label, input as LOSWorkerInput);
      expect(output.error, label).toEqual(expect.any(String));
      messages.add(output.error!);
    }
    // Every distinct computeLOS message: non-empty, rectangular, axis limit, cell limit,
    // resolution, cell area, total area, finite bounds/position, range, elevation and the
    // traversal precision stall.
    expect(messages.size).toBe(11);
    expect(messages).toContain("LOS grid must be rectangular");
    expect(messages).toContain("LOS ray traversal cannot advance at floating-point precision");
  });

  it("reproduces V8 TypeErrors from missing input fields through the same shared validation", async () => {
    // These messages are generated by V8 and depend on the JIT tier of the destructuring
    // function: `const { radar_position: [rx, ry, rz] } = input` throws "Cannot destructure
    // property 'Symbol(Symbol.iterator)' of 'input' as it is undefined." when cold and "input is
    // not iterable (cannot read property Symbol(Symbol.iterator))" once optimised, even within
    // the "ts" engine alone. Both engines run the same validateLOSInput, so each run uses a
    // freshly imported worker (cold functions) to compare like with like.
    const flat = [[0, 0], [0, 0]];
    const cases: Array<[string, unknown]> = [
      ["position-missing", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), radar_position: undefined }],
      ["bounds-missing", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), bounds: undefined }],
      ["radar-missing", { ...losInput(flat, 0, 0, 1, [0, 0, 1], openRadar), radar_config: undefined }],
    ];
    const freshHandler = async (): Promise<Handler> => {
      vi.resetModules();
      const scope: { onmessage: Handler | null; postMessage: () => void } = { onmessage: null, postMessage: () => undefined };
      vi.stubGlobal("self", scope);
      await import("./losWorker");
      vi.unstubAllGlobals();
      return scope.onmessage!;
    };
    for (const [label, input] of cases) {
      const ts = await runHandler(await freshHandler(), { ...(input as object), engine: "ts" });
      const rs = await runHandler(await freshHandler(), { ...(input as object), engine: "wasm" });
      expectSamePosted(label, ts, rs);
      expect(ts.message.error, label).toMatch(/undefined|not iterable/);
      summary.losErrorPairs++;
    }
  });

  it("reports a failure while posting the result as the job error in both engines and both workers", async () => {
    const losData = losInput([[0, 1, 2], [1, 2, 3]], 0, 0, 1, [0, 0, 10], openRadar);
    const sensitivityData = sensitivityInput([[0, 1, 2], [1, 2, 3]], 0, 0, 1, [
      observationFrom("post", [0, 0, 10], { grid_rows: 2, grid_cols: 3, resolution: 1, cell_states: new Uint8Array(6).fill(5) } as LOSWorkerOutput),
    ]);
    for (const [handler, data] of [[() => losHandler, losData], [() => sensitivityHandler, sensitivityData]] as const) {
      for (const engine of ["ts", "wasm"] as const) {
        const posted: unknown[] = [];
        let calls = 0;
        vi.stubGlobal("self", {
          onmessage: null,
          postMessage: (message: unknown) => {
            if (++calls === 1) throw new Error("DataCloneError: simulated");
            posted.push(message);
          },
        });
        try {
          await handler()({ data: { ...data, engine } } as MessageEvent);
        } finally {
          vi.unstubAllGlobals();
        }
        expect(posted).toEqual([{ error: "DataCloneError: simulated", engine_used: engine }]);
      }
    }
  });

  it("rejects an unknown engine in both workers without computing", async () => {
    const los = await runHandler(losHandler, { ...losInput([[0, 0], [0, 0]], 0, 0, 1, [0, 0, 1], openRadar), engine: "gpu" });
    expect(los.message).toEqual({ error: 'Unknown LOS compute engine: "gpu"' });
    const sensitivity = await runHandler(sensitivityHandler, { ...sensitivityInput([[0, 0], [0, 0]], 0, 0, 1, []), engine: null });
    expect(sensitivity.message).toEqual({ error: "Unknown sensitivity compute engine: null" });
  });

  it("documents the one LOS input the f64 boundary refuses: a non-numeric azimuth sector", async () => {
    const grid = [[0, 1, 2], [1, 2, 3], [2, 3, 4]];
    const radar = { ...openRadar, scan_pattern: "RAR" as const, azimuth_range_deg: ["10", "9"] as unknown as [number, number] };
    const ts = await runHandler(losHandler, { ...losInput(grid, 0, 0, 1, [1, 1, 9], radar), engine: "ts" });
    const rs = await runHandler(losHandler, { ...losInput(grid, 0, 0, 1, [1, 1, 9], radar), engine: "wasm" });
    expect(ts.message.error).toBeUndefined();
    expect(rs.message).toEqual({ error: "LOS azimuth range must be null or a [start, end] pair of numbers for the WASM engine", engine_used: "wasm" });
    // Missing entries are NaN in both engines, so a one-element sector still matches.
    await compareLOS("azimuth [start]", losInput(grid, 0, 0, 1, [1, 1, 9], { ...radar, azimuth_range_deg: [45] as unknown as [number, number] }));
  });
});

describe("LOS worker: one 120 s deadline window in both engines", () => {
  const ridgeRows = 4;
  const ridgeCols = 1_400;
  const ridge = Array.from({ length: ridgeRows }, (_, r) => Array.from({ length: ridgeCols }, (_, c) => (c > 300 && c < 330 ? 200 : 2 * Math.sin(c / 50 + r))));
  const ridgeInput = losInput(ridge, 0, 0, 1, [0, 1.5, 300], { ...openRadar, max_range_m: 5_000 });
  // A wall casting one shadow zone of > 2048 cells: BFS polls inside the zone, not only per row.
  const wall = Array.from({ length: 40 }, (_, r) => Array.from({ length: 160 }, (_, c) => (c === 5 && r > 0 && r < 39 ? 90 : 0)));
  const wallInput = losInput(wall, 0, 0, 1, [0, 20, 4], openRadar);
  const inputs: Array<[string, LOSWorkerInput, number]> = [["ridge", ridgeInput, ridgeRows], ["wall", wallInput, 40]];

  function withClock<T>(now: () => number, run: () => Promise<T>): Promise<T> {
    // runHandler unstubs every global once the handler settles, so the clock lives for one run.
    vi.stubGlobal("performance", { now });
    return run();
  }

  function countingClock(): { now: () => number; reads: () => number } {
    let reads = 0;
    return { now: () => { reads++; return 0; }, reads: () => reads };
  }

  /** Clock reads of the per-cell phase alone (window start included), via the cell-only binding. */
  function perCellReads(input: LOSWorkerInput): number {
    const clock = countingClock();
    vi.stubGlobal("performance", { now: clock.now });
    try {
      const values = new Float64Array(input.grid.flat());
      wasm.compute_los(values, input.grid.length, input.grid[0]!.length, input.bounds.min_x, input.bounds.min_y, input.resolution,
        ...input.radar_position, input.radar_config.min_range_m, input.radar_config.max_range_m,
        input.radar_config.elevation_min_deg, input.radar_config.elevation_max_deg, false, Number.NaN, Number.NaN, deadlineMs);
    } finally {
      vi.unstubAllGlobals();
    }
    return clock.reads();
  }

  it("reads the clock the same number of times, covering the per-cell phase and the shadow-zone BFS", async () => {
    for (const [label, input, rows] of inputs) {
      const tsClock = countingClock();
      const ts = await withClock(tsClock.now, () => runHandler(losHandler, { ...input, engine: "ts" }));
      const rsClock = countingClock();
      const rs = await withClock(rsClock.now, () => runHandler(losHandler, { ...input, engine: "wasm" }));
      expectSamePosted(label, ts, rs);
      expect(rsClock.reads(), label).toBe(tsClock.reads());
      const cellPhase = perCellReads(input);
      // BFS phase: one read per row plus at least one in-zone read for the wall.
      expect(rsClock.reads() - cellPhase, label).toBeGreaterThanOrEqual(rows);
      if (label === "wall") expect(rsClock.reads() - cellPhase).toBeGreaterThan(rows);
    }
  });

  // Exhaustive: ~10 aborts × 2 engines × every input; ~4.5 s alone, so it needs more than vitest's 5 s default.
  it("aborts with the identical TS message at every sampled check point of both phases", async () => {
    for (const [label, input] of inputs) {
      const counter = countingClock();
      await withClock(counter.now, () => runHandler(losHandler, { ...input, engine: "ts" }));
      const total = counter.reads();
      const cellPhase = perCellReads(input);
      // Allowed reads before the clock jumps; the window start is read 1.
      const samples = [...new Set([1, 2, 3, Math.floor(cellPhase / 2), cellPhase - 1, cellPhase, cellPhase + 1, cellPhase + 2, total - 2, total - 1])]
        .filter((k) => k >= 1 && k < total);
      expect(samples.some((k) => k >= cellPhase), `${label}: samples reach the BFS phase`).toBe(true);
      for (const allowed of samples) {
        const jumpAfter = (): (() => number) => { let reads = 0; return () => (++reads <= allowed ? 0 : 1e12); };
        const ts = await withClock(jumpAfter(), () => runHandler(losHandler, { ...input, engine: "ts" }));
        const rs = await withClock(jumpAfter(), () => runHandler(losHandler, { ...input, engine: "wasm" }));
        expectSamePosted(`${label} abort after ${allowed}`, ts, rs);
        expect(ts.message.error, `${label} abort after ${allowed}`).toMatch(/^El cálculo de visibilidad LOS excedió el tiempo máximo de ejecución \(120 segundos\)\. /);
      }
    }
  }, 60_000);

  it("measures the BFS against the single window start (no second window)", async () => {
    for (const [label, input] of inputs) {
      const cellPhase = perCellReads(input);
      // Reads 1..cellPhase (start + per-cell checks) see t = 0; every BFS read sees `late`.
      const clock = (late: number) => { let reads = 0; return () => (++reads <= cellPhase ? 0 : late); };
      for (const engine of ["ts", "wasm"] as const satisfies readonly Engine[]) {
        // Exactly at the budget is still inside the window: the check is `elapsed > 120000`.
        const inside = await withClock(clock(deadlineMs), () => runHandler(losHandler, { ...input, engine }));
        expect(inside.message.error, `${label} ${engine} at the budget`).toBeUndefined();
        // One millisecond later fails in the BFS. A second window opened for the BFS would
        // start at t = 120001 and pass.
        const late = await withClock(clock(deadlineMs + 1), () => runHandler(losHandler, { ...input, engine }));
        expect(late.message.error, `${label} ${engine} past the budget`).toMatch(/excedió el tiempo máximo de ejecución \(120 segundos\)/);
        expect(late.message.engine_used).toBe(engine);
      }
    }
  });
});

describe("Sensitivity worker: ts ↔ wasm complete-response parity", () => {
  it("matches with real observations produced by both LOS engines on terrainEngine terrain", async () => {
    const { grid, metadata } = generateSyntheticTerrain(300, 180, 60, 2);
    const { min_x, min_y, max_x, max_y } = metadata.bounds;
    const positions: Array<[number, number, number]> = [
      [min_x + 0.1 * (max_x - min_x), min_y + 0.05 * (max_y - min_y), 6],
      [(min_x + max_x) / 2, max_y, 25],
      [min_x + 0.37 * (max_x - min_x), min_y + 0.61 * (max_y - min_y), -10],
    ];
    const fromEngine: Record<Engine, SensitivityObservation[]> = { ts: [], wasm: [] };
    for (const [index, position] of positions.entries()) {
      const input: LOSWorkerInput = { grid, bounds: metadata.bounds, resolution: metadata.resolution, radar_position: position, radar_config: catalog[index]! };
      for (const engine of ["ts", "wasm"] as const) {
        const posted = await runHandler(losHandler, { ...input, engine });
        const output = posted.message as unknown as LOSWorkerOutput;
        expect(output.engine_used).toBe(engine);
        fromEngine[engine].push(observationFrom(`analysis-${index}`, position, output));
      }
    }
    for (let i = 0; i < positions.length; i++) {
      expect(firstDifference(fromEngine.ts[i]!.cell_states, fromEngine.wasm[i]!.cell_states)).toBeNull();
    }
    const outputs: SensitivityWorkerOutput[] = [];
    for (const engine of ["ts", "wasm"] as const) {
      for (const count of [1, 2, 3]) {
        const output = await compareSensitivity(`terrainEngine LOS-${engine} ×${count}`,
          sensitivityInput(grid, min_x, min_y, metadata.resolution, fromEngine[engine].slice(0, count)));
        expect(output.error).toBeUndefined();
        outputs.push(output);
      }
    }
    // Same observations from either LOS engine give the same map.
    for (let i = 0; i < 3; i++) expect(firstDifference(outputs[i], outputs[i + 3])).toBeNull();
    expect(Math.max(...outputs[2]!.observer_count)).toBe(3);
  });

  it("matches on 20 seeded terrains with NaN holes and 1-5 real LOS observations from both engines", async () => {
    const random = mulberry32(0x5e_75_1120);
    let contributors = 0;
    for (let caseIndex = 0; caseIndex < 20; caseIndex++) {
      const { grid, rows, cols } = seededTerrain(random, caseIndex);
      const resolution = [0.5, 1, 2.5, 10][caseIndex % 4]!;
      const minX = [0, -50.25, 92_008.875][caseIndex % 3]!;
      const minY = [17.5, 0, -3_000.3][caseIndex % 3]!;
      const observationCount = 1 + (caseIndex % 5);
      const observations: Record<Engine, SensitivityObservation[]> = { ts: [], wasm: [] };
      for (let j = 0; j < observationCount; j++) {
        const position: [number, number, number] = [minX + random() * (cols - 1) * resolution, minY + random() * (rows - 1) * resolution, 5 + random() * 40];
        const input = losInput(grid, minX, minY, resolution, position, catalog[j % catalog.length]!);
        for (const engine of ["ts", "wasm"] as const) {
          const output = (await runHandler(losHandler, { ...input, engine })).message as unknown as LOSWorkerOutput;
          expect(output.error).toBeUndefined();
          observations[engine].push(observationFrom(`a${caseIndex}-${j}`, position, output));
        }
      }
      for (const engine of ["ts", "wasm"] as const) {
        const output = await compareSensitivity(`seeded #${caseIndex} ${rows}x${cols} LOS-${engine} ×${observationCount}`,
          sensitivityInput(grid, minX, minY, resolution, observations[engine]));
        expect(output.error).toBeUndefined();
        contributors += output.observer_count.reduce((sum, count) => sum + count, 0);
      }
    }
    expect(contributors).toBeGreaterThan(0);
  });

  it("matches with every cell-state code, non-number DEM entries and an empty observation list", async () => {
    const grid = Array.from({ length: 5 }, (_, r) => Array.from({ length: 6 }, (_, c) => Math.sin(r) * 3 + c * 0.7)) as unknown[][];
    grid[1]![1] = null;
    grid[3]![2] = "4";
    grid[2]![5] = Number.NaN;
    const observations = [0, 1, 2].map((j) => {
      const states = new Uint8Array(30).map((_, i) => (i + j) % 6);
      return observationFrom(`mixed-${j}`, [j * 2, 1 - j, 9 + j], { grid_rows: 5, grid_cols: 6, resolution: 1.5, cell_states: states } as LOSWorkerOutput);
    });
    await compareSensitivity("mixed states", sensitivityInput(grid as number[][], -7, 13, 1.5, observations));
    const empty = await compareSensitivity("no observations", sensitivityInput(grid as number[][], -7, 13, 1.5, []));
    expect(empty.observer_count.every((count) => count === 0)).toBe(true);
    expect(Array.from(empty.flat_sensitivity_grid).every(Number.isNaN)).toBe(true);
  });

  it("reproduces every handler validation error with the identical message", async () => {
    const grid = [[0, 1, 2], [1, 2, 3]];
    const good = () => observationFrom("v", [1, 1, 9], { grid_rows: 2, grid_cols: 3, resolution: 1, cell_states: new Uint8Array(6).fill(5) } as LOSWorkerOutput);
    const base = () => sensitivityInput(grid, 0, 0, 1, [good()]);
    const mutateObservation = (patch: (observation: Record<string, unknown>) => void) => {
      const input = base();
      const observation = { ...input.observations[0]! } as unknown as Record<string, unknown>;
      patch(observation);
      return { ...input, observations: [observation] };
    };
    const mutateSnapshot = (patch: (snapshot: Record<string, unknown>) => void) => mutateObservation((observation) => {
      const snapshot = { ...(observation.snapshot as object) } as Record<string, unknown>;
      patch(snapshot);
      observation.snapshot = snapshot;
    });
    const cases: Array<[string, unknown]> = [
      ["job-type", { ...base(), type: "VECTOR" }],
      ["terrain-key-missing", { ...base(), terrainKey: undefined }],
      ["terrain-key-epoch", { ...base(), terrainKey: { terrain_id: "engine-parity", epoch: -1 } }],
      ["rows-zero", { ...base(), grid_rows: 0 }],
      ["cols-fraction", { ...base(), grid_cols: 2.5 }],
      ["grid-not-array", { ...base(), grid: { length: 2 } }],
      ["grid-ragged", { ...base(), grid: [[0, 1, 2], [1, 2]] }],
      ["grid-row-null", { ...base(), grid: [[0, 1, 2], null] }],
      ["resolution-zero", { ...base(), resolution: 0 }],
      ["bounds-missing", { ...base(), bounds: undefined }],
      ["bounds-nan", { ...base(), bounds: { min_x: Number.NaN, min_y: 0 } }],
      ["observations-not-array", { ...base(), observations: "none" }],
      ["observation-null", { ...base(), observations: [null] }],
      ["duplicate-id", { ...base(), observations: [good(), good()] }],
      ["analysis-id-mismatch", mutateSnapshot((snapshot) => { snapshot.analysisId = "other"; })],
      ["source-ids", mutateSnapshot((snapshot) => { snapshot.sourceAnalysisIds = ["v", "w"]; })],
      ["terrain-key-mismatch", mutateSnapshot((snapshot) => { snapshot.terrainKey = { terrain_id: "engine-parity", epoch: 4 }; })],
      ["two-radars", mutateSnapshot((snapshot) => { snapshot.radars = [...(snapshot.radars as unknown[]), ...(snapshot.radars as unknown[])]; })],
      ["position-infinite", mutateSnapshot((snapshot) => {
        const radar = (snapshot.radars as Array<Record<string, unknown>>)[0]!;
        snapshot.radars = [{ ...radar, position: { x: 0, y: Infinity, z: 0 } }];
      })],
      ["observation-rows", mutateObservation((observation) => { observation.grid_rows = 3; })],
      ["observation-resolution", mutateObservation((observation) => { observation.resolution = 2; })],
      ["states-not-uint8", mutateObservation((observation) => { observation.cell_states = Array(6).fill(5); })],
      ["states-short", mutateObservation((observation) => { observation.cell_states = new Uint8Array(5); })],
    ];
    const messages = new Set<string>();
    for (const [label, input] of cases) {
      const output = await compareSensitivity(label, input as SensitivityWorkerInput);
      expect(output.error, label).toEqual(expect.any(String));
      messages.add(output.error!);
    }
    // Every distinct handler message: job type, terrain key, grid dimensions, resolution/origin,
    // observations array, incomplete, unique IDs, stable analysis ID, terrain-key mismatch,
    // one radar, radar identity/position and observation dimensions.
    expect(messages.size).toBe(12);
  });

  it("documents the one sensitivity input the Rust boundary refuses: cell states outside 0-5", async () => {
    const grid = [[0, 1, 2], [1, 2, 3]];
    const observation = observationFrom("bad", [1, 1, 9], { grid_rows: 2, grid_cols: 3, resolution: 1, cell_states: new Uint8Array([5, 5, 7, 5, 5, 5]) } as LOSWorkerOutput);
    const input = sensitivityInput(grid, 0, 0, 1, [observation]);
    const ts = await runHandler(sensitivityHandler, { ...input, engine: "ts" });
    const rs = await runHandler(sensitivityHandler, { ...input, engine: "wasm" });
    expect(ts.message.error).toBeUndefined();
    expect(rs.message).toEqual({ error: "Los estados de celda de la observación de sensibilidad deben ser códigos LOS de 0 a 5", engine_used: "wasm" });
  });
});
