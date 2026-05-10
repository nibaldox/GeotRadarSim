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
  JobResponse,
  JobStatusResponse,
} from "../types/api";

import { generateSyntheticTerrain } from "./terrainEngine";
import { saveLocalTerrain, getLocalTerrain } from "./localDataStore";
import type { TerrainWorkerInput, TerrainWorkerOutput } from "../workers/terrainWorker";
import type { LOSWorkerInput, LOSWorkerOutput } from "../workers/losWorker";

// Simulated Job Store for long-running worker tasks
const jobStore = new Map<string, JobStatusResponse>();

// ────────────────────────────────────────────
// Radar Definitions (Hardcoded for local app)
// ────────────────────────────────────────────

const LOCAL_RADARS: RadarConfig[] = [
  {
    model_id: "groundprobe-ssr-fx",
    display_name: "GroundProbe SSR-FX",
    manufacturer: "GroundProbe",
    min_range_m: 0.0,
    max_range_m: 850.0,
    h_beam_width_deg: 90.0,
    v_beam_width_deg: 30.0,
    elevation_min_deg: -30.0,
    elevation_max_deg: 30.0,
    scan_pattern: "RAR",
    azimuth_range_deg: [-45.0, 45.0]
  },
  {
    model_id: "ibis-arcsar360",
    display_name: "IBIS-ArcSAR360",
    manufacturer: "IDS GeoRadar",
    min_range_m: 10.0,
    max_range_m: 400.0,
    h_beam_width_deg: 360.0,
    v_beam_width_deg: 40.0,
    elevation_min_deg: -20.0,
    elevation_max_deg: 20.0,
    scan_pattern: "SAR360",
    azimuth_range_deg: null
  },
  {
    model_id: "reutech-msr",
    display_name: "Reutech MSR",
    manufacturer: "Reutech Radar Systems",
    min_range_m: 0.0,
    max_range_m: 500.0,
    h_beam_width_deg: 120.0,
    v_beam_width_deg: 30.0,
    elevation_min_deg: -30.0,
    elevation_max_deg: 30.0,
    scan_pattern: "RAR",
    azimuth_range_deg: [-60.0, 60.0]
  }
];

export function setApiBaseUrl(_url: string): void {
  // No-op in serverless mode
}

// Helper to run Terrain Worker
async function runTerrainWorker(input: TerrainWorkerInput): Promise<DTMMetadata> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/terrainWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<TerrainWorkerOutput>) => {
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else {
        const metadata = e.data.metadata!;
        saveLocalTerrain({ metadata, grid: e.data.grid! });
        resolve(metadata);
      }
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error("Worker error: " + e.message));
      worker.terminate();
    };
    worker.postMessage(input);
  });
}

// ────────────────────────────────────────────
// Terrain endpoints
// ────────────────────────────────────────────

export async function uploadDXF(file: File, resolution?: number): Promise<DTMMetadata> {
  const fileData = await file.arrayBuffer();
  return runTerrainWorker({ fileData, filename: file.name, resolution: resolution || 1.0 });
}

export async function uploadSTL(file: File, resolution?: number): Promise<DTMMetadata> {
  const fileData = await file.arrayBuffer();
  return runTerrainWorker({ fileData, filename: file.name, resolution: resolution || 1.0 });
}

export async function generateSynthetic(params: SyntheticTerrainRequest): Promise<DTMMetadata> {
  // Can be synchronous because it's fast
  const res = params.resolution || 2.0;
  const result = generateSyntheticTerrain(params.size_x, params.size_y, params.depth, res);
  saveLocalTerrain({ metadata: result.metadata, grid: result.grid });
  return result.metadata;
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

// ────────────────────────────────────────────
// Analysis endpoints
// ────────────────────────────────────────────

export async function runLOSAnalysis(req: LOSRequest): Promise<JobResponse> {
  const terrain = getLocalTerrain(req.terrain_id);
  if (!terrain) throw new Error("Terrain not loaded");

  const radar = LOCAL_RADARS.find(r => r.model_id === req.radar_model_id);
  if (!radar) throw new Error("Radar model not found");

  const jobId = `job-${Math.random().toString(16).substring(2, 10)}`;
  
  jobStore.set(jobId, { job_id: jobId, status: "PENDING", created_at: new Date().toISOString() });

  const worker = new Worker(new URL('../workers/losWorker.ts', import.meta.url), { type: 'module' });
  
  const effectiveRadar: RadarConfig = { ...radar };
  if (req.range_min_m !== undefined) effectiveRadar.min_range_m = req.range_min_m;
  if (req.range_max_m !== undefined) effectiveRadar.max_range_m = req.range_max_m;
  if (req.el_min_deg !== undefined) effectiveRadar.elevation_min_deg = req.el_min_deg;
  if (req.el_max_deg !== undefined) effectiveRadar.elevation_max_deg = req.el_max_deg;
  
  if (req.az_center_deg !== undefined || req.az_width_deg !== undefined) {
    const center = req.az_center_deg !== undefined ? req.az_center_deg : 0;
    const width = req.az_width_deg !== undefined ? req.az_width_deg : radar.h_beam_width_deg;
    const halfWidth = width / 2;
    
    let azStart = center - halfWidth;
    let azEnd = center + halfWidth;
    
    // Normalize to [-180, 180] so the worker's logic works
    while (azStart > 180) azStart -= 360;
    while (azStart <= -180) azStart += 360;
    
    while (azEnd > 180) azEnd -= 360;
    while (azEnd <= -180) azEnd += 360;
    
    effectiveRadar.azimuth_range_deg = [azStart, azEnd];
    effectiveRadar.scan_pattern = "RAR"; // force RAR if azimuth is restricted
  }

  const workerInput: LOSWorkerInput = {
    grid: terrain.grid,
    bounds: terrain.metadata.bounds,
    resolution: terrain.metadata.resolution,
    radar_position: [req.radar_position.x, req.radar_position.y, req.radar_position.z],
    radar_config: effectiveRadar
  };

  worker.onmessage = (e: MessageEvent<LOSWorkerOutput & {error?: string}>) => {
    if (e.data.error) {
      jobStore.set(jobId, { job_id: jobId, status: "FAILED", error: e.data.error, created_at: new Date().toISOString() });
    } else {
      jobStore.set(jobId, {
        job_id: jobId,
        status: "COMPLETED",
        result: e.data,
        created_at: new Date().toISOString()
      });
    }
    worker.terminate();
  };
  
  worker.onerror = (e) => {
    jobStore.set(jobId, { job_id: jobId, status: "FAILED", error: e.message, created_at: new Date().toISOString() });
    worker.terminate();
  };

  worker.postMessage(workerInput);

  return { job_id: jobId, status: "PENDING" };
}

export async function getLOSJob(jobId: string): Promise<JobStatusResponse> {
  const job = jobStore.get(jobId);
  if (!job) throw new Error("Job not found");
  return job;
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

export async function exportPDF(_req: LOSRequest): Promise<Blob> {
  // Not implemented locally yet. 
  // TODO: Use jsPDF or similar in a real version.
  throw new Error("PDF Export not implemented in WebApp version yet");
}

export async function exportCSV(_req: LOSRequest): Promise<Blob> {
  throw new Error("CSV Export not implemented in WebApp version yet");
}
