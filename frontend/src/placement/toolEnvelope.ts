/**
 * Result envelope of the «Sugerir ubicación» runtime: error codes, binding, confirmation
 * request and the execution context. Moved verbatim from the former tool registry.
 */

/** Error codes of the result envelope (`x-result-envelope` in the W0a catalog). */
export const TOOL_ERROR_CODES = [
  "NO_TERRAIN",
  "TERRAIN_TRANSITIONING",
  "BUSY",
  "INVALID_ARGUMENT",
  "OUT_OF_TERRAIN",
  "NODATA_AT_POSITION",
  "NO_PROFILE",
  "NO_POSITION",
  "NO_SELECTION",
  "SUPERSEDED",
  "STALE_REF",
  "ANALYSIS_FAILED",
  "TIMEOUT",
  "CANCELLED_BY_USER",
  "USER_DECLINED",
  "NOT_AVAILABLE",
  "RESULT_TOO_LARGE",
  // Added by the loop (R1 WP5A-3, WP5A-10); not in the W0a catalog enum.
  "DUPLICATE_CALL",
  "TOO_MANY_CALLS",
  // Added by WP4 R4 (WP4A-12): the session ran out of opaque refs.
  "REF_EXHAUSTED",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Binds every figure to the terrain, epoch, analyses, metric and policy. */
export interface ToolBinding {
  /** Opaque `T<epoch>`; never the real terrain_id. */
  terrain_ref: string | null;
  epoch: number | null;
  analysis_refs?: string[];
  metric?: string | null;
  policy?: Record<string, unknown> | null;
  /** Loop step that produced the result; the loop overwrites it. */
  step: number;
}

export interface ToolError {
  code: ToolErrorCode;
  /** Spanish, ≤ 300 characters. */
  message: string;
  retryable?: boolean;
  /** ≤ 200 characters. */
  hint?: string;
}

export type ToolEnvelope =
  | { ok: true; binding: ToolBinding; data: Record<string, unknown>; truncated?: boolean }
  | {
      ok: false;
      binding: ToolBinding;
      error: ToolError;
      truncated?: boolean;
      /** Raw app text for the local trace only; the loop strips it before the model sees the envelope (R4 WP4B-7). */
      localDetail?: string;
    };

/** What the confirmation card shows. The text is produced by the runtime. */
export interface ConfirmationRequest {
  /** Effect in words, e.g. «Se reemplazará el terreno actual y se borrarán 4 análisis del historial». */
  effect: string;
  /** Kind of action, for the card style. */
  kind: "destructive" | "download" | "long_running";
}

export interface ToolContext {
  /** Aborted by «Detener». Tools must cancel ONLY work they started. */
  signal: AbortSignal;
  /** Loop step (1-based). */
  step: number;
  /** Id of the tool call being executed. */
  callId: string;
}

export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === "string" && (TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/** Builds an error envelope (used by the loop and by tools). */
export function errorEnvelope(
  binding: Omit<ToolBinding, "step"> & { step?: number },
  code: ToolErrorCode,
  message: string,
  extra: { retryable?: boolean; hint?: string } = {},
): ToolEnvelope {
  const error: ToolError = { code, message: message.length <= 300 ? message : `${message.slice(0, 297)}...` };
  if (extra.retryable !== undefined) error.retryable = extra.retryable;
  if (extra.hint !== undefined) error.hint = extra.hint.slice(0, 200);
  return { ok: false, binding: { ...binding, step: binding.step ?? 0 }, error };
}
