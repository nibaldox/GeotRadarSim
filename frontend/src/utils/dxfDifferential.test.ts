// @vitest-environment node
/**
 * Small deterministic version of the generative differential test (the full run, ≥ 3000 cases with
 * one process per parse, lives in plans/rust-wasm/evidence/c3). Every grammar case the preflight
 * accepts is parsed by the REAL dxf-parser (ESM dist/index.js, bundled like Vite) inside a
 * worker_thread with a per-case deadline, so a hang costs one deadline and cannot stall the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflightDxf } from "./dxfPreflight";
import { generateDxfCase } from "./dxfGrammar.testSupport";

interface ThreadLike {
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  postMessage(message: unknown): void;
  removeAllListeners(): void;
  terminate(): Promise<number>;
}
interface WorkerThreads {
  Worker: new (source: string, options: { eval: true; resourceLimits: { maxOldGenerationSizeMb: number } }) => ThreadLike;
}
interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
}

// Seeds 20261120..20261319, plus 20261321. Seeds 20261285 and 20261321 are the two grammar cases on
// which the previous (pattern-based) preflight accepted a hanging nested TABLE.
const SEEDS = [...Array.from({ length: 200 }, (_, i) => 20261120 + i), 20261321];
const DEADLINE_MS = 1_000;
const frontendDir = decodeURIComponent(new URL("../../", import.meta.url).pathname);
let workerThreads: WorkerThreads;
let threadSource: string;
let thread: ThreadLike | null = null;

beforeAll(async () => {
  const workerThreadsId = "node:worker_threads";
  const esbuildId = "esbuild";
  workerThreads = (await import(/* @vite-ignore */ workerThreadsId)) as WorkerThreads;
  const esbuild = (await import(/* @vite-ignore */ esbuildId)) as EsbuildLike;
  const parser = (await esbuild.build({
    stdin: {
      contents: "import DxfParser from 'dxf-parser'; globalThis.__parse = (text) => new DxfParser().parseSync(text);",
      resolveDir: frontendDir,
      loader: "js",
    },
    bundle: true, write: false, format: "iife", platform: "neutral", mainFields: ["module", "main"], logLevel: "silent",
  })).outputFiles[0]!.text;
  threadSource = `
const { parentPort } = require("node:worker_threads");
for (const k of ["log", "warn", "error", "debug", "info"]) console[k] = () => {};
${parser}
parentPort.on("message", (text) => {
  let result = "OK";
  try { globalThis.__parse(text); } catch { result = "ERROR"; }
  parentPort.postMessage(result);
});`;
}, 30_000);

afterAll(async () => {
  await thread?.terminate();
});

/** Parse in the long-lived thread; on a missed deadline terminate it and start a fresh one. */
function parseWithDeadline(text: string): Promise<"OK" | "ERROR" | "HANG"> {
  thread ??= new workerThreads.Worker(threadSource, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  const current = thread;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.removeAllListeners();
      void current.terminate();
      if (thread === current) thread = null;
      resolve("HANG");
    }, DEADLINE_MS);
    current.removeAllListeners();
    current.on("message", (result) => {
      clearTimeout(timer);
      resolve(result as "OK" | "ERROR");
    });
    current.on("error", (error) => {
      clearTimeout(timer);
      if (thread === current) thread = null;
      reject(error);
    });
    current.postMessage(text);
  });
}

describe("preflightDxf — generative differential against the real dxf-parser", () => {
  it("never accepts a generated DXF on which dxf-parser does not terminate", async () => {
    let accepted = 0;
    let rejected = 0;
    const acceptedHangs: number[] = [];
    for (const seed of SEEDS) {
      const text = generateDxfCase(seed);
      try {
        preflightDxf(text);
      } catch {
        rejected++;
        continue;
      }
      accepted++;
      if ((await parseWithDeadline(text)) === "HANG") acceptedHangs.push(seed);
    }

    expect(acceptedHangs).toEqual([]);
    expect(accepted + rejected).toBe(SEEDS.length);
    // The grammar must exercise both sides, or the test proves nothing.
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(10);
  }, 30_000);

  it("rejects the two grammar cases the pattern-based preflight let through", () => {
    for (const seed of [20261285, 20261321]) {
      expect(() => preflightDxf(generateDxfCase(seed)), String(seed)).toThrow(/tabla LAYER.*ENDTAB/);
    }
  });
});
