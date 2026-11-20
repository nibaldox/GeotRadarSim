import { beforeAll, describe, expect, it } from 'vitest';
import { generateSyntheticTerrain } from '../services/terrainEngine';
import { loadRadarWasm } from './loader';

let message: { error?: string; flat_sensitivity_grid: Float32Array; observer_count: Uint16Array };
let handler: (event: MessageEvent) => void;
beforeAll(async () => {
  const worker = { onmessage: null, postMessage: (value: typeof message) => { message = value; } };
  Object.defineProperty(globalThis, 'self', { value: worker, configurable: true, writable: true });
  await import('../workers/vectorWorker');
  handler = worker.onmessage as unknown as (event: MessageEvent) => void;
});
let seed = 0x93612a4b;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; }
async function compare(grid: number[][], n: number) {
  const rows = grid.length, cols = grid[0]!.length, size = rows * cols;
  const resolution = 1.25, minX = -7, minY = 13;
  const terrainKey = { terrain_id: 'differential', epoch: 1 };
  const positions: number[] = [], masks: number[] = [];
  const observations = Array.from({ length: n }, (_, j) => {
    const position = { x: random() * 20 - 10, y: random() * 20, z: random() * 40 - 20 };
    positions.push(position.x, position.y, position.z);
    const states = Array.from({ length: size }, (_, i) => (i + j) % 6);
    masks.push(...states);
    const analysisId = `a${j}`;
    return { analysisId, grid_rows: rows, grid_cols: cols, resolution, cell_states: new Uint8Array(states),
      snapshot: { terrainKey, analysisId, sourceAnalysisIds: [analysisId], generation: 1,
        radars: [{ radarId: `r${j}`, radarModelId: 'm', position, overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }] } };
  });
  handler({ data: { type: 'SENSITIVITY', terrainKey, grid, grid_rows: rows, grid_cols: cols, resolution,
    bounds: { min_x: minX, min_y: minY, max_x: 0, max_y: 0 }, observations } } as MessageEvent);
  expect(message.error).toBeUndefined();
  const wasm = await loadRadarWasm();
  const actual = wasm.sensitivity(new Float64Array(grid.flat()), rows, cols, minX, minY, resolution, new Float64Array(positions), new Uint8Array(masks)) as { flat_sensitivity_grid: Float32Array; observer_count: Uint16Array };
  const expectedBits = new Uint32Array(message.flat_sensitivity_grid.buffer);
  const actualBits = new Uint32Array(actual.flat_sensitivity_grid.buffer);
  for (let i = 0; i < size; i++) {
    if (actual.observer_count[i] !== message.observer_count[i]) {
      throw new Error(`cell ${i}: count wasm=${actual.observer_count[i]} bits=0x${actual.observer_count[i]!.toString(16)}, ts=${message.observer_count[i]} bits=0x${message.observer_count[i]!.toString(16)}`);
    }
    const a = actual.flat_sensitivity_grid[i]!, b = message.flat_sensitivity_grid[i]!;
    if (actualBits[i] !== expectedBits[i] && !(Number.isNaN(a) && Number.isNaN(b))) {
      throw new Error(`cell ${i}: wasm=${a} bits=0x${actualBits[i]!.toString(16)}, ts=${b} bits=0x${expectedBits[i]!.toString(16)}`);
    }
  }
}
describe('sensitivity TS/WASM bit exact', () => {
  it('matches 30 fixed-seed rectangular grids including 2x2 and 2xN', async () => {
    for (let k = 0; k < 30; k++) {
      const rows = k < 5 ? 2 : 2 + Math.floor(random() * 7);
      const cols = k === 0 ? 2 : 3 + Math.floor(random() * 8);
      const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => random() < 0.1 ? NaN : random() * 40 - 20));
      await compare(grid, 1 + k % 5);
    }
  });
  it('matches terrainEngine', async () => { await compare(generateSyntheticTerrain(12, 8, 5, 1).grid, 5); });
  it.each([
    [0, 2, [0, 0, 1], [5, 5, 5, 5], 'INVALID_DIMENSIONS'],
    [16385, 2, [0, 0, 1], [5, 5, 5, 5], 'LIMIT_EXCEEDED'],
    [2, 2, [], [], 'INVALID_OBSERVATIONS'],
    [2, 2, [0], [5, 5, 5, 5], 'LENGTH_MISMATCH'],
    [2, 2, [0, Infinity, 1], [5, 5, 5, 5], 'INVALID_POSITION'],
    [2, 2, [0, 0, 1], [5, 5, 5, 6], 'INVALID_STATE'],
  ] as const)('exposes stable error %s %s %s %s %s', async (rows, cols, positions, states, code) => {
    const wasm = await loadRadarWasm();
    try {
      wasm.sensitivity(new Float64Array(4), rows, cols, 0, 0, 1, new Float64Array(positions), new Uint8Array(states));
      throw new Error('expected error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code: string }).code).toBe(code);
      expect((error as Error).message).toBe(code);
    }
  });
  it('rejects invalid geometry at the WASM boundary', async () => {
    const wasm = await loadRadarWasm();
    expect(() => wasm.sensitivity(new Float64Array(4), 2, 2, 0, 0, 0, new Float64Array([0, 0, 1]), new Uint8Array(4))).toThrowError('INVALID_GEOMETRY');
  });
});
