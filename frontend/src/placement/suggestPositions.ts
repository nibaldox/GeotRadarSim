/**
 * `suggest_radar_positions` (WP8): the deterministic position optimizer behind «Sugerir ubicación».
 *
 * Flow (optimizador.md §1–§6, DESIGN §4 decisions 2 and 4, §6):
 * 1. Immutable snapshot at the start: terrain + epoch, effective profile and limits, quality
 *    policy, objective, fixed radars (`keep_analysis_refs`) and the drawn area (AOI) with its key.
 * 2. Coarse pass in the optimizer Worker (WASM only, budget, `terminate()` on Stop).
 * 3. Each chosen position is verified at full resolution through the app's own path
 *    (`setRadarPosition` [+ `azCenterOverride` with an AOI] → `runAnalysisAndWait`), which
 *    inserts it in the history with its `[A#]`. Every citable figure comes from those `[A#]` and
 *    their union (`metricsData`, the same function as `get_coverage_metrics`).
 * 4. The coarse score only ranks: it is returned as `_index` (never citable) and labelled
 *    «estimado en la grilla gruesa». The (1 − 1/e) bound is reported only with its scope.
 *
 * R8-FIX C1: the run signature (terrain key + epoch, profile + overrides, policy + metric, fixed
 * radars, AOI key + canonical polygon + hash) is compared after the coarse pass and before and
 * after every `runAnalysisAndWait`; any difference is `SUPERSEDED`. Each `C#` keeps the signature
 * it was verified with. C2: a failure during the verification lists, as `left_in_history`, the
 * `[A#]` this call already inserted (they are valid analyses; the store has no remove-by-ID).
 */

import { useAnalysisStore } from "../store/analysisStore";
import type { HistoryEntry } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { flattenGridForWasm } from "../wasm/loader";
import { AoiError, aoiMaskForGrid, validateAoiPolygon, type AoiPolygon } from "../utils/aoi";
import { createModuleWorker } from "../services/moduleWorker";
import optimizerWorkerUrl from "../workers/optimizerWorker.ts?worker&url";
import type {
  OptimizerJobProgress,
  OptimizerJobRequest,
  OptimizerJobResult,
  OptimizerRadar,
  OptimizerWorkerMessage,
} from "../workers/optimizerWorker";
import { normalizeAzimuthRangeForWorker } from "../workers/optimizerWorker";
import type { CandidateSet, OptimizerObjective } from "../utils/optimizer/types";
import type { QualityMetric, QualityPolicy } from "../utils/qualityMetrics";
import type { RadarConfig } from "../types/api";
import type { ToolContext, ConfirmationRequest, ToolEnvelope } from "./toolEnvelope";
import {
  activeTerrain,
  busyEnvelope,
  cancelledEnvelope,
  currentPolicy,
  failEnvelope,
  historyFor,
  historyRefs,
  isUserBusy,
  metricsData,
  okEnvelope,
  refExhaustedEnvelope,
  refsForIds,
  round3,
  storeFailureEnvelope,
  supersededEnvelope,
  terrainProblem,
  toLocal,
  userCancelledEnvelope,
  type ActiveTerrain,
} from "./appState";
import type { PlacementRefMap } from "./refs";

type Args = Record<string, unknown>;

export const COARSE_LABEL = "estimado en la grilla gruesa; solo ordena las posiciones, no es una cifra de la app";
export const MAX_HISTORY = 10;

// ---------------------------------------------------------------------------
// Running the Worker

export type OptimizerRunOutcome =
  | { status: "result"; result: OptimizerJobResult }
  | { status: "error"; code: "NOT_AVAILABLE" | "OPTIMIZER_FAILED" | "TIMEOUT"; message: string }
  | { status: "cancelled" };

export interface OptimizerRunOptions {
  signal: AbortSignal;
  onProgress?: (progress: OptimizerJobProgress) => void;
}

export type OptimizerRunner = (request: OptimizerJobRequest, options: OptimizerRunOptions) => Promise<OptimizerRunOutcome>;

/**
 * R8-FIX C3 · page-side watchdog margin. The Worker's own budget covers the coarse LOS; this
 * margin covers loading the WASM module and the last LOS (whose engine deadline is the remaining
 * budget). If the Worker sends no message for (remaining budget + 30 s), it is terminated and the
 * run ends as `TIMEOUT`.
 */
export const OPTIMIZER_WATCHDOG_MARGIN_MS = 30_000;

/**
 * Runs one job in a fresh optimizer Worker. Abort → `terminate()` at once and `cancelled`; a
 * late message after that is ignored, so no partial result is ever published. A silent Worker
 * is stopped by the watchdog (`OPTIMIZER_WATCHDOG_MARGIN_MS`).
 */
export function runOptimizerInWorker(
  request: OptimizerJobRequest,
  options: OptimizerRunOptions,
  createWorker: () => Worker = () => createModuleWorker(optimizerWorkerUrl),
): Promise<OptimizerRunOutcome> {
  return new Promise((resolve) => {
    if (options.signal.aborted) return resolve({ status: "cancelled" });
    let worker: Worker;
    try {
      worker = createWorker();
    } catch {
      return resolve({ status: "error", code: "NOT_AVAILABLE", message: "No se pudo iniciar el proceso del optimizador en este navegador." });
    }
    let settled = false;
    const budgetEndsAt = Date.now() + Math.max(0, request.timeBudgetS) * 1000;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = setTimeout(() => finish({
        status: "error", code: "TIMEOUT", message: "El optimizador no respondió dentro del presupuesto de tiempo y se detuvo.",
      }), Math.max(0, budgetEndsAt - Date.now()) + OPTIMIZER_WATCHDOG_MARGIN_MS);
    };
    const finish = (outcome: OptimizerRunOutcome) => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      options.signal.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };
    const onAbort = () => finish({ status: "cancelled" });
    options.signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<OptimizerWorkerMessage>) => {
      if (settled) return;
      arm();
      const message = event.data;
      if (message.type === "progress") {
        try {
          options.onProgress?.(message.progress);
        } catch {
          /* a broken listener must not break the run */
        }
      } else if (message.type === "result") finish({ status: "result", result: message.result });
      else finish({ status: "error", code: message.code, message: message.message });
    };
    worker.onerror = () => finish({ status: "error", code: "OPTIMIZER_FAILED", message: "El optimizador falló." });
    arm();
    try {
      worker.postMessage(request, [request.values.buffer]);
    } catch {
      finish({ status: "error", code: "OPTIMIZER_FAILED", message: "No se pudo enviar el terreno al optimizador." });
    }
  });
}

let runner: OptimizerRunner = runOptimizerInWorker;
let available: () => boolean = () => typeof Worker !== "undefined" && typeof WebAssembly !== "undefined";

/** Test seam: replace the Worker runner and the availability probe (null restores the defaults). */
export function setOptimizerRunnerForTests(next: { runner: OptimizerRunner; available?: () => boolean } | null): void {
  runner = next ? next.runner : runOptimizerInWorker;
  available = next?.available ?? (() => typeof Worker !== "undefined" && typeof WebAssembly !== "undefined");
}

/** R8-FIX C4: progress of one run, tagged with its `runId` and the tool call's `callId`. */
export type OptimizerProgressEvent = OptimizerJobProgress & { readonly runId: string; readonly callId: string };
type ProgressListener = (event: OptimizerProgressEvent) => void;
const progressListeners = new Set<ProgressListener>();
let runCounter = 0;

// ---------------------------------------------------------------------------
// R15b F2 · one suggestion at a time (every caller shares this module-level lock)

export const SUGGESTION_BUSY_MESSAGE = "Ya hay una sugerencia de ubicación en curso.";
let activeSuggestion: symbol | null = null;
const lockListeners = new Set<() => void>();
const notifyLock = () => {
  for (const listener of [...lockListeners]) {
    try {
      listener();
    } catch {
      /* a broken listener must not break the lock */
    }
  }
};
/** True while a `suggest_radar_positions` run (from any caller) is active. */
export function isSuggestionRunning(): boolean {
  return activeSuggestion !== null;
}
/** The panel re-renders on lock changes to disable «Calcular sugerencia» (`useSyncExternalStore`). */
export function subscribeSuggestionLock(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}
/** The trace card / UI subscribes here: `{phase, done, total, bestValue, runId, callId}` of the running job. */
export function subscribeOptimizerProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Snapshot helpers

/** Effective radar exactly as `services/api.ts` runLOSAnalysis builds it from a profile and overrides. */
export function effectiveRadar(
  radar: RadarConfig,
  o: { rangeMin: number | null; rangeMax: number | null; elMin: number | null; elMax: number | null; azCenter: number | null; azWidth: number | null },
): OptimizerRadar {
  const base: OptimizerRadar = {
    min_range_m: o.rangeMin ?? radar.min_range_m,
    max_range_m: o.rangeMax ?? radar.max_range_m,
    elevation_min_deg: o.elMin ?? radar.elevation_min_deg,
    elevation_max_deg: o.elMax ?? radar.elevation_max_deg,
    h_beam_width_deg: radar.h_beam_width_deg,
    scan_pattern: radar.scan_pattern,
    azimuth_range_deg: radar.azimuth_range_deg ? [radar.azimuth_range_deg[0], radar.azimuth_range_deg[1]] : null,
  };
  if (o.azCenter === null && o.azWidth === null) return base;
  return {
    ...base,
    azimuth_range_deg: normalizeAzimuthRangeForWorker(o.azCenter ?? 0, o.azWidth ?? radar.h_beam_width_deg),
    scan_pattern: "RAR",
  };
}

function storeOverrides() {
  const s = useAnalysisStore.getState();
  return {
    rangeMin: s.rangeMinOverride, rangeMax: s.rangeMaxOverride, elMin: s.elMinOverride, elMax: s.elMaxOverride,
    azCenter: s.azCenterOverride, azWidth: s.azWidthOverride,
  };
}

const sameKey = (a: { terrain_id: string; epoch: number } | null, b: { terrain_id: string; epoch: number } | null): boolean =>
  !!a && !!b && a.terrain_id === b.terrain_id && a.epoch === b.epoch;

const metricOf = (objective: OptimizerObjective): QualityMetric => (objective === "USEFUL_PROJECTION" ? "PROJECTION" : "INCIDENCE");

const OBJECTIVES: readonly OptimizerObjective[] = ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"];

interface Plan {
  k: number;
  keep: string[];
  objective: OptimizerObjective;
  candidateSet: CandidateSet;
  minSeparationM: number;
  heightAboveGroundM: number;
  timeBudgetS: number;
}

function planOf(args: Args): Plan | string {
  const k = args.k;
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > 4) return "k debe ser un entero entre 1 y 4.";
  const keep = Array.isArray(args.keep_analysis_refs) ? args.keep_analysis_refs.map(String) : [];
  const objective = (args.objective ?? "USEFUL_INCIDENCE") as OptimizerObjective;
  if (!OBJECTIVES.includes(objective)) return "Objetivo no válido.";
  const candidateSet = (args.candidate_set ?? "edges_and_berms") as CandidateSet;
  if (candidateSet !== "edges_and_berms" && candidateSet !== "regular_grid") return "Conjunto de candidatos no válido.";
  const minSeparationM = typeof args.min_separation_m === "number" ? args.min_separation_m : 50;
  const heightAboveGroundM = typeof args.height_above_ground_m === "number" ? args.height_above_ground_m : 2;
  const timeBudgetS = typeof args.time_budget_s === "number" ? args.time_budget_s : 90;
  if (![minSeparationM, heightAboveGroundM, timeBudgetS].every(Number.isFinite) || minSeparationM < 0 || heightAboveGroundM < 0 ||
      heightAboveGroundM > 50 || timeBudgetS < 10 || timeBudgetS > 600) {
    return "Separación, altura o presupuesto de tiempo no válidos.";
  }
  return { k, keep, objective, candidateSet, minSeparationM, heightAboveGroundM, timeBudgetS };
}

/**
 * R8-FIX C4 (R8A-5): the drawn area is validated before running, with a Spanish reason:
 * empty, collinear (no surface), smaller than one cell, or without any terrain cell.
 */
function aoiProblemOf(polygon: AoiPolygon, terrain: ActiveTerrain): string | null {
  const vertices = Array.isArray(polygon?.vertices) ? polygon.vertices : [];
  if (vertices.length === 0) return "El área a monitorear está vacía; dibújala de nuevo.";
  const COLLINEAR = "Los vértices del área a monitorear son colineales: el área no tiene superficie. Dibújala de nuevo.";
  // All vertices on one line (validateAoiPolygon reports that as overlapping edges).
  const [p0, p1] = [vertices[0]!, vertices.find((v) => v.x !== vertices[0]!.x || v.y !== vertices[0]!.y)];
  if (vertices.length >= 3 && p1 && vertices.every((v) => (p1.x - p0.x) * (v.y - p0.y) - (p1.y - p0.y) * (v.x - p0.x) === 0)) return COLLINEAR;
  let validated: AoiPolygon;
  try {
    validated = validateAoiPolygon({ vertices });
  } catch (error) {
    if (error instanceof AoiError) {
      if (error.code === "AOI_ZERO_AREA") return COLLINEAR;
      if (error.code === "AOI_TOO_FEW_VERTICES") return "El área a monitorear necesita al menos tres vértices; dibújala de nuevo.";
    }
    return "El área a monitorear no es válida; dibújala de nuevo.";
  }
  let twice = 0;
  const ring = validated.vertices;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  const resolution = terrain.metadata.resolution;
  if (Math.abs(twice) / 2 < resolution * resolution) {
    return "El área a monitorear es menor que una celda del terreno; dibújala más grande.";
  }
  let mask: Uint8Array;
  try {
    mask = aoiMaskForGrid({ grid: terrain.grid, bounds: terrain.metadata.bounds, resolution }, validated);
  } catch (error) {
    // R8C-1: aoiMaskForGrid throws AOI_OUTSIDE_TERRAIN for an area that misses the terrain extent.
    if (error instanceof AoiError && error.code === "AOI_OUTSIDE_TERRAIN") return "El área a monitorear no se superpone con el terreno cargado.";
    return "El área a monitorear no es válida; dibújala de nuevo.";
  }
  if (!mask.some((v) => v === 1)) return "El área a monitorear no contiene ninguna celda con datos del terreno.";
  return null;
}

// ---------------------------------------------------------------------------
// Run signature (R8-FIX C1) and partial verification (C2)

interface RunSnapshot {
  terrainKey: { terrain_id: string; epoch: number };
  profileId: string;
  overrides: ReturnType<typeof storeOverrides>;
  policy: QualityPolicy;
  /** The objective's metric (fixed by the arguments; the layer mode does not change the figures). */
  metric: QualityMetric;
  /** History IDs of the fixed radars; each must stay in the history. */
  fixedIds: string[];
  /** AOI key + canonical polygon + hash, or null without an area. */
  aoi: { terrainKey: { terrain_id: string; epoch: number } | null; vertices: Array<[number, number]>; hash: string } | null;
  /** WP15b: false when the caller chose not to use the drawn area; AOI changes are then ignored. */
  aoiUsed: boolean;
}

/** FNV-1a 32-bit, hex; only used to make the AOI part of the signature compact and comparable. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `aoiStore.polygon` is the validated canonical ring (editing order lives in `vertices`). */
function aoiSignatureOf(aoi: { polygon: { vertices: readonly { x: number; y: number }[] } | null; terrainKey: { terrain_id: string; epoch: number } | null } | null): RunSnapshot["aoi"] {
  if (!aoi || !aoi.polygon) return null;
  const vertices = aoi.polygon.vertices.map((v): [number, number] => [v.x, v.y]);
  return {
    terrainKey: aoi.terrainKey ? { terrain_id: aoi.terrainKey.terrain_id, epoch: aoi.terrainKey.epoch } : null,
    vertices,
    hash: fnv1a(JSON.stringify(vertices)),
  };
}

function snapshotSignature(run: RunSnapshot): string {
  const o = run.overrides;
  return JSON.stringify([
    run.terrainKey.terrain_id, run.terrainKey.epoch, run.profileId,
    o.rangeMin, o.rangeMax, o.elMin, o.elMax, o.azCenter, o.azWidth,
    run.policy.mediumMin, run.policy.highMin, run.metric, run.fixedIds,
    run.aoi ? [run.aoi.terrainKey?.terrain_id ?? null, run.aoi.terrainKey?.epoch ?? null, run.aoi.hash, run.aoi.vertices] : null,
  ]);
}

/** The same signature read from the live stores; fixed radars that left the history drop out. */
function liveSignature(run: RunSnapshot): string {
  const terrain = activeTerrain();
  if (!terrain) return "no-terrain";
  const s = useAnalysisStore.getState();
  const policy = currentPolicy();
  const present = new Set(historyFor(terrain.key).map((e) => e.snapshot?.analysisId));
  const aoi = useAoiStore.getState();
  return snapshotSignature({
    terrainKey: terrain.key,
    profileId: s.selectedRadarId ?? "",
    overrides: storeOverrides(),
    policy: { mediumMin: policy.mediumMin, highMin: policy.highMin },
    metric: run.metric,
    fixedIds: run.fixedIds.filter((id) => present.has(id)),
    aoi: run.aoiUsed ? aoiSignatureOf(aoi.polygon ? aoi : null) : null,
    aoiUsed: run.aoiUsed,
  });
}

/**
 * C2 (variant `left_in_history`): `analysisStore` has no remove-by-ID action (only
 * `removeHistoryEntry(index)`, which also cancels in-flight work), so the tool never removes
 * entries. A failure after some verification lists the `[A#]` it inserted that are still present.
 */
function leftInHistory(
  envelope: ToolEnvelope,
  refs: PlacementRefMap,
  key: { terrain_id: string; epoch: number },
  inserted: ReadonlyArray<{ ref: string; id: string }>,
): ToolEnvelope {
  if (envelope.ok) return envelope;
  const present = new Set(historyFor(key).map((e) => e.snapshot?.analysisId));
  const left = inserted.filter((v) => present.has(v.id) && refs.resolveAnalysis(v.ref).status === "ok").map((v) => v.ref);
  if (left.length === 0) return envelope;
  const list = left.join(", ");
  const note = ` Quedaron en el historial ${list}: son análisis válidos de esas posiciones, pero la sugerencia quedó incompleta.`;
  const message = (envelope.error.message + note).slice(0, 300);
  return {
    ...envelope,
    binding: { ...envelope.binding, analysis_refs: left },
    error: { ...envelope.error, message, hint: `left_in_history: [${list}]` },
  };
}

// ---------------------------------------------------------------------------
// The tool

export interface SuggestToolImpl {
  mutates: boolean;
  confirmation: "always" | "conditional" | "never";
  label(args: Args): string;
  confirm(args: Args): ConfirmationRequest | null;
  canonicalArgs?(args: Args): Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<ToolEnvelope>;
}

/** WP15b: options of the «Sugerir ubicación» panel; other callers use the defaults. */
export interface SuggestRadarPositionsOptions {
  /** Read at confirmation and at the start of each run; false ignores the drawn area. Default: true. */
  useAoi?: () => boolean;
}

export function createSuggestRadarPositions(
  refs: PlacementRefMap,
  candidateSignature: () => string,
  options: SuggestRadarPositionsOptions = {},
): SuggestToolImpl {
  const useAoi = options.useAoi ?? (() => true);
  const noAoi = { polygon: null, terrainKey: null };
  /** User entries the new LOS runs would push out of the history. */
  const displacedBy = (terrain: ActiveTerrain, k: number) => {
    const rows = historyRefs(refs, terrain.key);
    const overflow = Math.max(0, rows.length + k - MAX_HISTORY);
    return rows.slice(rows.length - overflow);
  };
  const shown = new Map<string, string>();
  const effectKey = (args: Args) => JSON.stringify([args.k, args.keep_analysis_refs ?? []]);
  const effectState = (terrain: ActiveTerrain | null, k: number) =>
    terrain ? JSON.stringify([terrain.key.epoch, displacedBy(terrain, k).map((r) => r.ref)]) : "none";

  return {
    mutates: true,
    confirmation: "always",
    label: (args) => `Busqué ${typeof args.k === "number" ? args.k : ""} posiciones sugeridas y las verifiqué con la línea de visión`.replace("  ", " "),
    confirm: (args) => {
      const terrain = activeTerrain();
      if (!terrain || typeof args.k !== "number") return null;
      const k = args.k;
      const displaced = displacedBy(terrain, k);
      shown.set(effectKey(args), effectState(terrain, k));
      const base = `Buscaré hasta ${k} posiciones con el optimizador y verificaré cada una con una línea de visión a resolución completa; ` +
        `cada verificación se agrega al historial y cambia la posición del radar.`;
      const aoi = useAoi() && useAoiStore.getState().polygon ? " Con el área a monitorear, también se fija el centro del azimut del radar." : "";
      if (displaced.length === 0) return { kind: "long_running", effect: base + aoi };
      return {
        kind: "destructive",
        effect: `${base}${aoi} El historial quedará lleno: se descartarán ${displaced.length} análisis antiguos (${displaced.map((r) => r.ref ?? "sin ref").join(", ")}).`,
      };
    },
    execute: async (args, ctx) => {
      // F2: a second run while one is active is BUSY; the lock is released on every exit (finally).
      if (activeSuggestion !== null) return failEnvelope(ctx.step, "BUSY", SUGGESTION_BUSY_MESSAGE, { retryable: true });
      const token = Symbol("suggestion");
      activeSuggestion = token;
      notifyLock();
      try {
        return await executeRun(args, ctx);
      } finally {
        if (activeSuggestion === token) {
          activeSuggestion = null;
          notifyLock();
        }
      }
    },
  };

  async function executeRun(args: Args, ctx: ToolContext): Promise<ToolEnvelope> {
    {
      if (ctx.signal.aborted) return cancelledEnvelope(ctx.step);
      if (!available()) {
        return failEnvelope(ctx.step, "NOT_AVAILABLE", "El optimizador de posiciones necesita Web Workers y WebAssembly, que no están disponibles aquí.");
      }
      if (isUserBusy()) return busyEnvelope(ctx.step);
      const problem = terrainProblem(ctx.step);
      if (problem) return problem;
      const plan = planOf(args);
      if (typeof plan === "string") return failEnvelope(ctx.step, "INVALID_ARGUMENT", plan);
      const terrain = activeTerrain()!;
      const state = useAnalysisStore.getState();
      const profile = state.radars.find((r) => r.model_id === state.selectedRadarId) ?? null;
      if (!profile) return failEnvelope(ctx.step, "NO_PROFILE", "Primero selecciona un perfil de radar.");
      const overrides = storeOverrides();
      if (Object.values(overrides).some((v) => v !== null && !Number.isFinite(v))) {
        return failEnvelope(ctx.step, "INVALID_ARGUMENT", "Los límites del radar no son números finitos.");
      }
      const shownState = shown.get(effectKey(args));
      shown.delete(effectKey(args));
      if (shownState !== undefined && shownState !== effectState(terrain, plan.k)) {
        return failEnvelope(ctx.step, "STALE_REF", "El historial o el terreno cambiaron desde la confirmación; no ejecuté la búsqueda. Vuelve a pedirla.", { retryable: true });
      }

      // Fixed radars: history entries of this terrain.
      const history = historyFor(terrain.key);
      const fixedEntries: HistoryEntry[] = [];
      for (const ref of plan.keep) {
        const resolved = refs.resolveAnalysis(ref);
        if (resolved.status === "unknown") return failEnvelope(ctx.step, "INVALID_ARGUMENT", `${ref} no existe; usa list_analyses.`);
        if (resolved.status === "stale") return failEnvelope(ctx.step, "STALE_REF", `${ref} pertenece a un terreno anterior o ya no está en el historial.`);
        const entry = history.find((e) => e.snapshot?.analysisId === resolved.value);
        if (!entry) return failEnvelope(ctx.step, "STALE_REF", `${ref} ya no está en el historial (tope de 10 entradas).`);
        fixedEntries.push(entry);
      }
      // Fixed + k ≤ 10, and the new entries must not push a fixed radar out of the history.
      if (fixedEntries.length + plan.k > MAX_HISTORY) {
        return failEnvelope(ctx.step, "INVALID_ARGUMENT", "Los radares fijos más k no pueden superar 10, el tope del historial.");
      }
      const displaced = displacedBy(terrain, plan.k);
      if (displaced.some((row) => fixedEntries.includes(row.entry))) {
        return failEnvelope(ctx.step, "INVALID_ARGUMENT", "El historial está lleno: las verificaciones descartarían un radar fijo. Borra análisis antiguos o reduce k.");
      }
      if (!refs.canMint("A", plan.k) || !refs.canMint("C", plan.k)) return refExhaustedEnvelope(ctx.step);
      const fixed: OptimizerJobRequest["fixed"][number][] = [];
      for (const entry of fixedEntries) {
        const snap = entry.snapshot?.radars[0];
        const fixedProfile = state.radars.find((r) => r.model_id === (snap?.radarModelId ?? entry.radarId));
        if (!snap || !fixedProfile) return failEnvelope(ctx.step, "STALE_REF", "Un radar fijo no tiene la configuración de su análisis.");
        fixed.push({ position: { x: entry.position.x, y: entry.position.y, z: entry.position.z }, radar: effectiveRadar(fixedProfile, snap.overrides) });
      }

      // Area to monitor, bound to the terrain it was drawn on.
      const aoiUsed = useAoi();
      const aoiState = aoiUsed ? useAoiStore.getState() : noAoi;
      let aoi: OptimizerJobRequest["aoi"];
      const azimuthWidthDeg = overrides.azWidth ?? profile.h_beam_width_deg;
      if (aoiState.polygon) {
        if (!sameKey(aoiState.terrainKey, terrain.key)) {
          return failEnvelope(ctx.step, "STALE_REF", "El área a monitorear pertenece a otro terreno; dibújala de nuevo.");
        }
        const aoiProblem = aoiProblemOf(aoiState.polygon, terrain);
        if (aoiProblem) return failEnvelope(ctx.step, "INVALID_ARGUMENT", aoiProblem);
        aoi = {
          polygon: { vertices: aoiState.polygon.vertices.map((v) => ({ x: v.x, y: v.y })) },
          profile: {
            rangeMinM: overrides.rangeMin ?? profile.min_range_m,
            rangeMaxM: overrides.rangeMax ?? profile.max_range_m,
            azimuthWidthDeg,
          },
        };
      }

      // Immutable snapshot (R8-FIX C1): every later check compares the live app against it.
      const policy: QualityPolicy = { mediumMin: currentPolicy().mediumMin, highMin: currentPolicy().highMin };
      const metric = metricOf(plan.objective);
      const metadata = terrain.metadata;
      const run: RunSnapshot = {
        terrainKey: { terrain_id: terrain.key.terrain_id, epoch: terrain.key.epoch },
        profileId: profile.model_id,
        overrides: { ...overrides },
        policy,
        metric,
        fixedIds: fixedEntries.map((e) => e.snapshot!.analysisId!),
        aoi: aoiSignatureOf(aoiState.polygon ? aoiState : null),
        aoiUsed,
      };
      runCounter += 1;
      const runId = `optim-${runCounter}`;
      const request: OptimizerJobRequest = {
        runId,
        values: flattenGridForWasm(terrain.grid),
        rows: metadata.grid_rows,
        cols: metadata.grid_cols,
        min_x: metadata.bounds.min_x,
        min_y: metadata.bounds.min_y,
        resolution: metadata.resolution,
        // With an AOI each candidate gets its own azimuth centre (the width stays the user's).
        radar: effectiveRadar(profile, aoi ? { ...overrides, azCenter: null, azWidth: null } : overrides),
        azimuthWidthDeg,
        fixed,
        k: plan.k,
        objective: plan.objective,
        policy: { mediumMin: policy.mediumMin, highMin: policy.highMin },
        candidateSet: plan.candidateSet,
        minSeparationM: plan.minSeparationM,
        heightAboveGroundM: plan.heightAboveGroundM,
        timeBudgetS: plan.timeBudgetS,
        ...(aoi ? { aoi } : {}),
      };
      /** The live app still matches the snapshot; `azCenter` is the value the tool itself expects now. */
      const current = (azCenter: number | null): boolean =>
        liveSignature(run) === snapshotSignature({ ...run, overrides: { ...run.overrides, azCenter } });

      const outcome = await runner(request, {
        signal: ctx.signal,
        onProgress: (progress) => {
          const event: OptimizerProgressEvent = { ...progress, runId, callId: ctx.callId };
          for (const listener of [...progressListeners]) {
            try {
              listener(event);
            } catch {
              /* ignore */
            }
          }
        },
      });
      if (outcome.status === "cancelled" || ctx.signal.aborted) return cancelledEnvelope(ctx.step);
      if (!current(run.overrides.azCenter)) return supersededEnvelope(ctx.step);
      if (outcome.status === "error") {
        if (outcome.code === "NOT_AVAILABLE") return failEnvelope(ctx.step, "NOT_AVAILABLE", outcome.message);
        if (outcome.code === "TIMEOUT") {
          return failEnvelope(ctx.step, "TIMEOUT", "El optimizador no respondió dentro del presupuesto de tiempo y se detuvo; puedes reintentar o usar un presupuesto mayor.", { retryable: true });
        }
        return failEnvelope(ctx.step, "ANALYSIS_FAILED", outcome.message);
      }
      const job = outcome.result;
      if (job.status === "BUDGET_EXCEEDED") {
        return failEnvelope(ctx.step, "TIMEOUT", `La búsqueda superó el presupuesto de tiempo y se detuvo sin resultado. ${job.reductionNote}`.trim(), { retryable: true });
      }
      const coarse = job.coarse!;
      if (job.status !== "OK" || !coarse.greedy || coarse.greedy.selected.length === 0) {
        const message = coarse.aoi?.message ??
          (job.status === "NO_CANDIDATES" ? "No hay posiciones candidatas en este terreno." : "Ninguna posición candidata agrega cobertura con la métrica elegida.");
        return failEnvelope(ctx.step, "ANALYSIS_FAILED", message);
      }
      if (isUserBusy()) return busyEnvelope(ctx.step);

      // Full-resolution verification through the app's own path, revalidated before and after each LOS.
      const verified: { candidate: number; ref: string; entry: HistoryEntry; signature: string }[] = [];
      /** C2: the store has no remove-by-ID action, so entries this call inserted are reported, never removed. */
      const partial = (envelope: ToolEnvelope): ToolEnvelope => leftInHistory(envelope, refs, terrain.key, verified.map((v) => ({ ref: v.ref, id: v.entry.snapshot!.analysisId! })));
      let expectedAz = run.overrides.azCenter;
      for (const index of coarse.greedy.selected) {
        const candidate = coarse.candidates[index]!;
        const orientation = coarse.aoi?.candidates[index];
        if (!current(expectedAz)) return partial(supersededEnvelope(ctx.step));
        const store = useAnalysisStore.getState();
        if (orientation) {
          store.setOverrides({ azCenter: orientation.az_center_deg });
          expectedAz = orientation.az_center_deg;
        }
        store.setRadarPosition({ x: candidate.x, y: candidate.y, z: candidate.z });
        const placed = useAnalysisStore.getState().radarPosition;
        if (!placed || placed.x !== candidate.x || placed.y !== candidate.y || placed.z !== candidate.z || !current(expectedAz)) {
          return partial(supersededEnvelope(ctx.step));
        }
        // R8A-3: the C# signature is the one this candidate is verified with.
        const signature = candidateSignature();
        const idsBefore = new Set(historyFor(run.terrainKey).map((e) => e.snapshot?.analysisId));
        const outcomeRun = await useAnalysisStore.getState().runAnalysisAndWait(run.terrainKey.terrain_id, { signal: ctx.signal });
        // Record the entry this LOS inserted first: even if the run is then rejected it stays in the
        // history. A change that lands inside the publication makes the store answer `superseded`
        // with the entry already in (R8C-2 «sync»), so it is found by identity, not by the outcome.
        const insertedId = outcomeRun.status === "published" && outcomeRun.epoch === run.terrainKey.epoch ? outcomeRun.analysisId
          : historyFor(run.terrainKey).find((e) => e.origin === "agent" && e.snapshot?.analysisId && !idsBefore.has(e.snapshot.analysisId) &&
            e.position.x === candidate.x && e.position.y === candidate.y && e.position.z === candidate.z)?.snapshot?.analysisId ?? null;
        if (insertedId) {
          const entry = historyFor(run.terrainKey).find((e) => e.snapshot?.analysisId === insertedId);
          const ref = entry ? refs.analysisRef(run.terrainKey, insertedId) : null;
          if (entry && ref) verified.push({ candidate: index, ref, entry, signature });
          else if (entry) return partial(refExhaustedEnvelope(ctx.step));
        }
        if (outcomeRun.status === "cancelled" && outcomeRun.reason === "user") return partial(userCancelledEnvelope(ctx.step));
        if (outcomeRun.status === "cancelled" || ctx.signal.aborted) return partial(cancelledEnvelope(ctx.step));
        if (outcomeRun.status === "superseded") return partial(supersededEnvelope(ctx.step));
        if (outcomeRun.status === "failed") return partial(storeFailureEnvelope(ctx.step, outcomeRun.error));
        const last = verified[verified.length - 1];
        if (!last || last.candidate !== index || !current(expectedAz)) return partial(supersededEnvelope(ctx.step));
        const pos = last.entry.position;
        if (pos.x !== candidate.x || pos.y !== candidate.y || pos.z !== candidate.z) return partial(supersededEnvelope(ctx.step));
      }

      // Union of fixed + chosen, in history order (the app's union).
      const now = terrain;
      const ids = [...run.fixedIds, ...verified.map((v) => v.entry.snapshot!.analysisId!)];
      const order = historyFor(now.key).map((e) => e.snapshot?.analysisId);
      const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      let union: Record<string, unknown> | null = null;
      let unionRefs: string[] = [];
      if (sorted.length > 1) {
        if (!current(expectedAz) || !useAnalysisStore.getState().setHistorySelection(sorted)) return partial(supersededEnvelope(ctx.step));
        const after = useAnalysisStore.getState();
        if (!after.losResult || !after.activeSnapshot || !current(expectedAz)) return partial(supersededEnvelope(ctx.step));
        const sourceRefs = refsForIds(refs, now.key, after.activeSnapshot.sourceAnalysisIds);
        if (!sourceRefs) return partial(refExhaustedEnvelope(ctx.step));
        unionRefs = sourceRefs;
        const u = metricsData(after.losResult, after.activeSnapshot, now, metric, policy, { source_refs: sourceRefs });
        union = {
          source_refs: sourceRefs,
          visibility_candidates_pct: u.visibility_candidates_pct,
          useful_coverage_pct: (u.quality as { useful_coverage_pct: number | null } | null)?.useful_coverage_pct ?? null,
          visible_area_m2: u.visible_area_m2,
        };
      }
      if (!current(expectedAz)) return partial(supersededEnvelope(ctx.step));

      const coarseTotal = coarse.aoi ? coarse.aoi.coarseCellCount : coarse.coarse.rows * coarse.coarse.cols;
      const suggestions = [];
      for (const v of verified) {
        const candidate = coarse.candidates[v.candidate]!;
        const local = toLocal({ x: candidate.x, y: candidate.y, z: candidate.z }, now.metadata);
        const candidateId = refs.registerCandidate(now.key, {
          x_m: local.x_m, y_m: local.y_m, height_above_ground_m: plan.heightAboveGroundM, signature: v.signature,
        });
        if (!candidateId) return partial(refExhaustedEnvelope(ctx.step));
        const m = metricsData(v.entry.result, v.entry.snapshot ?? null, now, metric, policy, { analysis_ref: v.ref });
        const orientation = coarse.aoi?.candidates[v.candidate];
        suggestions.push({
          candidate_id: candidateId,
          analysis_ref: v.ref,
          kind: candidate.kind,
          position: { x_m: local.x_m, y_m: local.y_m },
          visibility_candidates_pct: m.visibility_candidates_pct,
          useful_coverage_pct: (m.quality as { useful_coverage_pct: number | null } | null)?.useful_coverage_pct ?? null,
          visible_area_m2: m.visible_area_m2,
          coarse_score_index: coarseTotal > 0 ? round3(coarse.candidateValues[v.candidate]! / coarseTotal) : null,
          ...(orientation ? { aoi_fits_azimuth: orientation.aoi_fits_azimuth } : {}),
        });
      }
      const greedy = coarse.greedy;
      const refsAll = unionRefs.length > 0 ? unionRefs : verified.map((v) => v.ref);
      const data: Record<string, unknown> = {
        objective: plan.objective,
        metric,
        suggestions,
        union,
        coarse_label: COARSE_LABEL,
        candidate_set_used: coarse.candidateGeneration.candidateSetUsed,
        // R8-FIX C4: an `_index` is display-only, never a citable count (R8A-4).
        candidates_index: coarse.candidates.length,
        stop_reason: greedy.stopReason,
        guarantee: greedy.guarantee === "none"
          ? { kind: "ninguna", note: "Con la proyección del movimiento el voraz no tiene garantía." }
          : { kind: "1-1/e", scope: greedy.guaranteeScope, note: "Vale solo para los candidatos raleados en la grilla gruesa y sin la separación mínima." },
        reduced: job.reductionNote || null,
        note: "Las cifras son las de los análisis [A#] a resolución completa que quedaron en el historial.",
        ...(coarse.aoi ? { aoi_note: "Cada verificación fijó el centro del azimut hacia el área a monitorear y reemplazó el que tenía el usuario." } : {}),
      };
      return okEnvelope(ctx.step, data, { analysis_refs: refsAll, metric, policy });
    }
  }
}
