/**
 * Tests for the serverless local API client.
 *
 * These tests stub global Worker and isolated services to verify that
 * local Web Workers are launched with the correct parameters, jobs are
 * scheduled properly, and export engines are delegated to correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadDXF,
  uploadSTL,
  generateSynthetic,
  getTerrainGrid,
  runLOSAnalysis,
  getLOSJob,
  listRadars,
  getRadar,
  exportPDF,
  exportCSV,
  setApiBaseUrl,
  resetLastLOSResult,
} from "./api";
import { clearLocalTerrainCache } from "./localDataStore";
import type { DTMMetadata } from "../types/api";

// ────────────────────────────────────────────
// Global Mock Worker Setup
// ────────────────────────────────────────────

class MockWorker implements Worker {
  url: URL | string;
  options?: WorkerOptions;
  onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
  onerror: ((this: Worker, ev: ErrorEvent) => any) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => any) | null = null;

  static instances: MockWorker[] = [];
  static mockResponses: any[] = [];

  constructor(url: URL | string, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }

  postMessage(message: any): void {
    // Simulate async execution using setTimeout
    setTimeout(() => {
      const response = MockWorker.mockResponses.shift();
      if (response) {
        if (response.error) {
          if (this.onmessage) {
            this.onmessage({ data: { error: response.error } } as MessageEvent);
          }
        } else {
          if (this.onmessage) {
            this.onmessage({ data: response } as MessageEvent);
          }
        }
      }
    }, 0);
  }

  terminate(): void {
    // Terminate mock
  }

  addEventListener<K extends keyof WorkerEventMap>(
    type: K,
    listener: (this: Worker, ev: WorkerEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void {}

  removeEventListener<K extends keyof WorkerEventMap>(
    type: K,
    listener: (this: Worker, ev: WorkerEventMap[K]) => any,
    options?: boolean | EventListenerOptions
  ): void {}

  dispatchEvent(event: Event): boolean {
    return true;
  }
}

// Stub Worker globally in the test environment
vi.stubGlobal("Worker", MockWorker);

// Mock the export engine so we can assert parameters isolated from jsPDF/DOM rendering
vi.mock("./exportEngine", () => ({
  generatePDFBlob: vi.fn().mockImplementation(() => new Blob(["fake-pdf"], { type: "application/pdf" })),
  generateCSVBlob: vi.fn().mockImplementation(() => new Blob(["x,y,z\n1,2,3"], { type: "text/csv" })),
}));

import { generatePDFBlob, generateCSVBlob } from "./exportEngine";

beforeEach(() => {
  MockWorker.instances = [];
  MockWorker.mockResponses = [];
  clearLocalTerrainCache();
  resetLastLOSResult();
  vi.clearAllMocks();
});

afterEach(() => {
  // Clear any global mock restoration
});

// Helper for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ────────────────────────────────────────────
// API Configuration Tests
// ────────────────────────────────────────────

describe("setApiBaseUrl", () => {
  it("runs without throwing error in serverless environment", () => {
    expect(() => setApiBaseUrl("http://localhost:8000")).not.toThrow();
  });
});

// ────────────────────────────────────────────
// uploadDXF
// ────────────────────────────────────────────

describe("uploadDXF", () => {
  it("spawns Worker to process DXF and caches grid and metadata on success", async () => {
    const expectedMetadata: DTMMetadata = {
      terrain_id: "terrain-dxf",
      bounds: { min_x: 0, min_y: 0, min_z: -50, max_x: 100, max_y: 100, max_z: 10 },
      resolution: 2.0,
      grid_rows: 51,
      grid_cols: 51,
    };

    MockWorker.mockResponses.push({
      metadata: expectedMetadata,
      grid: [[1, 2], [3, 4]],
    });

    const file = new File(["dummy-dxf-content"], "test.dxf", { type: "application/dxf" });
    const result = await uploadDXF(file, 2.0);

    expect(result).toEqual(expectedMetadata);
    expect(MockWorker.instances).toHaveLength(1);
    
    // Verify it was saved to local store
    const cached = await getTerrainGrid("terrain-dxf");
    expect(cached.metadata).toEqual(expectedMetadata);
    expect(cached.grid).toEqual([[1, 2], [3, 4]]);
  });

  it("rejects with custom error from worker failure", async () => {
    MockWorker.mockResponses.push({
      error: "No elevation data in DXF",
    });

    const file = new File(["bad"], "bad.dxf", { type: "application/dxf" });
    await expect(uploadDXF(file)).rejects.toThrow("No elevation data in DXF");
  });
});

// ────────────────────────────────────────────
// uploadSTL
// ────────────────────────────────────────────

describe("uploadSTL", () => {
  it("spawns Worker to process STL and caches grid and metadata on success", async () => {
    const expectedMetadata: DTMMetadata = {
      terrain_id: "terrain-stl",
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 20, max_y: 20, max_z: 10 },
      resolution: 2.0,
      grid_rows: 11,
      grid_cols: 11,
    };

    MockWorker.mockResponses.push({
      metadata: expectedMetadata,
      grid: [[5, 6], [7, 8]],
    });

    const file = new File(["binary-stl-content"], "terrain.stl", { type: "application/octet-stream" });
    const result = await uploadSTL(file, 2.0);

    expect(result).toEqual(expectedMetadata);
    expect(MockWorker.instances).toHaveLength(1);

    const cached = await getTerrainGrid("terrain-stl");
    expect(cached.metadata).toEqual(expectedMetadata);
    expect(cached.grid).toEqual([[5, 6], [7, 8]]);
  });

  it("rejects with custom error from worker failure", async () => {
    MockWorker.mockResponses.push({
      error: "No valid triangles found in STL file",
    });

    const file = new File(["bad"], "bad.stl", { type: "application/octet-stream" });
    await expect(uploadSTL(file)).rejects.toThrow("No valid triangles found in STL file");
  });
});

// ────────────────────────────────────────────
// generateSynthetic
// ────────────────────────────────────────────

describe("generateSynthetic", () => {
  it("synchronously computes synthetic DTM and returns metadata and grid cache", async () => {
    const result = await generateSynthetic({
      size_x: 200,
      size_y: 200,
      depth: 30,
      resolution: 2.0,
    });

    expect(result.terrain_id).toContain("synthetic");
    expect(result.resolution).toBe(2.0);
    expect(result.grid_rows).toBe(100);
    expect(result.grid_cols).toBe(100);

    const cached = await getTerrainGrid(result.terrain_id);
    expect(cached.metadata).toEqual(result);
    expect(cached.grid).toHaveLength(100);
  });
});

// ────────────────────────────────────────────
// getTerrainGrid
// ────────────────────────────────────────────

describe("getTerrainGrid", () => {
  it("throws standard error on nonexistent terrain", async () => {
    await expect(getTerrainGrid("nonexistent")).rejects.toThrow("Terrain 'nonexistent' not found locally");
  });
});

// ────────────────────────────────────────────
// runLOSAnalysis
// ────────────────────────────────────────────

describe("runLOSAnalysis", () => {
  it("throws when terrain is not loaded", async () => {
    await expect(
      runLOSAnalysis({
        terrain_id: "missing-terrain",
        radar_position: { x: 0, y: 0, z: 0 },
        radar_model_id: "groundprobe-ssr-fx",
      })
    ).rejects.toThrow("Terrain not loaded");
  });

  it("throws when radar model ID is unknown", async () => {
    // Generate synthetic terrain first so it is cached
    const terrain = await generateSynthetic({ size_x: 100, size_y: 100, depth: 10 });
    
    await expect(
      runLOSAnalysis({
        terrain_id: terrain.terrain_id,
        radar_position: { x: 0, y: 0, z: 0 },
        radar_model_id: "unknown",
      })
    ).rejects.toThrow("Radar model not found");
  });

  it("schedules a job, launches Worker, and resolves results asynchronously", async () => {
    const terrain = await generateSynthetic({ size_x: 100, size_y: 100, depth: 10 });

    const mockLOSResult = {
      shadow_grid: [[false, true], [false, false]],
      coverage_polygon: [[0, 0], [100, 0], [100, 100], [0, 100]],
      coverage_pct: 75.0,
      visible_area_m2: 15000,
      shadow_zones: [{ zone_id: 1, cell_count: 1 }],
      quality_grid: [[0.9, 0.2], [1.0, 0.8]],
    };

    MockWorker.mockResponses.push(mockLOSResult);

    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 50, y: 50, z: 5 },
      radar_model_id: "groundprobe-ssr-fx",
    });

    expect(job.status).toBe("PENDING");
    expect(job.job_id).toContain("job-");

    // Initially pending
    let jobStatus = await getLOSJob(job.job_id);
    expect(jobStatus.status).toBe("PENDING");

    // Wait for the simulated worker thread message
    await delay(10);

    // Now completed
    jobStatus = await getLOSJob(job.job_id);
    expect(jobStatus.status).toBe("COMPLETED");
    expect(jobStatus.result).toEqual(mockLOSResult);
  });
});

// ────────────────────────────────────────────
// listRadars / getRadar
// ────────────────────────────────────────────

describe("listRadars", () => {
  it("returns hardcoded list of 3 radars", async () => {
    const list = await listRadars();
    expect(list).toHaveLength(3);
    expect(list[0]!.model_id).toBe("groundprobe-ssr-fx");
    expect(list[1]!.model_id).toBe("ibis-arcsar360");
    expect(list[2]!.model_id).toBe("reutech-msr");
  });
});

describe("getRadar", () => {
  it("retrieves the correct RadarConfig by ID", async () => {
    const radar = await getRadar("ibis-arcsar360");
    expect(radar.display_name).toBe("IBIS-ArcSAR360");
    expect(radar.manufacturer).toBe("IDS GeoRadar");
  });

  it("throws Radar not found for missing ID", async () => {
    await expect(getRadar("missing-radar")).rejects.toThrow("Radar not found");
  });
});

// ────────────────────────────────────────────
// exportPDF / exportCSV
// ────────────────────────────────────────────

describe("exportPDF", () => {
  it("throws error when no previous LOS result is available", async () => {
    await expect(
      exportPDF({
        terrain_id: "t1",
        radar_model_id: "groundprobe-ssr-fx",
        radar_position: { x: 0, y: 0, z: 0 },
      })
    ).rejects.toThrow("No analysis data available to export. Run LOS analysis first.");
  });

  it("delegates to exportEngine and returns Blob when customResult or cache exists", async () => {
    const mockLOSResult = {
      shadow_grid: [[false]],
      coverage_polygon: [],
      coverage_pct: 100.0,
      visible_area_m2: 100,
      shadow_zones: [],
    };

    const req = {
      terrain_id: "terrain-custom",
      radar_model_id: "reutech-msr",
      radar_position: { x: 10, y: 20, z: 3 },
    };

    const resultBlob = await exportPDF(req, mockLOSResult);
    expect(resultBlob).toBeInstanceOf(Blob);
    expect(resultBlob.type).toBe("application/pdf");

    expect(generatePDFBlob).toHaveBeenCalledWith(
      "terrain-custom",
      "reutech-msr",
      { x: 10, y: 20, z: 3 },
      mockLOSResult
    );
  });
});

describe("exportCSV", () => {
  it("throws error when no previous LOS result is available", async () => {
    await expect(
      exportCSV({
        terrain_id: "t1",
        radar_model_id: "groundprobe-ssr-fx",
        radar_position: { x: 0, y: 0, z: 0 },
      })
    ).rejects.toThrow("No analysis data available to export. Run LOS analysis first.");
  });

  it("delegates to exportEngine and returns Blob when customResult or cache exists", async () => {
    const mockLOSResult = {
      shadow_grid: [[false]],
      coverage_polygon: [],
      coverage_pct: 100.0,
      visible_area_m2: 100,
      shadow_zones: [],
    };

    const req = {
      terrain_id: "terrain-custom",
      radar_model_id: "reutech-msr",
      radar_position: { x: 10, y: 20, z: 3 },
    };

    const resultBlob = await exportCSV(req, mockLOSResult);
    expect(resultBlob).toBeInstanceOf(Blob);
    expect(resultBlob.type).toBe("text/csv");

    expect(generateCSVBlob).toHaveBeenCalledWith(
      "terrain-custom",
      "reutech-msr",
      { x: 10, y: 20, z: 3 },
      mockLOSResult
    );
  });
});
