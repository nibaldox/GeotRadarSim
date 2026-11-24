/**
 * Store: alta y baja de perfiles de radar personalizados.
 *
 * Usa el catálogo real (incluidos + localStorage) y simula solo el ciclo de trabajos LOS, para
 * probar la selección, el bloqueo por despliegue, la limpieza de resultados, el historial intacto
 * y las respuestas tardías (LOS y catálogo) que llegan después del borrado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/api")>();
  return {
    ...actual,
    runLOSAnalysis: vi.fn(),
    listRadars: vi.fn(actual.listRadars),
    getLOSJob: vi.fn(),
    releaseLOSJob: vi.fn(),
    cancelLOSAnalysis: vi.fn(),
  };
});

import { useAnalysisStore, CUSTOM_RADAR_DEPLOYED_ERROR } from "./analysisStore";
import type { HistoryEntry } from "./analysisStore";
import * as api from "../services/api";
import { cancelLOSAnalysis, getLOSJob, listRadars, runLOSAnalysis } from "../services/api";
import { CUSTOM_RADARS_STORAGE_KEY } from "../services/customRadars";
import type { CustomRadarInput } from "../services/customRadars";
import { saveLocalTerrain, clearLocalTerrainCache } from "../services/localDataStore";
import type { AnalysisSnapshot, JobResponse, JobStatusResponse, LOSResponse, RadarConfig } from "../types/api";

const input: CustomRadarInput = {
  name: "Radar Oeste",
  manufacturer: "Acme",
  minRangeM: 10,
  maxRangeM: 1500,
  elMinDeg: -40,
  elMaxDeg: 35,
  pattern: "RAR",
  apertureDeg: 80,
};

const sampleLOS: LOSResponse = {
  shadow_grid: [[false]],
  cell_states: new Uint8Array([5]),
  grid_rows: 1,
  grid_cols: 1,
  resolution: 1,
  coverage_polygon: [],
  coverage_pct: 100,
  completeness_pct: 100,
  visible_area_m2: 1,
  shadow_zones: [],
};

const historySnapshot = (modelId: string): AnalysisSnapshot => Object.freeze({
  terrainKey: Object.freeze({ terrain_id: "t-custom", epoch: 0 }),
  analysisId: "job-old",
  sourceAnalysisIds: Object.freeze(["job-old"]),
  generation: 1,
  radars: Object.freeze([Object.freeze({
    radarId: modelId,
    radarModelId: modelId,
    position: Object.freeze({ x: 1, y: 1, z: 1 }),
    overrides: Object.freeze({ rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null }),
  })]),
});

const historyEntry = (modelId: string): HistoryEntry => ({
  position: { x: 1, y: 1, z: 1 },
  coveragePct: 100,
  timestamp: "10:00:00",
  result: sampleLOS,
  radarId: modelId,
  selected: true,
  terrain_id: "t-custom",
  terrain_epoch: 0,
  snapshot: historySnapshot(modelId),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const addOrThrow = (radarInput: CustomRadarInput = input): string => {
  const result = useAnalysisStore.getState().addCustomRadar(radarInput);
  if (!result.ok) throw new Error(result.error);
  return result.modelId;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  clearLocalTerrainCache();
  useAnalysisStore.setState({
    radars: api.getRadarCatalog(),
    selectedRadarId: null,
    losResult: null,
    activeSnapshot: null,
    radarPosition: null,
    loading: false,
    error: null,
    rangeMinOverride: null,
    rangeMaxOverride: null,
    elMinOverride: null,
    elMaxOverride: null,
    azCenterOverride: null,
    azWidthOverride: null,
    history: [],
    deployedRadars: [],
    unifiedLos: null,
    multiLoading: false,
    terrainKey: null,
    terrainTransitioning: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

describe("addCustomRadar", () => {
  it("persiste, recarga el catálogo al final y selecciona el perfil con el reset de selectRadar", () => {
    useAnalysisStore.setState({
      selectedRadarId: "groundprobe-ssr-fx",
      rangeMaxOverride: 900,
      azWidthOverride: 60,
      losResult: sampleLOS,
      history: [historyEntry("groundprobe-ssr-fx")],
    });
    const modelId = addOrThrow();
    const state = useAnalysisStore.getState();
    expect(modelId).toMatch(/^custom-radar-oeste-[a-z0-9]+$/);
    expect(state.radars.map((radar) => radar.model_id)).toEqual([
      "groundprobe-ssr-fx", "ibis-arcsar360", "reutech-msr", "chcnav-ps-2000", modelId,
    ]);
    expect(state.radars[4]).toMatchObject({ display_name: "Radar Oeste", scan_pattern: "RAR", azimuth_range_deg: [-40, 40] });
    expect(state).toMatchObject({
      selectedRadarId: modelId,
      rangeMaxOverride: null,
      azWidthOverride: null,
      losResult: null,
      activeSnapshot: null,
    });
    expect(state.history).toHaveLength(1);
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toContain(modelId);
  });

  it("devuelve el error de validación sin persistir ni cambiar la selección", () => {
    useAnalysisStore.setState({ selectedRadarId: "ibis-arcsar360", losResult: sampleLOS });
    const result = useAnalysisStore.getState().addCustomRadar({ ...input, name: "chcnav ps-2000" });
    expect(result).toEqual({ ok: false, error: "Ya existe un perfil con ese nombre." });
    expect(useAnalysisStore.getState()).toMatchObject({ selectedRadarId: "ibis-arcsar360", losResult: sampleLOS });
    expect(useAnalysisStore.getState().radars).toHaveLength(4);
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toBeNull();
  });
});

describe("removeCustomRadar", () => {
  it("rechaza borrar un perfil desplegado sin tocar catálogo, red ni resultados", () => {
    const modelId = addOrThrow();
    const deployed = [{ id: "radar-1", modelId, position: { x: 1, y: 1, z: 1 }, color: "#ff4444", result: sampleLOS }];
    useAnalysisStore.setState({ deployedRadars: deployed, unifiedLos: sampleLOS, losResult: sampleLOS });
    const stored = localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY);

    expect(useAnalysisStore.getState().removeCustomRadar(modelId)).toEqual({ ok: false, error: CUSTOM_RADAR_DEPLOYED_ERROR });
    const state = useAnalysisStore.getState();
    expect(state.radars.some((radar) => radar.model_id === modelId)).toBe(true);
    expect(state.deployedRadars).toBe(deployed);
    expect(state).toMatchObject({ selectedRadarId: modelId, unifiedLos: sampleLOS, losResult: sampleLOS });
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toBe(stored);
  });

  it("si era el seleccionado limpia selección y resultados activos, y conserva el historial", () => {
    const modelId = addOrThrow();
    const entry = historyEntry(modelId);
    useAnalysisStore.setState({ history: [entry], losResult: sampleLOS, activeSnapshot: entry.snapshot!, rangeMinOverride: 20 });

    expect(useAnalysisStore.getState().removeCustomRadar(modelId)).toEqual({ ok: true, modelId });
    const state = useAnalysisStore.getState();
    expect(state).toMatchObject({ selectedRadarId: null, rangeMinOverride: null, losResult: null, activeSnapshot: null });
    expect(state.radars.map((radar) => radar.model_id)).not.toContain(modelId);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]!.snapshot).toBe(entry.snapshot);
    expect(state.history[0]!.radarId).toBe(modelId);
    expect(api.resolveRadar(modelId)).toBeUndefined();
  });

  it("si no era el seleccionado no toca la selección ni el resultado", () => {
    const modelId = addOrThrow();
    useAnalysisStore.setState({ selectedRadarId: "ibis-arcsar360", losResult: sampleLOS });
    expect(useAnalysisStore.getState().removeCustomRadar(modelId).ok).toBe(true);
    expect(useAnalysisStore.getState()).toMatchObject({ selectedRadarId: "ibis-arcsar360", losResult: sampleLOS });
  });

  it("no elimina perfiles incluidos", () => {
    expect(useAnalysisStore.getState().removeCustomRadar("ibis-arcsar360")).toEqual({
      ok: false, error: "Solo se pueden eliminar perfiles personalizados.",
    });
    expect(useAnalysisStore.getState().radars).toHaveLength(4);
  });

  it("un LOS en vuelo que responde después del borrado no publica ni resucita el modelo", async () => {
    const modelId = addOrThrow();
    useAnalysisStore.setState({ radarPosition: { x: 5, y: 5, z: 5 } });
    const job = deferred<JobResponse>();
    const status = deferred<JobStatusResponse>();
    vi.mocked(runLOSAnalysis).mockReturnValueOnce(job.promise);
    vi.mocked(getLOSJob).mockReturnValueOnce(status.promise);
    vi.useFakeTimers();

    const run = useAnalysisStore.getState().runAnalysis("t-custom");
    job.resolve({ job_id: "job-late", status: "PENDING" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(getLOSJob).toHaveBeenCalledWith("job-late");
    expect(useAnalysisStore.getState().loading).toBe(true);

    expect(useAnalysisStore.getState().removeCustomRadar(modelId).ok).toBe(true);
    expect(cancelLOSAnalysis).toHaveBeenCalledWith("job-late");
    status.resolve({ job_id: "job-late", status: "COMPLETED", created_at: "now", result: sampleLOS });
    await vi.advanceTimersByTimeAsync(5000);
    await run;

    const state = useAnalysisStore.getState();
    expect(state).toMatchObject({ losResult: null, activeSnapshot: null, loading: false, selectedRadarId: null, error: null });
    expect(state.history).toHaveLength(0);
    expect(state.radars.map((radar) => radar.model_id)).not.toContain(modelId);
  });

  it("un LOS cuyo trabajo se crea después del borrado se cancela al llegar", async () => {
    const modelId = addOrThrow();
    useAnalysisStore.setState({ radarPosition: { x: 5, y: 5, z: 5 } });
    const job = deferred<JobResponse>();
    vi.mocked(runLOSAnalysis).mockReturnValueOnce(job.promise);

    const run = useAnalysisStore.getState().runAnalysis("t-custom");
    useAnalysisStore.getState().removeCustomRadar(modelId);
    job.resolve({ job_id: "job-after-delete", status: "PENDING" });
    await run;

    expect(cancelLOSAnalysis).toHaveBeenCalledWith("job-after-delete");
    expect(getLOSJob).not.toHaveBeenCalled();
    expect(useAnalysisStore.getState()).toMatchObject({ losResult: null, loading: false, selectedRadarId: null });
  });

  it("una carga de catálogo iniciada antes del borrado no resucita el perfil", async () => {
    const modelId = addOrThrow();
    const stale = deferred<RadarConfig[]>();
    const staleList = api.getRadarCatalog();
    vi.mocked(listRadars).mockReturnValueOnce(stale.promise);

    const load = useAnalysisStore.getState().loadRadars();
    useAnalysisStore.getState().removeCustomRadar(modelId);
    stale.resolve(staleList);
    await load;

    const state = useAnalysisStore.getState();
    expect(state.radars.map((radar) => radar.model_id)).not.toContain(modelId);
    expect(state.loading).toBe(false);
  });

  it("volver a ejecutar desde el historial un perfil eliminado muestra el error sin romper", async () => {
    const modelId = addOrThrow();
    saveLocalTerrain({
      metadata: {
        terrain_id: "t-custom",
        bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 0, max_y: 0, max_z: 1 },
        resolution: 1,
        grid_rows: 1,
        grid_cols: 1,
      },
      grid: [[1]],
    });
    const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
    vi.mocked(runLOSAnalysis).mockImplementationOnce(actual.runLOSAnalysis);
    useAnalysisStore.setState({ history: [historyEntry(modelId)] });
    useAnalysisStore.getState().removeCustomRadar(modelId);

    useAnalysisStore.getState().restoreHistoryEntry(0);
    expect(useAnalysisStore.getState().selectedRadarId).toBe(modelId);
    await useAnalysisStore.getState().runAnalysis("t-custom");

    expect(useAnalysisStore.getState()).toMatchObject({ error: "No se encontró el modelo de radar.", loading: false });
    expect(useAnalysisStore.getState().history).toHaveLength(1);
  });
});
