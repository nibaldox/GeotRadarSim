/**
 * createModuleWorker starts each Worker from a `blob:` bootstrap (so it inherits the document's
 * <meta> CSP) that statically imports the Vite-emitted Worker module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModuleWorker, moduleWorkerBootstrapSource } from "./moduleWorker";
import { workerBootstrapBlob, workerBootstrapImport } from "./workerBootstrap.testSupport";
import terrainWorkerUrl from "../workers/terrainWorker.ts?worker&url";
import losWorkerUrl from "../workers/losWorker.ts?worker&url";
import vectorWorkerUrl from "../workers/vectorWorker.ts?worker&url";

class RecordingWorker {
  static instances: RecordingWorker[] = [];
  static constructionError: Error | null = null;
  constructor(readonly url: URL | string, readonly options?: WorkerOptions) {
    if (RecordingWorker.constructionError) throw RecordingWorker.constructionError;
    RecordingWorker.instances.push(this);
  }
}

beforeEach(() => {
  RecordingWorker.instances = [];
  RecordingWorker.constructionError = null;
  vi.stubGlobal("Worker", RecordingWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("moduleWorkerBootstrapSource", () => {
  it("is one static import of the module followed by self-revocation", () => {
    expect(moduleWorkerBootstrapSource("http://localhost:3000/GeotRadarSim/assets/losWorker-abc.js")).toBe(
      'import "http://localhost:3000/GeotRadarSim/assets/losWorker-abc.js";\nURL.revokeObjectURL(import.meta.url);\n',
    );
  });

  it("quotes the specifier as a JSON string literal", () => {
    const source = moduleWorkerBootstrapSource('http://localhost:3000/a"b\\c.js');
    expect(source.split("\n")[0]).toBe('import "http://localhost:3000/a\\"b\\\\c.js";');
  });
});

describe("createModuleWorker", () => {
  it("constructs a module Worker from a text/javascript blob: URL that imports the absolute module URL", async () => {
    const worker = createModuleWorker("/GeotRadarSim/assets/losWorker-abc.js") as unknown as RecordingWorker;
    expect(RecordingWorker.instances).toEqual([worker]);
    expect(String(worker.url)).toMatch(/^blob:/);
    expect(worker.options).toEqual({ type: "module" });
    const blob = workerBootstrapBlob(worker.url);
    expect(blob.type).toBe("text/javascript");
    expect(await blob.text()).toBe(moduleWorkerBootstrapSource(new URL("/GeotRadarSim/assets/losWorker-abc.js", location.href).href));
    expect(await workerBootstrapImport(worker.url)).toBe(new URL("/GeotRadarSim/assets/losWorker-abc.js", location.href).href);
  });

  it("does not revoke the bootstrap URL on the main thread after a successful construction", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    createModuleWorker("/assets/w.js");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes the bootstrap URL and rethrows when the Worker constructor throws", () => {
    const failure = new Error("constructor unavailable");
    RecordingWorker.constructionError = failure;
    const create = vi.spyOn(URL, "createObjectURL");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    expect(() => createModuleWorker("/assets/w.js")).toThrow(failure);
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(create.mock.results[0]!.value);
  });

  it("refuses a cross-origin module without creating a Blob or a Worker", () => {
    const create = vi.spyOn(URL, "createObjectURL");
    expect(() => createModuleWorker("https://example.com/evil.js")).toThrow(TypeError);
    expect(() => createModuleWorker("//example.com/evil.js")).toThrow(TypeError);
    expect(create).not.toHaveBeenCalled();
    expect(RecordingWorker.instances).toHaveLength(0);
  });
});

describe("Vite ?worker&url imports used by api.ts", () => {
  it("resolve to the three Worker modules as module-type worker files", () => {
    for (const [url, name] of [[terrainWorkerUrl, "terrainWorker"], [losWorkerUrl, "losWorker"], [vectorWorkerUrl, "vectorWorker"]] as const) {
      expect(url).toBe(`/src/workers/${name}.ts?worker_file&type=module`);
    }
  });
});
