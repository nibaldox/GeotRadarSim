/**
 * Cancellation plumbing for the terrain Worker jobs (bounds preview and import).
 *
 * The terrain API functions take an optional `AbortSignal` as their last parameter. When the
 * caller does not pass one explicitly, they read it from {@link withTerrainAbortSignal}, which
 * scopes a signal to the jobs started synchronously inside its callback. The terrain store uses
 * that form so its calls keep the `(file)` / `(file, resolution)` shape that existing tests and
 * callers assert on.
 */

let scopedSignal: AbortSignal | undefined;

/**
 * Run `start` so that every terrain job it starts synchronously (before its first `await`) is
 * cancelled by `signal`. Returns whatever `start` returns.
 */
export function withTerrainAbortSignal<T>(signal: AbortSignal, start: () => T): T {
  const previous = scopedSignal;
  scopedSignal = signal;
  try {
    return start();
  } finally {
    scopedSignal = previous;
  }
}

/** The signal scoped by {@link withTerrainAbortSignal}, if a terrain job is being started inside it. */
export function scopedTerrainAbortSignal(): AbortSignal | undefined {
  return scopedSignal;
}

/** The rejection of a cancelled terrain job: a `DOMException` named `"AbortError"`. */
export function terrainAbortError(): DOMException {
  return new DOMException("Se canceló el procesamiento del terreno.", "AbortError");
}

/** True for the rejection of a cancelled job; such a rejection is never shown as an error. */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
