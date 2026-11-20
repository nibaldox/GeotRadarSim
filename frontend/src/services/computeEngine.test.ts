import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTE_ENGINE_STORAGE_KEY,
  DEFAULT_COMPUTE_ENGINE,
  getComputeEngine,
  parseComputeEngine,
  resolveWorkerComputeEngine,
} from "./computeEngine";

const originalUrl = window.location.href;

function setSearch(search: string): void {
  window.history.replaceState(null, "", `/GeotRadarSim/${search}`);
}

beforeEach(() => {
  localStorage.clear();
  setSearch("");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", originalUrl);
});

describe("getComputeEngine", () => {
  it("defaults to wasm without an explicit selection", () => {
    expect(DEFAULT_COMPUTE_ENGINE).toBe("wasm");
    expect(getComputeEngine()).toBe("wasm");
  });

  it("honours ?engine=wasm and ?engine=ts", () => {
    setSearch("?engine=wasm");
    expect(getComputeEngine()).toBe("wasm");
    setSearch("?foo=1&engine=ts");
    expect(getComputeEngine()).toBe("ts");
  });

  it("honours localStorage['geotradarsim.engine']", () => {
    expect(COMPUTE_ENGINE_STORAGE_KEY).toBe("geotradarsim.engine");
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    expect(getComputeEngine()).toBe("wasm");
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "ts");
    expect(getComputeEngine()).toBe("ts");
  });

  it("reads the flag on every call, so a stored change applies to the next job", () => {
    expect(getComputeEngine()).toBe("wasm");
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    expect(getComputeEngine()).toBe("wasm");
    localStorage.removeItem(COMPUTE_ENGINE_STORAGE_KEY);
    expect(getComputeEngine()).toBe("wasm");
  });

  it("gives the URL precedence over localStorage, in both directions", () => {
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    setSearch("?engine=ts");
    expect(getComputeEngine()).toBe("ts");
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "ts");
    setSearch("?engine=wasm");
    expect(getComputeEngine()).toBe("wasm");
  });

  it.each(["WASM", "Wasm", " wasm", "wasm ", "rust", "", "1", "true", "null"])(
    "ignores the invalid value %j in the URL and in storage without throwing",
    (value) => {
      setSearch(`?engine=${encodeURIComponent(value)}`);
      expect(getComputeEngine()).toBe("wasm");
      localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, value);
      expect(getComputeEngine()).toBe("wasm");
    },
  );

  it("falls through an invalid URL value to a valid stored value", () => {
    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    setSearch("?engine=gpu");
    expect(getComputeEngine()).toBe("wasm");
  });

  it("uses the first engine parameter when the URL repeats it", () => {
    setSearch("?engine=wasm&engine=ts");
    expect(getComputeEngine()).toBe("wasm");
  });

  it("survives a storage that throws and a missing location or storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    expect(getComputeEngine()).toBe("wasm");
    setSearch("?engine=wasm");
    expect(getComputeEngine()).toBe("wasm");
    vi.restoreAllMocks();

    localStorage.setItem(COMPUTE_ENGINE_STORAGE_KEY, "wasm");
    vi.stubGlobal("location", undefined);
    expect(getComputeEngine()).toBe("wasm");
    vi.stubGlobal("localStorage", undefined);
    expect(getComputeEngine()).toBe("wasm");
  });
});

describe("parseComputeEngine and resolveWorkerComputeEngine", () => {
  it("accepts only the exact engine names", () => {
    expect(parseComputeEngine("ts")).toBe("ts");
    expect(parseComputeEngine("wasm")).toBe("wasm");
    for (const value of ["TS", "wasm32", "", null, undefined, 1, {}, ["wasm"]]) expect(parseComputeEngine(value)).toBeNull();
  });

  it("treats a missing worker engine as ts and rejects anything else", () => {
    expect(resolveWorkerComputeEngine(undefined, "LOS")).toBe("ts");
    expect(resolveWorkerComputeEngine("ts", "LOS")).toBe("ts");
    expect(resolveWorkerComputeEngine("wasm", "LOS")).toBe("wasm");
    expect(() => resolveWorkerComputeEngine("WASM", "LOS")).toThrow(new RangeError('Unknown LOS compute engine: "WASM"'));
    expect(() => resolveWorkerComputeEngine(null, "sensitivity")).toThrow("Unknown sensitivity compute engine: null");
    expect(() => resolveWorkerComputeEngine(1, "LOS")).toThrow("Unknown LOS compute engine: number");
  });
});
