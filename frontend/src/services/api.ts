/**
 * Typed API client for the Radar Monitoring Simulator backend.
 *
 * All functions use fetch and return typed responses.
 * Errors are thrown as Error objects with the backend detail message.
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

let baseUrl = "http://localhost:8000";

/** Override the base URL (useful for testing or proxy setups). */
export function setApiBaseUrl(url: string): void {
  baseUrl = url;
}

/** Extract error detail from a non-OK response. */
async function extractError(response: Response): Promise<never> {
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) {
      detail = body.detail;
    }
  } catch {
    // If JSON parsing fails, use the generic message
  }
  throw new Error(detail);
}

/** Generic JSON fetch helper. */
async function fetchJSON<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    return extractError(response);
  }
  return (await response.json()) as T;
}

// ────────────────────────────────────────────
// Terrain endpoints
// ────────────────────────────────────────────

/** Upload a DXF file and generate a DTM. */
export async function uploadDXF(file: File, resolution?: number): Promise<DTMMetadata> {
  const formData = new FormData();
  formData.append("file", file);
  const url = resolution 
    ? `${baseUrl}/api/terrain/upload?resolution=${resolution}`
    : `${baseUrl}/api/terrain/upload`;
    
  const response = await fetch(url, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    return extractError(response);
  }
  return (await response.json()) as DTMMetadata;
}

/** Upload an STL file and generate a DTM. */
export async function uploadSTL(file: File, resolution?: number): Promise<DTMMetadata> {
  const formData = new FormData();
  formData.append("file", file);
  const url = resolution 
    ? `${baseUrl}/api/terrain/upload-stl?resolution=${resolution}`
    : `${baseUrl}/api/terrain/upload-stl`;

  const response = await fetch(url, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    return extractError(response);
  }
  return (await response.json()) as DTMMetadata;
}

/** Generate synthetic bowl-shaped terrain. */
export async function generateSynthetic(
  params: SyntheticTerrainRequest,
): Promise<DTMMetadata> {
  const body: Record<string, unknown> = {
    size_x: params.size_x,
    size_y: params.size_y,
    depth: params.depth,
  };
  if (params.resolution !== undefined) {
    body.resolution = params.resolution;
  }
  return fetchJSON<DTMMetadata>("/api/terrain/synthetic", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Retrieve terrain grid data by ID. */
export async function getTerrainGrid(
  terrainId: string,
): Promise<TerrainGridResponse> {
  return fetchJSON<TerrainGridResponse>(
    `/api/terrain/${encodeURIComponent(terrainId)}/grid`,
    { method: "GET" },
  );
}

// ────────────────────────────────────────────
// Analysis endpoints
// ────────────────────────────────────────────

/** Start Line-of-Sight analysis job. */
export async function runLOSAnalysis(req: LOSRequest): Promise<JobResponse> {
  return fetchJSON<JobResponse>("/api/analysis/los", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Get status of an analysis job. */
export async function getLOSJob(jobId: string): Promise<JobStatusResponse> {
  return fetchJSON<JobStatusResponse>(`/api/analysis/jobs/${jobId}`, {
    method: "GET",
  });
}

// ────────────────────────────────────────────
// Radar endpoints
// ────────────────────────────────────────────

/** List all available radar models. */
export async function listRadars(): Promise<RadarConfig[]> {
  return fetchJSON<RadarConfig[]>("/api/radars", { method: "GET" });
}

/** Get a specific radar model configuration. */
export async function getRadar(modelId: string): Promise<RadarConfig> {
  return fetchJSON<RadarConfig>(
    `/api/radars/${encodeURIComponent(modelId)}`,
    { method: "GET" },
  );
}

// ────────────────────────────────────────────
// Export endpoints
// ────────────────────────────────────────────

/** Export analysis as PDF. Returns a Blob. */
export async function exportPDF(req: LOSRequest): Promise<Blob> {
  const response = await fetch(`${baseUrl}/api/export/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    return extractError(response);
  }
  return response.blob();
}

/** Export analysis data as CSV. Returns a Blob. */
export async function exportCSV(req: LOSRequest): Promise<Blob> {
  const response = await fetch(`${baseUrl}/api/export/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    return extractError(response);
  }
  return response.blob();
}
