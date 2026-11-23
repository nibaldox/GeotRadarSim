/**
 * «Sugerir ubicación» (WP15b): the deterministic position optimizer without an LLM.
 *
 * It runs the `suggest_radar_positions` runtime of `placement/` (WP8): its own
 * `PlacementRefMap`, `createSuggestRadarPositions`, the schema validator with its defaults, and a
 * `ctx` with `signal`, `step` and `callId`. Nothing of the optimizer or the verification is
 * duplicated here. The suggested positions end up as normal history analyses `[A#]`; every
 * figure on the cards is read from those entries with `computeQualitySummary` and the dashboard's
 * own `QualitySummaryView`.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { mergeResults, useAnalysisStore } from "../store/analysisStore";
import type { HistoryEntry } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useTerrainStore } from "../store/terrainStore";
import { computeQualitySummary, metricLabel } from "../utils/qualityMetrics";
import type { QualityMetric } from "../utils/qualityMetrics";
import type { AnalysisSnapshot } from "../types/api";
import { candidateSignature } from "../placement/candidateSignature";
import { currentTerrainKey, factoryAzimuth, historyFor } from "../placement/appState";
import { PlacementRefMap } from "../placement/refs";
import { TOOL_SPECS } from "../placement/schemas";
import {
  SUGGESTION_BUSY_MESSAGE,
  createSuggestRadarPositions,
  isSuggestionRunning,
  subscribeOptimizerProgress,
  subscribeSuggestionLock,
} from "../placement/suggestPositions";
import { parseAndValidateArgs } from "../placement/validate";
import type { ToolEnvelope } from "../placement/toolEnvelope";
import { QualitySummaryView } from "./QualitySummaryView";
import { Section } from "./ui/Section";
import { formatKpiHectares, formatKpiPercent } from "./KpiBar";
import { radarMarkerColor } from "../hooks/useGlobalQuality";
import "../styles/suggest.css";

type Objective = "USEFUL_INCIDENCE" | "VISIBLE_AREA" | "USEFUL_PROJECTION";
type TerrainKey = { terrain_id: string; epoch: number };

const OBJECTIVES: ReadonlyArray<{ value: Objective; label: string; short: string }> = [
  { value: "USEFUL_INCIDENCE", label: "Cobertura útil (incidencia)", short: "útil por incidencia" },
  { value: "VISIBLE_AREA", label: "Área visible", short: "área visible" },
  { value: "USEFUL_PROJECTION", label: "Cobertura útil (proyección del movimiento)", short: "útil por proyección" },
];
export const NO_GUARANTEE_NOTE = "Sin garantía de óptimo.";

export const HISTORY_LEGEND = "Las posiciones se agregaron al historial como análisis normales; puedes quitarlas desde el Historial.";
const MAX_FIXED = 3;
const SEPARATION_SCHEMA = (TOOL_SPECS.suggest_radar_positions.parameters as {
  properties: { min_separation_m: { default: number; minimum: number; maximum: number } };
}).properties.min_separation_m;

interface Suggestion {
  candidate_id: string;
  analysis_ref: string;
  aoi_fits_azimuth?: boolean;
}
interface ResultData {
  key: TerrainKey;
  metric: QualityMetric;
  suggestions: Suggestion[];
  unionRefs: string[] | null;
  reduced: string | null;
  guarantee: { kind: string; note: string } | null;
  aoiNote: string | null;
}
interface Progress {
  phase: "calibration" | "coarse_los";
  done: number;
  total: number;
}
type Status = "idle" | "confirm" | "running" | "cancelling";

const sameKey = (a: TerrainKey | null | undefined, b: TerrainKey | null | undefined): boolean =>
  !!a && !!b && a.terrain_id === b.terrain_id && a.epoch === b.epoch;

export const AREA_CHANGED_MESSAGE = "El área a monitorear cambió; revisa las opciones y vuelve a calcular.";

/** Parses `left_in_history: [A1, A2]` from the envelope hint. */
export function leftInHistoryRefs(hint: string | undefined): string[] {
  const m = hint ? /^left_in_history: \[([^\]]*)\]$/u.exec(hint) : null;
  return m ? m[1]!.split(",").map((r) => r.trim()).filter(Boolean) : [];
}

/** Runtime texts may name internal refs or arguments; the panel never shows them (F3, F4). */
/** U6 LOW-2: internal tool names never reach the panel either. */
const TOOL_NAMES_RE = /\b(?:list_analyses|run_los_analysis|place_radar|suggest_radar_positions)\b/gu;
function clean(message: string): string {
  return message
    .replace(/\b[ACF]\d{1,3}\b/gu, "un análisis")
    .replace(/\bk\b/gu, "la cantidad de radares")
    .replace(TOOL_NAMES_RE, "el análisis")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/**
 * R15b F4 · text written for the app user per error code, without tool names or internal instructions.
 * `describeLeft` turns the `left_in_history` refs into «Sugerencia n (Este …, Norte …)» (F3).
 */
export function errorText(
  code: string,
  message: string,
  hint?: string,
  describeLeft: (refs: string[]) => string = (refs) => refs.map((_, i) => `Sugerencia ${i + 1}`).join(", "),
): string {
  const left = leftInHistoryRefs(hint);
  const leftNote = left.length > 0 ? ` Quedaron en el historial: ${describeLeft(left)}.` : "";
  switch (code) {
    // U6 LOW-1: these codes also list what stayed in the history.
    case "TIMEOUT":
    case "BUDGET_EXCEEDED":
      return `Se agotó el tiempo. Prueba con menos radares o sin el área.${leftNote}`;
    case "NOT_AVAILABLE":
      return "El optimizador no está disponible en este navegador: necesita Web Workers y WebAssembly.";
    case "ANALYSIS_FAILED":
    case "OPTIMIZER_FAILED": {
      const text = clean(message);
      return `${text.startsWith("El cálculo falló") ? text : `El cálculo falló: ${text}`}${leftNote}`;
    }
    case "SUPERSEDED":
      return `La búsqueda se descartó porque cambió el terreno, el perfil, los límites, la política o el área durante el cálculo.${leftNote} Vuelve a calcularla.`;
    case "CANCELLED_BY_USER":
      return `Búsqueda detenida.${leftNote}`;
    case "INVALID_ARGUMENT":
      return `Revisa las opciones: ${clean(message)}`;
    case "BUSY":
      return message === SUGGESTION_BUSY_MESSAGE
        ? "Ya hay una sugerencia de ubicación en curso; espera a que termine."
        : "Hay un análisis en curso; espera a que termine y vuelve a intentarlo.";
    case "REF_EXHAUSTED":
      return `Se agotaron los identificadores de análisis de esta sesión; recarga la app para seguir.${leftNote}`;
    case "STALE_REF":
      return "El terreno, el área o el historial cambiaron desde que pediste la sugerencia; vuelve a calcularla.";
    case "NO_TERRAIN":
    case "TERRAIN_TRANSITIONING":
      return "Carga o genera un terreno y espera a que termine de cargarse.";
    case "NO_PROFILE":
      return "Selecciona un perfil de radar.";
    default:
      return "No se pudo calcular la sugerencia.";
  }
}

/** Identity of the drawn area (key + polygon) for F1. */
function areaSignature(polygon: { vertices: readonly { x: number; y: number }[] } | null, key: TerrainKey | null): string | null {
  return polygon ? JSON.stringify([key?.terrain_id ?? null, key?.epoch ?? null, polygon.vertices.map((v) => [v.x, v.y])]) : null;
}

function formatCoordinate(value: number): string {
  return value.toFixed(1);
}

export function SuggestPositionsPanel() {
  const terrainKey = useTerrainStore((s) => s.terrainKey);
  const terrainGrid = useTerrainStore((s) => s.grid);
  const terrainMetadata = useTerrainStore((s) => s.metadata);
  const terrainLoading = useTerrainStore((s) => s.loading);
  const history = useAnalysisStore((s) => s.history);
  const radars = useAnalysisStore((s) => s.radars);
  const selectedRadarId = useAnalysisStore((s) => s.selectedRadarId);
  const loading = useAnalysisStore((s) => s.loading);
  const multiLoading = useAnalysisStore((s) => s.multiLoading);
  const transitioning = useAnalysisStore((s) => s.terrainTransitioning);
  const analysisKey = useAnalysisStore((s) => s.terrainKey);
  const aoiPolygon = useAoiStore((s) => s.polygon);
  const aoiKey = useAoiStore((s) => s.terrainKey);
  const policy = useQualityPolicyStore((s) => s.policy);

  const [k, setK] = useState(1);
  const [objective, setObjective] = useState<Objective>("USEFUL_INCIDENCE");
  const [aoiChoice, setAoiChoice] = useState<boolean | null>(null);
  const [keepSelected, setKeepSelected] = useState(false);
  const [separation, setSeparation] = useState(String(SEPARATION_SCHEMA.default));
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingEffect, setPendingEffect] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const activeSnapshot = useAnalysisStore((s) => s.activeSnapshot);

  const terrainReady = !!terrainKey && !!terrainGrid && !!terrainMetadata && !terrainLoading && !transitioning &&
    sameKey(terrainKey, analysisKey);
  const busy = loading || multiLoading;
  const areaOnTerrain = !!aoiPolygon && sameKey(aoiKey, terrainKey);
  const useArea = areaOnTerrain && (aoiChoice ?? true);
  // F1: the run reads the value frozen at «Calcular», never the live checkbox.
  const frozenUseAoi = useRef(false);
  const frozenArea = useRef<string | null>(null);
  // F2: the module lock is shared by every caller; F5: no second run inside one render cycle.
  const lockHeld = useSyncExternalStore(subscribeSuggestionLock, isSuggestionRunning);
  const runningRef = useRef(false);
  const statusRef = useRef<Status>("idle");

  const refs = useMemo(() => new PlacementRefMap({
    currentKey: currentTerrainKey,
    candidateSignature,
    isLiveAnalysis: (key, analysisId) => historyFor(key).some((entry) => entry.snapshot?.analysisId === analysisId),
  }), []);
  const tool = useMemo(() => createSuggestRadarPositions(refs, candidateSignature, { useAoi: () => frozenUseAoi.current }), [refs]);

  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const pendingArgs = useRef<Record<string, unknown> | null>(null);

  useEffect(() => () => {
    // Unmount: the run in flight is stopped and can no longer paint.
    generation.current += 1;
    controller.current?.abort();
    unsubscribe.current?.();
    unsubscribe.current = null;
  }, []);

  statusRef.current = status;
  // A new area resets the checkbox to its default (checked when an area exists), except while a
  // confirmation is open (F1: the card closes with a warning) or a run is in flight.
  useEffect(() => {
    if (statusRef.current === "confirm") {
      pendingArgs.current = null;
      setPendingEffect(null);
      setStatus("idle");
      setError(AREA_CHANGED_MESSAGE);
      return;
    }
    if (statusRef.current !== "idle" || runningRef.current) return;
    setAoiChoice(null);
  }, [aoiPolygon, aoiKey]);

  // `history` (subscribed above) keeps the cards and the fixed-radar choice in step with the store.
  const selectedEntries = terrainKey ? historyFor(terrainKey).filter((e) => history.includes(e) && e.selected && e.snapshot?.analysisId) : [];

  const buildArgs = (): Record<string, unknown> | string => {
    const args: Record<string, unknown> = { k, objective };
    const sep = Number(separation);
    if (separation.trim() === "" || !Number.isFinite(sep) || sep < SEPARATION_SCHEMA.minimum || sep > SEPARATION_SCHEMA.maximum) {
      return `La separación mínima debe estar entre ${SEPARATION_SCHEMA.minimum} y ${SEPARATION_SCHEMA.maximum} m.`;
    }
    args.min_separation_m = sep;
    if (keepSelected && terrainKey) {
      if (selectedEntries.length > MAX_FIXED) return `Puedes conservar como máximo ${MAX_FIXED} radares seleccionados.`;
      const keep: string[] = [];
      for (const entry of selectedEntries) {
        const ref = refs.analysisRef(terrainKey, entry.snapshot!.analysisId!);
        if (!ref) return "La sesión se quedó sin referencias de análisis; recarga la app.";
        keep.push(ref);
      }
      if (keep.length > 0) args.keep_analysis_refs = keep;
    }
    const checked = parseAndValidateArgs(TOOL_SPECS.suggest_radar_positions.parameters, JSON.stringify(args));
    if (!checked.ok) return "Los datos de la búsqueda no son válidos.";
    return checked.value as Record<string, unknown>;
  };

  const run = async (args: Record<string, unknown>) => {
    runningRef.current = true;
    const gen = ++generation.current;
    const callId = `ui-suggest-${gen}`;
    const abort = new AbortController();
    controller.current = abort;
    let runId: string | null = null;
    unsubscribe.current?.();
    const unsub = subscribeOptimizerProgress((event) => {
      if (event.callId !== callId) return;
      runId ??= event.runId;
      if (event.runId !== runId || generation.current !== gen) return;
      setProgress({ phase: event.phase, done: event.done, total: event.total });
    });
    unsubscribe.current = unsub;
    setStatus("running");
    setProgress(null);
    setError(null);
    setResult(null);
    let envelope: ToolEnvelope;
    try {
      envelope = await tool.execute(args, { signal: abort.signal, step: 1, callId });
    } catch {
      envelope = { ok: false, binding: { terrain_ref: null, epoch: null, step: 1 }, error: { code: "ANALYSIS_FAILED", message: "El optimizador falló." } };
    } finally {
      unsub();
      if (unsubscribe.current === unsub) unsubscribe.current = null;
    }
    if (generation.current !== gen) return; // a stale run never paints
    runningRef.current = false;
    controller.current = null;
    setStatus("idle");
    setProgress(null);
    const key = currentTerrainKey();
    if (!envelope.ok) {
      setError(errorText(envelope.error.code, envelope.error.message, envelope.error.hint, describeLeft));
      return;
    }
    if (!key || envelope.binding.epoch !== key.epoch) {
      setError(errorText("SUPERSEDED", "", undefined));
      return;
    }
    const data = envelope.data as Record<string, any>;
    setOpenDetail(null);
    setResult({
      key,
      metric: data.metric as QualityMetric,
      suggestions: (data.suggestions as Suggestion[]).map((s) => ({
        candidate_id: s.candidate_id, analysis_ref: s.analysis_ref, aoi_fits_azimuth: s.aoi_fits_azimuth,
      })),
      unionRefs: data.union ? (data.union.source_refs as string[]) : null,
      reduced: typeof data.reduced === "string" ? data.reduced : null,
      guarantee: data.guarantee ? { kind: String(data.guarantee.kind), note: String(data.guarantee.note) } : null,
      aoiNote: typeof data.aoi_note === "string" ? data.aoi_note : null,
    });
  };

  const onCalculate = () => {
    if (runningRef.current || pendingArgs.current !== null || statusRef.current !== "idle") return; // F5
    if (isSuggestionRunning()) {
      setError(errorText("BUSY", SUGGESTION_BUSY_MESSAGE));
      return;
    }
    setError(null);
    // F1: freeze every option of the form, including whether the area is used.
    frozenUseAoi.current = useArea;
    frozenArea.current = useArea ? areaSignature(aoiPolygon, aoiKey) : null;
    const args = buildArgs();
    if (typeof args === "string") {
      setError(args);
      return;
    }
    const card = tool.confirm(args);
    if (card && card.kind === "destructive") {
      pendingArgs.current = args;
      statusRef.current = "confirm";
      setPendingEffect(card.effect);
      setStatus("confirm");
      return;
    }
    statusRef.current = "running";
    void run(args);
  };

  const onConfirm = () => {
    const args = pendingArgs.current;
    pendingArgs.current = null;
    setPendingEffect(null);
    if (!args || runningRef.current) {
      setStatus("idle");
      return;
    }
    // F1: the area the user confirmed must still be the current one.
    const live = useAoiStore.getState();
    if (frozenUseAoi.current && areaSignature(live.polygon, live.terrainKey) !== frozenArea.current) {
      setStatus("idle");
      setError(AREA_CHANGED_MESSAGE);
      return;
    }
    statusRef.current = "running";
    void run(args);
  };

  const onStop = () => {
    if (!controller.current) return;
    setStatus("cancelling");
    controller.current.abort();
  };

  function entryFor(ref: string): HistoryEntry | null {
    const resolved = refs.resolveAnalysis(ref);
    const liveKey = currentTerrainKey();
    if (resolved.status !== "ok" || !liveKey) return null;
    return historyFor(liveKey).find((e) => e.snapshot?.analysisId === resolved.value) ?? null;
  }
  /** F3: «Sugerencia n (Este …, Norte …)» instead of the panel's private refs. */
  function describeLeft(left: string[]): string {
    return left.map((ref, i) => {
      const entry = entryFor(ref);
      return entry
        ? `Sugerencia ${i + 1} (Este ${formatCoordinate(entry.position.x)}, Norte ${formatCoordinate(entry.position.y)})`
        : `Sugerencia ${i + 1}`;
    }).join(", ");
  }

  const shownResult = result && sameKey(result.key, terrainKey) ? result : null;
  const summaryOf = (losResult: HistoryEntry["result"], snapshot: AnalysisSnapshot | null) =>
    terrainGrid && terrainMetadata && terrainKey
      ? computeQualitySummary({
          metric: shownResult!.metric,
          policy,
          losResult,
          terrainGrid,
          terrainResolution: terrainMetadata.resolution,
          terrainKey,
          snapshot,
        })
      : null;

  const azimuthText = (entry: HistoryEntry): string => {
    const overrides = entry.snapshot?.radars[0]?.overrides;
    const profile = radars.find((r) => r.model_id === (entry.snapshot?.radars[0]?.radarModelId ?? entry.radarId));
    const width = overrides?.azWidth ?? (profile ? factoryAzimuth(profile).width : null);
    if (overrides?.azCenter !== null && overrides?.azCenter !== undefined) return `${overrides.azCenter.toFixed(1)}°`;
    if (width !== null && width >= 360) return "Barrido completo (360°)";
    return profile ? `${factoryAzimuth(profile).center.toFixed(1)}°` : "Sin datos";
  };

  /** U6: one compact line per result; a click opens its detail (kept mounted with `hidden`). */
  const toggleDetail = (id: string) => setOpenDetail((current) => (current === id ? null : id));
  const activeIds = activeSnapshot?.sourceAnalysisIds ?? [];
  const dotColor = (entry: HistoryEntry | null): string | undefined => {
    const index = entry?.snapshot?.analysisId ? activeIds.indexOf(entry.snapshot.analysisId) : -1;
    return index >= 0 ? radarMarkerColor(index) : undefined;
  };

  const unionView = () => {
    if (!shownResult?.unionRefs || !terrainKey) return null;
    const entries = shownResult.unionRefs.map(entryFor);
    if (entries.some((e) => e === null)) return <div role="note" className="suggest-note">La unión ya no está completa en el historial.</div>;
    const order = historyFor(terrainKey);
    const sorted = (entries as HistoryEntry[]).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const merged = mergeResults(sorted.map((e) => e.result));
    const snapshot: AnalysisSnapshot = {
      terrainKey, analysisId: null, sourceAnalysisIds: sorted.map((e) => e.snapshot!.analysisId!), generation: 0, radars: [],
    };
    const summary = summaryOf(merged, snapshot);
    const open = openDetail === "union";
    return (
      <div className="suggest-item suggest-union" data-testid="suggest-union">
        <button type="button" className="suggest-line" aria-expanded={open} aria-controls="suggest-detail-union" onClick={() => toggleDetail("union")}>
          <strong>Unión: {shownResult.unionRefs.map((ref) => {
            const n = shownResult.suggestions.findIndex((s) => s.analysis_ref === ref);
            return n >= 0 ? `Sugerencia ${n + 1}` : "radar conservado";
          }).join(" + ")}</strong>
          <span className="suggest-line-figures">
            útil {formatKpiPercent(summary?.usefulCoveragePct ?? null)} · {formatKpiHectares(summary?.usefulAreaM2 ?? null)}
          </span>
        </button>
        <div id="suggest-detail-union" className="suggest-detail" data-testid="suggest-detail" hidden={!open}>
          <QualitySummaryView
            compact
            summary={summary}
            metricLabel={metricLabel(shownResult.metric)}
            coveragePct={merged.coverage_pct ?? null}
            completenessPct={merged.completeness_pct ?? null}
          />
        </div>
      </div>
    );
  };

  const progressText = progress === null
    ? "Preparando el cálculo…"
    : progress.phase === "calibration"
      ? "Calibrando…"
      : progress.done >= progress.total
        ? "Verificando con la línea de visión completa…"
        : `Evaluando candidatos ${progress.done}/${progress.total}`;

  const running = status === "running" || status === "cancelling";
  const formAvailable = terrainReady && !busy;
  const objectiveShort = OBJECTIVES.find((o) => o.value === objective)?.short ?? "";
  const notes = shownResult
    ? [
        shownResult.reduced,
        shownResult.guarantee
          ? `Garantía: ${shownResult.guarantee.kind === "ninguna" ? "ninguna" : "al menos el 63 % del óptimo (1 − 1/e)"}. ${shownResult.guarantee.note}`
          : null,
        shownResult.aoiNote,
      ].filter((n): n is string => !!n)
    : [];

  return (
    <Section
      id="suggest"
      title="Sugerir ubicación"
      summary={`${k} ${k === 1 ? "radar" : "radares"} · ${objectiveShort}`}
      defaultOpen={false}
      storageKey="geotradar-collapse-suggest"
    >
      <div className="suggest-positions" data-testid="suggest-positions">
        {running ? (
          <div className="suggest-progress" role="status" aria-live="polite">
            <div className="suggest-phase">{status === "cancelling" ? "Cancelando…" : progressText}</div>
            <progress
              className="suggest-bar"
              aria-label="Progreso de la sugerencia"
              max={progress && progress.phase === "coarse_los" ? progress.total : 1}
              value={progress && progress.phase === "coarse_los" ? progress.done : undefined}
            />
            <button type="button" className="btn-compact" onClick={onStop} disabled={status === "cancelling"}>Detener</button>
          </div>
        ) : !formAvailable ? (
          <div className="suggest-hint">
            {terrainReady ? "Hay un análisis o una carga en curso; espera a que termine." : "Carga o genera un terreno para pedir una sugerencia."}
          </div>
        ) : status === "confirm" ? (
          <div className="suggest-confirm" role="alertdialog" aria-label="Confirmar la sugerencia">
            <div>{pendingEffect}</div>
            {lockHeld && <div className="suggest-note">{SUGGESTION_BUSY_MESSAGE}</div>}
            <div className="suggest-actions">
              <button type="button" className="btn-compact primary" onClick={onConfirm} disabled={lockHeld}>Continuar</button>
              <button type="button" className="btn-compact" onClick={() => { pendingArgs.current = null; setPendingEffect(null); setStatus("idle"); }}>Cancelar</button>
            </div>
          </div>
        ) : (
          <form className="suggest-form" onSubmit={(e) => { e.preventDefault(); onCalculate(); }}>
            <div className="suggest-row field-row">
              <label className="cs-field" title="Cantidad de radares">
                <span className="cs-label">Radares</span>
                <select aria-label="Cantidad de radares" value={k} onChange={(e) => setK(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="cs-field">
                <span className="cs-label">
                  Objetivo
                  {objective === "USEFUL_PROJECTION" && (
                    <span className="suggest-info" title={NO_GUARANTEE_NOTE} aria-label={NO_GUARANTEE_NOTE} role="img">i</span>
                  )}
                </span>
                <select aria-label="Objetivo" value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
                  {OBJECTIVES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </div>
            <label className="suggest-check">
              <input
                type="checkbox"
                checked={useArea}
                disabled={!areaOnTerrain}
                onChange={(e) => setAoiChoice(e.target.checked)}
              />
              Usar el área a monitorear
            </label>
            <label className="suggest-check">
              <input type="checkbox" checked={keepSelected} onChange={(e) => setKeepSelected(e.target.checked)} />
              Conservar los radares seleccionados en el historial
            </label>
            <label className="cs-field">
              <span className="cs-label">Separación mínima (m)</span>
              <input
                aria-label="Separación mínima (m)"
                type="number"
                min={SEPARATION_SCHEMA.minimum}
                max={SEPARATION_SCHEMA.maximum}
                value={separation}
                onChange={(e) => setSeparation(e.target.value)}
              />
            </label>
            {!selectedRadarId && <div className="suggest-note">Selecciona un perfil de radar para calcular.</div>}
            {lockHeld && <div className="suggest-note">{SUGGESTION_BUSY_MESSAGE}</div>}
            <button type="submit" className="btn-compact primary" disabled={!selectedRadarId || lockHeld}>Calcular sugerencia</button>
          </form>
        )}
        {error && <div className="suggest-error" role="alert">{error}</div>}
        {shownResult && !running && (
          <div className="suggest-results" data-testid="suggest-results">
            <div className="suggest-results-head">
              <span className="cs-label">Sugerencias</span>
              <span className="suggest-info" title={HISTORY_LEGEND} aria-label={HISTORY_LEGEND} role="img">i</span>
            </div>
            {shownResult.suggestions.map((s, i) => {
              const entry = entryFor(s.analysis_ref);
              const id = `s${i + 1}`;
              const open = openDetail === id;
              const summary = entry ? summaryOf(entry.result, entry.snapshot ?? null) : null;
              const color = dotColor(entry);
              return (
                <div className="suggest-item" key={s.analysis_ref} data-testid="suggest-card">
                  <button type="button" className="suggest-line" aria-expanded={open} aria-controls={`suggest-detail-${id}`} onClick={() => toggleDetail(id)}>
                    <span className="suggest-dot" aria-hidden="true" style={color ? { background: color } : undefined} />
                    <strong>Sugerencia {i + 1}</strong>
                    {entry && (
                      <span className="suggest-line-figures">
                        útil {formatKpiPercent(summary?.usefulCoveragePct ?? null)} · {formatKpiHectares(summary?.usefulAreaM2 ?? null)}
                      </span>
                    )}
                  </button>
                  <div id={`suggest-detail-${id}`} className="suggest-detail" data-testid="suggest-detail" hidden={!open}>
                    {entry ? (
                      <>
                        <div className="suggest-coords">
                          <span>Este: {formatCoordinate(entry.position.x)}</span>{" "}
                          <span>Norte: {formatCoordinate(entry.position.y)}</span>{" "}
                          <span>Cota: {formatCoordinate(entry.position.z)}</span>
                        </div>
                        <div>Centro de azimut: {azimuthText(entry)}</div>
                        {s.aoi_fits_azimuth === false && (
                          <div className="suggest-note">El área no cabe completa en la apertura de azimut de esta posición.</div>
                        )}
                        <QualitySummaryView
                          compact
                          summary={summary}
                          metricLabel={metricLabel(shownResult.metric)}
                          coveragePct={entry.result.coverage_pct ?? null}
                          completenessPct={entry.result.completeness_pct ?? null}
                        />
                      </>
                    ) : (
                      <div>Este análisis ya no está en el historial.</div>
                    )}
                  </div>
                </div>
              );
            })}
            {unionView()}
            {notes.length > 0 && (
              <div className="suggest-item">
                <button type="button" className="suggest-line" aria-expanded={openDetail === "notes"} aria-controls="suggest-detail-notes" onClick={() => toggleDetail("notes")}>
                  <span className="suggest-line-figures">Notas del cálculo</span>
                </button>
                <div id="suggest-detail-notes" className="suggest-detail suggest-notes" hidden={openDetail !== "notes"}>
                  {notes.map((note) => <div key={note}>{note}</div>)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
