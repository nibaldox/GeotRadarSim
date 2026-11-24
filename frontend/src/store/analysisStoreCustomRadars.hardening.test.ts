/**
 * Store — correcciones de la revisión adversarial: A-2 (no desplegar un perfil fantasma),
 * A-5 (catalogRevision en el alta) y B-5 (refresco cuando el borrado responde «no encontrado»).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/api")>();
  return { ...actual, listRadars: vi.fn(actual.listRadars) };
});

import { CUSTOM_RADAR_MISSING_PROFILE_ERROR, useAnalysisStore } from "./analysisStore";
import * as api from "../services/api";
import { listRadars } from "../services/api";
import { CUSTOM_RADARS_STORAGE_KEY, deleteCustomRadar, saveCustomRadar } from "../services/customRadars";
import type { CustomRadarInput } from "../services/customRadars";
import type { RadarConfig } from "../types/api";

const input: CustomRadarInput = {
  name: "Radar Fantasma",
  manufacturer: "",
  minRangeM: 10,
  maxRangeM: 900,
  elMinDeg: -30,
  elMaxDeg: 30,
  pattern: "SAR360",
  apertureDeg: 360,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  useAnalysisStore.setState({
    radars: api.getRadarCatalog(),
    selectedRadarId: null,
    radarPosition: null,
    deployedRadars: [],
    history: [],
    losResult: null,
    activeSnapshot: null,
    loading: false,
    error: null,
    terrainTransitioning: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

describe("A-2 — deployCurrentRadar con un perfil que ya no existe", () => {
  it("rechaza con mensaje en español si el id seleccionado no está en el catálogo", () => {
    useAnalysisStore.setState({ selectedRadarId: "custom-fantasma-abc123", radarPosition: { x: 1, y: 2, z: 3 } });
    useAnalysisStore.getState().deployCurrentRadar();
    expect(useAnalysisStore.getState().deployedRadars).toEqual([]);
    expect(useAnalysisStore.getState().error).toBe(CUSTOM_RADAR_MISSING_PROFILE_ERROR);
    expect(CUSTOM_RADAR_MISSING_PROFILE_ERROR).toMatch(/perfil/);
  });

  it("rechaza un perfil borrado por otra pestaña aunque siga seleccionado", () => {
    const added = useAnalysisStore.getState().addCustomRadar(input);
    if (!added.ok) throw new Error(added.error);
    deleteCustomRadar(added.modelId, api.getBuiltinRadars());
    useAnalysisStore.getState().refreshCustomRadars();
    useAnalysisStore.setState({ radarPosition: { x: 1, y: 2, z: 3 } });
    expect(useAnalysisStore.getState().selectedRadarId).toBe(added.modelId);

    useAnalysisStore.getState().deployCurrentRadar();
    expect(useAnalysisStore.getState().deployedRadars).toEqual([]);
    expect(useAnalysisStore.getState().error).toBe(CUSTOM_RADAR_MISSING_PROFILE_ERROR);
  });

  it("sigue desplegando un perfil incluido o personalizado vigente", () => {
    useAnalysisStore.setState({ selectedRadarId: "ibis-arcsar360", radarPosition: { x: 1, y: 2, z: 3 } });
    useAnalysisStore.getState().deployCurrentRadar();
    const added = useAnalysisStore.getState().addCustomRadar(input);
    if (!added.ok) throw new Error(added.error);
    useAnalysisStore.setState({ radarPosition: { x: 4, y: 5, z: 6 } });
    useAnalysisStore.getState().deployCurrentRadar();
    expect(useAnalysisStore.getState().deployedRadars.map((radar) => radar.modelId)).toEqual(["ibis-arcsar360", added.modelId]);
    expect(useAnalysisStore.getState().error).toBeNull();
  });
});

describe("A-5 — el alta invalida una carga de catálogo en vuelo", () => {
  it("una carga iniciada antes del alta no borra el perfil recién creado", async () => {
    const stale = deferred<RadarConfig[]>();
    const staleList = api.getRadarCatalog();
    vi.mocked(listRadars).mockReturnValueOnce(stale.promise);

    const load = useAnalysisStore.getState().loadRadars();
    const added = useAnalysisStore.getState().addCustomRadar(input);
    if (!added.ok) throw new Error(added.error);
    stale.resolve(staleList);
    await load;

    const state = useAnalysisStore.getState();
    expect(state.radars.map((radar) => radar.model_id)).toContain(added.modelId);
    expect(state.selectedRadarId).toBe(added.modelId);
    expect(state.loading).toBe(false);
  });
});

describe("B-5 — refresco del catálogo cuando el perfil ya no está guardado", () => {
  it("«Eliminar perfil» que responde «no encontrado» recarga el catálogo", () => {
    const saved = saveCustomRadar(input, api.getBuiltinRadars());
    if (!saved.ok) throw new Error(saved.error);
    useAnalysisStore.setState({ radars: api.getRadarCatalog() });
    deleteCustomRadar(saved.radar.model_id, api.getBuiltinRadars());

    expect(useAnalysisStore.getState().removeCustomRadar(saved.radar.model_id)).toEqual({
      ok: false, error: "No se encontró el perfil personalizado.",
    });
    expect(useAnalysisStore.getState().radars.map((radar) => radar.model_id)).not.toContain(saved.radar.model_id);
  });

  it("refreshCustomRadars relee localStorage e invalida una carga en vuelo", async () => {
    const stale = deferred<RadarConfig[]>();
    vi.mocked(listRadars).mockReturnValueOnce(stale.promise);
    const load = useAnalysisStore.getState().loadRadars();

    const saved = saveCustomRadar(input, api.getBuiltinRadars());
    if (!saved.ok) throw new Error(saved.error);
    useAnalysisStore.getState().refreshCustomRadars();
    expect(useAnalysisStore.getState().radars.map((radar) => radar.model_id)).toContain(saved.radar.model_id);

    stale.resolve(api.getBuiltinRadars());
    await load;
    expect(useAnalysisStore.getState().radars.map((radar) => radar.model_id)).toContain(saved.radar.model_id);
  });
});
