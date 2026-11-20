/**
 * Compute-engine flag for the LOS and sensitivity Workers.
 *
 * - `ts`: the TypeScript implementation (default).
 * - `wasm`: the Rust core compiled to WebAssembly, opt-in for the A/B and the browser checks.
 *
 * Precedence: the URL parameter `?engine=ts|wasm`, then `localStorage["geotradarsim.engine"]`,
 * then {@link DEFAULT_COMPUTE_ENGINE}. Only the exact values `ts` and `wasm` are honoured;
 * anything else (including a different case) is ignored, and so is any failure to read the
 * URL or the storage (for example a storage `SecurityError`). Reading never throws.
 *
 * The flag is read on every call, so changing the stored value applies to the next job.
 */
export type ComputeEngine = "ts" | "wasm";

export const DEFAULT_COMPUTE_ENGINE: ComputeEngine = "ts";
export const COMPUTE_ENGINE_URL_PARAM = "engine";
export const COMPUTE_ENGINE_STORAGE_KEY = "geotradarsim.engine";

/** Return the engine named by `value`, or null when it is not exactly `ts` or `wasm`. */
export function parseComputeEngine(value: unknown): ComputeEngine | null {
  return value === "ts" || value === "wasm" ? value : null;
}

function engineFromUrl(): ComputeEngine | null {
  try {
    const search = globalThis.location?.search;
    if (typeof search !== "string" || search === "") return null;
    return parseComputeEngine(new URLSearchParams(search).get(COMPUTE_ENGINE_URL_PARAM));
  } catch {
    return null;
  }
}

function engineFromStorage(): ComputeEngine | null {
  try {
    return parseComputeEngine(globalThis.localStorage?.getItem(COMPUTE_ENGINE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The engine for the next LOS or sensitivity job. */
export function getComputeEngine(): ComputeEngine {
  return engineFromUrl() ?? engineFromStorage() ?? DEFAULT_COMPUTE_ENGINE;
}

function describeEngineValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return value === null ? "null" : typeof value;
}

/**
 * Worker-side reading of the `engine` message field: missing means `ts`; `ts` and `wasm` are
 * honoured; anything else is a caller error and throws, so a typo can never silently run the
 * other engine during an A/B.
 */
export function resolveWorkerComputeEngine(value: unknown, label: string): ComputeEngine {
  if (value === undefined) return DEFAULT_COMPUTE_ENGINE;
  const engine = parseComputeEngine(value);
  if (engine === null) {
    throw new RangeError(`Unknown ${label} compute engine: ${describeEngineValue(value)}`);
  }
  return engine;
}
