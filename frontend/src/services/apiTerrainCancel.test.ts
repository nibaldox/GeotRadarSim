/**
 * Real cancellation and deadlines for the terrain Worker jobs (preview and import).
 *
 * The Worker is a controllable stub: it never answers unless the test says so, so a job only
 * ends through the AbortSignal, the watchdog or an explicit reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTerrainGrid, previewTerrainBounds, uploadDXF, uploadSTL } from "./api";
import { scopedTerrainAbortSignal, withTerrainAbortSignal } from "./terrainAbort";
import { TERRAIN_IMPORT_DEADLINE_MS, TERRAIN_PREVIEW_DEADLINE_MS } from "../utils/terrainLimits";

class HeldWorker {
  static instances: HeldWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminateCalls = 0;
  posted: unknown[] = [];
  constructor() {
    HeldWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminateCalls++;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function fakeFile(name: string, read?: () => Promise<ArrayBuffer>): File & { arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(read ?? (async () => new TextEncoder().encode("bytes").buffer as ArrayBuffer));
  return { name, size: 5, arrayBuffer } as unknown as File & { arrayBuffer: ReturnType<typeof vi.fn> };
}

/** Let the File read and the Worker construction (after an await) happen. */
async function untilWorkerStarted(): Promise<HeldWorker> {
  for (let i = 0; i < 20 && HeldWorker.instances.length === 0; i++) await Promise.resolve();
  expect(HeldWorker.instances).toHaveLength(1);
  return HeldWorker.instances[0]!;
}

const deadlineMessage = (ms: number): string =>
  `El procesamiento del terreno superó ${ms / 1000} s y se detuvo; revisa que el archivo sea válido.`;

const jobs = [
  ["preview", (file: File, signal?: AbortSignal) => previewTerrainBounds(file, signal), TERRAIN_PREVIEW_DEADLINE_MS, "x.dxf"],
  ["DXF import", (file: File, signal?: AbortSignal) => uploadDXF(file, 1, signal), TERRAIN_IMPORT_DEADLINE_MS, "x.dxf"],
  ["STL import", (file: File, signal?: AbortSignal) => uploadSTL(file, 1, signal), TERRAIN_IMPORT_DEADLINE_MS, "x.stl"],
] as const;

beforeEach(() => {
  HeldWorker.instances = [];
  vi.stubGlobal("Worker", HeldWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("terrain jobs — AbortSignal", () => {
  for (const [label, start, , filename] of jobs) {
    it(`${label}: aborting terminates the Worker exactly once, clears its handlers and rejects with AbortError`, async () => {
      const controller = new AbortController();
      const job = start(fakeFile(filename), controller.signal);
      const worker = await untilWorkerStarted();

      controller.abort();
      const error = await job.catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expect(worker.terminateCalls).toBe(1);
      expect(worker.onmessage).toBeNull();
      expect(worker.onerror).toBeNull();

      // A late reply or a second abort changes nothing.
      controller.abort();
      worker.reply({ mode: "bounds", source: "DXF", pointCount: 1, bbox: {}, span: {} });
      expect(worker.terminateCalls).toBe(1);
    });

    it(`${label}: an already aborted signal rejects before reading the file or starting a Worker`, async () => {
      const controller = new AbortController();
      controller.abort();
      const file = fakeFile(filename);

      await expect(start(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(file.arrayBuffer).not.toHaveBeenCalled();
      expect(HeldWorker.instances).toHaveLength(0);
    });

    it(`${label}: aborting while the file is being read never starts a Worker`, async () => {
      const controller = new AbortController();
      let finishRead!: (buffer: ArrayBuffer) => void;
      const file = fakeFile(filename, () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }));
      const job = start(file, controller.signal);
      await Promise.resolve();

      controller.abort();
      finishRead(new ArrayBuffer(4));

      await expect(job).rejects.toMatchObject({ name: "AbortError" });
      expect(HeldWorker.instances).toHaveLength(0);
    });
  }

  // The scoped signal only exists while withTerrainAbortSignal runs synchronously. These tests
  // fail at once (terminateCalls stays 0) if a job function reads it after its first await.
  for (const [label, start, , filename] of jobs) {
    it(`${label}: reads the withTerrainAbortSignal scope synchronously, before its first await`, async () => {
      const controller = new AbortController();
      let finishRead!: (buffer: ArrayBuffer) => void;
      const file = fakeFile(filename, () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }));
      const job = withTerrainAbortSignal(controller.signal, () => start(file));
      expect(scopedTerrainAbortSignal()).toBeUndefined();
      const settled = job.then(() => "resolved", (error: unknown) => error);

      finishRead(new TextEncoder().encode("bytes").buffer as ArrayBuffer);
      const worker = await untilWorkerStarted();
      controller.abort();

      expect(worker.terminateCalls).toBe(1);
      expect(worker.onmessage).toBeNull();
      expect(await settled).toMatchObject({ name: "AbortError" });
    });
  }

  it("an aborted import leaves nothing in the local terrain cache", async () => {
    const controller = new AbortController();
    const job = uploadDXF(fakeFile("x.dxf"), 1, controller.signal);
    const worker = await untilWorkerStarted();
    controller.abort();
    worker.reply({ grid: [[1, 2], [3, 4]], metadata: { terrain_id: "late", bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 4 }, resolution: 1, grid_rows: 2, grid_cols: 2 } });

    await expect(job).rejects.toMatchObject({ name: "AbortError" });
    await expect(getTerrainGrid("late")).rejects.toThrow(/not found/);
  });
});

describe("terrain jobs — watchdog", () => {
  for (const [label, start, deadline, filename] of jobs) {
    it(`${label}: terminates the Worker and rejects in Spanish once ${deadline} ms elapse`, async () => {
      vi.useFakeTimers();
      const job = start(fakeFile(filename));
      const settled = job.then(() => "resolved", (error: unknown) => error);
      const worker = await untilWorkerStarted();

      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(worker.terminateCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).not.toBe("AbortError");
      expect((error as Error).message).toBe(deadlineMessage(deadline));
      expect(worker.terminateCalls).toBe(1);
      expect(worker.onmessage).toBeNull();
      expect(worker.onerror).toBeNull();
    });
  }

  it("clears the deadline and the abort listener once the Worker answers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const job = previewTerrainBounds(fakeFile("x.dxf"), controller.signal);
    const worker = await untilWorkerStarted();
    expect(vi.getTimerCount()).toBe(1);

    worker.reply({ mode: "bounds", source: "DXF", pointCount: 1, bbox: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }, span: { x: 1, y: 1, z: 1 } });
    await expect(job).resolves.toMatchObject({ source: "DXF", pointCount: 1 });

    expect(vi.getTimerCount()).toBe(0);
    expect(worker.terminateCalls).toBe(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(TERRAIN_PREVIEW_DEADLINE_MS * 2);
    expect(worker.terminateCalls).toBe(1);
  });
});
