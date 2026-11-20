/**
 * C1-c wiring of services/api.ts:
 * - the four Workers (terrain full import, terrain bounds preview, LOS, sensitivity) start from a
 *   `blob:` bootstrap that imports the Vite-emitted Worker module, so they inherit the CSP;
 * - the terrain file bytes are transferred (not copied) and never touched again on the main thread;
 * - the compute-engine selection is read once per message, so `engine` and `engine_explicit`
 *   always come from the same reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLOSAnalysis, cancelSensitivityAnalysis, generateSynthetic, previewTerrainBounds, releaseTerrain, runLOSAnalysis, runSensitivityAnalysis, uploadDXF, uploadSTL } from "./api";
import { getComputeEngineSelection } from "./computeEngine";
import { clearLocalTerrainCache, getLocalTerrain, saveLocalTerrain } from "./localDataStore";
import { LOSCellState, type DTMMetadata, type SensitivityObservation } from "../types/api";
import { workerBootstrapImport } from "./workerBootstrap.testSupport";
import terrainWorkerUrl from "../workers/terrainWorker.ts?worker&url";
import losWorkerUrl from "../workers/losWorker.ts?worker&url";
import vectorWorkerUrl from "../workers/vectorWorker.ts?worker&url";

vi.mock("./computeEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./computeEngine")>();
  return { ...actual, getComputeEngineSelection: vi.fn(actual.getComputeEngineSelection) };
});

/** Worker double whose postMessage really structured-clones with the transfer list. */
class TransferringWorker {
  static instances: TransferringWorker[] = [];
  static nextResponse: unknown = undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: { message: any; transfer: Transferable[] | undefined; received: any }[] = [];
  terminateCalls = 0;
  constructor(readonly url: URL | string, readonly options?: WorkerOptions) {
    TransferringWorker.instances.push(this);
  }
  postMessage(message: any, transfer?: Transferable[]): void {
    const received = structuredClone(message, { transfer: transfer ?? [] });
    this.posted.push({ message, transfer, received });
    const response = TransferringWorker.nextResponse;
    TransferringWorker.nextResponse = undefined;
    if (response !== undefined) setTimeout(() => this.onmessage?.({ data: response } as MessageEvent), 0);
  }
  terminate(): void {
    this.terminateCalls++;
  }
}

const originalUrl = window.location.href;

beforeEach(() => {
  TransferringWorker.instances = [];
  TransferringWorker.nextResponse = undefined;
  vi.stubGlobal("Worker", TransferringWorker);
  localStorage.clear();
  clearLocalTerrainCache();
  vi.mocked(getComputeEngineSelection).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", originalUrl);
});

const absolute = (url: string) => new URL(url, window.location.href).href;
const lastWorker = () => TransferringWorker.instances[TransferringWorker.instances.length - 1]!;

const importedMetadata: DTMMetadata = {
  terrain_id: "terrain-transfer",
  bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
  resolution: 1,
  grid_rows: 2,
  grid_cols: 2,
};
const boundsResponse = {
  mode: "bounds",
  source: "STL",
  pointCount: 3,
  bbox: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
  span: { x: 1, y: 1, z: 1 },
};

function sensitivityRequest() {
  const terrainKey = { terrain_id: "terrain-bootstrap-sensitivity", epoch: 1 };
  saveLocalTerrain({
    metadata: { terrain_id: terrainKey.terrain_id, bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 6 }, resolution: 2, grid_rows: 2, grid_cols: 3 },
    grid: [[1, 2, 3], [4, 5, 6]],
  });
  const observation: SensitivityObservation = {
    analysisId: "analysis-bootstrap",
    snapshot: {
      terrainKey,
      analysisId: "analysis-bootstrap",
      sourceAnalysisIds: ["analysis-bootstrap"],
      generation: 1,
      radars: [{ radarId: "radar-bootstrap", radarModelId: "groundprobe-ssr-fx", position: { x: 1, y: 1, z: 9 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }],
    },
    grid_rows: 2,
    grid_cols: 3,
    resolution: 2,
    cell_states: new Uint8Array(6).fill(LOSCellState.SHADOW),
  };
  return { terrainKey, observations: [observation] };
}

describe("api.ts Worker bootstrap", () => {
  it("starts all four Workers as module Workers from blob: bootstraps importing the Vite-emitted modules", async () => {
    TransferringWorker.nextResponse = { metadata: importedMetadata, grid: [[1, 2], [3, 4]] };
    await uploadSTL(new File(["stl"], "a.stl"), 1);
    TransferringWorker.nextResponse = boundsResponse;
    await previewTerrainBounds(new File(["stl"], "a.stl"));
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
    const losJob = await runLOSAnalysis({ terrain_id: terrain.terrain_id, radar_position: { x: 10, y: 10, z: 5 }, radar_model_id: "groundprobe-ssr-fx" });
    const sensitivityJob = await runSensitivityAnalysis(sensitivityRequest());

    const expected = [terrainWorkerUrl, terrainWorkerUrl, losWorkerUrl, vectorWorkerUrl].map(absolute);
    expect(TransferringWorker.instances).toHaveLength(4);
    for (const [index, worker] of TransferringWorker.instances.entries()) {
      expect(String(worker.url)).toMatch(/^blob:/);
      expect(worker.options).toEqual({ type: "module" });
      expect(await workerBootstrapImport(worker.url)).toBe(expected[index]);
    }
    cancelLOSAnalysis(losJob.job_id);
    cancelSensitivityAnalysis(sensitivityJob.job_id);
    releaseTerrain(terrain.terrain_id);
  });
});

describe("terrain file transfer", () => {
  for (const [label, upload, filename] of [
    ["uploadSTL", uploadSTL, "terrain.stl"],
    ["uploadDXF", uploadDXF, "terrain.dxf"],
  ] as const) {
    it(`${label} transfers the file ArrayBuffer and completes without touching it again`, async () => {
      TransferringWorker.nextResponse = { metadata: importedMetadata, grid: [[1, 2], [3, 4]] };
      const metadata = await upload(new File(["terrain-bytes"], filename), 1);

      const { message, transfer, received } = lastWorker().posted[0]!;
      expect(lastWorker().posted).toHaveLength(1);
      expect(transfer).toHaveLength(1);
      expect(transfer![0]).toBe(message.fileData);
      // Detached on the main thread: any later view or copy of it there would throw.
      expect((message.fileData as ArrayBuffer).byteLength).toBe(0);
      expect(() => new Uint8Array(message.fileData as ArrayBuffer)).toThrow(/detached/);
      expect(new TextDecoder().decode(received.fileData)).toBe("terrain-bytes");
      expect(received.filename).toBe(filename);
      expect(getLocalTerrain(metadata.terrain_id)?.grid).toEqual([[1, 2], [3, 4]]);
    });
  }

  it("previewTerrainBounds transfers its buffer, and the full import reads the same File again", async () => {
    const file = new File(["same-file-bytes"], "terrain.stl");
    TransferringWorker.nextResponse = boundsResponse;
    const preview = await previewTerrainBounds(file);
    TransferringWorker.nextResponse = { metadata: importedMetadata, grid: [[1, 2], [3, 4]] };
    await uploadSTL(file, 1);

    expect(preview).toEqual({ source: "STL", pointCount: 3, bbox: boundsResponse.bbox, span: boundsResponse.span });
    const [previewPost, importPost] = TransferringWorker.instances.map((worker) => worker.posted[0]!);
    expect(previewPost!.received.mode).toBe("bounds");
    expect(importPost!.received.mode).toBeUndefined();
    for (const post of [previewPost!, importPost!]) {
      expect(post.transfer).toEqual([post.message.fileData]);
      expect((post.message.fileData as ArrayBuffer).byteLength).toBe(0);
      expect(new TextDecoder().decode(post.received.fileData)).toBe("same-file-bytes");
    }
    expect(previewPost!.message.fileData).not.toBe(importPost!.message.fileData);
  });
});

describe("compute-engine selection is read once per message", () => {
  it("takes LOS engine and engine_explicit from a single selection", async () => {
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
    // A second reading would see the default (wasm, not explicit) and mix the two.
    vi.mocked(getComputeEngineSelection).mockClear().mockReturnValueOnce({ engine: "ts", explicit: true });
    const job = await runLOSAnalysis({ terrain_id: terrain.terrain_id, radar_position: { x: 10, y: 10, z: 5 }, radar_model_id: "groundprobe-ssr-fx" });
    expect(getComputeEngineSelection).toHaveBeenCalledTimes(1);
    expect(lastWorker().posted[0]!.message).toMatchObject({ engine: "ts", engine_explicit: true });
    cancelLOSAnalysis(job.job_id);
    releaseTerrain(terrain.terrain_id);
  });

  it("takes sensitivity engine and engine_explicit from a single selection", async () => {
    const request = sensitivityRequest();
    vi.mocked(getComputeEngineSelection).mockClear().mockReturnValueOnce({ engine: "ts", explicit: true });
    const job = await runSensitivityAnalysis(request);
    expect(getComputeEngineSelection).toHaveBeenCalledTimes(1);
    expect(lastWorker().posted[0]!.message).toMatchObject({ type: "SENSITIVITY", engine: "ts", engine_explicit: true });
    cancelSensitivityAnalysis(job.job_id);
  });
});
