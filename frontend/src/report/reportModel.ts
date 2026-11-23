/**
 * Management report model: synchronous capture of the app state at the click
 * and a pure, provenance-checked model builder.
 *
 * - `captureReportInputs` reads the stores without mutating them and applies
 *   the same currency guards as `isCurrentExport` (`components/ExportPanel.tsx`),
 *   reimplemented here as `isCurrentReportState` so this module never imports a
 *   component. It also refuses to capture while an analysis or terrain is loading.
 * - `buildReportModel` resolves every radar's individual result through the path
 *   that produced the active snapshot (selected history entries, or
 *   `deployedRadars[].result` for a multi-radar run), checks ids, epoch,
 *   terrain id, count and order, and computes every figure with the dashboard
 *   helpers (`buildQualityExportContext` → `computeQualitySummary`,
 *   `computeAoiCoverage` with the strict context). No formula is reimplemented;
 *   only the per-cell radar counts (exclusive / overlap) are counted here.
 *
 * Any failure throws a `ReportError` with a contract code and an actionable
 * Spanish message. Nothing is invented and no partial result is used.
 */

import { RADAR_COLORS, useAnalysisStore } from "../store/analysisStore";
import type { DeployedRadar, HistoryEntry } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useVectorStore } from "../store/vectorStore";
import { normalizeAzimuthRange } from "../services/api";
import { LOSCellState } from "../types/api";
import type {
  AnalysisRadarOverrides,
  AnalysisRadarSnapshot,
  AnalysisSnapshot,
  DTMMetadata,
  LOSResponse,
  RadarConfig,
} from "../types/api";
import { isValidQualityPolicy } from "../utils/qualityMetrics";
import type { QualityPolicy } from "../utils/qualityMetrics";
import { buildQualityExportContext, metricForVisualizationMode } from "../utils/qualityReport";
import { aoiMaskForGrid, computeAoiCoverage, validateAoiPolygon } from "../utils/aoi";
import type { AoiPolygon } from "../utils/aoi";
import { ReportError } from "./types";
import type {
  ReportCoverageMetrics,
  ReportMetric,
  ReportModel,
  ReportRadar,
  ReportTerrain,
  ReportUnion,
} from "./types";

export const DEFAULT_REPORT_TITLE = "Informe de cobertura de radares";
/** Palette size: the report accepts 1..MAX_REPORT_RADARS radars. */
export const MAX_REPORT_RADARS = RADAR_COLORS.length;

type Key = Readonly<{ terrain_id: string; epoch: number }>;

/** Where the individual results of the active snapshot live. */
export type ReportResultSource =
  | { readonly kind: "history"; readonly entries: readonly HistoryEntry[] }
  | { readonly kind: "multi"; readonly deployed: readonly DeployedRadar[] };

/** Everything the model needs, captured synchronously at the click. */
export interface ReportInputs {
  readonly snapshot: AnalysisSnapshot;
  /** Active result published by the app: the individual result or the union. */
  readonly result: LOSResponse;
  readonly source: ReportResultSource;
  readonly terrainKey: Key;
  readonly metadata: DTMMetadata;
  readonly grid: readonly (readonly number[])[];
  readonly policy: QualityPolicy;
  readonly metric: ReportMetric;
  /** Radar catalog loaded in the app (`analysisStore.radars`). */
  readonly catalog: readonly RadarConfig[];
  /** Area to monitor with the terrain key it was drawn on, or null. */
  readonly aoi: { readonly polygon: AoiPolygon; readonly terrainKey: Key } | null;
}

const sameKey = (left: Key | null | undefined, right: Key | null | undefined): boolean =>
  !!left && !!right && left.terrain_id === right.terrain_id && left.epoch === right.epoch;

// Identity tokens avoid serializing large LOS grids while detecting replaced results.
const reportIdentities = new WeakMap<object, number>();
let nextReportIdentity = 1;
function reportIdentity(value: object | null | undefined): number | null {
  if (!value) return null;
  let id = reportIdentities.get(value);
  if (id === undefined) { id = nextReportIdentity++; reportIdentities.set(value, id); }
  return id;
}

/** Capture a comparable signature synchronously; never expose it in the PDF or logs. */
export function reportStateSignature(inputs?: ReportInputs): string {
  const analysis = useAnalysisStore.getState();
  const area = useAoiStore.getState();
  const mode = useVectorStore.getState().visualizationMode;
  const source = inputs?.source ?? (analysis.unifiedLos !== null && analysis.losResult === analysis.unifiedLos
    ? { kind: "multi" as const, deployed: analysis.deployedRadars }
    : { kind: "history" as const, entries: analysis.history.filter(entry => entry.selected) });
  // Also track selected history while multi is active, as it may change independently.
  const history = source.kind === "history" ? source.entries : analysis.history.filter(entry => entry.selected);
  return JSON.stringify({
    policy: Object.entries(inputs?.policy ?? useQualityPolicyStore.getState().policy).sort(([a], [b]) => a.localeCompare(b)),
    metric: inputs?.metric ?? metricForVisualizationMode(mode),
    mode,
    transitioning: analysis.terrainTransitioning,
    loading: [analysis.loading, analysis.multiLoading, useTerrainStore.getState().loading],
    aoi: inputs?.aoi === undefined ? (area.polygon && area.terrainKey ? { polygon: area.polygon, terrainKey: area.terrainKey } : null) : inputs.aoi,
    areaKey: area.terrainKey,
    polygonIdentity: reportIdentity(area.polygon),
    polygon: area.polygon,
    history: history.map(entry => ({ ids: entry.snapshot?.sourceAnalysisIds, analysisId: entry.snapshot?.analysisId,
      radarId: entry.radarId, result: reportIdentity(entry.result) })),
    source: source.kind,
    deployed: source.kind === "multi" ? source.deployed.map(({ result, ...radar }) => ({ ...radar, result: reportIdentity(result) })) : null,
  });
}

/** Store fields read by the currency guard. */
export interface ReportGuardState {
  analysis: Pick<ReturnType<typeof useAnalysisStore.getState>,
    "activeSnapshot" | "losResult" | "terrainTransitioning" | "terrainKey">;
  terrain: Pick<ReturnType<typeof useTerrainStore.getState>, "terrainKey" | "metadata">;
}

/**
 * Reimplementation of `isCurrentExport` (`ExportPanel.tsx`): identity of the
 * active snapshot and result, no terrain transition, and the snapshot key equal
 * to both store keys and to the active metadata id. Pinned by an equivalence test.
 */
export function isCurrentReportState(
  state: ReportGuardState,
  snapshot: AnalysisSnapshot,
  result: LOSResponse,
): boolean {
  const { analysis, terrain } = state;
  return analysis.activeSnapshot === snapshot && analysis.losResult === result &&
    !analysis.terrainTransitioning &&
    sameKey(snapshot.terrainKey, analysis.terrainKey) &&
    sameKey(snapshot.terrainKey, terrain.terrainKey) &&
    terrain.metadata?.terrain_id === snapshot.terrainKey.terrain_id;
}

const RECALCULATE = "Vuelve a calcular la cobertura y genera el informe otra vez.";

/** Read the stores synchronously (no writes) and capture the report inputs. */
export function captureReportInputs(): ReportInputs {
  const analysis = useAnalysisStore.getState();
  const terrain = useTerrainStore.getState();
  const snapshot = analysis.activeSnapshot;
  const result = analysis.losResult;
  if (!snapshot || !result) {
    throw new ReportError("NO_ACTIVE_ANALYSIS",
      "No hay un análisis de cobertura activo. Calcula la cobertura antes de generar el informe.");
  }
  if (analysis.terrainTransitioning || analysis.loading || analysis.multiLoading || terrain.loading) {
    throw new ReportError("TRANSITION",
      "Hay un cálculo o una carga de terreno en curso. Espera a que termine y genera el informe otra vez.");
  }
  if (!isCurrentReportState({ analysis, terrain }, snapshot, result) || !terrain.terrainKey ||
      !terrain.metadata || !terrain.grid) {
    throw new ReportError("STALE", `El análisis activo no corresponde al terreno cargado. ${RECALCULATE}`);
  }
  const source: ReportResultSource = analysis.unifiedLos !== null && analysis.losResult === analysis.unifiedLos
    ? { kind: "multi", deployed: Object.freeze([...analysis.deployedRadars]) }
    : { kind: "history", entries: Object.freeze(analysis.history.filter((entry) => entry.selected)) };
  const aoi = useAoiStore.getState();
  return Object.freeze({
    snapshot,
    result,
    source,
    terrainKey: Object.freeze({ ...terrain.terrainKey }),
    metadata: terrain.metadata,
    grid: terrain.grid,
    policy: Object.freeze({ ...useQualityPolicyStore.getState().policy }),
    metric: metricForVisualizationMode(useVectorStore.getState().visualizationMode),
    catalog: Object.freeze([...analysis.radars]),
    aoi: aoi.polygon && aoi.terrainKey
      ? Object.freeze({
        polygon: { vertices: Object.freeze(aoi.polygon.vertices.map((v) => ({ x: v.x, y: v.y }))) },
        terrainKey: Object.freeze({ ...aoi.terrainKey }),
      })
      : null,
  });
}

// ─── Radar parameters ──────────────────────────────────────────────────────

/** Angle in (−180, 180], the convention of `normalizeAzimuthRange`. */
const normalizeAngle = (angle: number): number => {
  const normalized = ((angle % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
};

export interface EffectiveRadarParameters {
  modelName: string | null;
  rangeM: number | null;
  /** Window centre, degrees in (−180, 180], 0 = +y (north), 90 = +x; null = full circle or unknown. */
  azimuthDeg: number | null;
  /** Window width, degrees; 360 = full circle; null when unknown. */
  apertureDeg: number | null;
}

/**
 * Effective model name, maximum range and azimuth window with the precedence of
 * `runLOSAnalysis` (`services/api.ts`): a non-null override replaces the catalog
 * value; an azimuth override uses `normalizeAzimuthRange(azCenter ?? 0,
 * azWidth ?? h_beam_width_deg)`; otherwise the catalog `azimuth_range_deg`
 * (null = full circle). Unresolvable values are null, never zero.
 */
export function resolveRadarParameters(
  radarModelId: string,
  overrides: AnalysisRadarOverrides,
  catalog: readonly RadarConfig[],
): EffectiveRadarParameters {
  const model = catalog.find((candidate) => candidate.model_id === radarModelId) ?? null;
  const finite = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const rangeM = overrides.rangeMax !== null && overrides.rangeMax !== undefined
    ? finite(overrides.rangeMax)
    : finite(model?.max_range_m);
  let azimuthDeg: number | null = null;
  let apertureDeg: number | null = null;
  const hasAzOverride = (overrides.azCenter !== null && overrides.azCenter !== undefined) ||
    (overrides.azWidth !== null && overrides.azWidth !== undefined);
  if (hasAzOverride) {
    const center = overrides.azCenter ?? 0;
    const width = overrides.azWidth ?? model?.h_beam_width_deg ?? null;
    if (width !== null) {
      try {
        const window = normalizeAzimuthRange(center, width);
        apertureDeg = window === null ? 360 : width;
        azimuthDeg = window === null ? null : normalizeAngle(center);
      } catch { /* Invalid override: the analysis could not use it, so it stays unknown. */ }
    }
  } else if (model) {
    const range = model.azimuth_range_deg;
    if (range === null) {
      apertureDeg = 360;
    } else {
      const [start, end] = range;
      const width = start <= end ? end - start : end - start + 360;
      apertureDeg = width;
      azimuthDeg = normalizeAngle(start + width / 2);
    }
  }
  return { modelName: model?.display_name ?? null, rangeM, azimuthDeg, apertureDeg };
}

// ─── Terrain helpers ───────────────────────────────────────────────────────

const EDGE_SNAP = 1e-9;

/**
 * Bilinear ground elevation at (x, y) on node grid `grid` (row r → y = min_y + r·res,
 * column c → x = min_x + c·res). Null outside the node extent or when a node with a
 * non-zero weight is NaN; exactly on a node or edge only the nodes it touches count.
 */
export function bilinearGroundZ(
  grid: readonly (readonly number[])[],
  bounds: Readonly<{ min_x: number; min_y: number }>,
  resolution: number,
  x: number,
  y: number,
): number | null {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0]!.length : 0;
  if (rows === 0 || cols === 0 || !Number.isFinite(resolution) || resolution <= 0) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const locate = (value: number, count: number): [number, number] | null => {
    let u = value;
    if (u < 0 && u > -EDGE_SNAP) u = 0;
    if (u > count - 1 && u < count - 1 + EDGE_SNAP) u = count - 1;
    if (!(u >= 0 && u <= count - 1)) return null;
    const i0 = Math.floor(u);
    return [i0, u - i0];
  };
  const c = locate((x - bounds.min_x) / resolution, cols);
  const r = locate((y - bounds.min_y) / resolution, rows);
  if (!c || !r) return null;
  const [c0, tc] = c;
  const [r0, tr] = r;
  const c1 = tc > 0 ? c0 + 1 : c0;
  const r1 = tr > 0 ? r0 + 1 : r0;
  const z00 = grid[r0]![c0]!;
  const z01 = grid[r0]![c1]!;
  const z10 = grid[r1]![c0]!;
  const z11 = grid[r1]![c1]!;
  if (![z00, z01, z10, z11].every((z) => typeof z === "number" && Number.isFinite(z))) return null;
  const bottom = z00 + (z01 - z00) * tc;
  const top = z10 + (z11 - z10) * tc;
  return bottom + (top - bottom) * tr;
}

function copyTerrain(inputs: ReportInputs): ReportTerrain {
  const { metadata, grid, snapshot } = inputs;
  const rows = metadata.grid_rows;
  const cols = metadata.grid_cols;
  const elevations = new Float32Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const value = grid[row]![col];
      elevations[row * cols + col] = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
    }
  }
  const b = metadata.bounds;
  return {
    terrainId: snapshot.terrainKey.terrain_id,
    epoch: snapshot.terrainKey.epoch,
    rows,
    cols,
    resolution: metadata.resolution,
    bounds: { min_x: b.min_x, max_x: b.max_x, min_y: b.min_y, max_y: b.max_y, min_z: b.min_z, max_z: b.max_z },
    elevations,
  };
}

// ─── Provenance ────────────────────────────────────────────────────────────

const sameOverrides = (left: AnalysisRadarOverrides, right: AnalysisRadarOverrides): boolean =>
  left.rangeMin === right.rangeMin && left.rangeMax === right.rangeMax &&
  left.elMin === right.elMin && left.elMax === right.elMax &&
  left.azCenter === right.azCenter && left.azWidth === right.azWidth;

const sameRadar = (left: AnalysisRadarSnapshot, right: AnalysisRadarSnapshot): boolean =>
  left.radarId === right.radarId && left.radarModelId === right.radarModelId &&
  left.position.x === right.position.x && left.position.y === right.position.y &&
  left.position.z === right.position.z && sameOverrides(left.overrides, right.overrides);

interface ResolvedRadar {
  radar: AnalysisRadarSnapshot;
  analysisId: string;
  result: LOSResponse;
  /** Provenance used for the per-radar quality summary. */
  snapshot: AnalysisSnapshot;
  /** Viewer color: `deployedRadars[i].color` (multi-radar) or the palette by index (history). */
  color: string;
}

const paletteColor = (index: number): string => RADAR_COLORS[index % RADAR_COLORS.length]!;

const missing = (index: number): ReportError => new ReportError("MISSING_RADAR_RESULT",
  `Falta el resultado individual del Radar ${index + 1}. ${RECALCULATE}`);
const mismatched = (index: number, what: string): ReportError => new ReportError("MISMATCHED_RADAR_RESULT",
  `El resultado individual del Radar ${index + 1} no coincide con el análisis activo (${what}). ${RECALCULATE}`);
const stale = (what: string): ReportError => new ReportError("STALE", `${what} ${RECALCULATE}`);

function resolveFromHistory(snapshot: AnalysisSnapshot, entries: readonly HistoryEntry[]): ResolvedRadar[] {
  const count = snapshot.radars.length;
  const entryId = (entry: HistoryEntry | undefined): string | undefined =>
    entry?.snapshot?.sourceAnalysisIds.length === 1 ? entry.snapshot.sourceAnalysisIds[0] : undefined;
  const resolved = snapshot.radars.map((radar, index) => {
    const expectedId = snapshot.sourceAnalysisIds[index]!;
    const entry = entries[index];
    if (!entry || !entry.snapshot) {
      if (entries.some((candidate) => entryId(candidate) === expectedId)) throw mismatched(index, "orden");
      throw missing(index);
    }
    const id = entryId(entry);
    if (id !== expectedId) {
      if (entries.some((candidate) => entryId(candidate) === expectedId)) throw mismatched(index, "orden");
      throw missing(index);
    }
    if (entry.snapshot.radars.length !== 1 || !sameRadar(entry.snapshot.radars[0]!, radar)) {
      throw mismatched(index, "radar o posición");
    }
    if (!sameKey(entry.snapshot.terrainKey, snapshot.terrainKey) ||
        entry.terrain_id !== snapshot.terrainKey.terrain_id || entry.terrain_epoch !== snapshot.terrainKey.epoch) {
      throw stale(`El resultado del Radar ${index + 1} pertenece a otro terreno o a otra carga del terreno.`);
    }
    if (!entry.result) throw missing(index);
    return { radar, analysisId: expectedId, result: entry.result, snapshot: entry.snapshot, color: paletteColor(index) };
  });
  // More selected entries than radars in the snapshot: the set is not the one analysed.
  if (entries.length !== count) throw mismatched(count - 1, "cantidad de radares");
  return resolved;
}

function resolveFromDeployed(snapshot: AnalysisSnapshot, deployed: readonly DeployedRadar[]): ResolvedRadar[] {
  const resolved = snapshot.radars.map((radar, index) => {
    const current = deployed[index];
    if (!current || current.id !== radar.radarId) {
      if (deployed.some((candidate) => candidate.id === radar.radarId)) throw mismatched(index, "orden");
      throw missing(index);
    }
    const overrides: AnalysisRadarOverrides = {
      rangeMin: current.rangeMin ?? null, rangeMax: current.rangeMax ?? null,
      elMin: current.elMin ?? null, elMax: current.elMax ?? null,
      azCenter: current.azCenter ?? null, azWidth: current.azWidth ?? null,
    };
    if (!sameRadar({ radarId: current.id, radarModelId: current.modelId, position: current.position, overrides }, radar)) {
      throw mismatched(index, "radar o posición");
    }
    if (!current.result) throw missing(index);
    const analysisId = snapshot.sourceAnalysisIds[index]!;
    const own: AnalysisSnapshot = {
      terrainKey: snapshot.terrainKey, analysisId, sourceAnalysisIds: [analysisId],
      generation: snapshot.generation, radars: [radar],
    };
    // Contract amendment 1: the color assigned at deploy time, as the viewer shows it; it survives removals.
    return { radar, analysisId, result: current.result, snapshot: own, color: current.color };
  });
  if (deployed.length !== snapshot.radars.length) throw mismatched(snapshot.radars.length, "cantidad de radares");
  return resolved;
}

// ─── Metrics ───────────────────────────────────────────────────────────────

interface MetricContext {
  inputs: ReportInputs;
  mask: Uint8Array | null;
}

function coverageMetrics(
  ctx: MetricContext,
  result: LOSResponse,
  snapshot: AnalysisSnapshot,
  label: string,
): { metrics: ReportCoverageMetrics; qualityValues: Float32Array } {
  const { inputs, mask } = ctx;
  const context = buildQualityExportContext({
    snapshot, losResult: result, metric: inputs.metric, policy: inputs.policy,
    terrainGrid: inputs.grid, terrainMetadata: inputs.metadata, terrainKey: inputs.terrainKey,
  });
  if (!context) {
    throw new ReportError("INVALID_QUALITY_CONTEXT",
      `No se pudo calcular la calidad de ${label} con la política y la métrica vigentes. ${RECALCULATE}`);
  }
  const summary = context.summary;
  let aoi: ReportCoverageMetrics["aoi"] = null;
  if (mask) {
    const coverage = computeAoiCoverage(result, mask, inputs.policy, {
      metric: inputs.metric, terrainGrid: inputs.grid, terrainResolution: inputs.metadata.resolution,
      terrainKey: inputs.terrainKey, snapshot,
    });
    aoi = coverage ? { areaM2: coverage.aoiAreaM2, visiblePct: coverage.visiblePct, usefulPct: coverage.usefulPct } : null;
  }
  const d = summary.distribution;
  const source = (inputs.metric === "PROJECTION" ? result.flat_projection_grid : result.flat_quality_grid)!;
  const qualityValues = new Float32Array(source.length);
  for (let idx = 0; idx < source.length; idx++) {
    const value = source[idx]!;
    // Same "measured" rule as the summary: anything else is a missing index.
    qualityValues[idx] = Number.isFinite(value) && value >= 0 && value <= 1 ? value : Number.NaN;
  }
  return {
    metrics: {
      visiblePct: result.coverage_pct,
      visibleAreaM2: result.visible_area_m2,
      usefulPct: summary.usefulCoveragePct,
      usefulAreaM2: summary.usefulAreaM2,
      bandsPct: d ? { low: d.lowPct, medium: d.mediumPct, high: d.highPct, noIndex: d.noIndexPct } : null,
      aoi,
    },
    qualityValues,
  };
}

function captureAoi(inputs: ReportInputs): { model: ReportModel["aoi"]; mask: Uint8Array | null } {
  const aoi = inputs.aoi;
  if (!aoi || !sameKey(aoi.terrainKey, inputs.snapshot.terrainKey)) return { model: null, mask: null };
  let validated;
  try {
    validated = validateAoiPolygon(aoi.polygon);
  } catch {
    return { model: null, mask: null };
  }
  const model = {
    vertices: Object.freeze(validated.vertices.map((v) => Object.freeze({ x: v.x, y: v.y }))),
    areaM2: Math.abs(validated.signedAreaM2),
  };
  let mask: Uint8Array | null = null;
  try {
    mask = aoiMaskForGrid({ grid: inputs.grid, bounds: inputs.metadata.bounds, resolution: inputs.metadata.resolution },
      { vertices: validated.vertices });
  } catch { /* The area has no valid grid cells: its coverage stays null. */ }
  return { model, mask };
}

// ─── Model ─────────────────────────────────────────────────────────────────

/** Pure: builds the report model from captured inputs or throws a `ReportError`. */
export function buildReportModel(inputs: ReportInputs, opts: { title?: string; now?: Date } = {}): ReportModel {
  const { snapshot, result, metadata, grid } = inputs;
  if (!snapshot || !result || snapshot.radars.length === 0) {
    throw new ReportError("NO_ACTIVE_ANALYSIS",
      "No hay un análisis de cobertura activo. Calcula la cobertura antes de generar el informe.");
  }
  const count = snapshot.radars.length;
  if (count > MAX_REPORT_RADARS) {
    throw new ReportError("TOO_MANY_RADARS",
      `El informe admite hasta ${MAX_REPORT_RADARS} radares y el análisis activo tiene ${count}. ` +
      "Selecciona menos radares y vuelve a calcular la cobertura.");
  }
  if (!sameKey(snapshot.terrainKey, inputs.terrainKey) || metadata.terrain_id !== snapshot.terrainKey.terrain_id) {
    throw stale("El análisis activo no corresponde al terreno cargado.");
  }
  const rows = metadata.grid_rows;
  const cols = metadata.grid_cols;
  const size = rows * cols;
  if (grid.length !== rows || grid.some((row) => row.length !== cols)) {
    throw stale("La grilla del terreno no coincide con sus metadatos.");
  }
  if (snapshot.sourceAnalysisIds.length !== count) throw mismatched(0, "identificadores de análisis");
  if (!isValidQualityPolicy(inputs.policy) || (inputs.metric !== "INCIDENCE" && inputs.metric !== "PROJECTION")) {
    throw new ReportError("INVALID_QUALITY_CONTEXT",
      "La política de calidad o la métrica vigente no es válida. Revísala y genera el informe otra vez.");
  }

  const resolved = inputs.source.kind === "history"
    ? resolveFromHistory(snapshot, inputs.source.entries)
    : resolveFromDeployed(snapshot, inputs.source.deployed);
  resolved.forEach(({ result: own }, index) => {
    if (own.grid_rows !== rows || own.grid_cols !== cols || own.resolution !== metadata.resolution ||
        !(own.cell_states instanceof Uint8Array) || own.cell_states.length !== size) {
      throw stale(`El resultado del Radar ${index + 1} tiene otra grilla o resolución que el terreno cargado.`);
    }
  });
  if (count === 1 && inputs.source.kind === "history" && resolved[0]!.result !== result) {
    throw mismatched(0, "resultado activo");
  }
  if (result.grid_rows !== rows || result.grid_cols !== cols || result.resolution !== metadata.resolution ||
      !(result.cell_states instanceof Uint8Array) || result.cell_states.length !== size) {
    throw stale("El resultado activo tiene otra grilla o resolución que el terreno cargado.");
  }

  // Per-cell count of individual VISIBLE radars (not observer_count).
  const visibleCount = new Uint8Array(size);
  for (const { result: own } of resolved) {
    for (let idx = 0; idx < size; idx++) if (own.cell_states[idx] === LOSCellState.VISIBLE) visibleCount[idx]!++;
  }
  // The published union must be exactly the OR of the resolved results.
  for (let idx = 0; idx < size; idx++) {
    if ((result.cell_states[idx] === LOSCellState.VISIBLE) !== (visibleCount[idx]! > 0)) {
      throw new ReportError("MISMATCHED_RADAR_RESULT",
        `La cobertura activa no coincide con los resultados individuales. ${RECALCULATE}`);
    }
  }

  const terrain = copyTerrain(inputs);
  const aoi = captureAoi(inputs);
  const ctx: MetricContext = { inputs, mask: aoi.mask };
  const cellArea = metadata.resolution * metadata.resolution;
  const multi = count > 1;

  const radars: ReportRadar[] = resolved.map(({ radar, analysisId, result: own, snapshot: ownSnapshot, color }, index) => {
    const label = `Radar ${index + 1}`;
    const { metrics, qualityValues } = coverageMetrics(ctx, own, ownSnapshot, `el ${label}`);
    let exclusiveCells = 0;
    if (multi) {
      for (let idx = 0; idx < size; idx++) {
        if (visibleCount[idx] === 1 && own.cell_states[idx] === LOSCellState.VISIBLE) exclusiveCells++;
      }
    }
    const params = resolveRadarParameters(radar.radarModelId, radar.overrides, inputs.catalog);
    const position = { x: radar.position.x, y: radar.position.y, z: radar.position.z };
    const groundZ = bilinearGroundZ(grid, metadata.bounds, metadata.resolution, position.x, position.y);
    return {
      index,
      label,
      radarId: radar.radarId,
      modelId: radar.radarModelId,
      modelName: params.modelName,
      color,
      position,
      groundZ,
      heightAboveGround: groundZ === null || !Number.isFinite(position.z) ? null : position.z - groundZ,
      rangeM: params.rangeM,
      azimuthDeg: params.azimuthDeg,
      apertureDeg: params.apertureDeg,
      analysisId,
      cellStates: own.cell_states.slice(),
      qualityValues,
      metrics,
      exclusiveAreaM2: multi ? exclusiveCells * cellArea : null,
    };
  });

  let union: ReportUnion | null = null;
  if (multi) {
    const { metrics, qualityValues } = coverageMetrics(ctx, result, snapshot, "la cobertura unificada");
    let overlapCells = 0;
    for (let idx = 0; idx < size; idx++) if (visibleCount[idx]! >= 2) overlapCells++;
    union = {
      cellStates: result.cell_states.slice(),
      visibleCount,
      qualityValues,
      metrics,
      overlapAreaM2: overlapCells * cellArea,
    };
  }

  const title = opts.title?.trim() ? opts.title.trim() : DEFAULT_REPORT_TITLE;
  return {
    version: 1,
    createdAtIso: (opts.now ?? new Date()).toISOString(),
    title,
    terrain,
    policy: { mediumMin: inputs.policy.mediumMin, highMin: inputs.policy.highMin },
    metric: inputs.metric,
    qualityModel: result.quality_model ?? null,
    radars: Object.freeze(radars),
    union,
    aoi: aoi.model,
    provenance: { generation: snapshot.generation, sourceAnalysisIds: Object.freeze([...snapshot.sourceAnalysisIds]) },
  };
}

/** Convenience for the panel: capture and build in one synchronous call. */
export function createReportModelFromStores(opts?: { title?: string; now?: Date }): ReportModel {
  return buildReportModel(captureReportInputs(), opts);
}
