/**
 * Local API Client for the Radar Monitoring Simulator WebApp.
 *
 * This replaces the previous HTTP fetch-based client. It delegates heavy processing
 * to local Web Workers and synchronous operations to local services, enabling
 * a 100% serverless WebApp deployable on GitHub Pages.
 */

import type {
  DTMMetadata,
  TerrainGridResponse,
  RadarConfig,
  SyntheticTerrainRequest,
  LOSRequest,
  AnalysisSnapshot,
  JobResponse,
  JobStatusResponse,
  SensitivityMapRequest,
  SensitivityMapResponse,
} from "../types/api";
import { LOSCellState } from "../types/api";

import { generateSyntheticTerrain } from "./terrainEngine";
import {
  saveLocalTerrain,
  getLocalTerrain,
  identifyLocalTerrainImport,
  activateLocalTerrain as activateCachedTerrain,
  releaseLocalTerrain as releaseProvisionalTerrain,
  acquireLocalTerrainLease,
} from "./localDataStore";
import type { TerrainWorkerInput, TerrainWorkerOutput } from "../workers/terrainWorker";
import type { LOSWorkerInput, LOSWorkerOutput } from "../workers/losWorker";
import type { SensitivityWorkerInput, SensitivityWorkerOutput } from "../workers/vectorWorker";
import { generatePDFBlob, generateCSVBlob } from "./exportEngine";
import type { LOSResponse } from "../types/api";
import { validateTerrainGridDimensions, validateTerrainResolution } from "../utils/terrainLimits";
import { terrainGradientAt } from "../utils/sensitivity";

// Simulated Job Store for long-running worker tasks
const jobStore = new Map<string, JobStatusResponse>();
const losJobIds = new Set<string>();
const sensitivityJobIds = new Set<string>();
const activeLOSWorkers = new Map<string, Worker>();
const activeSensitivityWorkers = new Map<string, Worker>();
const jobTerrainLeaseReleases = new Map<string, () => void>();
let nextLOSJobSequence = 0;
let nextSensitivityJobSequence = 0;

function releaseJobTerrainLease(jobId: string): void {
  const release = jobTerrainLeaseReleases.get(jobId);
  if (!release) return;
  jobTerrainLeaseReleases.delete(jobId);
  release();
}

// ────────────────────────────────────────────
// Radar Definitions (Hardcoded for local app)
// ────────────────────────────────────────────

const LOCAL_RADARS: RadarConfig[] = [
  {
    model_id: "groundprobe-ssr-fx",
    display_name: "GroundProbe SSR-FX",
    manufacturer: "GroundProbe",
    min_range_m: 50.0,
    max_range_m: 2500.0,
    h_beam_width_deg: 150.0,
    v_beam_width_deg: 30.0,
    elevation_min_deg: -60.0,
    elevation_max_deg: 60.0,
    scan_pattern: "RAR",
    azimuth_range_deg: [-75.0, 75.0]
  },
  {
    model_id: "ibis-arcsar360",
    display_name: "IBIS-ArcSAR360",
    manufacturer: "IDS GeoRadar",
    min_range_m: 50.0,
    max_range_m: 2500.0,
    h_beam_width_deg: 360.0,
    v_beam_width_deg: 40.0,
    elevation_min_deg: -60.0,
    elevation_max_deg: 60.0,
    scan_pattern: "SAR360",
    azimuth_range_deg: null
  },
  {
    model_id: "reutech-msr",
    display_name: "Reutech MSR",
    manufacturer: "Reutech Radar Systems",
    min_range_m: 50.0,
    max_range_m: 2500.0,
    h_beam_width_deg: 150.0,
    v_beam_width_deg: 30.0,
    elevation_min_deg: -60.0,
    elevation_max_deg: 60.0,
    scan_pattern: "RAR",
    azimuth_range_deg: [-75.0, 75.0]
  }
];

export function setApiBaseUrl(_url: string): void {
  // No-op in serverless mode
}

export function normalizeAzimuthRange(center: number, width: number): [number, number] | null {
  if (!Number.isFinite(center)) {
    throw new RangeError("Azimuth center must be finite");
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError("Azimuth width must be finite and greater than 0");
  }
  if (width >= 360) return null;

  const normalizeAngle = (angle: number): number => {
    const normalized = ((angle % 360) + 360) % 360;
    return normalized > 180 ? normalized - 360 : normalized;
  };
  const normalizedCenter = normalizeAngle(center);
  const halfWidth = width / 2;

  return [
    normalizeAngle(normalizedCenter - halfWidth),
    normalizeAngle(normalizedCenter + halfWidth),
  ];
}

function validateRadarLimits(radar: RadarConfig): void {
  if (!Number.isFinite(radar.min_range_m) || !Number.isFinite(radar.max_range_m) ||
      radar.min_range_m < 0 || radar.min_range_m > radar.max_range_m) {
    throw new RangeError("LOS range limits must be finite, non-negative, and ordered");
  }
  if (!Number.isFinite(radar.elevation_min_deg) || !Number.isFinite(radar.elevation_max_deg) ||
      radar.elevation_min_deg < -90 || radar.elevation_max_deg > 90 ||
      radar.elevation_min_deg > radar.elevation_max_deg) {
    throw new RangeError("LOS elevation limits must be finite, within [-90, 90], and ordered");
  }
}

// Helper to run Terrain Worker
async function runTerrainWorker(input: TerrainWorkerInput): Promise<DTMMetadata> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;

    const claimTerminal = (): boolean => {
      if (settled) return false;
      settled = true;
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        try {
          worker.terminate();
        } catch {
          // Preserve the first worker result or failure.
        }
      }
      return true;
    };

    try {
      worker = new Worker(new URL('../workers/terrainWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<TerrainWorkerOutput>) => {
        if (!claimTerminal()) return;
        try {
          if (e.data.error) {
            reject(new Error(e.data.error));
            return;
          }
          const metadata = identifyLocalTerrainImport(e.data.metadata!);
          saveLocalTerrain({ metadata, grid: e.data.grid! });
          resolve(metadata);
        } catch (error) {
          reject(error);
        }
      };
      worker.onerror = (e) => {
        if (!claimTerminal()) return;
        reject(new Error("Worker error: " + e.message));
      };
      worker.postMessage(input);
    } catch (error) {
      if (claimTerminal()) reject(error);
    }
  });
}

// ────────────────────────────────────────────
// Terrain endpoints
// ────────────────────────────────────────────

/** Imports a DXF grid provisionally; service callers must activate or release its terrain ID. */
export async function uploadDXF(file: File, resolution?: number): Promise<DTMMetadata> {
  const fileData = await file.arrayBuffer();
  return runTerrainWorker({ fileData, filename: file.name, resolution: resolution || 1.0 });
}

/** Imports an STL grid provisionally; service callers must activate or release its terrain ID. */
export async function uploadSTL(file: File, resolution?: number): Promise<DTMMetadata> {
  const fileData = await file.arrayBuffer();
  return runTerrainWorker({ fileData, filename: file.name, resolution: resolution || 1.0 });
}

/** Generates a synthetic grid provisionally; service callers must activate or release its terrain ID. */
export async function generateSynthetic(params: SyntheticTerrainRequest): Promise<DTMMetadata> {
  // Can be synchronous because it's fast
  const res = params.resolution || 2.0;
  const result = generateSyntheticTerrain(params.size_x, params.size_y, params.depth, res);
  const metadata = identifyLocalTerrainImport(result.metadata);
  saveLocalTerrain({ metadata, grid: result.grid });
  return metadata;
}

export async function getTerrainGrid(terrainId: string): Promise<TerrainGridResponse> {
  const terrain = getLocalTerrain(terrainId);
  if (!terrain) {
    throw new Error(`Terrain '${terrainId}' not found locally`);
  }
  return {
    terrain_id: terrainId,
    metadata: terrain.metadata,
    grid: terrain.grid,
  };
}

/** Promote a generated terrain's provisional grid to the active cache owner. */
export function activateTerrain(terrainId: string): void {
  activateCachedTerrain(terrainId);
}

/**
 * Release the provisional grid returned by uploadDXF/uploadSTL/generateSynthetic.
 * Direct service callers should call this when abandoning an import or after a
 * worker has synchronously acquired its terrain lease; active grids are safe.
 */
export function releaseTerrain(terrainId: string): void {
  releaseProvisionalTerrain(terrainId);
}

// ────────────────────────────────────────────
// Analysis endpoints
// ────────────────────────────────────────────

export async function runLOSAnalysis(req: LOSRequest): Promise<JobResponse> {
  const terrain = getLocalTerrain(req.terrain_id);
  if (!terrain) throw new Error("Terrain not loaded");

  const metadataRows = terrain.metadata.grid_rows;
  const metadataCols = terrain.metadata.grid_cols;
  validateTerrainGridDimensions(metadataRows, metadataCols, "Terrain");
  validateTerrainResolution(terrain.metadata.resolution, "Terrain");
  const gridRows = terrain.grid.length;
  const gridCols = terrain.grid[0]?.length ?? 0;
  validateTerrainGridDimensions(gridRows, gridCols, "Terrain");
  if (gridRows !== metadataRows || gridCols !== metadataCols ||
      terrain.grid.some((row) => !Array.isArray(row) || row.length !== gridCols)) {
    throw new RangeError("Terrain grid dimensions do not match metadata");
  }

  const radar = LOCAL_RADARS.find(r => r.model_id === req.radar_model_id);
  if (!radar) throw new Error("Radar model not found");

  const effectiveRadar: RadarConfig = { ...radar };
  if (req.range_min_m !== undefined) effectiveRadar.min_range_m = req.range_min_m;
  if (req.range_max_m !== undefined) effectiveRadar.max_range_m = req.range_max_m;
  if (req.el_min_deg !== undefined) effectiveRadar.elevation_min_deg = req.el_min_deg;
  if (req.el_max_deg !== undefined) effectiveRadar.elevation_max_deg = req.el_max_deg;
  validateRadarLimits(effectiveRadar);

  if (req.az_center_deg !== undefined || req.az_width_deg !== undefined) {
    const center = req.az_center_deg !== undefined ? req.az_center_deg : 0;
    const width = req.az_width_deg !== undefined ? req.az_width_deg : radar.h_beam_width_deg;

    effectiveRadar.azimuth_range_deg = normalizeAzimuthRange(center, width);
    effectiveRadar.scan_pattern = "RAR"; // Azimuth overrides use the RAR path; null range remains full-circle.
  }

  const jobId = `los-job-${Date.now().toString(16)}-${nextLOSJobSequence++}`;
  const createdAt = new Date().toISOString();
  losJobIds.add(jobId);
  jobStore.set(jobId, { job_id: jobId, status: "PENDING", created_at: createdAt });

  const workerInput: LOSWorkerInput = {
    grid: terrain.grid,
    bounds: terrain.metadata.bounds,
    resolution: terrain.metadata.resolution,
    radar_position: [req.radar_position.x, req.radar_position.y, req.radar_position.z],
    radar_config: effectiveRadar
  };
  jobTerrainLeaseReleases.set(jobId, acquireLocalTerrainLease(req.terrain_id));
  const markFailed = (error: string) => {
    if (!losJobIds.has(jobId) || jobStore.get(jobId)?.status !== "PENDING") return;
    jobStore.set(jobId, { job_id: jobId, status: "FAILED", error, created_at: createdAt });
    releaseJobTerrainLease(jobId);
  };

  let worker: Worker | undefined;
  let synchronousFailure = false;
  try {
    worker = new Worker(new URL('../workers/losWorker.ts', import.meta.url), { type: 'module' });
    const activeWorker = worker;
    activeLOSWorkers.set(jobId, activeWorker);
    const cleanup = () => {
      if (activeLOSWorkers.get(jobId) === activeWorker) activeLOSWorkers.delete(jobId);
      activeWorker.onmessage = null;
      activeWorker.onerror = null;
      try {
        activeWorker.terminate();
      } catch {
        // Keep the result or failure already recorded for this LOS job.
      }
    };
    const isActive = () => losJobIds.has(jobId) &&
      activeLOSWorkers.get(jobId) === activeWorker && jobStore.get(jobId)?.status === "PENDING";

    activeWorker.onmessage = (e: MessageEvent<LOSWorkerOutput & {error?: string}>) => {
      if (!isActive()) return;
      try {
        if (e.data.error) {
          markFailed(e.data.error);
        } else {
          const resultData = { ...e.data } as LOSResponse;
          if (resultData.flat_quality_grid && (!resultData.shadow_grid || !resultData.quality_grid)) {
            const { shadow_grid, quality_grid } = inflateLOSResult(
              resultData.flat_quality_grid,
              terrain.metadata.grid_rows,
              terrain.metadata.grid_cols,
              resultData.cell_states
            );
            resultData.shadow_grid = shadow_grid;
            resultData.quality_grid = quality_grid;
          }
          jobStore.set(jobId, {
            job_id: jobId,
            status: "COMPLETED",
            result: resultData,
            created_at: createdAt
          });
          releaseJobTerrainLease(jobId);
        }
      } catch (error) {
        markFailed(error instanceof Error ? error.message : String(error));
      } finally {
        cleanup();
      }
    };

    activeWorker.onerror = (e) => {
      if (!isActive()) return;
      markFailed(e.message);
      cleanup();
    };

    activeWorker.postMessage(workerInput);
  } catch (err) {
    synchronousFailure = true;
    markFailed(err instanceof Error ? err.message : String(err));
    if (worker) {
      if (activeLOSWorkers.get(jobId) === worker) activeLOSWorkers.delete(jobId);
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        // Keep the recorded FAILED state even if termination itself also throws.
      }
    }
  }

  return { job_id: jobId, status: synchronousFailure ? "FAILED" : "PENDING" };
}

export async function getLOSJob(jobId: string): Promise<JobStatusResponse> {
  const job = jobStore.get(jobId);
  if (!job) throw new Error("Job not found");
  return job;
}

/** Release a terminal LOS job after its result or failure has been consumed. */
export function releaseLOSJob(jobId: string): void {
  if (!losJobIds.has(jobId)) return;
  const job = jobStore.get(jobId);
  if (job?.status === "PENDING") return;
  jobStore.delete(jobId);
  losJobIds.delete(jobId);
  releaseJobTerrainLease(jobId);
}

/** Cancel an obsolete LOS job and discard any eventual worker message. */
export function cancelLOSAnalysis(jobId: string): void {
  if (!losJobIds.has(jobId)) return;
  losJobIds.delete(jobId);
  jobStore.delete(jobId);
  releaseJobTerrainLease(jobId);
  const worker = activeLOSWorkers.get(jobId);
  if (!worker) return;
  activeLOSWorkers.delete(jobId);
  worker.onmessage = null;
  worker.onerror = null;
  try {
    worker.terminate();
  } catch {
    // The job has already been removed, so late worker messages are fenced off.
  }
}

// ────────────────────────────────────────────
// Radar endpoints
// ────────────────────────────────────────────

export async function listRadars(): Promise<RadarConfig[]> {
  return LOCAL_RADARS;
}

export async function getRadar(modelId: string): Promise<RadarConfig> {
  const radar = LOCAL_RADARS.find(r => r.model_id === modelId);
  if (!radar) throw new Error("Radar not found");
  return radar;
}

// ────────────────────────────────────────────
// Export endpoints
// ────────────────────────────────────────────

export async function exportPDF(snapshot: AnalysisSnapshot, customResult?: LOSResponse): Promise<Blob> {
  if (!snapshot || !customResult) {
    throw new Error("No analysis data available to export. Run LOS analysis first.");
  }
  return generatePDFBlob(snapshot, customResult);
}

export async function exportCSV(snapshot: AnalysisSnapshot, customResult?: LOSResponse): Promise<Blob> {
  if (!snapshot || !customResult) {
    throw new Error("No analysis data available to export. Run LOS analysis first.");
  }
  return generateCSVBlob(snapshot, customResult);
}

function inflateLOSResult(
  flatQuality: Float32Array,
  rows: number,
  cols: number,
  cellStates?: Uint8Array
): { shadow_grid: boolean[][]; quality_grid: number[][] } {
  if (cellStates && cellStates.length !== rows * cols) {
    throw new RangeError("LOS cell-state dimensions do not match the terrain grid");
  }
  const shadow_grid: boolean[][] = [];
  const quality_grid: number[][] = [];

  for (let r = 0; r < rows; r++) {
    const shadowRow = new Array<boolean>(cols);
    const qualityRow = new Array<number>(cols);
    const rowOffset = r * cols;
    for (let c = 0; c < cols; c++) {
      const idx = rowOffset + c;
      const q = flatQuality[idx] ?? -1;
      shadowRow[c] = cellStates?.[idx] === LOSCellState.SHADOW;
      qualityRow[c] = Number.isFinite(q) && q >= 0 ? q : 0;
    }
    shadow_grid.push(shadowRow);
    quality_grid.push(qualityRow);
  }

  return { shadow_grid, quality_grid };
}

function sameSensitivityTerrainKey(
  left: AnalysisSnapshot["terrainKey"],
  right: AnalysisSnapshot["terrainKey"],
): boolean {
  return left.terrain_id === right.terrain_id && left.epoch === right.epoch;
}

function prepareSensitivityWorkerInput(
  req: SensitivityMapRequest,
): { terrain: ReturnType<typeof getLocalTerrain> & {}; input: SensitivityWorkerInput } {
  const terrainKey = req?.terrainKey;
  if (!terrainKey || !terrainKey.terrain_id || !Number.isSafeInteger(terrainKey.epoch) || terrainKey.epoch < 0) {
    throw new RangeError("Sensitivity terrain key is invalid");
  }
  const terrain = getLocalTerrain(terrainKey.terrain_id);
  if (!terrain) throw new Error("Terrain not loaded");
  if (terrain.metadata.terrain_id !== terrainKey.terrain_id) {
    throw new RangeError("Sensitivity terrain key does not match the loaded terrain");
  }

  const rows = terrain.metadata.grid_rows;
  const cols = terrain.metadata.grid_cols;
  validateTerrainGridDimensions(rows, cols, "Sensitivity terrain");
  validateTerrainResolution(terrain.metadata.resolution, "Sensitivity terrain");
  const gridRows = Array.isArray(terrain.grid) ? terrain.grid.length : 0;
  const gridCols = terrain.grid[0]?.length ?? 0;
  validateTerrainGridDimensions(gridRows, gridCols, "Sensitivity terrain grid");
  if (gridRows !== rows || gridCols !== cols ||
      terrain.grid.some((row) => !Array.isArray(row) || row.length !== cols)) {
    throw new RangeError("Sensitivity terrain grid dimensions do not match metadata");
  }
  if (!Number.isFinite(terrain.metadata.bounds.min_x) || !Number.isFinite(terrain.metadata.bounds.min_y)) {
    throw new RangeError("Sensitivity terrain origin must be finite");
  }

  if (!Array.isArray(req.observations) || req.observations.length === 0 || req.observations.length > 0xffff) {
    throw new RangeError("Sensitivity requires between 1 and 65535 individual radar observations");
  }
  const ids = new Set<string>();
  const cellCount = rows * cols;
  for (const observation of req.observations) {
    if (!observation || typeof observation.analysisId !== "string" || !observation.analysisId || ids.has(observation.analysisId)) {
      throw new RangeError("Sensitivity observations require unique stable analysis IDs");
    }
    ids.add(observation.analysisId);
    const snapshot = observation.snapshot;
    if (!snapshot || snapshot.analysisId !== observation.analysisId ||
        !Array.isArray(snapshot.sourceAnalysisIds) || snapshot.sourceAnalysisIds.length !== 1 ||
        snapshot.sourceAnalysisIds[0] !== observation.analysisId ||
        !sameSensitivityTerrainKey(snapshot.terrainKey, terrainKey)) {
      throw new RangeError("Sensitivity analysis snapshot does not match the active terrain and analysis ID");
    }
    if (!Array.isArray(snapshot.radars) || snapshot.radars.length !== 1) {
      throw new RangeError("Sensitivity requires an individual radar snapshot for every analysis");
    }
    const radar = snapshot.radars[0]!;
    if (typeof radar.radarId !== "string" || !radar.radarId || typeof radar.radarModelId !== "string" ||
        !radar.radarModelId || !radar.position || !Number.isFinite(radar.position.x) ||
        !Number.isFinite(radar.position.y) || !Number.isFinite(radar.position.z)) {
      throw new RangeError("Sensitivity radar provenance requires a stable ID and finite position");
    }
    if (observation.grid_rows !== rows || observation.grid_cols !== cols ||
        observation.resolution !== terrain.metadata.resolution ||
        !(observation.cell_states instanceof Uint8Array) || observation.cell_states.length !== cellCount) {
      throw new RangeError("Sensitivity observation dimensions, resolution, or cell-state length do not match the active terrain");
    }
  }

  return {
    terrain,
    input: {
      type: "SENSITIVITY",
      terrainKey: { ...terrainKey },
      grid: terrain.grid,
      grid_rows: rows,
      grid_cols: cols,
      resolution: terrain.metadata.resolution,
      bounds: terrain.metadata.bounds,
      observations: req.observations,
    },
  };
}

function validateSensitivityWorkerOutput(
  data: SensitivityWorkerOutput,
  req: SensitivityMapRequest,
  terrain: NonNullable<ReturnType<typeof getLocalTerrain>>,
): SensitivityMapResponse {
  const { grid_rows: rows, grid_cols: cols, resolution } = terrain.metadata;
  const expectedIds = req.observations.map((observation) => observation.analysisId);
  const validIds = Array.isArray(data.sourceAnalysisIds) && data.sourceAnalysisIds.length === expectedIds.length &&
    data.sourceAnalysisIds.every((id, index) => id === expectedIds[index]);
  if (!data.terrainKey || !sameSensitivityTerrainKey(data.terrainKey, req.terrainKey) || !validIds ||
      data.grid_rows !== rows || data.grid_cols !== cols || data.resolution !== resolution ||
      !(data.flat_sensitivity_grid instanceof Float32Array) || data.flat_sensitivity_grid.length !== rows * cols ||
      !(data.observer_count instanceof Uint16Array) || data.observer_count.length !== rows * cols ||
      "sensitivityGrid" in data) {
    throw new RangeError("Sensitivity worker returned invalid provenance or map dimensions");
  }

  for (let index = 0; index < rows * cols; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const gradientAvailable = terrainGradientAt(terrain.grid, row, col, resolution) !== null;
    const expectedObserverCount = gradientAvailable
      ? req.observations.reduce((count, observation) => count + Number(observation.cell_states[index] === LOSCellState.VISIBLE), 0)
      : 0;
    const count = data.observer_count[index]!;
    const value = data.flat_sensitivity_grid[index]!;
    if (count !== expectedObserverCount ||
        (count === 0 ? !Number.isNaN(value) : !Number.isFinite(value) || value < 0 || value > 1.00001)) {
      throw new RangeError("Sensitivity worker mask, gradient, or observer count does not match individual LOS cell states");
    }
  }
  return data;
}

export async function runSensitivityAnalysis(req: SensitivityMapRequest): Promise<JobResponse> {
  const { terrain, input } = prepareSensitivityWorkerInput(req);
  const jobId = `job-${Date.now().toString(16)}-${nextSensitivityJobSequence++}`;
  const createdAt = new Date().toISOString();
  sensitivityJobIds.add(jobId);
  jobStore.set(jobId, { job_id: jobId, status: "PENDING", created_at: createdAt });
  jobTerrainLeaseReleases.set(jobId, acquireLocalTerrainLease(req.terrainKey.terrain_id));

  const markFailed = (error: string) => {
    if (!sensitivityJobIds.has(jobId) || jobStore.get(jobId)?.status !== "PENDING") return;
    jobStore.set(jobId, { job_id: jobId, status: "FAILED", error, created_at: createdAt });
    releaseJobTerrainLease(jobId);
  };
  let worker: Worker | undefined;
  let cleanupWorker: (() => void) | null = null;
  let synchronousFailure = false;

  try {
    worker = new Worker(new URL("../workers/vectorWorker.ts", import.meta.url), { type: "module" });
    const activeWorker = worker;
    activeSensitivityWorkers.set(jobId, activeWorker);
    let workerCleaned = false;
    cleanupWorker = () => {
      if (workerCleaned) return;
      workerCleaned = true;
      if (activeSensitivityWorkers.get(jobId) === activeWorker) activeSensitivityWorkers.delete(jobId);
      activeWorker.onmessage = null;
      activeWorker.onerror = null;
      try {
        activeWorker.terminate();
      } catch {
        // Keep the terminal result or failure already recorded for this job.
      }
    };
    const isActive = () => sensitivityJobIds.has(jobId) &&
      activeSensitivityWorkers.get(jobId) === activeWorker && jobStore.get(jobId)?.status === "PENDING";

    activeWorker.onmessage = (event: MessageEvent<SensitivityWorkerOutput>) => {
      if (!isActive()) return;
      if (event.data.error) {
        markFailed(event.data.error);
      } else {
        try {
          const result = validateSensitivityWorkerOutput(event.data, req, terrain);
          jobStore.set(jobId, { job_id: jobId, status: "COMPLETED", result, created_at: createdAt });
          releaseJobTerrainLease(jobId);
        } catch (error) {
          markFailed(error instanceof Error ? error.message : String(error));
        }
      }
      cleanupWorker?.();
    };

    activeWorker.onerror = (event) => {
      if (!isActive()) return;
      markFailed(event.message);
      cleanupWorker?.();
    };

    activeWorker.postMessage(input);
  } catch (error) {
    synchronousFailure = true;
    markFailed(error instanceof Error ? error.message : String(error));
    if (worker) {
      if (cleanupWorker) {
        cleanupWorker();
      } else {
        if (activeSensitivityWorkers.get(jobId) === worker) activeSensitivityWorkers.delete(jobId);
        worker.onmessage = null;
        worker.onerror = null;
        try {
          worker.terminate();
        } catch {
          // Keep the original job failure if termination also throws.
        }
      }
    }
  }

  return { job_id: jobId, status: synchronousFailure ? "FAILED" : "PENDING" };
}

/** Release a terminal sensitivity job after its result or failure has been consumed. */
export function releaseSensitivityJob(jobId: string): void {
  if (!sensitivityJobIds.has(jobId)) return;
  const job = jobStore.get(jobId);
  if (!job || job.status === "PENDING") return;
  jobStore.delete(jobId);
  sensitivityJobIds.delete(jobId);
  releaseJobTerrainLease(jobId);
}

export function cancelSensitivityAnalysis(jobId: string): void {
  if (!sensitivityJobIds.has(jobId)) return;
  const job = jobStore.get(jobId);
  if (job && job.status !== "PENDING") return;
  jobStore.delete(jobId);
  sensitivityJobIds.delete(jobId);
  releaseJobTerrainLease(jobId);
  const worker = activeSensitivityWorkers.get(jobId);
  if (!worker) return;
  activeSensitivityWorkers.delete(jobId);
  worker.onmessage = null;
  worker.onerror = null;
  try {
    worker.terminate();
  } catch {
    // The job has already been removed, so late worker messages are fenced off.
  }
}
