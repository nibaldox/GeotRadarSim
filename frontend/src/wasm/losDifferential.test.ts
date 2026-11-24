/**
 * Differential equivalence: the real LOS worker handler (TypeScript) vs. the Rust/WASM port.
 *
 * - cell_states: byte-for-byte equality.
 * - quality / projection: Float32 bit equality through Uint32Array views (any NaN ≡ any NaN).
 * - errors: identical user-visible message.
 * Any mismatch reports the first differing cell with its index, both values and their bits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOSCellState, type RadarConfig } from "../types/api";
import { listRadars, normalizeAzimuthRange } from "../services/api";
import { generateSyntheticTerrain } from "../services/terrainEngine";
import type { LOSWorkerInput, LOSWorkerOutput } from "../workers/losWorker";
import { loadRadarWasm } from "./loader";

type RadarWasm = Awaited<ReturnType<typeof loadRadarWasm>>;
type Handler = (event: MessageEvent<LOSWorkerInput>) => void;

interface LosBuffersOut {
  cell_states: Uint8Array;
  quality: Float32Array;
  projection: Float32Array;
}
type Outcome = { ok: true; out: LosBuffersOut } | { ok: false; message: string; code?: string };

let wasm: RadarWasm;
let handler: Handler;
let deadlineMs: number;
let catalog: RadarConfig[];
const summary = { cases: 0, cells: 0, errorCases: 0, states: [0, 0, 0, 0, 0, 0] };

beforeAll(async () => {
  wasm = await loadRadarWasm();
  vi.resetModules();
  const scope: { onmessage: Handler | null; postMessage: (message: unknown) => void } = {
    onmessage: null,
    postMessage: () => undefined,
  };
  vi.stubGlobal("self", scope);
  const module = await import("../workers/losWorker");
  vi.unstubAllGlobals();
  if (!scope.onmessage) throw new Error("LOS worker did not register its message handler");
  handler = scope.onmessage;
  deadlineMs = module.LOS_RUNTIME_DEADLINE_MS;
  catalog = await listRadars();
});

afterAll(() => {
  vi.unstubAllGlobals();
  // Evidence for the hand-off report.
  console.info(`[losDifferential] ${JSON.stringify(summary)}`);
});

/** Run the real worker message handler, exactly as the Worker would. */
function runTs(input: LOSWorkerInput): Outcome {
  const posted: unknown[] = [];
  // The handler resolves the global `self` at call time, like inside a Worker.
  vi.stubGlobal("self", { onmessage: null, postMessage: (message: unknown) => posted.push(message) });
  handler({ data: input } as MessageEvent<LOSWorkerInput>);
  const result = posted[0] as LOSWorkerOutput;
  if (result.error !== undefined) return { ok: false, message: result.error };
  return {
    ok: true,
    out: {
      cell_states: result.cell_states,
      quality: result.flat_quality_grid!,
      projection: result.flat_projection_grid!,
    },
  };
}

/** Map a worker input onto the frozen WASM signature (the mapping W2b must use). */
function runWasm(input: LOSWorkerInput): Outcome {
  const grid = input.grid;
  const rows = Array.isArray(grid) ? grid.length : 0;
  const cols = rows > 0 && Array.isArray(grid[0]) ? grid[0].length : 0;
  let total = 0;
  for (const row of grid) total += row.length;
  const values = new Float64Array(total);
  let offset = 0;
  for (const row of grid) {
    values.set(row, offset);
    offset += row.length;
  }
  const radar = input.radar_config;
  const range = radar.azimuth_range_deg;
  const [rx, ry, rz] = input.radar_position;
  try {
    const out = wasm.compute_los(
      values, rows, cols, input.bounds.min_x, input.bounds.min_y, input.resolution, rx, ry, rz,
      radar.min_range_m ?? 0, radar.max_range_m, radar.elevation_min_deg, radar.elevation_max_deg,
      radar.scan_pattern !== "SAR360" && !!range, range?.[0] ?? Number.NaN, range?.[1] ?? Number.NaN,
      deadlineMs,
    ) as LosBuffersOut;
    return { ok: true, out };
  } catch (error) {
    const typed = error as Error & { code?: string };
    return { ok: false, message: typed.message, code: typed.code };
  }
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function cellLabel(index: number, cols: number): string {
  return `index ${index} (row ${Math.floor(index / Math.max(cols, 1))}, col ${index % Math.max(cols, 1)})`;
}

function firstStateDifference(ts: Uint8Array, rs: Uint8Array, cols: number): string | null {
  if (ts.length !== rs.length) return `cell_states length ts=${ts.length} wasm=${rs.length}`;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] !== rs[i]) return `cell_states ${cellLabel(i, cols)}: ts=${ts[i]} wasm=${rs[i]}`;
  }
  return null;
}

function firstFloat32Difference(name: string, ts: Float32Array, rs: Float32Array, cols: number): string | null {
  if (ts.length !== rs.length) return `${name} length ts=${ts.length} wasm=${rs.length}`;
  const tsBits = new Uint32Array(ts.buffer, ts.byteOffset, ts.length);
  const rsBits = new Uint32Array(rs.buffer, rs.byteOffset, rs.length);
  for (let i = 0; i < ts.length; i++) {
    if (Number.isNaN(ts[i]) && Number.isNaN(rs[i])) continue;
    if (tsBits[i] !== rsBits[i]) {
      return `${name} ${cellLabel(i, cols)}: ts=${ts[i]} (${hex32(tsBits[i]!)}) ` +
        `wasm=${rs[i]} (${hex32(rsBits[i]!)})`;
    }
  }
  return null;
}

/** Compare both engines on one input; returns the TS outcome for extra assertions. */
function expectEquivalent(label: string, input: LOSWorkerInput): Outcome {
  const ts = runTs(input);
  const rs = runWasm(input);
  summary.cases++;
  const cols = input.grid[0]?.length ?? 0;
  if (!ts.ok || !rs.ok) {
    summary.errorCases++;
    expect({ label, ok: rs.ok, message: rs.ok ? undefined : rs.message })
      .toEqual({ label, ok: ts.ok, message: ts.ok ? undefined : ts.message });
    if (!rs.ok) expect(rs.code, label).toMatch(/^LOS_[A-Z_]+$/);
    return ts;
  }
  const difference = firstStateDifference(ts.out.cell_states, rs.out.cell_states, cols) ??
    firstFloat32Difference("quality", ts.out.quality, rs.out.quality, cols) ??
    firstFloat32Difference("projection", ts.out.projection, rs.out.projection, cols);
  expect(difference, `${label}: first difference`).toBeNull();
  summary.cells += ts.out.cell_states.length;
  for (const state of ts.out.cell_states) summary.states[state] = (summary.states[state] ?? 0) + 1;
  return ts;
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

function inputFor(
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

function expectSomeVisible(outcome: Outcome, label: string): void {
  expect(outcome.ok, label).toBe(true);
  if (outcome.ok) expect(outcome.out.cell_states.includes(LOSCellState.VISIBLE), label).toBe(true);
}

describe("LOS TS ↔ WASM differential equivalence", () => {
  it("matches on rectangular synthetic terrainEngine pits with every catalog radar", () => {
    expect(catalog.map((radar) => radar.model_id)).toEqual(["groundprobe-ssr-fx", "ibis-arcsar360", "reutech-msr", "chcnav-ps-2000"]);
    const terrains = [generateSyntheticTerrain(300, 180, 60, 2), generateSyntheticTerrain(1200, 640, 140, 8)];
    let visible = 0;
    for (const terrain of terrains) {
      const { grid, metadata } = terrain;
      expect(metadata.grid_rows).not.toBe(metadata.grid_cols);
      const { min_x, min_y, max_x, max_y } = metadata.bounds;
      const positions: Array<[number, number, number]> = [
        [min_x + 0.1 * (max_x - min_x), min_y + 0.05 * (max_y - min_y), 6],
        [(min_x + max_x) / 2, max_y, 25],
        [min_x + 0.37 * (max_x - min_x), min_y + 0.61 * (max_y - min_y), -10],
      ];
      for (const radar of catalog) {
        for (const position of positions) {
          const outcome = expectEquivalent(`${metadata.grid_rows}x${metadata.grid_cols} ${radar.model_id}`,
            { grid, bounds: metadata.bounds, resolution: metadata.resolution, radar_position: position, radar_config: radar });
          if (outcome.ok) visible += outcome.out.cell_states.filter((s) => s === LOSCellState.VISIBLE).length;
        }
      }
    }
    expect(visible).toBeGreaterThan(0);
  }, 30_000);

  it("matches on 36 seeded pseudo-random terrains with NaN holes, random radars and catalog models", () => {
    const random = mulberry32(0x5eed_1a05);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const stateTotals = [0, 0, 0, 0, 0, 0];
    for (let caseIndex = 0; caseIndex < 36; caseIndex++) {
      let rows = 2 + Math.floor(random() * 46);
      let cols = 2 + Math.floor(random() * 46);
      if (rows === cols) cols++;
      if (caseIndex % 9 === 0) rows = 2;
      const catalogRadar = catalog[caseIndex % catalog.length]!;
      const override = caseIndex % 2 === 1;
      const resolution = override ? pick([0.5, 1, 2, 2.5, 3.7]) : pick([5, 10, 25, 50]);
      const minX = pick([0, -50.25, 92_008.875, 100_000.1]);
      const minY = pick([0, 17.5, 20_288.2734375, -3_000.3]);
      const amplitude = pick([0, 3, 12, 40]);
      const holeRate = pick([0, 0.03, 0.12]);
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
      if (random() < 0.3 && rows > 3 && cols > 3) {
        const r0 = Math.floor(random() * (rows - 2));
        const c0 = Math.floor(random() * (cols - 2));
        for (let r = r0; r < r0 + 2; r++) for (let c = c0; c < c0 + 2; c++) grid[r]![c] = Number.NaN;
      }

      const placement = pick(["node", "edge", "diagonal", "inside", "outside"] as const);
      let gx = random() * (cols - 1);
      let gy = random() * (rows - 1);
      if (placement === "node") { gx = Math.round(gx); gy = Math.round(gy); }
      if (placement === "edge") { gx = Math.round(gx); }
      if (placement === "diagonal") { const s = Math.floor(gx + gy); gx = Math.min(s, cols - 1) - 0.25; gy = s - gx; }
      if (placement === "outside") { gx = -0.5 * cols + random() * 2 * cols; gy = random() < 0.5 ? -2 - random() * rows : rows + random() * rows; }
      const ground = grid[Math.min(rows - 1, Math.max(0, Math.round(gy)))]?.[Math.min(cols - 1, Math.max(0, Math.round(gx)))];
      const height = (Number.isFinite(ground) ? ground! : 0) + pick([-5, 0, 2, 15, 60]);
      const position: [number, number, number] = [minX + gx * resolution, minY + gy * resolution, height];

      let radar: RadarConfig = catalogRadar;
      if (override) {
        const extent = Math.hypot(cols, rows) * resolution;
        const elMin = -90 + random() * 80;
        radar = {
          ...catalogRadar,
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
      const outcome = expectEquivalent(`random #${caseIndex} ${rows}x${cols} ${placement} ${radar.model_id}`,
        inputFor(grid, minX, minY, resolution, position, radar));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) for (const state of outcome.out.cell_states) stateTotals[state] = (stateTotals[state] ?? 0) + 1;
    }
    // The corpus must exercise every state, not just trivially agree on one.
    for (const state of Object.values(LOSCellState)) expect(stateTotals[state], `state ${state}`).toBeGreaterThan(0);
  });

  it("matches on adversarial shapes: 1×N, N×1, 2×2, 2×N, N×2 and non-square grids", () => {
    const shapes: Array<[number, number]> = [[1, 7], [9, 1], [2, 2], [2, 17], [19, 2], [3, 11], [13, 4]];
    for (const [rows, cols] of shapes) {
      const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ((r * 7 + c * 3) % 5) - 2));
      const positions: Array<[number, number, number]> = [
        [0, 0, 4], [(cols - 1) / 2, (rows - 1) / 2, 3], [cols - 1, 0, 1], [0.5, 0, 2], [-3, rows + 2, 5],
      ];
      for (const position of positions) {
        expectEquivalent(`shape ${rows}x${cols} @${position.join(",")}`, inputFor(grid, 10, -20, 1, [position[0] + 10, position[1] - 20, position[2]], openRadar));
      }
    }
    const tiny = [[0, 1], [2, 3]];
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.5, 0], [0, 0.5], [0.25, 0.75], [1, 0.5]] as const) {
      expectSomeVisible(expectEquivalent(`2x2 @${x},${y}`, inputFor(tiny, 0, 0, 1, [x, y, 6], openRadar)), `2x2 @${x},${y}`);
    }
  });

  it("matches with the radar on a node, a grid edge, a mesh diagonal and outside the grid", () => {
    const rows = 9;
    const cols = 13;
    const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => 4 * Math.sin(c / 2) + 3 * Math.cos(r / 3)));
    grid[4]![6] = 12;
    grid[2]![9] = Number.NaN;
    const origin: [number, number] = [92_008.875, 20_288.2734375];
    const res = 2;
    const placements: Array<[string, number, number]> = [
      ["node", 6, 4], ["node-corner", 0, 0], ["edge-x", 3, 2.5], ["edge-y", 7.5, 5], ["diagonal", 4.25, 3.75],
      ["diagonal-2", 2.6, 2.4], ["border", 0, 4.5], ["outside-left", -4, 3], ["outside-far", 30, -12],
    ];
    for (const [name, gx, gy] of placements) {
      for (const dz of [0.5, 8, 40]) {
        expectEquivalent(`${name} dz=${dz}`, inputFor(grid, origin[0], origin[1], res, [origin[0] + gx * res, origin[1] + gy * res, 6 + dz], openRadar));
      }
    }
    // Rays exactly on grid lines and diagonals over non-flat terrain.
    for (const [gx, gy] of [[0, 4], [6, 0], [0, 8], [12, 8], [4, 4]] as const) {
      expectEquivalent(`line-ray @${gx},${gy}`, inputFor(grid, origin[0], origin[1], res, [origin[0] + gx * res, origin[1] + gy * res, 20], openRadar));
    }
    // Grazing rays over a flat plane at the radar height: incidence is -(+0) → Math.max(0, -0) = +0.
    const plane = Array.from({ length: 6 }, () => new Array<number>(9).fill(0));
    const grazing = expectEquivalent("grazing signed zero", inputFor(plane, 0, 0, 1, [2, 3, 0], openRadar));
    expect(grazing.ok).toBe(true);
    if (grazing.ok) {
      const bits = new Uint32Array(grazing.out.quality.buffer, grazing.out.quality.byteOffset, grazing.out.quality.length);
      expect(bits.filter((value) => value === 0).length).toBeGreaterThan(40);
    }
  });

  it("matches with cells exactly on the range, azimuth and elevation limits", () => {
    const rows = 7;
    const cols = 10;
    const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r + c) % 3));
    const res = 3;
    const position: [number, number, number] = [res * 2, res * 3, 9];
    let boundaryCases = 0;
    for (const [tr, tc] of [[0, 9], [6, 0], [3, 7], [5, 5]] as const) {
      const dx = tc * res - position[0];
      const dy = tr * res - position[1];
      const distance = Math.hypot(dx, dy);
      const azimuth = Math.atan2(dx, dy) * (180 / Math.PI);
      const elevation = Math.atan2(grid[tr]![tc]! - position[2], distance) * (180 / Math.PI);
      const variants: Array<[string, Partial<RadarConfig>]> = [
        ["max-range", { max_range_m: distance }],
        ["min-range", { min_range_m: distance, max_range_m: distance * 2 }],
        ["exact-range", { min_range_m: distance, max_range_m: distance }],
        ["azimuth-point", { scan_pattern: "RAR", azimuth_range_deg: [azimuth, azimuth] }],
        ["azimuth-start", { scan_pattern: "RAR", azimuth_range_deg: [azimuth, azimuth + 30] }],
        ["azimuth-end-wrap", { scan_pattern: "RAR", azimuth_range_deg: [170, azimuth] }],
        ["elevation-min", { elevation_min_deg: elevation }],
        ["elevation-max", { elevation_max_deg: elevation }],
        ["elevation-point", { elevation_min_deg: elevation, elevation_max_deg: elevation }],
        ["sar-ignores-azimuth", { scan_pattern: "SAR360", azimuth_range_deg: [azimuth, azimuth] }],
        ["min-range-undefined", { min_range_m: undefined as unknown as number }],
      ];
      for (const [name, patch] of variants) {
        const outcome = expectEquivalent(`limit ${name} @${tr},${tc}`, inputFor(grid, 0, 0, res, position, { ...openRadar, ...patch }));
        expect(outcome.ok).toBe(true);
        if (outcome.ok && name !== "sar-ignores-azimuth" && name !== "min-range-undefined") {
          // The boundary cell itself passes the inclusive filter.
          expect([LOSCellState.VISIBLE, LOSCellState.SHADOW, LOSCellState.UNKNOWN_RAY])
            .toContain(outcome.out.cell_states[tr * cols + tc]);
          boundaryCases++;
        }
      }
    }
    expect(boundaryCases).toBe(36);
  });

  it("reproduces every validation and traversal error message", () => {
    const flat = [[0, 0], [0, 0]];
    const cases: Array<[string, LOSWorkerInput]> = [
      ["empty", inputFor([], 0, 0, 1, [0, 0, 1], openRadar)],
      ["ragged", inputFor([[0, 0], [0]], 0, 0, 1, [0, 0, 1], openRadar)],
      ["axis-limit", inputFor([Array(16_385).fill(0)], 0, 0, 1, [0, 0, 1], openRadar)],
      ["cell-limit", inputFor(Array.from({ length: 1_001 }, () => new Array<number>(1_000).fill(0)), 0, 0, 1, [0, 0, 1], openRadar)],
      ["resolution-zero", inputFor(flat, 0, 0, 0, [0, 0, 1], openRadar)],
      ["resolution-nan", inputFor(flat, 0, 0, Number.NaN, [0, 0, 1], openRadar)],
      ["resolution-negative", inputFor(flat, 0, 0, -1, [0, 0, 1], openRadar)],
      ["resolution-infinite", inputFor(flat, 0, 0, Infinity, [0, 0, 1], openRadar)],
      ["area-underflow", inputFor(flat, 0, 0, 1e-200, [0, 0, 1], openRadar)],
      ["area-overflow", inputFor(flat, 0, 0, 1e200, [0, 0, 1], openRadar)],
      ["total-area", inputFor(flat, 0, 0, 1e154, [0, 0, 1], openRadar)],
      ["bounds-nan", inputFor(flat, Number.NaN, 0, 1, [0, 0, 1], openRadar)],
      ["position-infinite", inputFor(flat, 0, 0, 1, [0, Infinity, 1], openRadar)],
      ["range-negative", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, min_range_m: -1 })],
      ["range-nan", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, min_range_m: Number.NaN })],
      ["range-unordered", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, min_range_m: 5, max_range_m: 4 })],
      ["range-infinite", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, max_range_m: Infinity })],
      ["elevation-low", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_min_deg: -91 })],
      ["elevation-high", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_max_deg: 91 })],
      ["elevation-unordered", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_min_deg: 5, elevation_max_deg: 4 })],
      ["elevation-nan", inputFor(flat, 0, 0, 1, [0, 0, 1], { ...openRadar, elevation_max_deg: Number.NaN })],
      ["precision-stall", inputFor([new Array<number>(16_384).fill(0), new Array<number>(16_384).fill(0)], 0, 0, 1,
        [2 ** 60, 0.5, 1e6], { ...openRadar, max_range_m: 1e300 })],
    ];
    for (const [label, input] of cases) {
      const outcome = expectEquivalent(label, input);
      expect(outcome.ok, label).toBe(false);
    }
    const stall = runWasm(cases[cases.length - 1]![1]);
    expect(stall.ok ? undefined : stall.code).toBe("LOS_RAY_PRECISION_STALL");
  });

  it("polls the deadline at the same check points and reproduces the timeout message", () => {
    const cols = 2_000;
    const longRay: number[][] = [new Array<number>(cols).fill(Number.NaN), new Array<number>(cols).fill(Number.NaN)];
    longRay[0]![cols - 1] = 0;
    const longInput = inputFor(longRay, 0, 0, 1, [0, 0, 10], { ...openRadar, max_range_m: 5_000 });
    const ridgeRows = 4;
    const ridgeCols = 1_400;
    const ridge = Array.from({ length: ridgeRows }, (_, r) => Array.from({ length: ridgeCols }, (_, c) => (c > 300 && c < 330 ? 200 : 2 * Math.sin(c / 50 + r))));
    const ridgeInput = inputFor(ridge, 0, 0, 1, [0, 1.5, 300], { ...openRadar, max_range_m: 5_000 });

    const countReads = (run: () => Outcome): { reads: number; outcome: Outcome } => {
      let reads = 0;
      vi.stubGlobal("performance", { now: () => { reads++; return 0; } });
      try {
        return { outcome: run(), reads };
      } finally {
        vi.unstubAllGlobals();
      }
    };
    /** TS-only reads of the shadow-zone BFS phase: one per row plus one per 1024 dequeued cells per zone. */
    const bfsReads = (states: Uint8Array, rows: number, width: number): number => {
      const seen = new Uint8Array(states.length);
      let reads = rows;
      for (let start = 0; start < states.length; start++) {
        if (states[start] !== LOSCellState.SHADOW || seen[start]) continue;
        const queue = [start];
        seen[start] = 1;
        for (let head = 0; head < queue.length; head++) {
          const index = queue[head]!;
          const row = Math.floor(index / width);
          const col = index % width;
          for (const [nr, nc] of [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]] as const) {
            if (nr < 0 || nr >= rows || nc < 0 || nc >= width) continue;
            const next = nr * width + nc;
            if (!seen[next] && states[next] === LOSCellState.SHADOW) { seen[next] = 1; queue.push(next); }
          }
        }
        reads += Math.floor(queue.length / 1_024);
      }
      return reads;
    };

    for (const [label, input, rows, width] of [["long-ray", longInput, 2, cols], ["ridge", ridgeInput, ridgeRows, ridgeCols]] as const) {
      const ts = countReads(() => runTs(input));
      const rs = countReads(() => runWasm(input));
      expect(ts.outcome.ok && rs.outcome.ok, label).toBe(true);
      if (!ts.outcome.ok || !rs.outcome.ok) continue;
      expect(firstStateDifference(ts.outcome.out.cell_states, rs.outcome.out.cell_states, width), label).toBeNull();
      // Identical clock reads in the per-cell phase: start + one per row + one per 1024 ray intervals.
      expect(rs.reads, label).toBeGreaterThan(1 + rows);
      const tsOnlyReads = bfsReads(ts.outcome.out.cell_states, rows, width);
      if (label === "ridge") expect(tsOnlyReads, "ridge exercises BFS checks").toBeGreaterThan(rows);
      expect(ts.reads - tsOnlyReads, label).toBe(rs.reads);

      // Abort at each per-cell check point: both engines fail with the same user-visible message.
      const last = rs.reads - 1;
      const samples = [...new Set([1, 2, 3, 4, 5, 6, Math.floor(last / 2), last - 1, last])].filter((k) => k >= 1 && k <= last);
      for (const allowed of samples) {
        const clock = (): (() => number) => { let reads = 0; return () => (++reads <= allowed ? 0 : 1e12); };
        vi.stubGlobal("performance", { now: clock() });
        const tsAbort = runTs(input);
        vi.stubGlobal("performance", { now: clock() });
        const rsAbort = runWasm(input);
        vi.unstubAllGlobals();
        expect(tsAbort.ok || rsAbort.ok, `${label} abort after ${allowed}`).toBe(false);
        if (tsAbort.ok || rsAbort.ok) continue;
        expect(rsAbort.message).toBe(tsAbort.message);
        expect(rsAbort.code).toBe("LOS_DEADLINE_EXCEEDED");
        expect(tsAbort.message).toMatch(/excedió el tiempo máximo de ejecución \(120 segundos\)/);
      }
    }
  }, 30_000);

  it("ports Math.atan2, Math.hypot, Math.round, Math.min and Math.max bit-for-bit (adversarial probe)", () => {
    const random = mulberry32(0xa7a2_2026);
    const special = [0, -0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.4375, 0.6875, 1.1875, 2.4375,
      2 ** -27, 2 ** -1022, 5e-324, 2 ** 52, 2 ** 53, 2 ** 60, 2 ** 66, 1e300, Number.MAX_VALUE,
      Infinity, -Infinity, Number.NaN, 0.49999999999999994, -0.49999999999999994, 4503599627370497];
    const a: number[] = [];
    const b: number[] = [];
    const push = (x: number, y: number) => { a.push(x); b.push(y); };
    for (const x of special) for (const y of special) push(x, y);
    const nudge = (v: number, ulps: number) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, v);
      view.setBigInt64(0, view.getBigInt64(0) + BigInt(ulps));
      return view.getFloat64(0);
    };
    for (const threshold of [0.4375, 0.6875, 1.1875, 2.4375, 2 ** -27, 2 ** 66]) {
      for (let u = -3; u <= 3; u++) for (const s of [1, -1]) push(s * nudge(threshold, u), 1);
    }
    for (let i = 0; i < 120_000; i++) {
      const scaleA = 10 ** (random() * 40 - 20);
      const scaleB = 10 ** (random() * 40 - 20);
      const x = (random() * 2 - 1) * scaleA;
      const y = (random() * 2 - 1) * (random() < 0.2 ? scaleA : scaleB);
      push(x, y);
      // Realistic LOS operands: grid offsets in metres and terrain-gradient components.
      push(Math.round(random() * 4000 - 2000) * 0.5, Math.round(random() * 4000 - 2000) * 0.5);
      push((random() * 2 - 1) * 3, (random() * 2 - 1) * 3);
      push(random() * 3000 - 1500 + random(), random() * 3000 - 1500);
    }
    // k = ±60 exponent-difference thresholds of fdlibm atan2.
    for (let e = 55; e <= 66; e++) for (const s of [1, -1]) { push(2 ** e * 1.25, s); push(s, -(2 ** e) * 1.25); push(1, -(2 ** -e)); }
    const xs = Float64Array.from(a);
    const ys = Float64Array.from(b);
    const reference: Array<(x: number, y: number) => number> = [
      (x, y) => Math.atan2(x, y),
      (x, y) => Math.hypot(x, y),
      (x, y) => Math.hypot(x, y, 1),
      (x) => Math.round(x),
      (x, y) => Math.min(x, y),
      (x, y) => Math.max(x, y),
    ];
    const names = ["atan2", "hypot2", "hypot3", "round", "min", "max"];
    for (let op = 0; op < reference.length; op++) {
      const probe = wasm.los_math_probe(op, xs, ys);
      const fn = reference[op]!;
      const expected = new Float64Array(xs.length);
      for (let i = 0; i < xs.length; i++) expected[i] = fn(xs[i]!, ys[i]!);
      const eb = new BigUint64Array(expected.buffer);
      const pb = new BigUint64Array(probe.buffer, probe.byteOffset, probe.length);
      let firstDifference: string | null = null;
      for (let i = 0; i < xs.length && firstDifference === null; i++) {
        if (Number.isNaN(expected[i]) && Number.isNaN(probe[i])) continue;
        if (eb[i] !== pb[i]) {
          firstDifference = `${names[op]}(${xs[i]}, ${ys[i]}) at ${i}: js=${expected[i]} (0x${eb[i]!.toString(16)}) ` +
            `wasm=${probe[i]} (0x${pb[i]!.toString(16)})`;
        }
      }
      expect(firstDifference, names[op]).toBeNull();
    }
    expect(xs.length).toBeGreaterThan(480_000);
  });
});
