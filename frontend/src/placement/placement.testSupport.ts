/**
 * Test helpers for the «Sugerir ubicación» runtime (formerly the WP4 tools' helpers): a deterministic fake of the Worker-backed
 * API (terrain, LOS, sensitivity, exports) used through `vi.mock` of
 * `services/api` in each test file, plus store resets and timer driving.
 * Not imported by production code.
 */

import { vi } from "vitest";
import * as api from "../services/api";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { LOSCellState } from "../types/api";
import type {
  DTMMetadata,
  JobResponse,
  LOSRequest,
  LOSResponse,
  RadarConfig,
  SensitivityMapRequest,
  SensitivityMapResponse,
  SyntheticTerrainRequest,
  TerrainGridResponse,
} from "../types/api";
import type { ToolContext } from "./toolEnvelope";
import { currentTerrainKey, historyFor } from "./appState";
import { candidateSignature } from "./candidateSignature";
import { PlacementRefMap } from "./refs";
import { TOOL_SPECS } from "./schemas";
import { createSuggestRadarPositions, type SuggestToolImpl } from "./suggestPositions";

export const API_MOCK_KEYS = [
  "listRadars", "runLOSAnalysis", "getLOSJob", "cancelLOSAnalysis", "releaseLOSJob",
  "runSensitivityAnalysis", "cancelSensitivityAnalysis", "releaseSensitivityJob",
  "generateSynthetic", "getTerrainGrid", "activateTerrain", "releaseTerrain",
  "uploadDXF", "uploadSTL", "previewTerrainBounds", "exportPDF", "exportCSV",
] as const;

export const RADARS: RadarConfig[] = [
  {
    model_id: "perfil-a", display_name: "Perfil A", manufacturer: "Ejemplo", min_range_m: 0, max_range_m: 25,
    h_beam_width_deg: 360, v_beam_width_deg: 60, elevation_min_deg: -45, elevation_max_deg: 45,
    scan_pattern: "SAR360", azimuth_range_deg: null,
  },
  {
    model_id: "perfil-b", display_name: "Perfil B", manufacturer: "Ejemplo", min_range_m: 0, max_range_m: 40,
    h_beam_width_deg: 150, v_beam_width_deg: 30, elevation_min_deg: -30, elevation_max_deg: 30,
    scan_pattern: "RAR", azimuth_range_deg: [-75, 75],
  },
];

export const BOUNDS_ORIGIN = { min_x: 350_000.5, min_y: 6_400_000.25, min_z: 100 };

interface FakeState {
  terrains: Map<string, TerrainGridResponse>;
  jobs: Map<string, { kind: "los"; request: LOSRequest } | { kind: "sens"; request: SensitivityMapRequest }>;
  nextTerrain: number;
  nextJob: number;
  /** Jobs stay PENDING while true. */
  hang: boolean;
  /** Next LOS job fails with this message. */
  failWith: string | null;
  /** NaN block in the terrain's far corner. */
  nodataCorner: boolean;
  /** generateSynthetic never resolves while true. */
  hangTerrain: boolean;
  /** exports never resolve while true. */
  hangExport: boolean;
}

export const fake: FakeState = {
  terrains: new Map(), jobs: new Map(), nextTerrain: 0, nextJob: 0,
  hang: false, failWith: null, nodataCorner: false, hangTerrain: false, hangExport: false,
};

export function buildTerrain(request: SyntheticTerrainRequest, id: string): TerrainGridResponse {
  const res = request.resolution ?? 1;
  const cols = Math.floor(request.size_x / res + 1e-9) + 1;
  const rows = Math.floor(request.size_y / res + 1e-9) + 1;
  const grid: number[][] = [];
  let maxZ = -Infinity;
  for (let r = 0; r < rows; r += 1) {
    const row: number[] = [];
    for (let c = 0; c < cols; c += 1) {
      const u = (c / (cols - 1)) * 2 - 1;
      const v = (r / (rows - 1)) * 2 - 1;
      let z = BOUNDS_ORIGIN.min_z + request.depth * Math.min(1, (u * u + v * v) / 2);
      if (fake.nodataCorner && r >= rows - 3 && c >= cols - 3) z = Number.NaN;
      if (Number.isFinite(z)) maxZ = Math.max(maxZ, z);
      row.push(z);
    }
    grid.push(row);
  }
  const metadata: DTMMetadata = {
    terrain_id: id,
    bounds: {
      min_x: BOUNDS_ORIGIN.min_x, max_x: BOUNDS_ORIGIN.min_x + (cols - 1) * res,
      min_y: BOUNDS_ORIGIN.min_y, max_y: BOUNDS_ORIGIN.min_y + (rows - 1) * res,
      min_z: BOUNDS_ORIGIN.min_z, max_z: maxZ,
    },
    resolution: res, grid_rows: rows, grid_cols: cols,
  };
  return { terrain_id: id, grid, metadata };
}

/** Deterministic LOS: range circle, fixed shadow pattern, NODATA where the terrain has none. */
export function fakeLos(request: LOSRequest): LOSResponse {
  const terrain = fake.terrains.get(request.terrain_id);
  if (!terrain) throw new Error("terreno desconocido");
  const { grid, metadata } = terrain;
  const rows = metadata.grid_rows;
  const cols = metadata.grid_cols;
  const res = metadata.resolution;
  const radar = RADARS.find((r) => r.model_id === request.radar_model_id)!;
  const range = request.range_max_m ?? radar.max_range_m;
  const size = rows * cols;
  const cell_states = new Uint8Array(size);
  const quality = new Float32Array(size).fill(-1);
  const projection = new Float32Array(size).fill(Number.NaN);
  let visible = 0;
  let shadow = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      if (!Number.isFinite(grid[r]![c]!)) { cell_states[i] = LOSCellState.NODATA; continue; }
      const dx = metadata.bounds.min_x + c * res - request.radar_position.x;
      const dy = metadata.bounds.min_y + r * res - request.radar_position.y;
      if (Math.hypot(dx, dy) > range) { cell_states[i] = LOSCellState.OUT_OF_RANGE; continue; }
      if ((r * 7 + c * 3) % 11 === 0) { cell_states[i] = LOSCellState.SHADOW; shadow += 1; continue; }
      cell_states[i] = LOSCellState.VISIBLE;
      visible += 1;
      quality[i] = ((r * 13 + c * 7) % 100) / 100;
      projection[i] = ((r * 5 + c * 11) % 100) / 100;
    }
  }
  const candidates = visible + shadow;
  return {
    shadow_grid: [], cell_states, grid_rows: rows, grid_cols: cols, resolution: res, coverage_polygon: [],
    coverage_pct: candidates > 0 ? (visible / candidates) * 100 : null,
    completeness_pct: candidates > 0 ? 100 : null,
    visible_area_m2: visible * res * res,
    shadow_zones: shadow > 0 ? [{ zone_id: 1, cell_count: shadow }] : [],
    flat_quality_grid: quality, quality_model: "geometric-v2", flat_projection_grid: projection, engine_used: "ts",
  };
}

function fakeSensitivity(request: SensitivityMapRequest): SensitivityMapResponse {
  const first = request.observations[0]!;
  const size = first.grid_rows * first.grid_cols;
  const flat = new Float32Array(size).fill(Number.NaN);
  const count = new Uint16Array(size);
  for (let i = 0; i < size; i += 1) {
    const visible = request.observations.filter((o) => o.cell_states[i] === LOSCellState.VISIBLE).length;
    count[i] = visible;
    if (visible > 0) flat[i] = ((i * 17) % 100) / 100;
  }
  return {
    terrainKey: { ...request.terrainKey }, sourceAnalysisIds: request.observations.map((o) => o.analysisId),
    grid_rows: first.grid_rows, grid_cols: first.grid_cols, resolution: first.resolution,
    flat_sensitivity_grid: flat, observer_count: count, engine_used: "ts",
  };
}

const never = <T>() => new Promise<T>(() => undefined);

/** Installs the fake behaviour on the mocked `services/api` module. */
export function installFakeApi(): void {
  fake.terrains.clear();
  fake.jobs.clear();
  Object.assign(fake, { hang: false, failWith: null, nodataCorner: false, hangTerrain: false, hangExport: false });
  const m = vi.mocked(api);
  m.listRadars.mockImplementation(async () => RADARS.map((r) => ({ ...r })));
  m.generateSynthetic.mockImplementation(async (request: SyntheticTerrainRequest) => {
    if (fake.hangTerrain) return never<DTMMetadata>();
    fake.nextTerrain += 1;
    const terrain = buildTerrain(request, `dtm-synth-${fake.nextTerrain}-x350000y6400000`);
    fake.terrains.set(terrain.terrain_id, terrain);
    return terrain.metadata;
  });
  m.getTerrainGrid.mockImplementation(async (id: string) => {
    const terrain = fake.terrains.get(id);
    if (!terrain) throw new Error("terreno desconocido");
    return terrain;
  });
  m.runLOSAnalysis.mockImplementation(async (request: LOSRequest) => {
    fake.nextJob += 1;
    const job_id = `los-job-${fake.nextJob}`;
    fake.jobs.set(job_id, { kind: "los", request: { ...request } });
    return { job_id, status: "PENDING", created_at: "now" } as JobResponse;
  });
  m.runSensitivityAnalysis.mockImplementation(async (request: SensitivityMapRequest) => {
    fake.nextJob += 1;
    const job_id = `los-job-sens-${fake.nextJob}`;
    fake.jobs.set(job_id, { kind: "sens", request });
    return { job_id, status: "PENDING", created_at: "now" } as JobResponse;
  });
  type JobStatus = Awaited<ReturnType<typeof api.getLOSJob>>;
  const status = (value: Record<string, unknown>) => ({ created_at: "now", ...value }) as unknown as JobStatus;
  m.getLOSJob.mockImplementation(async (id: string) => {
    const job = fake.jobs.get(id);
    if (!job || fake.hang) return status({ job_id: id, status: "PENDING" });
    if (job.kind === "los") {
      if (fake.failWith) return status({ job_id: id, status: "FAILED", error: fake.failWith });
      return status({ job_id: id, status: "COMPLETED", result: fakeLos(job.request) });
    }
    return status({ job_id: id, status: "COMPLETED", result: fakeSensitivity(job.request) });
  });
  m.exportPDF.mockImplementation(async () => (fake.hangExport ? never<Blob>() : new Blob(["%PDF-fake"], { type: "application/pdf" })));
  m.exportCSV.mockImplementation(async () => (fake.hangExport ? never<Blob>() : new Blob(["a,b\n1,2\n"], { type: "text/csv" })));
}

const initialTerrain = useTerrainStore.getState();
const initialAnalysis = useAnalysisStore.getState();
const initialPolicy = useQualityPolicyStore.getState();

export function resetStores(): void {
  useAnalysisStore.getState().cancelAnalysis();
  useVectorStore.getState().reset();
  useTerrainStore.setState(initialTerrain, true);
  useAnalysisStore.setState(initialAnalysis, true);
  useQualityPolicyStore.setState(initialPolicy, true);
}

/** Advances fake timers until the promise settles. */
export async function drive<T>(promise: Promise<T>, maxMs = 60_000): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => { settled = true; });
  for (let t = 0; t < maxMs && !settled; t += 250) await vi.advanceTimersByTimeAsync(250);
  return tracked;
}

export function ctxFor(signal: AbortSignal = new AbortController().signal, step = 1): ToolContext {
  return { signal, step, callId: `c${step}` };
}

export function byName<T extends { readonly name: string }>(tools: readonly T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`falta ${name}`);
  return tool;
}

/** Generates and activates a synthetic terrain through the real store. */
export async function loadTerrain(size_x = 30, size_y = 20, resolution = 1): Promise<void> {
  useTerrainStore.getState().setPreferredResolution(resolution);
  await useTerrainStore.getState().generateSynthetic({ size_x, size_y, depth: 10, resolution });
}

export async function loadProfiles(): Promise<void> {
  await useAnalysisStore.getState().loadRadars();
}

/** `suggest_radar_positions` with its spec, as a second caller of the shared module lock would build it. */
export type SuggestionTool = SuggestToolImpl & {
  readonly name: "suggest_radar_positions";
  readonly description: string;
  readonly parameters: (typeof TOOL_SPECS)["suggest_radar_positions"]["parameters"];
  readonly maxResultBytes: number;
};

export interface SuggestionToolkit {
  refs: PlacementRefMap;
  tools: SuggestionTool[];
}

/**
 * One session of the suggestion runtime, built like the panel builds it (its own ref map and
 * `createSuggestRadarPositions` with the defaults). Replaces the former toolkit in the tests.
 */
export function createSuggestionToolkit(): SuggestionToolkit {
  const refs = new PlacementRefMap({
    currentKey: currentTerrainKey,
    candidateSignature,
    isLiveAnalysis: (key, analysisId) => historyFor(key).some((entry) => entry.snapshot?.analysisId === analysisId),
  });
  const spec = TOOL_SPECS.suggest_radar_positions;
  const tool: SuggestionTool = {
    name: "suggest_radar_positions",
    description: spec.description,
    parameters: spec.parameters,
    maxResultBytes: spec.maxResultBytes,
    ...createSuggestRadarPositions(refs, candidateSignature),
  };
  return { refs, tools: [tool] };
}
