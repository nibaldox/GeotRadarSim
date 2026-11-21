// @vitest-environment node
/**
 * Runs the REAL dxf-parser and the REAL terrain Worker module (bundled with esbuild exactly as
 * Vite resolves them: `module` field → dist/index.js) inside `worker_threads`, each with a
 * deadline after which the thread is terminated. A hang therefore costs at most one deadline
 * and can never stall the suite.
 *
 * 1. Every hanging fixture really hangs dxf-parser (the thread misses its deadline).
 * 2. The Worker module answers every hanging fixture with the preflight error, in < 100 ms.
 * 3. Valid fixtures still parse with the real parser through the Worker.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HANGING_DXF, LWPOLYLINE_COUNT_BOMB, VALID_DXF, VALID_TERRAIN_DXF } from "../utils/dxfFixtures.testSupport";

interface ThreadLike {
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): Promise<number>;
}
interface WorkerThreads {
  Worker: new (source: string, options: { eval: true; resourceLimits: { maxOldGenerationSizeMb: number } }) => ThreadLike;
}
interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
}

const HANG_DEADLINE_MS = 1_000;
const frontendDir = decodeURIComponent(new URL("../../", import.meta.url).pathname);
let workerThreads: WorkerThreads;
let parserBundle: string;
let workerBundle: string;

async function bundle(esbuild: EsbuildLike, options: Record<string, unknown>): Promise<string> {
  const result = await esbuild.build({
    bundle: true,
    write: false,
    format: "iife",
    platform: "neutral",
    // Same resolution as Vite's browser build: dxf-parser's `module` entry (dist/index.js).
    mainFields: ["module", "main"],
    logLevel: "silent",
    ...options,
  });
  return result.outputFiles[0]!.text;
}

beforeAll(async () => {
  const workerThreadsId = "node:worker_threads";
  const esbuildId = "esbuild";
  workerThreads = (await import(/* @vite-ignore */ workerThreadsId)) as WorkerThreads;
  const esbuild = (await import(/* @vite-ignore */ esbuildId)) as EsbuildLike;
  parserBundle = await bundle(esbuild, {
    stdin: {
      contents: "import DxfParser from 'dxf-parser'; globalThis.__parse = (text) => new DxfParser().parseSync(text);",
      resolveDir: frontendDir,
      loader: "js",
    },
  });
  workerBundle = await bundle(esbuild, { entryPoints: [`${frontendDir}src/workers/terrainWorker.ts`] });
}, 30_000);

type ThreadOutcome = { kind: "timeout" } | { kind: "message"; message: Record<string, unknown>; ms: number };

/** Run `body` (which posts one message) in a fresh thread; terminate it at the deadline. */
function runInThread(source: string, payload: unknown, deadlineMs: number): Promise<ThreadOutcome> {
  // The heap cap turns an allocation bomb that slipped through into a thread error, not host OOM.
  const thread = new workerThreads.Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  return new Promise<ThreadOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      void thread.terminate();
      resolve({ kind: "timeout" });
    }, deadlineMs);
    thread.on("message", (message) => {
      clearTimeout(timer);
      void thread.terminate();
      const { result, ms } = message as { result: Record<string, unknown>; ms: number };
      resolve({ kind: "message", message: result, ms });
    });
    thread.on("error", (error) => {
      clearTimeout(timer);
      void thread.terminate();
      reject(error);
    });
    thread.postMessage(payload);
  });
}

function parserThreadSource(): string {
  return `
const { parentPort } = require("node:worker_threads");
for (const k of ["log", "warn", "error", "debug", "info"]) console[k] = () => {};
${parserBundle}
parentPort.once("message", (text) => {
  const t0 = performance.now();
  let result;
  try { const dxf = globalThis.__parse(text); result = { entities: dxf && dxf.entities ? dxf.entities.length : null }; }
  catch (error) { result = { error: String(error && error.message || error) }; }
  parentPort.postMessage({ result, ms: performance.now() - t0 });
});`;
}

function terrainWorkerThreadSource(): string {
  return `
const { parentPort } = require("node:worker_threads");
for (const k of ["log", "warn", "error", "debug", "info"]) console[k] = () => {};
let t0 = 0;
globalThis.self = { postMessage: (result) => parentPort.postMessage({ result, ms: performance.now() - t0 }) };
${workerBundle}
parentPort.once("message", (data) => { t0 = performance.now(); void self.onmessage({ data }); });`;
}

function dxfMessage(text: string, filename: string, mode: "bounds" | "full") {
  return { fileData: new TextEncoder().encode(text).buffer, filename, resolution: 1, mode };
}

describe("real dxf-parser@1.1.2 in worker_threads", () => {
  it("hangs on every fixture the audit marked as hanging", async () => {
    // At most 6 spinning threads at a time: the machine is shared.
    const outcomes: ThreadOutcome[] = [];
    for (let start = 0; start < HANGING_DXF.length; start += 6) {
      outcomes.push(...await Promise.all(
        HANGING_DXF.slice(start, start + 6).map((fixture) => runInThread(parserThreadSource(), fixture.text, HANG_DEADLINE_MS)),
      ));
    }
    expect(outcomes.map((outcome, index) => [HANGING_DXF[index]!.id, outcome.kind]))
      .toEqual(HANGING_DXF.map((fixture) => [fixture.id, "timeout"]));
  }, 20_000);

  it("parses every valid fixture", async () => {
    for (const fixture of VALID_DXF) {
      const outcome = await runInThread(parserThreadSource(), fixture.text, 5_000);
      expect(outcome.kind, fixture.id).toBe("message");
      if (outcome.kind === "message") expect(outcome.message.error, fixture.id).toBeUndefined();
    }
  }, 30_000);
});

describe("real terrain Worker module in worker_threads", () => {
  for (const mode of ["bounds", "full"] as const) {
    it(`rejects every hanging fixture in ${mode} mode within 100 ms`, async () => {
      for (const fixture of [...HANGING_DXF, LWPOLYLINE_COUNT_BOMB]) {
        const outcome = await runInThread(terrainWorkerThreadSource(), dxfMessage(fixture.text, `${fixture.id}.dxf`, mode), 5_000);
        expect(outcome.kind, fixture.id).toBe("message");
        if (outcome.kind !== "message") continue;
        expect(outcome.message.error, fixture.id).toMatch(fixture.reason!);
        expect(outcome.ms, fixture.id).toBeLessThan(100);
      }
    }, 60_000);
  }

  it("still previews and imports the valid terrain DXF with the real parser", async () => {
    const preview = await runInThread(terrainWorkerThreadSource(), dxfMessage(VALID_TERRAIN_DXF, "valid.dxf", "bounds"), 5_000);
    expect(preview.kind).toBe("message");
    if (preview.kind === "message") {
      expect(preview.message.error).toBeUndefined();
      expect(preview.message.pointCount).toBe(9);
    }
    const full = await runInThread(terrainWorkerThreadSource(), dxfMessage(VALID_TERRAIN_DXF, "valid.dxf", "full"), 5_000);
    expect(full.kind).toBe("message");
    if (full.kind === "message") {
      expect(full.message.error).toBeUndefined();
      expect((full.message.metadata as { grid_rows: number }).grid_rows).toBe(11);
    }
  }, 20_000);
});
