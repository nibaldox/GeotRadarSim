/**
 * Shared readers and envelope helpers of the «Sugerir ubicación» runtime (moved from the WP4 tools).
 *
 * Everything here reads the REAL zustand stores. Positions are converted to
 * the model's local frame (metres from min_x/min_y/min_z) through WP2's
 * `localFrame`; figures are rounded like the UI and every numeric field of a
 * result carries a type suffix (`_pct`, `_m2`, `_m`, `_deg`, `_s`, `_count`,
 * plus `_index` for the dimensionless geometric indices) so the citation
 * verifier can type it.
 */

import { useAnalysisStore, type HistoryEntry, type TerrainKey } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { computeQualitySummary, type QualityMetric, type QualityPolicy } from "../utils/qualityMetrics";
import { terrainToLocal } from "../utils/localFrame";
import type { AnalysisSnapshot, DTMMetadata, LOSResponse, Point3D, RadarConfig } from "../types/api";
import { errorEnvelope, type ToolBinding, type ToolEnvelope, type ToolErrorCode } from "./toolEnvelope";
import type { PlacementRefMap } from "./refs";

// ---------------------------------------------------------------------------
// Rounding (herramientas.md «Redondeo»: % with 1 decimal, m² integers, 0.1 m)

const noNegZero = (value: number): number => (Object.is(value, -0) ? 0 : value);
/** Same `toFixed` as the UI (`QualitySummaryView`, `ExportPanel`), so a figure read on screen verifies (R4 WP4A-5). */
export const round1 = (value: number): number => noNegZero(Number(value.toFixed(1)));
export const round0 = (value: number): number => noNegZero(Number(value.toFixed(0)));
export const round3 = (value: number): number => noNegZero(Math.round(value * 1000) / 1000);
export const pctOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? round1(value) : null;

// ---------------------------------------------------------------------------
// Binding and terrain

export interface ActiveTerrain {
  key: TerrainKey;
  metadata: DTMMetadata;
  grid: number[][];
}

export const terrainRefOf = (epoch: number): string => `T${epoch}`;

/** Committed terrain key (metadata and grid are committed together by terrainStore). */
export function currentTerrainKey(): TerrainKey | null {
  const key = useTerrainStore.getState().terrainKey;
  return key ? { terrain_id: key.terrain_id, epoch: key.epoch } : null;
}

/** `{terrain_ref, epoch}` as the loop and the envelopes see it; never the terrain_id. */
export function readBinding(): { terrain_ref: string | null; epoch: number | null } {
  const key = currentTerrainKey();
  return key ? { terrain_ref: terrainRefOf(key.epoch), epoch: key.epoch } : { terrain_ref: null, epoch: null };
}

export function isTransitioning(): boolean {
  return useAnalysisStore.getState().terrainTransitioning || useTerrainStore.getState().loading;
}

/** BUSY comes from `inFlightOrigin` (WP1): work the USER launched is never touched. */
export function isUserBusy(): boolean {
  const analysis = useAnalysisStore.getState();
  return analysis.inFlightOrigin === "user" || analysis.multiLoading || useVectorStore.getState().inFlightOrigin === "user";
}

/** Active terrain only when both stores agree on the same key and nothing is transitioning. */
export function activeTerrain(): ActiveTerrain | null {
  const terrain = useTerrainStore.getState();
  const analysis = useAnalysisStore.getState();
  const key = terrain.terrainKey;
  if (!key || !terrain.metadata || !terrain.grid || analysis.terrainTransitioning) return null;
  if (terrain.metadata.terrain_id !== key.terrain_id) return null;
  if (!analysis.terrainKey || analysis.terrainKey.terrain_id !== key.terrain_id || analysis.terrainKey.epoch !== key.epoch) return null;
  return { key: { terrain_id: key.terrain_id, epoch: key.epoch }, metadata: terrain.metadata, grid: terrain.grid };
}

export interface BindingExtra {
  analysis_refs?: string[];
  metric?: QualityMetric | null;
  policy?: QualityPolicy | null;
}

/** Binding read NOW (tools call this at the END of execution). */
export function endBinding(step: number, extra: BindingExtra = {}): ToolBinding {
  const binding: ToolBinding = { ...readBinding(), step };
  if (extra.analysis_refs && extra.analysis_refs.length > 0) binding.analysis_refs = [...extra.analysis_refs];
  if (extra.metric !== undefined) binding.metric = extra.metric;
  if (extra.policy !== undefined) {
    binding.policy = extra.policy ? { mediumMin: extra.policy.mediumMin, highMin: extra.policy.highMin } : null;
  }
  return binding;
}

export function okEnvelope(step: number, data: Record<string, unknown>, extra: BindingExtra = {}, truncated = false): ToolEnvelope {
  const envelope: ToolEnvelope = { ok: true, binding: endBinding(step, extra), data };
  if (truncated) envelope.truncated = true;
  return envelope;
}

export function failEnvelope(
  step: number,
  code: ToolErrorCode,
  message: string,
  extra: { retryable?: boolean; hint?: string } = {},
): ToolEnvelope {
  return errorEnvelope(endBinding(step), code, message, extra);
}

/** Error envelope when there is no usable terrain, or null when there is one. */
export function terrainProblem(step: number): ToolEnvelope | null {
  if (isTransitioning()) {
    return failEnvelope(step, "TERRAIN_TRANSITIONING", "El terreno se está cargando o reemplazando; espera a que termine.", { retryable: true });
  }
  if (!activeTerrain()) return failEnvelope(step, "NO_TERRAIN", "No hay un terreno cargado. Genera el sintético o pide al usuario que suba un archivo.");
  return null;
}

export function busyEnvelope(step: number): ToolEnvelope {
  return failEnvelope(step, "BUSY", "Hay un análisis del usuario en curso; no lo interrumpo.", { retryable: true });
}

export function cancelledEnvelope(step: number): ToolEnvelope {
  return failEnvelope(step, "CANCELLED_BY_USER", "Detenido por el usuario.");
}

export function supersededEnvelope(step: number, message = "Otra acción reemplazó a esta antes de terminar; sus datos no se usan."): ToolEnvelope {
  return failEnvelope(step, "SUPERSEDED", message, { retryable: true });
}

/** The user pressed the app's Cancel: not retryable, so the loop never relaunches it (R4 WP4B-10). */
export function userCancelledEnvelope(step: number): ToolEnvelope {
  return failEnvelope(step, "CANCELLED_BY_USER", "El usuario canceló el análisis en la app; no lo repito.", { retryable: false });
}

/** Catalog text per code; the raw store text goes only to the local trace (R4 WP4B-2, WP4B-7). */
const GENERIC_FAILURE: Partial<Record<ToolErrorCode, string>> = {
  TIMEOUT: "El cálculo superó el tiempo máximo de la app. Prueba con un tamaño de celda mayor, menos área o menos alcance.",
  INVALID_ARGUMENT: "La posición o los límites no son válidos.",
  ANALYSIS_FAILED: "El cálculo falló en la app.",
};

export function storeFailureEnvelope(step: number, rawMessage: string | null): ToolEnvelope {
  const code = failureCode(rawMessage);
  const envelope = failEnvelope(step, code, GENERIC_FAILURE[code] ?? "El cálculo falló en la app.");
  if (rawMessage && !envelope.ok) envelope.localDetail = rawMessage.slice(0, 300);
  return envelope;
}

export function refExhaustedEnvelope(step: number): ToolEnvelope {
  return failEnvelope(step, "REF_EXHAUSTED", "Se agotaron las referencias de esta sesión; recarga la app.");
}

// ---------------------------------------------------------------------------
// Local frame

export interface LocalPosition {
  x_m: number;
  y_m: number;
  z_m: number;
}

/** Terrain coordinates → model's local metres, through WP2's viewer frame. */
export function toLocal(point: Point3D, metadata: DTMMetadata): LocalPosition {
  const viewer = terrainToLocal(point, metadata.bounds);
  return { x_m: round1(viewer.x), y_m: round1(-viewer.z), z_m: round1(viewer.y) };
}

// ---------------------------------------------------------------------------
// Profiles and limits

export function factoryAzimuth(radar: RadarConfig): { center: number; width: number } {
  const range = radar.azimuth_range_deg;
  if (!range) return { center: 0, width: 360 };
  const [start, end] = range;
  const width = end >= start ? end - start : end - start + 360;
  let center = start + width / 2;
  if (center > 180) center -= 360;
  return { center, width };
}

// ---------------------------------------------------------------------------
// History and refs

export const entryMatchesKey = (entry: HistoryEntry, key: TerrainKey): boolean =>
  entry.terrain_id === key.terrain_id && entry.terrain_epoch === key.epoch && !!entry.snapshot?.analysisId;

/** History entries of the active terrain, newest first (store order). */
export function historyFor(key: TerrainKey): HistoryEntry[] {
  return useAnalysisStore.getState().history.filter((entry) => entryMatchesKey(entry, key));
}

/** Mints refs oldest first so A# grow with time, and returns entry → ref (newest first). */
export function historyRefs(refs: PlacementRefMap, key: TerrainKey): { entry: HistoryEntry; ref: string | null }[] {
  const entries = historyFor(key);
  const out = entries.map((entry) => ({ entry, ref: null as string | null }));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const item = out[i]!;
    item.ref = refs.analysisRef(key, item.entry.snapshot!.analysisId!);
  }
  return out;
}

/** Refs of `ids`, or null when any could not be minted (never a partial scope; R4 WP4A-12). */
export function refsForIds(refs: PlacementRefMap, key: TerrainKey, ids: readonly string[]): string[] | null {
  historyRefs(refs, key);
  const out = ids.map((id) => refs.analysisRef(key, id));
  return out.every((r): r is string => r !== null) ? out : null;
}

export function currentPolicy(): QualityPolicy {
  const policy = useQualityPolicyStore.getState().policy;
  return { mediumMin: policy.mediumMin, highMin: policy.highMin };
}

// ---------------------------------------------------------------------------
// Metrics (x-metrics-data), always from computeQualitySummary like the UI

export interface MetricsScope {
  analysis_ref?: string;
  source_refs?: string[];
}

export function metricsData(
  result: LOSResponse,
  snapshot: AnalysisSnapshot | null,
  terrain: ActiveTerrain,
  metric: QualityMetric,
  policy: QualityPolicy,
  scope: MetricsScope,
): Record<string, unknown> {
  const summary = snapshot
    ? computeQualitySummary({
        metric,
        policy,
        losResult: result,
        terrainGrid: terrain.grid,
        terrainResolution: terrain.metadata.resolution,
        terrainKey: terrain.key,
        snapshot,
      })
    : null;
  const data: Record<string, unknown> = {};
  if (scope.source_refs && scope.source_refs.length > 1) {
    data.kind = "union";
    data.source_refs = [...scope.source_refs];
  } else {
    data.kind = "single";
    if (scope.analysis_ref) data.analysis_ref = scope.analysis_ref;
  }
  data.visibility_candidates_pct = pctOrNull(result.coverage_pct);
  data.completeness_pct = pctOrNull(result.completeness_pct);
  data.visible_area_m2 = round0(result.visible_area_m2);
  data.shadow_zone_count = Array.isArray(result.shadow_zones) ? result.shadow_zones.length : 0;
  data.quality = summary
    ? {
        metric: summary.metric,
        target_cells_count: summary.target.cellCount,
        target_area_m2: round0(summary.target.nominalAreaM2),
        useful_cells_count: summary.usefulCount,
        useful_coverage_pct: pctOrNull(summary.usefulCoveragePct),
        useful_area_m2: summary.usefulAreaM2 === null ? null : round0(summary.usefulAreaM2),
        medium_high_of_visible_pct: pctOrNull(summary.mediumHighAmongVisiblePct),
        distribution_pct: summary.distribution
          ? {
              low: round1(summary.distribution.lowPct),
              medium: round1(summary.distribution.mediumPct),
              high: round1(summary.distribution.highPct),
              no_index: round1(summary.distribution.noIndexPct),
            }
          : null,
      }
    : null;
  data.engine = result.engine_used ?? null;
  return data;
}

/**
 * The app's own deadline messages (`services/api.ts` LOS_WORKER_WATCHDOG_ERROR,
 * `workers/losWorker.ts` deadline check), matched by their fixed wording, never by a
 * loose number (R4 WP4A-7).
 */
const TIMEOUT_MESSAGES: readonly RegExp[] = [
  /^El análisis LOS superó el tiempo máximo de \d+ segundos y fue cancelado/u,
  /^El cálculo de visibilidad LOS excedió el tiempo máximo de ejecución/u,
];

/** Store error → catalog code. */
export function failureCode(message: string | null): ToolErrorCode {
  if (message === "INVALID_ARGUMENT") return "INVALID_ARGUMENT";
  if (message && TIMEOUT_MESSAGES.some((re) => re.test(message))) return "TIMEOUT";
  return "ANALYSIS_FAILED";
}
