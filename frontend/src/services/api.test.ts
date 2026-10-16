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
  releaseLOSJob,
  cancelLOSAnalysis,
  activateTerrain,
  releaseTerrain,
  listRadars,
  getRadar,
  exportPDF,
  exportCSV,
  setApiBaseUrl,
  runSensitivityAnalysis,
  cancelSensitivityAnalysis,
  releaseSensitivityJob,
} from "./api";
import { clearLocalTerrainCache, getLocalTerrain, getLocalTerrainCacheSize, saveLocalTerrain } from "./localDataStore";
import * as persistentTerrainDataStore from "./localDataStore";
import type { AnalysisSnapshot, DTMMetadata, LOSRequest, LOSResponse, RadarConfig, SensitivityMapRequest, SensitivityMapResponse, SensitivityObservation } from "../types/api";
import { LOSCellState } from "../types/api";
import * as api from "./api";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

// ────────────────────────────────────────────
// Global Mock Worker Setup
// ────────────────────────────────────────────

class MockWorker implements Worker {
  url: URL | string;
  options?: WorkerOptions;
  onmessage: ((ev: MessageEvent) => any) | null = null;
  onerror: ((ev: ErrorEvent) => any) | null = null;
  onmessageerror: ((ev: MessageEvent) => any) | null = null;

  static instances: MockWorker[] = [];
  static mockResponses: any[] = [];
  static constructionError: Error | null = null;
  static postMessageError: Error | null = null;
  postedMessages: any[] = [];
  terminateCalls = 0;

  constructor(url: URL | string, options?: WorkerOptions) {
    if (MockWorker.constructionError) throw MockWorker.constructionError;
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }

  postMessage(message: any): void {
    this.postedMessages.push(message);
    if (MockWorker.postMessageError) throw MockWorker.postMessageError;
    const response = MockWorker.mockResponses.shift();
    // Simulate async execution using setTimeout
    setTimeout(() => {
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
    this.terminateCalls++;
  }

  addEventListener<K extends keyof WorkerEventMap>(
    _type: K,
    _listener: (this: Worker, ev: WorkerEventMap[K]) => any,
    _options?: boolean | AddEventListenerOptions
  ): void {}

  removeEventListener<K extends keyof WorkerEventMap>(
    _type: K,
    _listener: (this: Worker, ev: WorkerEventMap[K]) => any,
    _options?: boolean | EventListenerOptions
  ): void {}

  dispatchEvent(_event: Event): boolean {
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
  MockWorker.constructionError = null;
  MockWorker.postMessageError = null;
  clearLocalTerrainCache();
  vi.clearAllMocks();
});

afterEach(() => {
  // Clear any global mock restoration
});

// Helper for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function resetTerrainStores() {
  useTerrainStore.setState({
    metadata: null,
    grid: null,
    terrainKey: null,
    terrainEpoch: 0,
    loading: false,
    error: null,
  });
  useAnalysisStore.setState({
    terrainKey: null,
    terrainTransitioning: false,
    losResult: null,
    activeSnapshot: null,
    history: [],
    deployedRadars: [],
    unifiedLos: null,
    loading: false,
    multiLoading: false,
    error: null,
  });
}

function installActiveTerrain() {
  const metadata: DTMMetadata = {
    terrain_id: "active-terrain-for-import-lifecycle",
    bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
    resolution: 1,
    grid_rows: 1,
    grid_cols: 1,
  };
  const grid = [[7]];
  saveLocalTerrain({ metadata, grid });
  activateTerrain(metadata.terrain_id);
  return { metadata, grid };
}

async function captureRadarConfig(
  radarModelId: string,
  azimuth: Pick<LOSRequest, "az_center_deg" | "az_width_deg"> = {}
): Promise<RadarConfig> {
  const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
  const job = await runLOSAnalysis({
    terrain_id: terrain.terrain_id,
    radar_position: { x: 10, y: 10, z: 5 },
    radar_model_id: radarModelId,
    ...azimuth,
  });
  const config = MockWorker.instances[MockWorker.instances.length - 1]!.postedMessages[0].radar_config as RadarConfig;
  cancelLOSAnalysis(job.job_id);
  releaseTerrain(terrain.terrain_id);
  return config;
}

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

    expect(result).toMatchObject({
      ...expectedMetadata,
      terrain_id: expect.stringMatching(/^terrain-dxf-import-/),
    });
    expect(result.terrain_id).not.toBe(expectedMetadata.terrain_id);
    expect(MockWorker.instances).toHaveLength(1);
    
    // Verify it was saved to local store
    const cached = await getTerrainGrid(result.terrain_id);
    expect(cached.metadata).toEqual(result);
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

    expect(result).toMatchObject({
      ...expectedMetadata,
      terrain_id: expect.stringMatching(/^terrain-stl-import-/),
    });
    expect(result.terrain_id).not.toBe(expectedMetadata.terrain_id);
    expect(MockWorker.instances).toHaveLength(1);

    const cached = await getTerrainGrid(result.terrain_id);
    expect(cached.metadata).toEqual(result);
    expect(cached.grid).toEqual([[5, 6], [7, 8]]);
  });

  it("rejects with custom error from worker failure", async () => {
    MockWorker.mockResponses.push({
      error: "No valid triangles found in STL file",
    });

    const file = new File(["bad"], "bad.stl", { type: "application/octet-stream" });
    await expect(uploadSTL(file)).rejects.toThrow("No valid triangles found in STL file");
    expect(getLocalTerrainCacheSize()).toBe(0);
  });

  it("rejects and terminates the terrain Worker when postMessage throws synchronously", async () => {
    MockWorker.postMessageError = new Error("postMessage unavailable");
    const file = new File(["bad"], "bad.stl", { type: "application/octet-stream" });

    await expect(uploadSTL(file)).rejects.toThrow("postMessage unavailable");
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0]!.terminateCalls).toBe(1);
    expect(MockWorker.instances[0]!.onmessage).toBeNull();
    expect(MockWorker.instances[0]!.onerror).toBeNull();
    expect(getLocalTerrainCacheSize()).toBe(0);
  });

  it("does not cache a queued success after an import worker error or disturb an active grid or LOS job", async () => {
    const active = installActiveTerrain();
    const job = await runLOSAnalysis({
      terrain_id: active.metadata.terrain_id,
      radar_position: { x: 0, y: 0, z: 1 },
      radar_model_id: "ibis-arcsar360",
    });
    const losWorker = MockWorker.instances[0]!;
    const importPromise = uploadSTL(new File(["bad"], "broken.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
    const importWorker = MockWorker.instances[1]!;
    const queuedSuccess = importWorker.onmessage;

    importWorker.onerror?.({ message: "STL worker crashed" } as ErrorEvent);
    await expect(importPromise).rejects.toThrow("Worker error: STL worker crashed");

    expect(importWorker.onmessage).toBeNull();
    expect(importWorker.onerror).toBeNull();
    expect(importWorker.terminateCalls).toBe(1);
    expect(getLocalTerrainCacheSize()).toBe(1);

    queuedSuccess?.({
      data: {
        metadata: { ...active.metadata, terrain_id: "late-import" },
        grid: [[99]],
      },
    } as MessageEvent);

    expect(getLocalTerrain(active.metadata.terrain_id)?.grid).toBe(active.grid);
    expect(getLocalTerrainCacheSize()).toBe(1);
    expect(importWorker.terminateCalls).toBe(1);
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "PENDING" });
    expect(losWorker.terminateCalls).toBe(0);
    cancelLOSAnalysis(job.job_id);
  });

  it("keeps the first successful import when an error callback was already queued", async () => {
    const active = installActiveTerrain();
    const importPromise = uploadSTL(new File(["valid"], "valid.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    const queuedError = worker.onerror;
    const firstGrid = [[21]];
    const onmessage = worker.onmessage;

    onmessage?.({
      data: {
        metadata: { ...active.metadata, terrain_id: "successful-import" },
        grid: firstGrid,
      },
    } as MessageEvent);
    const imported = await importPromise;

    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.terminateCalls).toBe(1);
    expect(getLocalTerrain(imported.terrain_id)?.grid).toBe(firstGrid);
    expect(getLocalTerrainCacheSize()).toBe(2);

    queuedError?.({ message: "late worker error" } as ErrorEvent);

    expect(getLocalTerrain(imported.terrain_id)?.grid).toBe(firstGrid);
    expect(getLocalTerrain(active.metadata.terrain_id)?.grid).toBe(active.grid);
    expect(getLocalTerrainCacheSize()).toBe(2);
    expect(worker.terminateCalls).toBe(1);
  });

  it("ignores a second success message after the first import result", async () => {
    const active = installActiveTerrain();
    const importPromise = uploadSTL(new File(["valid"], "valid.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    const onmessage = worker.onmessage;
    const firstGrid = [[31]];

    onmessage?.({
      data: {
        metadata: { ...active.metadata, terrain_id: "first-import" },
        grid: firstGrid,
      },
    } as MessageEvent);
    const imported = await importPromise;
    onmessage?.({
      data: {
        metadata: { ...active.metadata, terrain_id: "duplicate-import" },
        grid: [[42]],
      },
    } as MessageEvent);

    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.terminateCalls).toBe(1);
    expect(getLocalTerrain(imported.terrain_id)?.grid).toBe(firstGrid);
    expect(getLocalTerrainCacheSize()).toBe(2);
    expect(getLocalTerrain(active.metadata.terrain_id)?.grid).toBe(active.grid);
  });

  it("treats the first error message as terminal and ignores a second worker error", async () => {
    const active = installActiveTerrain();
    const importPromise = uploadSTL(new File(["bad"], "broken.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0]!;
    const queuedError = worker.onerror;

    worker.onmessage?.({ data: { error: "invalid STL" } } as MessageEvent);
    await expect(importPromise).rejects.toThrow("invalid STL");
    queuedError?.({ message: "second worker error" } as ErrorEvent);

    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.terminateCalls).toBe(1);
    expect(getLocalTerrain(active.metadata.terrain_id)?.grid).toBe(active.grid);
    expect(getLocalTerrainCacheSize()).toBe(1);
  });

  it("rejects when the terrain Worker constructor throws synchronously", async () => {
    MockWorker.constructionError = new Error("constructor unavailable");
    const file = new File(["bad"], "bad.stl", { type: "application/octet-stream" });

    await expect(uploadSTL(file)).rejects.toThrow("constructor unavailable");
    expect(MockWorker.instances).toHaveLength(0);
    expect(getLocalTerrainCacheSize()).toBe(0);
  });
});

describe("terrain import identity", () => {
  const collidingWorkerMetadata: DTMMetadata = {
    terrain_id: "dtm-0-0-1",
    bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 0, max_y: 0, max_z: 20 },
    resolution: 1,
    grid_rows: 1,
    grid_cols: 1,
  };

  it("keeps C's grid, LOS, sensitivity, and export tied to C when B finishes last with the same worker ID", async () => {
    resetTerrainStores();
    const terrainA: DTMMetadata = { ...collidingWorkerMetadata, terrain_id: "terrain-A" };
    const keyA = { terrain_id: terrainA.terrain_id, epoch: 1 };
    useTerrainStore.setState({ metadata: terrainA, grid: [[5]], terrainKey: keyA, terrainEpoch: 1 });
    useAnalysisStore.getState().activateTerrain(keyA);

    const gridB = [[11]];
    const gridC = [[22]];
    const importB = useTerrainStore.getState().uploadSTL(new File(["B"], "terrain-B.stl"));
    const importC = useTerrainStore.getState().uploadSTL(new File(["C"], "terrain-C.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));

    const workerB = MockWorker.instances[0]!;
    const workerC = MockWorker.instances[1]!;
    workerC.onmessage?.({ data: { metadata: collidingWorkerMetadata, grid: gridC } } as MessageEvent);
    await importC;

    const activeC = useTerrainStore.getState();
    const terrainIdC = activeC.metadata!.terrain_id;
    const activeGridC = await getTerrainGrid(terrainIdC);
    expect.soft(activeC.grid).toEqual(gridC);
    expect.soft(activeC.terrainKey).toEqual({ terrain_id: terrainIdC, epoch: 2 });
    expect.soft(terrainIdC).not.toBe(collidingWorkerMetadata.terrain_id);
    expect.soft(activeGridC.grid).toEqual(gridC);

    workerB.onmessage?.({ data: { metadata: collidingWorkerMetadata, grid: gridB } } as MessageEvent);
    await importB;
    expect.soft(useTerrainStore.getState().metadata?.terrain_id).toBe(terrainIdC);
    expect.soft((await getTerrainGrid(terrainIdC)).grid).toEqual(gridC);
    expect.soft(useAnalysisStore.getState().terrainKey).toEqual(activeC.terrainKey);

    const losResult: LOSResponse = {
      shadow_grid: [[false]],
      cell_states: new Uint8Array([LOSCellState.VISIBLE]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 1,
      quality_grid: [[1]],
      coverage_pct: 100,
      completeness_pct: 100,
      visible_area_m2: 1,
      coverage_polygon: [],
      shadow_zones: [],
    };
    MockWorker.mockResponses.push(losResult);
    const losJob = await runLOSAnalysis({
      terrain_id: terrainIdC,
      radar_position: { x: 0, y: 0, z: 2 },
      radar_model_id: "ibis-arcsar360",
    });
    const losWorker = MockWorker.instances[2]!;
    await delay(10);
    expect.soft(losWorker.postedMessages[0]?.grid).toEqual(gridC);
    const completedLOS = await getLOSJob(losJob.job_id);
    expect.soft(completedLOS.result).toEqual(losResult);

    const currentKey = useTerrainStore.getState().terrainKey!;
    const exportSnapshot: AnalysisSnapshot = {
      terrainKey: { ...currentKey },
      analysisId: losJob.job_id,
      sourceAnalysisIds: [losJob.job_id],
      generation: 1,
      radars: [{
        radarId: "radar-C",
        radarModelId: "ibis-arcsar360",
        position: { x: 0, y: 0, z: 2 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
      }],
    };
    await exportCSV(exportSnapshot, completedLOS.result);
    expect.soft(generateCSVBlob).toHaveBeenCalledWith(exportSnapshot, losResult);

    const sensitivitySnapshot: AnalysisSnapshot = {
      ...exportSnapshot,
      analysisId: "analysis-C",
      sourceAnalysisIds: ["analysis-C"],
    };
    const sensitivityResponse: SensitivityMapResponse = {
      terrainKey: { ...currentKey },
      sourceAnalysisIds: ["analysis-C"],
      grid_rows: 1,
      grid_cols: 1,
      resolution: 1,
      flat_sensitivity_grid: new Float32Array([Number.NaN]),
      observer_count: new Uint16Array([0]),
    };
    MockWorker.mockResponses.push(sensitivityResponse);
    const sensitivityJob = await runSensitivityAnalysis({
      terrainKey: { ...currentKey },
      observations: [{
        analysisId: "analysis-C",
        snapshot: sensitivitySnapshot,
        grid_rows: 1,
        grid_cols: 1,
        resolution: 1,
        cell_states: new Uint8Array([LOSCellState.VISIBLE]),
      }],
    });
    await delay(10);
    const sensitivityWorker = MockWorker.instances[3]!;
    expect.soft(sensitivityWorker.postedMessages[0]?.grid).toEqual(gridC);
    expect.soft(await getLOSJob(sensitivityJob.job_id)).toMatchObject({ status: "COMPLETED", result: sensitivityResponse });
  });

  it("retains A while B's imported grid is provisional, then evicts A after B activates", async () => {
    resetTerrainStores();
    const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    await useTerrainStore.getState().loadGrid(terrainA.terrain_id);
    const gridA = getLocalTerrain(terrainA.terrain_id)!.grid;
    const importB = useTerrainStore.getState().uploadSTL(new File(["B"], "terrain-B.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    expect(useTerrainStore.getState()).toMatchObject({ metadata: terrainA, grid: gridA, loading: true });
    expect(getLocalTerrain(terrainA.terrain_id)?.grid).toBe(gridA);
    expect(getLocalTerrainCacheSize()).toBe(1);

    const metadataB: DTMMetadata = {
      terrain_id: "terrain-B-worker",
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
      resolution: 1,
      grid_rows: 1,
      grid_cols: 1,
    };
    MockWorker.instances[0]!.onmessage?.({ data: { metadata: metadataB, grid: [[99]] } } as MessageEvent);
    expect(getLocalTerrain(terrainA.terrain_id)?.grid).toBe(gridA);
    expect(getLocalTerrainCacheSize()).toBe(2);

    await importB;

    expect(useTerrainStore.getState()).toMatchObject({
      metadata: expect.objectContaining({ terrain_id: expect.stringContaining("terrain-B-worker") }),
      loading: false,
    });
    expect(getLocalTerrain(terrainA.terrain_id)).toBeUndefined();
    expect(getLocalTerrainCacheSize()).toBe(1);
  });

  it("evicts obsolete B when newer C fails, without evicting active A", async () => {
    resetTerrainStores();
    const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    await useTerrainStore.getState().loadGrid(terrainA.terrain_id);
    const gridA = getLocalTerrain(terrainA.terrain_id)!.grid;
    const importB = useTerrainStore.getState().uploadSTL(new File(["B"], "terrain-B.stl"));
    const importC = useTerrainStore.getState().uploadSTL(new File(["C"], "terrain-C.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));

    MockWorker.instances[1]!.onmessage?.({ data: { error: "terrain C failed" } } as MessageEvent);
    await importC;
    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainA,
      grid: gridA,
      loading: false,
      error: "terrain C failed",
    });

    const metadataB: DTMMetadata = {
      terrain_id: "terrain-B-worker",
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
      resolution: 1,
      grid_rows: 1,
      grid_cols: 1,
    };
    MockWorker.instances[0]!.onmessage?.({ data: { metadata: metadataB, grid: [[99]] } } as MessageEvent);
    await importB;

    expect(getLocalTerrain(terrainA.terrain_id)?.grid).toBe(gridA);
    expect(getLocalTerrain(metadataB.terrain_id)).toBeUndefined();
    expect(getLocalTerrainCacheSize()).toBe(1);
    expect(useTerrainStore.getState()).toMatchObject({ metadata: terrainA, grid: gridA, loading: false });
  });

  it("keeps active A and its grid when B import fails before entering the cache", async () => {
    resetTerrainStores();
    const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    await useTerrainStore.getState().loadGrid(terrainA.terrain_id);
    const activeA = useTerrainStore.getState();
    const gridA = activeA.grid;
    const keyA = activeA.terrainKey;
    MockWorker.mockResponses.push({ error: "terrain B import failed" });

    await useTerrainStore.getState().uploadSTL(new File(["bad"], "terrain-B.stl"));

    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainA,
      grid: gridA,
      terrainKey: keyA,
      loading: false,
      error: "terrain B import failed",
    });
    expect(getLocalTerrain(terrainA.terrain_id)).toBeDefined();
    expect(getLocalTerrainCacheSize()).toBe(1);
  });

  it("evicts the previous grid after sequential imports activate a new terrain while preserving snapshot identity", async () => {
    resetTerrainStores();
    const gridA = [[31]];
    const gridB = [[47]];
    MockWorker.mockResponses.push(
      { metadata: collidingWorkerMetadata, grid: gridA },
      { metadata: collidingWorkerMetadata, grid: gridB },
    );

    const metadataA = await uploadSTL(new File(["A"], "terrain-A.stl"));
    await useTerrainStore.getState().loadGrid(metadataA.terrain_id);
    const oldSnapshotKey = useTerrainStore.getState().terrainKey!;

    await useTerrainStore.getState().uploadSTL(new File(["B"], "terrain-B.stl"));
    const activeB = useTerrainStore.getState();
    const metadataB = activeB.metadata!;

    expect.soft(metadataB.terrain_id).not.toBe(metadataA.terrain_id);
    expect.soft(activeB.terrainKey).not.toEqual(oldSnapshotKey);
    expect.soft(getLocalTerrainCacheSize()).toBe(1);
    expect.soft(getLocalTerrain(metadataA.terrain_id)).toBeUndefined();
    expect.soft(getLocalTerrain(metadataB.terrain_id)?.grid).toEqual(gridB);
  });

  it("keeps import IDs unique when api.ts is re-evaluated while its terrain cache remains alive", async () => {
    const gridA = [[61]];
    const gridB = [[83]];
    const workerMetadata: DTMMetadata = {
      ...collidingWorkerMetadata,
      terrain_id: "dtm-0-0-1",
    };
    const importA = uploadSTL(new File(["A"], "terrain-A.stl"));
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));

    vi.doMock("./localDataStore", () => persistentTerrainDataStore);
    vi.resetModules();
    try {
      const reloadedApi = await import("./api");
      const importB = reloadedApi.uploadSTL(new File(["B"], "terrain-B.stl"));
      await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));

      MockWorker.instances[1]!.onmessage?.({ data: { metadata: workerMetadata, grid: gridB } } as MessageEvent);
      const metadataB = await importB;
      MockWorker.instances[0]!.onmessage?.({ data: { metadata: workerMetadata, grid: gridA } } as MessageEvent);
      const metadataA = await importA;

      expect(metadataA.terrain_id).not.toBe(metadataB.terrain_id);
      expect(persistentTerrainDataStore.getLocalTerrain(metadataA.terrain_id)?.grid).toEqual(gridA);
      expect(persistentTerrainDataStore.getLocalTerrain(metadataB.terrain_id)?.grid).toEqual(gridB);
      expect(MockWorker.instances[0]!.terminateCalls).toBe(1);
      expect(MockWorker.instances[1]!.terminateCalls).toBe(1);
    } finally {
      vi.doUnmock("./localDataStore");
      vi.resetModules();
    }
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
    expect(result.grid_rows).toBe(101);
    expect(result.grid_cols).toBe(101);

    const cached = await getTerrainGrid(result.terrain_id);
    expect(cached.metadata).toEqual(result);
    expect(cached.grid).toHaveLength(101);
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

  it("rejects oversized cached terrain metadata before creating a LOS job", async () => {
    const metadata: DTMMetadata = {
      terrain_id: "oversized-cache",
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
      resolution: 1,
      grid_rows: 2,
      grid_cols: 2_097_152,
    };
    saveLocalTerrain({ metadata, grid: [[0, 0], [0, 0]] });

    await expect(runLOSAnalysis({
      terrain_id: metadata.terrain_id,
      radar_position: { x: 0, y: 0, z: 1 },
      radar_model_id: "ibis-arcsar360",
    })).rejects.toThrow(/dimension|maximum/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("marks a job failed when the Worker constructor throws synchronously", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    MockWorker.constructionError = new Error("constructor unavailable");

    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });

    expect(job.status).toBe("FAILED");
    expect((await getLOSJob(job.job_id))).toMatchObject({
      status: "FAILED",
      error: "constructor unavailable",
    });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("marks a job failed and terminates its Worker when postMessage throws synchronously", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    MockWorker.postMessageError = new Error("postMessage unavailable");

    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });

    expect(job.status).toBe("FAILED");
    expect((await getLOSJob(job.job_id))).toMatchObject({
      status: "FAILED",
      error: "postMessage unavailable",
    });
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0]!.terminateCalls).toBe(1);
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

  it("retains a completed LOS result until explicit release", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    const result = {
      cell_states: new Uint8Array([5]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 2,
      coverage_pct: 100,
      completeness_pct: 100,
      visible_area_m2: 4,
      coverage_polygon: [],
      shadow_zones: [],
    };
    MockWorker.mockResponses.push(result);

    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });
    await delay(10);

    const consumed = await getLOSJob(job.job_id);
    expect(consumed).toMatchObject({ status: "COMPLETED", result });
    releaseLOSJob(job.job_id);
    await expect(getLOSJob(job.job_id)).rejects.toThrow("Job not found");
  });

  it("cancels an LOS job idempotently and fences off its late worker message", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });
    const worker = MockWorker.instances[0]!;

    cancelLOSAnalysis(job.job_id);
    cancelLOSAnalysis(job.job_id);
    worker.onmessage?.({ data: { coverage_pct: 100 } } as MessageEvent);

    expect(worker.terminateCalls).toBe(1);
    await expect(getLOSJob(job.job_id)).rejects.toThrow("Job not found");
  });

  it("does not let sensitivity cancellation alter or stop a pending LOS job", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });
    const worker = MockWorker.instances[0]!;
    const result = { coverage_pct: 73 };

    cancelSensitivityAnalysis(job.job_id);

    expect(worker.terminateCalls).toBe(0);
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "PENDING" });
    worker.onmessage?.({ data: result } as MessageEvent);

    expect(worker.terminateCalls).toBe(1);
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "COMPLETED", result });
  });

  it("inflates legacy grids from cell states so only SHADOW is marked shadowed", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    const cellStates = new Uint8Array([0, 4, 3, 5, 0, 0, 0, 0, 0]);
    MockWorker.mockResponses.push({
      cell_states: cellStates,
      grid_rows: 3,
      grid_cols: 3,
      resolution: 2,
      coverage_pct: 25,
      completeness_pct: 50,
      visible_area_m2: 4,
      shadow_zones: [{ zone_id: 1, cell_count: 1 }],
      flat_quality_grid: new Float32Array([-1, -1, -1, 0.8, -1, -1, -1, -1, -1]),
    });

    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });
    await delay(10);
    const status = await getLOSJob(job.job_id);

    expect(status.result).toMatchObject({
      cell_states: cellStates,
      grid_rows: 3,
      grid_cols: 3,
      resolution: 2,
      coverage_pct: 25,
      completeness_pct: 50,
      shadow_grid: [[false, true, false], [false, false, false], [false, false, false]],
    });
    expect((status.result as any).quality_grid[1][0]).toBeCloseTo(0.8);
  });
});

describe("LOS range and elevation overrides", () => {
  it.each([
    ["NaN minimum range", { range_min_m: Number.NaN }],
    ["infinite minimum range", { range_min_m: Number.POSITIVE_INFINITY }],
    ["NaN maximum range", { range_max_m: Number.NaN }],
    ["infinite maximum range", { range_max_m: Number.POSITIVE_INFINITY }],
    ["NaN minimum elevation", { el_min_deg: Number.NaN }],
    ["infinite minimum elevation", { el_min_deg: Number.POSITIVE_INFINITY }],
    ["NaN maximum elevation", { el_max_deg: Number.NaN }],
    ["infinite maximum elevation", { el_max_deg: Number.POSITIVE_INFINITY }],
  ])("rejects %s before starting a Worker", async (_label, overrides) => {
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });

    await expect(runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 10, y: 10, z: 5 },
      radar_model_id: "groundprobe-ssr-fx",
      ...overrides,
    })).rejects.toThrow(/range|elevation/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it.each([
    ["negative minimum range", { range_min_m: -1 }],
    ["minimum range above the default maximum", { range_min_m: 2501 }],
    ["maximum range below the default minimum", { range_max_m: 49 }],
    ["minimum elevation below -90°", { el_min_deg: -91 }],
    ["maximum elevation above 90°", { el_max_deg: 91 }],
    ["minimum elevation above maximum", { el_min_deg: 10, el_max_deg: 0 }],
  ])("rejects %s before starting a Worker", async (_label, overrides) => {
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });

    await expect(runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 10, y: 10, z: 5 },
      radar_model_id: "groundprobe-ssr-fx",
      ...overrides,
    })).rejects.toThrow(/range|elevation/i);
    expect(MockWorker.instances).toHaveLength(0);
  });
});

describe("azimuth sectors", () => {
  it.each([0, 30])(
    "treats an explicit 360° aperture centered at %i° as full-circle coverage",
    async (center) => {
      const radarConfig = await captureRadarConfig("groundprobe-ssr-fx", {
        az_center_deg: center,
        az_width_deg: 360,
      });

      expect(radarConfig.azimuth_range_deg).toBeNull();
    }
  );

  it.each([
    [170, 40, [150, -170]],
    [-170, 40, [170, -150]],
  ] as const)("wraps sector edges across ±180° for center %i°", async (center, width, expected) => {
    const radarConfig = await captureRadarConfig("groundprobe-ssr-fx", {
      az_center_deg: center,
      az_width_deg: width,
    });

    expect(radarConfig.azimuth_range_deg).toEqual(expected);
  });

  it("normalizes a huge finite center and full-circle width without an unbounded loop", () => {
    const normalize = (api as unknown as {
      normalizeAzimuthRange?: (center: number, width: number) => [number, number] | null;
    }).normalizeAzimuthRange;
    expect(normalize).toBeTypeOf("function");
    if (!normalize) return;

    expect(normalize(1e20, 60)).toEqual([-110, -50]);
    expect(normalize(30, 1e20)).toBeNull();
  });

  it.each([
    ["NaN center", Number.NaN, 60],
    ["infinite center", Number.POSITIVE_INFINITY, 60],
    ["NaN width", 0, Number.NaN],
    ["infinite width", 0, Number.POSITIVE_INFINITY],
    ["zero width", 0, 0],
    ["negative width", 0, -1],
  ])("rejects %s before sector normalization", (_label, center, width) => {
    const normalize = (api as unknown as {
      normalizeAzimuthRange?: (center: number, width: number) => [number, number] | null;
    }).normalizeAzimuthRange;
    expect(normalize).toBeTypeOf("function");
    if (!normalize) return;

    expect(() => normalize(center, width)).toThrow(/azimuth/i);
  });

  it.each([
    ["NaN center", { az_center_deg: Number.NaN }],
    ["NaN width", { az_width_deg: Number.NaN }],
  ])("rejects invalid %s before starting a Worker", async (_label, azimuth) => {
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });

    await expect(runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 10, y: 10, z: 5 },
      radar_model_id: "groundprobe-ssr-fx",
      ...azimuth,
    })).rejects.toThrow(/azimuth/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("keeps the SAR360 model unchanged when no azimuth override is supplied", async () => {
    const radarConfig = await captureRadarConfig("ibis-arcsar360");

    expect(radarConfig.scan_pattern).toBe("SAR360");
    expect(radarConfig.azimuth_range_deg).toBeNull();
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

const sensitivityTerrainKey = { terrain_id: "terrain-sensitivity-api", epoch: 5 } as const;
const sensitivityTerrainMetadata: DTMMetadata = {
  terrain_id: sensitivityTerrainKey.terrain_id,
  bounds: { min_x: 10, min_y: 20, min_z: 0, max_x: 16, max_y: 22, max_z: 10 },
  resolution: 2,
  grid_rows: 2,
  grid_cols: 3,
};

function installSensitivityTerrain(grid: number[][] = [[1, 2, 3], [4, 5, 6]]) {
  saveLocalTerrain({
    metadata: {
      ...sensitivityTerrainMetadata,
      grid_rows: grid.length,
      grid_cols: grid[0]?.length ?? 0,
    },
    grid,
  });
}

function makeSensitivityObservation(
  analysisId = "analysis-sensitivity-api",
  cellStates = [LOSCellState.VISIBLE, LOSCellState.SHADOW, LOSCellState.NODATA, LOSCellState.UNKNOWN_RAY, LOSCellState.OUT_OF_RANGE, LOSCellState.OUTSIDE_FOV],
  overrides: Partial<Pick<SensitivityObservation, "grid_rows" | "grid_cols" | "resolution" | "snapshot">> = {},
): SensitivityObservation {
  const snapshot: AnalysisSnapshot = overrides.snapshot ?? {
    terrainKey: sensitivityTerrainKey,
    analysisId,
    sourceAnalysisIds: [analysisId],
    generation: 8,
    radars: [{
      radarId: `radar-${analysisId}`,
      radarModelId: "groundprobe-ssr-fx",
      position: { x: 10, y: 20, z: 15 },
      overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
    }],
  };
  return {
    analysisId,
    snapshot,
    grid_rows: overrides.grid_rows ?? 2,
    grid_cols: overrides.grid_cols ?? 3,
    resolution: overrides.resolution ?? 2,
    cell_states: new Uint8Array(cellStates),
  };
}

const sensitivityResponse = (): SensitivityMapResponse => ({
  terrainKey: sensitivityTerrainKey,
  sourceAnalysisIds: ["analysis-sensitivity-api"],
  grid_rows: 2,
  grid_cols: 3,
  resolution: 2,
  flat_sensitivity_grid: new Float32Array([0.5, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
  observer_count: new Uint16Array([1, 0, 0, 0, 0, 0]),
});

const sensitivityRequest = (observation = makeSensitivityObservation()): SensitivityMapRequest => ({
  terrainKey: sensitivityTerrainKey,
  observations: [observation],
});

function noDataSensitivityResponse(sourceAnalysisIds: string[], rows: number, cols: number): SensitivityMapResponse {
  return {
    terrainKey: sensitivityTerrainKey,
    sourceAnalysisIds,
    grid_rows: rows,
    grid_cols: cols,
    resolution: 2,
    flat_sensitivity_grid: new Float32Array(rows * cols).fill(Number.NaN),
    observer_count: new Uint16Array(rows * cols),
  };
}

describe("runSensitivityAnalysis", () => {
  it("accepts a finite VISIBLE cell with no computable gradient as no-data", async () => {
    const isolated = [[Number.NaN, Number.NaN, Number.NaN], [Number.NaN, 5, Number.NaN], [Number.NaN, Number.NaN, Number.NaN]];
    installSensitivityTerrain(isolated);
    const states = new Array(9).fill(0);
    states[4] = LOSCellState.VISIBLE;
    const observation = makeSensitivityObservation("analysis-isolated", states, { grid_rows: 3, grid_cols: 3 });
    const response = noDataSensitivityResponse([observation.analysisId], 3, 3);
    MockWorker.mockResponses.push(response);

    const job = await runSensitivityAnalysis({ terrainKey: sensitivityTerrainKey, observations: [observation] });
    await delay(10);

    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "COMPLETED", result: response });
  });

  it("does not count two VISIBLE analyses when their finite cell has no gradient", async () => {
    installSensitivityTerrain([[Number.NaN, Number.NaN, Number.NaN], [Number.NaN, 5, Number.NaN], [Number.NaN, Number.NaN, Number.NaN]]);
    const states = new Array(9).fill(0);
    states[4] = LOSCellState.VISIBLE;
    const observations = [
      makeSensitivityObservation("analysis-isolated-one", states, { grid_rows: 3, grid_cols: 3 }),
      makeSensitivityObservation("analysis-isolated-two", states, { grid_rows: 3, grid_cols: 3 }),
    ];
    const response = noDataSensitivityResponse(observations.map((observation) => observation.analysisId), 3, 3);
    MockWorker.mockResponses.push(response);

    const job = await runSensitivityAnalysis({ terrainKey: sensitivityTerrainKey, observations });
    await delay(10);

    const status = await getLOSJob(job.job_id);
    expect(status.status).toBe("COMPLETED");
    expect((status.result as SensitivityMapResponse).observer_count[4]).toBe(0);
    expect(Number.isNaN((status.result as SensitivityMapResponse).flat_sensitivity_grid[4])).toBe(true);
  });

  it("accepts a one-sided boundary gradient while passing individual masks and provenance to the worker", async () => {
    installSensitivityTerrain();
    const expected = sensitivityResponse();
    MockWorker.mockResponses.push(expected);

    const job = await runSensitivityAnalysis(sensitivityRequest());
    await delay(10);
    const posted = MockWorker.instances[0]!.postedMessages[0] as any;
    const status = await getLOSJob(job.job_id);

    expect(posted.type).toBe("SENSITIVITY");
    expect(posted.terrainKey).toEqual(sensitivityTerrainKey);
    expect(posted.grid_rows).toBe(2);
    expect(posted.grid_cols).toBe(3);
    expect(posted.resolution).toBe(2);
    expect(posted.observations[0]).toMatchObject({
      analysisId: "analysis-sensitivity-api",
      snapshot: { terrainKey: sensitivityTerrainKey, radars: [{ radarId: "radar-analysis-sensitivity-api", position: { x: 10, y: 20, z: 15 } }] },
      grid_rows: 2,
      grid_cols: 3,
      resolution: 2,
    });
    expect(posted.observations[0].cell_states).toEqual(new Uint8Array([5, 4, 0, 3, 1, 2]));
    expect(status.status).toBe("COMPLETED");
    expect(status.result).toEqual(expected);
    expect(status.result).not.toHaveProperty("sensitivityGrid");
    expect(MockWorker.instances[0]!.terminateCalls).toBe(1);
  });

  it("rejects a stale terrain key and same-ID old epochs before creating a worker", async () => {
    installSensitivityTerrain();
    const stale = makeSensitivityObservation("analysis-old", [LOSCellState.VISIBLE], {
      grid_rows: 2,
      grid_cols: 3,
      snapshot: {
        ...makeSensitivityObservation("analysis-old").snapshot,
        terrainKey: { terrain_id: sensitivityTerrainKey.terrain_id, epoch: sensitivityTerrainKey.epoch - 1 },
      },
    });

    await expect(runSensitivityAnalysis(sensitivityRequest(stale))).rejects.toThrow(/terrain/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it.each([
    ["row count", { grid_rows: 1 }],
    ["column count", { grid_cols: 2 }],
    ["resolution", { resolution: 1 }],
  ])("rejects mismatched observation %s before creating a worker", async (_label, overrides) => {
    installSensitivityTerrain();
    await expect(runSensitivityAnalysis(sensitivityRequest(makeSensitivityObservation("bad-dimensions", [5, 0, 0, 0, 0, 0], overrides))))
      .rejects.toThrow(/dimension|resolution|grid/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("rejects cell-state arrays whose length does not match the active rectangular grid", async () => {
    installSensitivityTerrain();
    await expect(runSensitivityAnalysis(sensitivityRequest(makeSensitivityObservation("short-mask", [5, 0]))))
      .rejects.toThrow(/cell-state|length|dimension/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("rejects a ragged cached terrain grid before creating a worker", async () => {
    installSensitivityTerrain([[1, 2, 3], [4, 5]]);
    await expect(runSensitivityAnalysis(sensitivityRequest())).rejects.toThrow(/grid|dimension/i);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("marks a job failed when the Worker constructor throws synchronously", async () => {
    installSensitivityTerrain();
    MockWorker.constructionError = new Error("constructor unavailable");

    const job = await runSensitivityAnalysis(sensitivityRequest());

    expect(job.status).toBe("FAILED");
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED", error: "constructor unavailable" });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("marks a job failed and terminates its Worker when postMessage throws", async () => {
    installSensitivityTerrain();
    MockWorker.postMessageError = new Error("postMessage unavailable");

    const job = await runSensitivityAnalysis(sensitivityRequest());

    expect(job.status).toBe("FAILED");
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED", error: "postMessage unavailable" });
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0]!.terminateCalls).toBe(1);
  });

  it("keeps a sensitivity job queryable until it is terminal", async () => {
    installSensitivityTerrain();
    const job = await runSensitivityAnalysis(sensitivityRequest());

    releaseSensitivityJob(job.job_id);

    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "PENDING" });
  });

  it("cancels a sensitivity job by deleting its registry and fencing off its late message", async () => {
    installSensitivityTerrain();
    const job = await runSensitivityAnalysis(sensitivityRequest());
    const worker = MockWorker.instances[0]!;
    const lateMessage = worker.onmessage;
    cancelSensitivityAnalysis(job.job_id);
    cancelSensitivityAnalysis(job.job_id);

    lateMessage?.({ data: sensitivityResponse() } as MessageEvent);

    expect(worker.terminateCalls).toBe(1);
    await expect(getLOSJob(job.job_id)).rejects.toThrow("Job not found");
  });

  it("releases only the consumed sensitivity job and rejects late publication", async () => {
    installSensitivityTerrain();
    const resultA = sensitivityResponse();
    const resultB = sensitivityResponse();
    MockWorker.mockResponses.push(resultA);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const jobA = await runSensitivityAnalysis(sensitivityRequest());
    const workerA = MockWorker.instances[0]!;
    const lateMessageA = workerA.onmessage;
    const jobB = await runSensitivityAnalysis(sensitivityRequest());
    random.mockRestore();
    expect(jobA.job_id).not.toBe(jobB.job_id);
    const workerB = MockWorker.instances[1]!;
    const finishJobB = workerB.onmessage;
    await delay(10);

    expect(await getLOSJob(jobA.job_id)).toMatchObject({ status: "COMPLETED", result: resultA });
    expect(await getLOSJob(jobB.job_id)).toMatchObject({ status: "PENDING" });

    releaseSensitivityJob(jobA.job_id);
    lateMessageA?.({ data: sensitivityResponse() } as MessageEvent);

    await expect(getLOSJob(jobA.job_id)).rejects.toThrow("Job not found");
    expect(await getLOSJob(jobB.job_id)).toMatchObject({ status: "PENDING" });
    expect(workerB.terminateCalls).toBe(0);

    finishJobB?.({ data: resultB } as MessageEvent);
    expect(await getLOSJob(jobB.job_id)).toMatchObject({ status: "COMPLETED", result: resultB });
    releaseSensitivityJob(jobB.job_id);
    await expect(getLOSJob(jobB.job_id)).rejects.toThrow("Job not found");
  });

  it("releases a consumed sensitivity failure", async () => {
    installSensitivityTerrain();
    MockWorker.mockResponses.push({ error: "sensitivity worker failed" });
    const job = await runSensitivityAnalysis(sensitivityRequest());
    await delay(10);

    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED", error: "sensitivity worker failed" });
    releaseSensitivityJob(job.job_id);
    await expect(getLOSJob(job.job_id)).rejects.toThrow("Job not found");
  });

  it("does not let LOS release or cancellation APIs consume a sensitivity job", async () => {
    installSensitivityTerrain();
    const job = await runSensitivityAnalysis(sensitivityRequest());
    const worker = MockWorker.instances[0]!;

    releaseLOSJob(job.job_id);
    releaseSensitivityJob(job.job_id);
    cancelLOSAnalysis(job.job_id);

    expect(worker.terminateCalls).toBe(0);
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "PENDING" });
    worker.onmessage?.({ data: sensitivityResponse() } as MessageEvent);

    expect(worker.terminateCalls).toBe(1);
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "COMPLETED", result: sensitivityResponse() });
  });

  it("marks malformed worker buffers failed instead of publishing an invalid map", async () => {
    installSensitivityTerrain();
    MockWorker.mockResponses.push({ ...sensitivityResponse(), observer_count: new Uint16Array([1]) });
    const job = await runSensitivityAnalysis(sensitivityRequest());
    await delay(10);

    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED" });
  });

  it("rejects a missing contributor when both terrain-gradient axes are computable", async () => {
    installSensitivityTerrain();
    const invalid = sensitivityResponse();
    invalid.observer_count[0] = 0;
    invalid.flat_sensitivity_grid[0] = Number.NaN;
    MockWorker.mockResponses.push(invalid);
    const job = await runSensitivityAnalysis(sensitivityRequest());
    await delay(10);

    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED" });
  });

  it("rejects forged sensitivity count/value buffers and provenance", async () => {
    const forgedCount = sensitivityResponse();
    forgedCount.observer_count[0] = 2;
    const finiteNoData = sensitivityResponse();
    finiteNoData.flat_sensitivity_grid[1] = 0;
    const missingMeasuredValue = sensitivityResponse();
    missingMeasuredValue.flat_sensitivity_grid[0] = Number.NaN;
    const outOfRangeValue = sensitivityResponse();
    outOfRangeValue.flat_sensitivity_grid[0] = 1.1;
    const forgedProvenance = sensitivityResponse();
    forgedProvenance.sourceAnalysisIds = ["different-analysis"];

    installSensitivityTerrain();
    for (const invalid of [forgedCount, finiteNoData, missingMeasuredValue, outOfRangeValue, forgedProvenance]) {
      MockWorker.mockResponses.push(invalid);
      const job = await runSensitivityAnalysis(sensitivityRequest());
      await delay(10);
      expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED" });
    }
  });
});

// ────────────────────────────────────────────
// exportPDF / exportCSV
// ────────────────────────────────────────────

const exportSnapshotForApi: AnalysisSnapshot = Object.freeze({
  terrainKey: Object.freeze({ terrain_id: "terrain-custom", epoch: 4 }),
  analysisId: "job-export",
  sourceAnalysisIds: Object.freeze(["job-export"]),
  generation: 11,
  radars: Object.freeze([Object.freeze({
    radarId: "reutech-msr",
    radarModelId: "reutech-msr",
    position: Object.freeze({ x: 10, y: 20, z: 3 }),
    overrides: Object.freeze({ rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null }),
  })]),
});

describe("exportPDF", () => {
  it("does not export an earlier worker result without an explicit analysis result", async () => {
    const terrain = await generateSynthetic({ size_x: 2, size_y: 2, depth: 1, resolution: 2 });
    MockWorker.mockResponses.push({
      shadow_grid: [[false]],
      cell_states: new Uint8Array([5]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 2,
      coverage_pct: 100,
      completeness_pct: 100,
      visible_area_m2: 4,
      coverage_polygon: [],
      shadow_zones: [],
    });
    await runLOSAnalysis({ terrain_id: terrain.terrain_id, radar_position: { x: 1, y: 1, z: 2 }, radar_model_id: "reutech-msr" });
    await delay(10);

    await expect(exportPDF(exportSnapshotForApi)).rejects.toThrow("No analysis data available to export. Run LOS analysis first.");
  });

  it("delegates the explicit snapshot and result to exportEngine", async () => {
    const mockLOSResult = {
      shadow_grid: [[false]],
      cell_states: new Uint8Array([5]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 1,
      coverage_polygon: [],
      coverage_pct: 100.0,
      completeness_pct: 100.0,
      visible_area_m2: 1,
      shadow_zones: [],
    };

    const resultBlob = await exportPDF(exportSnapshotForApi, mockLOSResult);
    expect(resultBlob).toBeInstanceOf(Blob);
    expect(resultBlob.type).toBe("application/pdf");

    expect(generatePDFBlob).toHaveBeenCalledWith(exportSnapshotForApi, mockLOSResult);
  });
});

describe("exportCSV", () => {
  it("does not export an earlier worker result without an explicit analysis result", async () => {
    const terrain = await generateSynthetic({ size_x: 2, size_y: 2, depth: 1, resolution: 2 });
    MockWorker.mockResponses.push({
      shadow_grid: [[false]],
      cell_states: new Uint8Array([5]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 2,
      coverage_pct: 100,
      completeness_pct: 100,
      visible_area_m2: 4,
      coverage_polygon: [],
      shadow_zones: [],
    });
    await runLOSAnalysis({ terrain_id: terrain.terrain_id, radar_position: { x: 1, y: 1, z: 2 }, radar_model_id: "reutech-msr" });
    await delay(10);

    await expect(exportCSV(exportSnapshotForApi)).rejects.toThrow("No analysis data available to export. Run LOS analysis first.");
  });

  it("delegates the explicit snapshot and result to exportEngine", async () => {
    const mockLOSResult = {
      shadow_grid: [[false]],
      cell_states: new Uint8Array([5]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 1,
      coverage_polygon: [],
      coverage_pct: 100.0,
      completeness_pct: 100.0,
      visible_area_m2: 1,
      shadow_zones: [],
    };

    const resultBlob = await exportCSV(exportSnapshotForApi, mockLOSResult);
    expect(resultBlob).toBeInstanceOf(Blob);
    expect(resultBlob.type).toBe("text/csv");

    expect(generateCSVBlob).toHaveBeenCalledWith(exportSnapshotForApi, mockLOSResult);
  });

  it("exports an explicit consumed LOS result after releasing its job", async () => {
    const terrain = await generateSynthetic({ size_x: 2, size_y: 2, depth: 1, resolution: 2 });
    const result = {
      cell_states: new Uint8Array([5]),
      grid_rows: 1,
      grid_cols: 1,
      resolution: 2,
      coverage_pct: 100,
      completeness_pct: 100,
      visible_area_m2: 4,
      coverage_polygon: [],
      shadow_zones: [],
    };
    MockWorker.mockResponses.push(result);
    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 1, y: 1, z: 2 },
      radar_model_id: "reutech-msr",
    });
    await delay(10);
    const consumed = await getLOSJob(job.job_id);
    releaseLOSJob(job.job_id);

    const blob = await exportCSV(exportSnapshotForApi, consumed.result);

    expect(blob.type).toBe("text/csv");
    expect(generateCSVBlob).toHaveBeenCalledWith(exportSnapshotForApi, consumed.result);
    await expect(getLOSJob(job.job_id)).rejects.toThrow("Job not found");
  });
});

describe("terrain ownership and worker leases", () => {
  const losResult: LOSResponse = {
    shadow_grid: [[false]],
    cell_states: new Uint8Array([LOSCellState.VISIBLE]),
    grid_rows: 1,
    grid_cols: 1,
    resolution: 1,
    quality_grid: [[1]],
    coverage_pct: 100,
    completeness_pct: 100,
    visible_area_m2: 1,
    coverage_polygon: [],
    shadow_zones: [],
  };

  it("lets direct terrain-service callers release a provisional grid", async () => {
    const terrain = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    expect(getLocalTerrain(terrain.terrain_id)).toBeDefined();

    releaseTerrain(terrain.terrain_id);

    expect(getLocalTerrain(terrain.terrain_id)).toBeUndefined();
  });

  it("retains a leased LOS grid through completion and exports its historical snapshot after eviction", async () => {
    const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    activateTerrain(terrainA.terrain_id);
    const job = await runLOSAnalysis({
      terrain_id: terrainA.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });
    const worker = MockWorker.instances[0]!;

    const terrainB = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    activateTerrain(terrainB.terrain_id);
    expect(getLocalTerrain(terrainA.terrain_id)).toBeDefined();
    expect(getLocalTerrainCacheSize()).toBe(2);

    worker.onmessage?.({ data: losResult } as MessageEvent);
    const terminal = await getLOSJob(job.job_id);
    expect(terminal).toMatchObject({ status: "COMPLETED", result: losResult });
    expect(getLocalTerrain(terrainA.terrain_id)).toBeUndefined();
    expect(getLocalTerrainCacheSize()).toBe(1);

    const snapshot: AnalysisSnapshot = {
      terrainKey: { terrain_id: terrainA.terrain_id, epoch: 1 },
      analysisId: job.job_id,
      sourceAnalysisIds: [job.job_id],
      generation: 1,
      radars: [{
        radarId: "radar-A",
        radarModelId: "ibis-arcsar360",
        position: { x: 0, y: 0, z: 5 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
      }],
    };
    const exported = await exportCSV(snapshot, terminal.result as LOSResponse);
    expect(exported.type).toBe("text/csv");
    expect(generateCSVBlob).toHaveBeenCalledWith(snapshot, losResult);
  });

  it("retains a leased sensitivity grid through worker validation, without cross-kind cancellation releasing it", async () => {
    installSensitivityTerrain();
    activateTerrain(sensitivityTerrainKey.terrain_id);
    const job = await runSensitivityAnalysis(sensitivityRequest());
    const worker = MockWorker.instances[0]!;

    const terrainB = {
      metadata: { ...sensitivityTerrainMetadata, terrain_id: "terrain-after-sensitivity" },
      grid: [[7, 8, 9], [10, 11, 12]],
    };
    saveLocalTerrain(terrainB);
    activateTerrain(terrainB.metadata.terrain_id);
    cancelLOSAnalysis(job.job_id);
    releaseLOSJob(job.job_id);

    expect(getLocalTerrain(sensitivityTerrainKey.terrain_id)).toBeDefined();
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "PENDING" });

    worker.onmessage?.({ data: sensitivityResponse() } as MessageEvent);

    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "COMPLETED", result: sensitivityResponse() });
    expect(getLocalTerrain(sensitivityTerrainKey.terrain_id)).toBeUndefined();
    expect(getLocalTerrain(terrainB.metadata.terrain_id)).toBe(terrainB);
  });

  it.each(["constructor", "postMessage", "worker"] as const)(
    "releases an LOS lease after a %s failure",
    async (failure) => {
      const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
      activateTerrain(terrainA.terrain_id);
      if (failure === "constructor") MockWorker.constructionError = new Error("constructor unavailable");
      if (failure === "postMessage") MockWorker.postMessageError = new Error("postMessage unavailable");
      if (failure === "worker") MockWorker.mockResponses.push({ error: "worker failed" });

      const job = await runLOSAnalysis({
        terrain_id: terrainA.terrain_id,
        radar_position: { x: 0, y: 0, z: 5 },
        radar_model_id: "ibis-arcsar360",
      });
      const terrainB = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
      activateTerrain(terrainB.terrain_id);
      await delay(10);

      expect(getLocalTerrain(terrainA.terrain_id)).toBeUndefined();
      expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED" });
    },
  );

  it("does not release a pending LOS lease through sensitivity cancellation APIs", async () => {
    const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    activateTerrain(terrainA.terrain_id);
    const job = await runLOSAnalysis({
      terrain_id: terrainA.terrain_id,
      radar_position: { x: 0, y: 0, z: 5 },
      radar_model_id: "ibis-arcsar360",
    });
    const worker = MockWorker.instances[0]!;
    const terrainB = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    activateTerrain(terrainB.terrain_id);

    cancelSensitivityAnalysis(job.job_id);
    releaseSensitivityJob(job.job_id);
    expect(getLocalTerrain(terrainA.terrain_id)).toBeDefined();

    worker.onmessage?.({ data: losResult } as MessageEvent);

    expect(getLocalTerrain(terrainA.terrain_id)).toBeUndefined();
    expect(await getLOSJob(job.job_id)).toMatchObject({ status: "COMPLETED", result: losResult });
  });

  it.each(["constructor", "postMessage", "worker"] as const)(
    "releases a sensitivity lease after a %s failure",
    async (failure) => {
      installSensitivityTerrain();
      activateTerrain(sensitivityTerrainKey.terrain_id);
      if (failure === "constructor") MockWorker.constructionError = new Error("constructor unavailable");
      if (failure === "postMessage") MockWorker.postMessageError = new Error("postMessage unavailable");
      if (failure === "worker") MockWorker.mockResponses.push({ error: "sensitivity worker failed" });

      const job = await runSensitivityAnalysis(sensitivityRequest());
      const terrainB = {
        metadata: { ...sensitivityTerrainMetadata, terrain_id: `terrain-after-${failure}` },
        grid: [[7, 8, 9], [10, 11, 12]],
      };
      saveLocalTerrain(terrainB);
      activateTerrain(terrainB.metadata.terrain_id);
      await delay(10);

      expect(getLocalTerrain(sensitivityTerrainKey.terrain_id)).toBeUndefined();
      expect(await getLOSJob(job.job_id)).toMatchObject({ status: "FAILED" });
    },
  );

  it("releases a canceled sensitivity lease while preserving the terminal job registry contract", async () => {
    installSensitivityTerrain();
    activateTerrain(sensitivityTerrainKey.terrain_id);
    const job = await runSensitivityAnalysis(sensitivityRequest());
    const terrainB = {
      metadata: { ...sensitivityTerrainMetadata, terrain_id: "terrain-after-cancel" },
      grid: [[7, 8, 9], [10, 11, 12]],
    };
    saveLocalTerrain(terrainB);
    activateTerrain(terrainB.metadata.terrain_id);

    cancelSensitivityAnalysis(job.job_id);

    expect(getLocalTerrain(sensitivityTerrainKey.terrain_id)).toBeUndefined();
    await expect(getLOSJob(job.job_id)).rejects.toThrow("Job not found");
  });

  it("evicts nine stale grids from ten overlapping imports and keeps the latest terrain", async () => {
    resetTerrainStores();
    const terrainA = await generateSynthetic({ size_x: 4, size_y: 4, depth: 1, resolution: 2 });
    activateTerrain(terrainA.terrain_id);
    const keyA = { terrain_id: terrainA.terrain_id, epoch: 1 };
    useTerrainStore.setState({
      metadata: terrainA,
      grid: getLocalTerrain(terrainA.terrain_id)!.grid,
      terrainKey: keyA,
      terrainEpoch: 1,
    });
    useAnalysisStore.getState().activateTerrain(keyA);

    const imports = Array.from({ length: 10 }, (_, index) =>
      useTerrainStore.getState().uploadSTL(new File([String(index)], `terrain-${index}.stl`)),
    );
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(10));

    const workerMetadata: DTMMetadata = {
      terrain_id: "same-worker-id",
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
      resolution: 1,
      grid_rows: 1,
      grid_cols: 1,
    };
    MockWorker.instances[9]!.onmessage?.({ data: { metadata: workerMetadata, grid: [[99]] } } as MessageEvent);
    await imports[9];
    const latestId = useTerrainStore.getState().metadata!.terrain_id;
    expect(getLocalTerrainCacheSize()).toBe(1);

    for (let index = 0; index < 9; index++) {
      MockWorker.instances[index]!.onmessage?.({
        data: { metadata: workerMetadata, grid: [[index]] },
      } as MessageEvent);
      await imports[index];
      expect(useTerrainStore.getState().metadata?.terrain_id).toBe(latestId);
      expect(getLocalTerrainCacheSize()).toBe(1);
      expect(getLocalTerrain(latestId)?.grid).toEqual([[99]]);
    }
  });
});
