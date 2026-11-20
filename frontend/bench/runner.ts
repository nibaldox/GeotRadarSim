import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, endianness, loadavg } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { generateSyntheticTerrain } from '../src/services/terrainEngine';
import { listRadars } from '../src/services/api';
import { gridNodeCountForSpan, suggestResolutionForSpan } from '../src/utils/terrainLimits';
import type { DTMMetadata, LOSResponse, RadarConfig, SensitivityObservation } from '../src/types/api';
import type { TerrainWorkerInput, TerrainWorkerMessage, TerrainWorkerOutput, TerrainBoundsWorkerOutput } from '../src/workers/terrainWorker';
import type { LOSWorkerInput, LOSWorkerOutput } from '../src/workers/losWorker';
import type { SensitivityWorkerInput, SensitivityWorkerOutput } from '../src/workers/vectorWorker';
import { flattenGrid, hashBytes, outputPath, summarize, firstCellDifference } from './harness';
import { loadRadarWasm, flattenGridForWasm } from '../src/wasm/loader';

type Scope = { onmessage: ((event: MessageEvent) => unknown) | null; postMessage: (value: unknown) => void };
type Terrain = { grid: number[][]; metadata: DTMMetadata; warnings?: string[] };
type Engine = 'ts' | 'wasm';
type Pair<T> = Record<Engine, T>;
const baselinePath = '/home/xodla/.hermes/profiles/simulacion-radar/plans/rust-wasm/evidence/w1a-frozen/golden-manifest.json';
const baselineHash = '60223fba7dc1c162ba5f594d7174b09f9474da490331151bee9ef289f0f316b3';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const command = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
async function handlers() {
  const scope: Scope = { onmessage: null, postMessage: () => {} };
  Object.assign(globalThis, { self: scope });
  await import('../src/workers/terrainWorker'); const terrain = scope.onmessage;
  const losModule = await import('../src/workers/losWorker'); const los = scope.onmessage;
  await import('../src/workers/vectorWorker'); const vector = scope.onmessage;
  if (!terrain || !los || !vector) throw new Error('Worker handler missing');
  async function call<T>(fn: NonNullable<Scope['onmessage']>, data: unknown): Promise<T> {
    let result: unknown; scope.postMessage = value => { result = value; };
    await fn({ data } as MessageEvent);
    if (!result) throw new Error('Worker did not return a message');
    if (typeof result === 'object' && 'error' in result) throw new Error(String((result as {error: unknown}).error));
    return result as T;
  }
  return { terrain: (x: TerrainWorkerInput) => call<TerrainWorkerMessage>(terrain, x), los: (x: LOSWorkerInput) => call<LOSWorkerOutput>(los, x), vector: (x: SensitivityWorkerInput) => call<SensitivityWorkerOutput>(vector, x), sample: losModule.sampleTerrainAtCoordinates };
}
export function finestResolution(x: number, y: number, upper: number): number {
  const fits = (r: number) => { try { return gridNodeCountForSpan(y, r) * gridNodeCountForSpan(x, r) <= 1_000_000; } catch { return false; } };
  if (!fits(upper)) throw new Error('Suggested resolution does not fit');
  let lo = 0, hi = upper;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (mid === lo || mid === hi) break; if (fits(mid)) hi = mid; else lo = mid; }
  return hi;
}
export async function run() {
  const mode = process.env.GEOT_BENCH_MODE;
  if (mode !== 'smoke' && mode !== 'golden' && mode !== 'full') throw new Error('GEOT_BENCH_MODE must be smoke, golden or full');
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const out = outputPath(process.env.GEOT_BENCH_OUT, process.env.TMPDIR ?? '/tmp', stamp);
  const baselineBytes = readFileSync(baselinePath);
  if (sha(baselineBytes) !== baselineHash) throw new Error('Frozen baseline hash mismatch');
  const baseline = JSON.parse(new TextDecoder().decode(baselineBytes)) as { cases: Record<string, unknown> };
  const h = await handlers();
  const startInit = performance.now(); await loadRadarWasm(); const coldInit = performance.now() - startInit;
  const stlPath = process.env.GEOT_BENCH_STL;
  if (mode !== 'smoke' && !stlPath) throw new Error('GEOT_BENCH_STL required');
  const stl = stlPath ? readFileSync(stlPath) : undefined;
  const env = { node: process.version, v8: process.versions.v8, cpu: cpus()[0]?.model, endian: endianness(), code_sha: command('git', ['rev-parse', 'HEAD']),
    code_diff: command('git', ['-c', 'core.filemode=false', 'status', '--short']), rustc: command('rustc', ['--version']),
    stl_sha256: stl ? sha(stl) : null, wasm_sha256: sha(readFileSync('src/wasm/pkg/radar_wasm_bg.wasm')), baseline_sha256: baselineHash,
    load_before: loadavg(), load_after: [] as number[] };
  mkdirSync(out, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(`${out}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
  const cases: Record<string, unknown> = {}, samples: Record<string, Pair<number[]>> = {}, contexts: Record<string, number> = {}, flatten: Record<string, number> = {};
  const started = performance.now();
  function check(name: string, ts: unknown, wasm: unknown) {
    const anchor = baseline.cases[name];
    if (anchor === undefined) throw new Error(`Missing W1-A case: ${name}`);
    if (JSON.stringify(ts) !== JSON.stringify(wasm)) throw new Error(`${name}: TS/WASM fingerprint mismatch`);
    if (JSON.stringify(ts) !== JSON.stringify(anchor)) throw new Error(`${name}: TS/W1-A fingerprint mismatch; baseline provides hashes, not per-cell bytes`);
    cases[name] = { ts_equals_wasm: true, ts_equals_w1a: true, wasm_equals_w1a: true, fingerprint: ts };
    console.log(`${name}: equivalent`);
  }
  function compareArrays(name: string, a: Record<string, Uint8Array | Uint16Array | Float32Array>, b: typeof a) {
    for (const key of Object.keys(a)) {
      const left = a[key]!, right = b[key]!; const i = firstCellDifference(left, right);
      if (i !== -1) throw new Error(`${name}: ${key} first differing cell ${i}: ts=${left[i]} wasm=${right[i]}`);
    }
  }
  async function measure<T>(name: string, invoke: (engine: Engine) => Promise<T>, digest: (x: T) => unknown, compare: (a: T, b: T) => void): Promise<Pair<T>> {
    const ts = await invoke('ts'), wasm = await invoke('wasm'); compare(ts, wasm); check(name, digest(ts), digest(wasm));
    if (mode === 'full') {
      const values: Pair<number[]> = { ts: [], wasm: [] };
      for (let i = 0; i < 9; i++) for (const engine of ['ts', 'wasm'] as const) {
        if (performance.now() - started > 1_490_000) throw new Error('Full exceeded time budget');
        const begin = performance.now(); const result = await invoke(engine); const elapsed = performance.now() - begin;
        if (JSON.stringify(digest(result)) !== JSON.stringify(digest(engine === 'ts' ? ts : wasm))) throw new Error(`${name}: nondeterministic ${engine}`);
        if (i >= 2) values[engine].push(elapsed);
      }
      samples[name] = values;
    }
    return { ts, wasm };
  }
  function terrainDigest(t: Terrain) {
    const { terrain_id: _id, ...metadata } = t.metadata;
    if (t.grid.length !== metadata.grid_rows || t.grid[0]?.length !== metadata.grid_cols) throw new Error('Terrain dimensions mismatch');
    return { metadata, warnings: t.warnings, dtm_float64: hashBytes(flattenGrid(t.grid)) };
  }
  const models: RadarConfig[] = await listRadars();
  async function analyze(prefix: string, terrain: Terrain, allModels: boolean) {
    const m = terrain.metadata, b = m.bounds;
    const f = performance.now(); flattenGridForWasm(terrain.grid); flatten[prefix] = performance.now() - f;
    const outputs: Pair<{ result: LOSResponse; position: { x: number; y: number; z: number } }[]> = { ts: [], wasm: [] };
    const positions = prefix === 'synthetic' ? [0.5] : [0.25, 0.5, 0.75];
    const jobs = positions.map(p => ({ p, model: models[0]! }));
    if (allModels) jobs.push(...models.slice(1).map(model => ({ p: 0.5, model })));
    for (const job of jobs) {
      const x = b.min_x + (b.max_x - b.min_x) * job.p, y = b.min_y + (b.max_y - b.min_y) * job.p;
      const z0 = h.sample(terrain.grid, b, m.resolution, x, y);
      if (z0 === null || !Number.isFinite(z0)) throw new Error(`Radar position ${job.p} has no renderable terrain`);
      const position = { x, y, z: z0 + 2 }, name = `${prefix}/los-${job.p}-${job.model.model_id}`;
      const result = await measure(name, engine => h.los({ grid: terrain.grid, bounds: b, resolution: m.resolution, radar_position: [x, y, position.z], radar_config: job.model, engine }), r => {
        if (r.grid_rows !== m.grid_rows || r.grid_cols !== m.grid_cols || !r.flat_quality_grid || !r.flat_projection_grid || r.cell_states.length !== m.grid_rows * m.grid_cols) throw new Error('Invalid LOS result');
        return { grid_rows: r.grid_rows, grid_cols: r.grid_cols, resolution: r.resolution, position, radar: job.model, coverage_pct: r.coverage_pct, completeness_pct: r.completeness_pct, visible_area_m2: r.visible_area_m2, cell_states: hashBytes(r.cell_states), flat_quality_grid: hashBytes(r.flat_quality_grid), flat_projection_grid: hashBytes(r.flat_projection_grid) };
      }, (a, c) => compareArrays(name, { cell_states: a.cell_states, quality: a.flat_quality_grid!, projection: a.flat_projection_grid! }, { cell_states: c.cell_states, quality: c.flat_quality_grid!, projection: c.flat_projection_grid! }));
      for (const engine of ['ts', 'wasm'] as const) { if (result[engine].engine_used !== engine) throw new Error(`${name}: incorrect engine`); if (outputs[engine].length < 3) outputs[engine].push({ result: result[engine], position }); }
    }
    const key = { terrain_id: 'baseline', epoch: 1 };
    const makeObservations = (engine: Engine): SensitivityObservation[] => outputs[engine].map(({ result, position }, i) => {
      const id = `analysis-${i}`;
      return { analysisId: id, grid_rows: result.grid_rows, grid_cols: result.grid_cols, resolution: result.resolution, cell_states: result.cell_states, snapshot: { terrainKey: key, analysisId: id, sourceAnalysisIds: [id], generation: 1, radars: [{ radarId: `radar-${i}`, radarModelId: models[0]!.model_id, position, overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }] } };
    });
    const observations = { ts: makeObservations('ts'), wasm: makeObservations('wasm') };
    const invoke = (engine: Engine, source: Engine) => h.vector({ type: 'SENSITIVITY', terrainKey: key, grid: terrain.grid, grid_rows: m.grid_rows, grid_cols: m.grid_cols, resolution: m.resolution, bounds: b, observations: observations[source], engine });
    const digest = (r: SensitivityWorkerOutput) => {
      if (r.grid_rows !== m.grid_rows || r.grid_cols !== m.grid_cols || r.observer_count.length !== m.grid_rows * m.grid_cols) throw new Error('Invalid sensitivity');
      return { grid_rows: r.grid_rows, grid_cols: r.grid_cols, resolution: r.resolution, flat_sensitivity_grid: hashBytes(r.flat_sensitivity_grid), observer_count: hashBytes(r.observer_count) };
    };
    const compare = (a: SensitivityWorkerOutput, c: SensitivityWorkerOutput) => compareArrays(`${prefix}/sensitivity`, { sensitivity: a.flat_sensitivity_grid, count: a.observer_count }, { sensitivity: c.flat_sensitivity_grid, count: c.observer_count });
    const result = await measure(`${prefix}/sensitivity`, engine => invoke(engine, engine), digest, compare);
    for (const engine of ['ts', 'wasm'] as const) {
      if (result[engine].engine_used !== engine) throw new Error('Incorrect sensitivity engine');
      const cross = await invoke(engine, engine === 'ts' ? 'wasm' : 'ts'); compare(result[engine], cross);
      if (JSON.stringify(digest(cross)) !== JSON.stringify(digest(result[engine]))) throw new Error('Cross sensitivity mismatch');
    }
    (cases[`${prefix}/sensitivity`] as Record<string, unknown>).cross_observations_equal = true;
  }
  let t0 = performance.now(); const synthetic = generateSyntheticTerrain(899, 599, 150, 1); contexts['synthetic/terrain'] = performance.now() - t0;
  const sd = terrainDigest(synthetic); check('synthetic/terrain', sd, sd); await analyze('synthetic', synthetic, false);
  if (stl && stlPath) {
    const data = Uint8Array.from(stl).buffer, baseInput = { fileData: data, filename: stlPath, resolution: 1 };
    t0 = performance.now(); const bounds = await h.terrain({ ...baseInput, mode: 'bounds' }) as TerrainBoundsWorkerOutput; contexts['stl/bounds'] = performance.now() - t0;
    const suggested = suggestResolutionForSpan(bounds.span.x, bounds.span.y), fine = finestResolution(bounds.span.x, bounds.span.y, suggested);
    for (const [label, resolution] of [['default', suggested], ['finest', fine]] as const) {
      t0 = performance.now(); const result = await h.terrain({ ...baseInput, resolution }) as TerrainWorkerOutput; contexts[`stl-${label}/terrain`] = performance.now() - t0;
      if (!result.grid || !result.metadata) throw new Error('Terrain result incomplete');
      const terrain = { grid: result.grid, metadata: result.metadata, warnings: result.warnings }, d = terrainDigest(terrain);
      check(`stl-${label}/terrain`, d, d); if (label === 'default') await analyze('stl-default', terrain, true);
    }
  }
  if (mode !== 'smoke' && Object.keys(cases).length !== Object.keys(baseline.cases).length) throw new Error('Not all baseline cases covered');
  env.load_after = loadavg(); save('env.json', env);
  save('equivalence.json', { baseline: baselinePath, baseline_sha256: baselineHash, mode, cases });
  if (mode === 'full') {
    const summary = Object.fromEntries(Object.entries(samples).map(([name, s]) => [name, summarize(s.ts, s.wasm)]));
    save(`samples-${stamp}.json`, { code_sha: env.code_sha, samples, cold_init_ms: coldInit, flatten_ms: flatten, context_ms: contexts });
    save(`summary-${stamp}.json`, { code_sha: env.code_sha, measurement_load: env.load_before[0]! > 1.5 ? 'medición con carga' : 'sin carga > 1.5', cold_init_ms: coldInit, flatten_ms: flatten, context_ms: contexts, cases: summary });
  }
}
