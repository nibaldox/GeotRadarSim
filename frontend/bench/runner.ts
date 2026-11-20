import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, endianness } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { generateSyntheticTerrain } from '../src/services/terrainEngine';
import { listRadars } from '../src/services/api';
import { gridNodeCountForSpan, suggestResolutionForSpan } from '../src/utils/terrainLimits';
import type { DTMMetadata, LOSResponse, RadarConfig, SensitivityObservation } from '../src/types/api';
import type { TerrainWorkerInput, TerrainWorkerMessage, TerrainWorkerOutput, TerrainBoundsWorkerOutput } from '../src/workers/terrainWorker';
import type { LOSWorkerInput, LOSWorkerOutput } from '../src/workers/losWorker';
import type { SensitivityWorkerInput, SensitivityWorkerOutput } from '../src/workers/vectorWorker';
import { flattenGrid, hashBytes } from './harness';

type Scope = { onmessage: ((event: MessageEvent) => unknown) | null; postMessage: (value: unknown) => void };
type Terrain = { grid: number[][]; metadata: DTMMetadata; warnings?: string[] };
const out = process.env.GEOT_BENCH_OUT ?? '/home/xodla/.hermes/profiles/simulacion-radar/plans/rust-wasm/evidence/w1a/';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function handlers() {
  const scope: Scope = { onmessage: null, postMessage: () => {} };
  Object.assign(globalThis, { self: scope });
  await import('../src/workers/terrainWorker');
  const terrain = scope.onmessage;
  await import('../src/workers/losWorker');
  const los = scope.onmessage;
  const { sampleTerrainAtCoordinates } = await import('../src/workers/losWorker');
  await import('../src/workers/vectorWorker');
  const vector = scope.onmessage;
  if (!terrain || !los || !vector) throw new Error('Worker handler missing');
  async function call<T>(fn: NonNullable<Scope['onmessage']>, data: unknown): Promise<T> {
    let result: unknown;
    scope.postMessage = value => { result = value; };
    await fn({ data } as MessageEvent);
    if (!result) throw new Error('Worker did not return a message');
    if (typeof result === 'object' && 'error' in result) throw new Error(String((result as {error: unknown}).error));
    return result as T;
  }
  return {
    terrain: (input: TerrainWorkerInput) => call<TerrainWorkerMessage>(terrain, input),
    los: (input: LOSWorkerInput) => call<LOSWorkerOutput>(los, input),
    vector: (input: SensitivityWorkerInput) => call<SensitivityWorkerOutput>(vector, input),
    sampleTerrainAtCoordinates,
  };
}

// Binary search over representable doubles: the application node-count rule includes a tolerance.
export function finestResolution(x: number, y: number, upper: number): number {
  const fits = (r: number) => {
    try { const rows = gridNodeCountForSpan(y, r), cols = gridNodeCountForSpan(x, r); return rows * cols <= 1_000_000; }
    catch { return false; }
  };
  if (!fits(upper)) throw new Error('Suggested resolution does not fit');
  let lo = 0, hi = upper;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (mid === lo || mid === hi) break; if (fits(mid)) hi = mid; else lo = mid; }
  return hi;
}

export async function run() {
  const mode = process.env.GEOT_BENCH_MODE;
  if (mode !== 'smoke' && mode !== 'golden' && mode !== 'full') throw new Error('GEOT_BENCH_MODE must be smoke, golden or full');
  const h = await handlers();
  const started = performance.now();
  const cases: Record<string, unknown> = {};
  const samples: Record<string, number[]> = {};
  const stlPath = process.env.GEOT_BENCH_STL;
  const stl = stlPath ? readFileSync(stlPath) : undefined;
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const env = { node: process.version, v8: process.versions.v8, cpu: cpus()[0]?.model, endian: endianness(), code_sha: gitSha,
    stl_sha256: stl ? sha(stl) : null, package_lock_sha256: sha(readFileSync('package-lock.json')) };
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/env.json`, `${JSON.stringify(env, null, 2)}\n`);
  async function measure<T>(name: string, fn: () => Promise<T>, validate: (result: T) => unknown): Promise<T> {
    // Full has two warmups and seven measured samples. Hashing and validation are untimed.
    const warmups = mode === 'full' ? 2 : 0, count = mode === 'full' ? 7 : 1;
    let result!: T;
    for (let i = 0; i < warmups + count; i++) {
      if (mode === 'full' && performance.now() - started > 570_000) throw new Error('Full benchmark stopped before 10 minute budget');
      const start = performance.now(); result = await fn(); const elapsed = performance.now() - start;
      const digest = validate(result);
      if (i >= warmups) (samples[name] ??= []).push(elapsed);
      if (cases[name] && JSON.stringify(cases[name]) !== JSON.stringify(digest)) throw new Error(`Nondeterministic output: ${name}`);
      cases[name] = digest;
    }
    console.log(`${name}: ok`);
    return result;
  }
  function terrainDigest(t: Terrain) {
    const { terrain_id: _id, ...metadata } = t.metadata;
    if (t.grid.length !== metadata.grid_rows || t.grid[0]?.length !== metadata.grid_cols) throw new Error('Terrain dimensions mismatch');
    return { metadata, warnings: t.warnings, dtm_float64: hashBytes(flattenGrid(t.grid)) };
  }
  const models: RadarConfig[] = await listRadars();
  async function analyze(prefix: string, terrain: Terrain, allModels: boolean) {
    const m = terrain.metadata, b = m.bounds;
    const outputs: { result: LOSResponse; position: { x: number; y: number; z: number } }[] = [];
    const positions = prefix === 'synthetic' ? [0.5] : [0.25, 0.5, 0.75];
    const jobs = positions.map(p => ({ p, model: models[0]! }));
    if (allModels) jobs.push(...models.slice(1).map(model => ({ p: 0.5, model })));
    for (const job of jobs) {
      const x = b.min_x + (b.max_x - b.min_x) * job.p, y = b.min_y + (b.max_y - b.min_y) * job.p;
      const z0 = h.sampleTerrainAtCoordinates(terrain.grid, b, m.resolution, x, y);
      if (z0 === null || !Number.isFinite(z0)) throw new Error(`Radar position ${job.p} has no renderable terrain`);
      const position = { x, y, z: z0 + 2 };
      const result = await measure(`${prefix}/los-${job.p}-${job.model.model_id}`, () => h.los({ grid: terrain.grid, bounds: b,
        resolution: m.resolution, radar_position: [x, y, position.z], radar_config: job.model }), r => {
          if (r.grid_rows !== m.grid_rows || r.grid_cols !== m.grid_cols || !r.flat_quality_grid || !r.flat_projection_grid || r.cell_states.length !== m.grid_rows * m.grid_cols) throw new Error('Invalid LOS result');
          return { grid_rows: r.grid_rows, grid_cols: r.grid_cols, resolution: r.resolution, position, radar: job.model,
            coverage_pct: r.coverage_pct, completeness_pct: r.completeness_pct, visible_area_m2: r.visible_area_m2,
            cell_states: hashBytes(r.cell_states), flat_quality_grid: hashBytes(r.flat_quality_grid), flat_projection_grid: hashBytes(r.flat_projection_grid) };
        });
      if (outputs.length < 3) outputs.push({ result, position });
    }
    const key = { terrain_id: 'baseline', epoch: 1 };
    const observations: SensitivityObservation[] = outputs.map(({ result, position }, i) => {
      const id = `analysis-${i}`;
      return { analysisId: id, grid_rows: result.grid_rows, grid_cols: result.grid_cols, resolution: result.resolution, cell_states: result.cell_states,
        snapshot: { terrainKey: key, analysisId: id, sourceAnalysisIds: [id], generation: 1, radars: [{ radarId: `radar-${i}`, radarModelId: models[0]!.model_id, position,
          overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }] } };
    });
    await measure(`${prefix}/sensitivity`, () => h.vector({ type: 'SENSITIVITY', terrainKey: key, grid: terrain.grid, grid_rows: m.grid_rows,
      grid_cols: m.grid_cols, resolution: m.resolution, bounds: b, observations }), r => {
        if (r.grid_rows !== m.grid_rows || r.grid_cols !== m.grid_cols || r.observer_count.length !== m.grid_rows * m.grid_cols) throw new Error('Invalid sensitivity');
        return { grid_rows: r.grid_rows, grid_cols: r.grid_cols, resolution: r.resolution,
          flat_sensitivity_grid: hashBytes(r.flat_sensitivity_grid), observer_count: hashBytes(r.observer_count) };
      });
  }
  const synthetic = await measure('synthetic/terrain', async () => generateSyntheticTerrain(899, 599, 150, 1), terrainDigest);
  await analyze('synthetic', synthetic, false);
  if (mode !== 'smoke') {
    if (!stl) console.log('STL scenarios skipped: GEOT_BENCH_STL is not set');
    else {
      const data = Uint8Array.from(stl).buffer;
      const baseInput = { fileData: data, filename: stlPath!, resolution: 1 };
      const bounds = await h.terrain({ ...baseInput, mode: 'bounds' }) as TerrainBoundsWorkerOutput;
      const suggested = suggestResolutionForSpan(bounds.span.x, bounds.span.y);
      const fine = finestResolution(bounds.span.x, bounds.span.y, suggested);
      console.log(`STL suggested resolution: ${suggested}; finest: ${fine}`);
      for (const [label, resolution] of [['default', suggested], ['finest', fine]] as const) {
        const t = await measure(`stl-${label}/terrain`, async () => {
          const result = await h.terrain({ ...baseInput, resolution }) as TerrainWorkerOutput;
          if (!result.grid || !result.metadata) throw new Error('Terrain result incomplete');
          return { grid: result.grid, metadata: result.metadata, warnings: result.warnings };
        }, terrainDigest);
        if (label === 'default') await analyze('stl-default', t, true);
      }
    }
  }
  const manifest = { schema: 'geot-ts-baseline-v1', code_sha: gitSha, endian: endianness(), cases };
  writeFileSync(`${out}/golden-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  if (mode === 'full') writeFileSync(`${out}/samples-${new Date().toISOString().replace(/:/g, '-')}.json`, `${JSON.stringify({ env, samples }, null, 2)}\n`);
}
