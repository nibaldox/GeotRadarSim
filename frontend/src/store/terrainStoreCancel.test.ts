/**
 * Store-level cancellation of terrain Worker jobs, through the real API module.
 *
 * The Worker is a stub that only answers when told to, so the tests observe exactly when the
 * store aborts a job (terminate() count, handlers) and that an AbortError never reaches the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerrainStore } from "./terrainStore";
import { useAnalysisStore } from "./analysisStore";
import { clearLocalTerrainCache } from "../services/localDataStore";

class HeldWorker {
  static instances: HeldWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminateCalls = 0;
  constructor() {
    HeldWorker.instances.push(this);
  }
  postMessage(): void {}
  terminate(): void {
    this.terminateCalls++;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function fakeFile(name: string): File {
  return {
    name,
    size: 5,
    arrayBuffer: async () => new TextEncoder().encode("bytes").buffer as ArrayBuffer,
  } as unknown as File;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function workerNumber(index: number): Promise<HeldWorker> {
  for (let i = 0; i < 20 && HeldWorker.instances.length <= index; i++) await Promise.resolve();
  expect(HeldWorker.instances.length).toBeGreaterThan(index);
  return HeldWorker.instances[index]!;
}

function expectReleased(worker: HeldWorker): void {
  expect(worker.terminateCalls).toBe(1);
  expect(worker.onmessage).toBeNull();
  expect(worker.onerror).toBeNull();
}

const bounds = {
  mode: "bounds",
  source: "DXF",
  pointCount: 4,
  bbox: { minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 1 },
  span: { x: 10, y: 10, z: 1 },
};

function fullReply(id: string) {
  return {
    grid: [[1, 2], [3, 4]],
    metadata: {
      terrain_id: id,
      bounds: { min_x: 0, min_y: 0, min_z: 1, max_x: 1, max_y: 1, max_z: 4 },
      resolution: 1,
      grid_rows: 2,
      grid_cols: 2,
    },
  };
}

beforeEach(() => {
  HeldWorker.instances = [];
  vi.stubGlobal("Worker", HeldWorker);
  clearLocalTerrainCache();
  useTerrainStore.setState({
    metadata: null,
    grid: null,
    loading: false,
    error: null,
    terrainKey: null,
    terrainEpoch: 0,
    uploadPreview: null,
    uploadPreviewLoading: false,
    uploadPreviewError: null,
  });
  useAnalysisStore.setState({ terrainKey: null, terrainTransitioning: false, history: [], error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terrainStore — upload preview cancellation", () => {
  it("cancelUploadPreview reaches the preview Worker's terminate() once (real store and api) and shows no error", async () => {
    const preview = useTerrainStore.getState().startUploadPreview(fakeFile("slow.dxf"));
    const worker = await workerNumber(0);

    useTerrainStore.getState().cancelUploadPreview();
    await preview;
    await flush();

    expectReleased(worker);
    const state = useTerrainStore.getState();
    expect(state.uploadPreview).toBeNull();
    expect(state.uploadPreviewLoading).toBe(false);
    expect(state.uploadPreviewError).toBeNull();
  });

  it("a new preview aborts the previous one, and only the new one is shown", async () => {
    const first = useTerrainStore.getState().startUploadPreview(fakeFile("a.dxf"));
    const firstWorker = await workerNumber(0);

    const second = useTerrainStore.getState().startUploadPreview(fakeFile("b.dxf"));
    expectReleased(firstWorker);
    const secondWorker = await workerNumber(1);
    secondWorker.reply(bounds);
    await Promise.all([first, second]);

    expect(secondWorker.terminateCalls).toBe(1); // a completed job releases its Worker as before
    const state = useTerrainStore.getState();
    expect(state.uploadPreview?.filename).toBe("b.dxf");
    expect(state.uploadPreview?.source).toBe("DXF");
    expect(state.uploadPreviewError).toBeNull();
    expect(HeldWorker.instances).toHaveLength(2);
  });

  it("still surfaces a real Worker error from the preview", async () => {
    const preview = useTerrainStore.getState().startUploadPreview(fakeFile("hang.dxf"));
    const worker = await workerNumber(0);
    worker.reply({ error: "DXF rechazado: la POLYLINE de la línea 5 no termina con SEQEND" });
    await preview;

    expect(useTerrainStore.getState().uploadPreviewError).toMatch(/SEQEND/);
  });
});

describe("terrainStore — superseded imports (not aborted; fenced and deadline-bound)", () => {
  it("a newer import leaves the older Worker running and fences its late result without an error", async () => {
    const older = useTerrainStore.getState().uploadDXF(fakeFile("older.dxf"));
    const olderWorker = await workerNumber(0);

    const newer = useTerrainStore.getState().uploadDXF(fakeFile("newer.dxf"));
    const newerWorker = await workerNumber(1);
    expect(olderWorker.terminateCalls).toBe(0);
    newerWorker.reply(fullReply("newer"));
    await newer;
    olderWorker.reply(fullReply("older"));
    await older;

    const state = useTerrainStore.getState();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.metadata?.terrain_id).toMatch(/^newer-import-/);
  });

  it("changing terrain does not abort an import in flight; its late result is discarded", async () => {
    const pending = useTerrainStore.getState().uploadSTL(fakeFile("big.stl"));
    const worker = await workerNumber(0);

    await useTerrainStore.getState().generateSynthetic({ size_x: 10, size_y: 10, depth: 1, resolution: 2 });
    const syntheticId = useTerrainStore.getState().metadata?.terrain_id;
    expect(worker.terminateCalls).toBe(0);
    worker.reply(fullReply("late"));
    await pending;

    const state = useTerrainStore.getState();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.metadata?.terrain_id).toBe(syntheticId);
  });
});

describe("terrainStore — confirm", () => {
  it("confirming a preview aborts a preview still in flight", async () => {
    const preview = useTerrainStore.getState().startUploadPreview(fakeFile("first.dxf"));
    const previewWorker = await workerNumber(0);
    useTerrainStore.setState({
      uploadPreview: {
        file: fakeFile("ready.dxf"),
        filename: "ready.dxf",
        source: "DXF",
        pointCount: bounds.pointCount,
        bbox: bounds.bbox,
        span: bounds.span,
      },
    });

    const confirm = useTerrainStore.getState().confirmUploadPreview(1);
    expectReleased(previewWorker);
    const importWorker = await workerNumber(1);
    importWorker.reply(fullReply("ready"));
    await Promise.all([preview, confirm]);

    expect(useTerrainStore.getState().uploadPreviewError).toBeNull();
    expect(useTerrainStore.getState().error).toBeNull();
  });
});
