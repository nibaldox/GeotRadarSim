/**
 * UI — correcciones de la revisión adversarial: A-1 (aviso de perfil inexistente en Resultados),
 * A-3/A-4 (errores que no quedan obsoletos) y B-5 (evento `storage` de otra pestaña).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { RadarControls } from "./RadarControls";
import { QualityDashboard } from "./QualityDashboard";
import { CUSTOM_RADAR_DEPLOYED_ERROR, useAnalysisStore } from "../store/analysisStore";
import type { HistoryEntry } from "../store/analysisStore";
import { getBuiltinRadars, getRadarCatalog } from "../services/api";
import { CUSTOM_RADARS_STORAGE_KEY, deleteCustomRadar, saveCustomRadar } from "../services/customRadars";
import type { CustomRadarInput } from "../services/customRadars";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const MISSING_PROFILE_NOTICE = "El perfil de este análisis ya no existe; los parámetros del modelo no están disponibles.";

const input: CustomRadarInput = {
  name: "Radar Este",
  manufacturer: "",
  minRangeM: 50,
  maxRangeM: 3200,
  elMinDeg: -30,
  elMaxDeg: 30,
  pattern: "RAR",
  apertureDeg: 110,
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

const snapshotFor = (...modelIds: string[]): AnalysisSnapshot => ({
  terrainKey: { terrain_id: "t-ui", epoch: 0 },
  analysisId: "job-ui",
  sourceAnalysisIds: ["job-ui"],
  generation: 1,
  radars: modelIds.map((modelId, index) => ({
    radarId: `r-${index}`,
    radarModelId: modelId,
    position: { x: 1, y: 1, z: 1 },
    overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
  })),
});

const addOrThrow = (radarInput: CustomRadarInput = input): string => {
  const result = useAnalysisStore.getState().addCustomRadar(radarInput);
  if (!result.ok) throw new Error(result.error);
  return result.modelId;
};

const openForm = () => {
  fireEvent.click(screen.getByRole("button", { name: "Radar personalizado" }));
  return screen.getByRole("group", { name: "Nuevo radar personalizado" });
};

beforeEach(() => {
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  localStorage.setItem("geotradar-collapse-radar-params", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useAnalysisStore.setState({
    radars: getRadarCatalog(),
    selectedRadarId: null,
    radarPosition: null,
    loading: false,
    multiLoading: false,
    error: null,
    losResult: null,
    activeSnapshot: null,
    deployedRadars: [],
    history: [],
    terrainKey: null,
    terrainTransitioning: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

describe("A-1 — Resultados avisa cuando el perfil del análisis ya no existe", () => {
  it("muestra el aviso al reactivar del historial un análisis de un perfil eliminado", () => {
    const modelId = addOrThrow();
    const entry: HistoryEntry = {
      position: { x: 1, y: 1, z: 1 },
      coveragePct: 100,
      timestamp: "10:00:00",
      result: sampleLOS,
      radarId: modelId,
      selected: true,
      terrain_id: "t-ui",
      terrain_epoch: 0,
      snapshot: snapshotFor(modelId),
    };
    useAnalysisStore.setState({ history: [entry] });
    render(<QualityDashboard />);
    expect(screen.queryByText(MISSING_PROFILE_NOTICE)).not.toBeInTheDocument();

    act(() => {
      useAnalysisStore.getState().restoreHistoryEntry(0);
    });
    expect(screen.queryByText(MISSING_PROFILE_NOTICE)).not.toBeInTheDocument();

    act(() => {
      useAnalysisStore.getState().selectRadar(null);
      useAnalysisStore.getState().removeCustomRadar(modelId);
      useAnalysisStore.getState().restoreHistoryEntry(0);
    });
    expect(useAnalysisStore.getState().activeSnapshot).toBe(entry.snapshot);
    expect(screen.getByText(MISSING_PROFILE_NOTICE)).toBeInTheDocument();
  });

  it("avisa si cualquier radar del resultado activo no resuelve, y calla si todos resuelven", () => {
    useAnalysisStore.setState({ activeSnapshot: snapshotFor("ibis-arcsar360", "custom-borrado-abc123"), losResult: sampleLOS });
    const { unmount } = render(<QualityDashboard />);
    expect(screen.getByText(MISSING_PROFILE_NOTICE)).toBeInTheDocument();
    unmount();

    useAnalysisStore.setState({ activeSnapshot: snapshotFor("ibis-arcsar360", "chcnav-ps-2000") });
    render(<QualityDashboard />);
    expect(screen.queryByText(MISSING_PROFILE_NOTICE)).not.toBeInTheDocument();
  });
});

describe("A-3 — el error del formulario no queda obsoleto", () => {
  it("se limpia tras eliminar con éxito el perfil que causaba el duplicado", () => {
    render(<RadarControls />);
    act(() => { addOrThrow(); });
    const form = openForm();
    fireEvent.change(within(form).getByLabelText(/^Nombre/), { target: { value: "radar este" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Ya existe un perfil con ese nombre.");

    fireEvent.click(screen.getByRole("button", { name: "Eliminar perfil" }));
    expect(screen.queryByRole("option", { name: "Radar Este" })).not.toBeInTheDocument();
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("se limpia cuando cambia el catálogo", () => {
    render(<RadarControls />);
    const form = openForm();
    fireEvent.change(within(form).getByLabelText(/^Nombre/), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(within(form).getByRole("alert")).toBeInTheDocument();

    act(() => { useAnalysisStore.setState({ radars: [...getRadarCatalog()] }); });
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("A-4 — el error de borrado no queda obsoleto", () => {
  const blockDelete = () => {
    render(<RadarControls />);
    let modelId = "";
    act(() => { modelId = addOrThrow(); });
    act(() => {
      useAnalysisStore.setState({ deployedRadars: [{ id: "radar-1", modelId, position: { x: 1, y: 2, z: 3 }, color: "#ff4444" }] });
    });
    fireEvent.click(screen.getByRole("button", { name: "Eliminar perfil" }));
    expect(screen.getByRole("alert")).toHaveTextContent(CUSTOM_RADAR_DEPLOYED_ERROR);
  };

  it("se limpia cuando cambian los radares desplegados", () => {
    blockDelete();
    act(() => { useAnalysisStore.getState().clearDeployedRadars(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("se limpia cuando cambia el terreno", () => {
    blockDelete();
    act(() => { useAnalysisStore.setState({ terrainKey: { terrain_id: "otro-terreno", epoch: 3 } }); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("B-5 — cambios hechos en otra pestaña", () => {
  it("un evento storage de la clave recarga el selector", () => {
    render(<RadarControls />);
    expect(screen.queryByRole("option", { name: "Otra pestaña" })).not.toBeInTheDocument();

    const saved = saveCustomRadar({ ...input, name: "Otra pestaña" }, getBuiltinRadars());
    if (!saved.ok) throw new Error(saved.error);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "geotradar-theme" }));
    });
    expect(screen.queryByRole("option", { name: "Otra pestaña" })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CUSTOM_RADARS_STORAGE_KEY }));
    });
    expect(screen.getByRole("option", { name: "Otra pestaña" })).toBeInTheDocument();

    deleteCustomRadar(saved.radar.model_id, getBuiltinRadars());
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(screen.queryByRole("option", { name: "Otra pestaña" })).not.toBeInTheDocument();
  });

  it("deja de escuchar al desmontar", () => {
    const { unmount } = render(<RadarControls />);
    unmount();
    const before = useAnalysisStore.getState().radars;
    saveCustomRadar({ ...input, name: "Tras desmontar" }, getBuiltinRadars());
    window.dispatchEvent(new StorageEvent("storage", { key: CUSTOM_RADARS_STORAGE_KEY }));
    expect(useAnalysisStore.getState().radars).toBe(before);
  });
});
