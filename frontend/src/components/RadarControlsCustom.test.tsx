/**
 * RadarControls: formulario inline de radar personalizado, grupo «Personalizados» en el selector
 * y «Eliminar perfil» bloqueado con su motivo cuando el perfil está desplegado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { RadarControls } from "./RadarControls";
import { CUSTOM_RADAR_DEPLOYED_ERROR, useAnalysisStore } from "../store/analysisStore";
import { getRadarCatalog } from "../services/api";
import { CUSTOM_RADARS_STORAGE_KEY } from "../services/customRadars";

beforeEach(() => {
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  localStorage.setItem("geotradar-collapse-radar-params", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useAnalysisStore.setState({
    radars: getRadarCatalog(),
    selectedRadarId: null,
    radarPosition: null,
    loading: false,
    error: null,
    losResult: null,
    activeSnapshot: null,
    deployedRadars: [],
    history: [],
    terrainTransitioning: false,
    rangeMinOverride: null,
    rangeMaxOverride: null,
    elMinOverride: null,
    elMaxOverride: null,
    azCenterOverride: null,
    azWidthOverride: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

const openForm = () => {
  const toggle = screen.getByRole("button", { name: "Radar personalizado" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return screen.getByRole("group", { name: "Nuevo radar personalizado" });
};

const fill = (form: HTMLElement, label: RegExp, value: string) => {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
};

const saveSector = (name = "Radar Este") => {
  const form = openForm();
  fill(form, /^Nombre/, name);
  fill(form, /^Rango máx/, "3200");
  fireEvent.change(within(form).getByLabelText(/^Cobertura/), { target: { value: "RAR" } });
  fill(form, /^Apertura/, "110");
  fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
};

describe("RadarControls — radar personalizado", () => {
  it("abre el formulario, guarda y agrega una opción seleccionada en «Personalizados» al final", () => {
    render(<RadarControls />);
    saveSector();

    expect(screen.queryByRole("group", { name: "Nuevo radar personalizado" })).not.toBeInTheDocument();
    const select = screen.getByLabelText(/modelo de radar/i) as HTMLSelectElement;
    const group = select.querySelector("optgroup");
    expect(group).toHaveAttribute("label", "Personalizados");
    expect(select.lastElementChild).toBe(group);
    const option = within(group as HTMLElement).getByRole("option", { name: "Radar Este" }) as HTMLOptionElement;
    expect(option.selected).toBe(true);
    expect(select.value).toMatch(/^custom-radar-este-/);
    // Los incluidos conservan sus índices.
    const options = screen.getAllByRole("option");
    expect(options.slice(1, 5).map((o) => o.textContent)).toEqual(["GroundProbe SSR-FX", "IBIS-ArcSAR360", "Reutech MSR", "CHCNAV PS-2000"]);
    expect(screen.getByRole("button", { name: /Radar.*Radar Este.*50–3200 m.*110°/ })).toBeInTheDocument();
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toContain("Radar Este");
  });

  it("valida en español en una línea y no agrega nada", () => {
    render(<RadarControls />);
    const form = openForm();
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Escribe un nombre para el perfil.");

    fill(form, /^Nombre/, "ibis-arcsar360");
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Ya existe un perfil con ese nombre.");

    fill(form, /^Nombre/, "Otro");
    fill(form, /^Rango mín/, "");
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(/rango mínimo/);

    expect(screen.getByLabelText(/modelo de radar/i).querySelector("optgroup")).toBeNull();
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toBeNull();
  });

  it("habilita «Apertura (°)» solo con cobertura Sector, y Cancelar cierra sin guardar", () => {
    render(<RadarControls />);
    const form = openForm();
    const aperture = within(form).getByLabelText("Apertura (°)");
    expect(aperture).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Cobertura"), { target: { value: "RAR" } });
    expect(aperture).toBeEnabled();
    expect(within(within(form).getByLabelText("Cobertura")).getAllByRole("option").map((o) => o.textContent)).toEqual(["360°", "Sector"]);

    fill(form, /^Nombre/, "Borrador");
    fireEvent.click(within(form).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("group", { name: "Nuevo radar personalizado" })).not.toBeInTheDocument();
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toBeNull();
    expect((within(openForm()).getByLabelText(/^Nombre/) as HTMLInputElement).value).toBe("");
  });

  it("«Eliminar perfil» solo aparece con un personalizado y se bloquea con el motivo si está desplegado", () => {
    useAnalysisStore.setState({ selectedRadarId: "ibis-arcsar360" });
    render(<RadarControls />);
    expect(screen.queryByRole("button", { name: "Eliminar perfil" })).not.toBeInTheDocument();

    saveSector();
    const modelId = useAnalysisStore.getState().selectedRadarId!;
    act(() => { useAnalysisStore.setState({ deployedRadars: [{ id: "radar-1", modelId, position: { x: 1, y: 2, z: 3 }, color: "#ff4444" }] }); });

    fireEvent.click(screen.getByRole("button", { name: "Eliminar perfil" }));
    expect(screen.getByRole("alert")).toHaveTextContent(CUSTOM_RADAR_DEPLOYED_ERROR);
    expect(screen.getByRole("option", { name: "Radar Este" })).toBeInTheDocument();
    expect(useAnalysisStore.getState().selectedRadarId).toBe(modelId);
  });

  it("elimina el perfil seleccionado no desplegado y vuelve a «Elige un modelo»", () => {
    render(<RadarControls />);
    saveSector();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar perfil" }));

    expect(screen.queryByRole("option", { name: "Radar Este" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/modelo de radar/i).querySelector("optgroup")).toBeNull();
    expect((screen.getByLabelText(/modelo de radar/i) as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Eliminar perfil" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useAnalysisStore.getState().selectedRadarId).toBeNull();
  });

  it("muestra perfiles guardados en una sesión anterior al cargar el catálogo", async () => {
    localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify([{
      model_id: "custom-guardado-abc123", name: "Guardado", manufacturer: "", minRangeM: 0, maxRangeM: 800,
      elMinDeg: -10, elMaxDeg: 10, pattern: "SAR360", apertureDeg: 360,
    }]));
    useAnalysisStore.setState({ radars: [] });
    render(<RadarControls />);
    expect(await screen.findByRole("option", { name: "Guardado" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("desactiva el alta y el formulario durante una transición de terreno", () => {
    render(<RadarControls />);
    const form = openForm();
    act(() => { useAnalysisStore.setState({ terrainTransitioning: true }); });
    expect(screen.getByRole("button", { name: "Radar personalizado" })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Guardar" })).toBeDisabled();
    expect(within(form).getByLabelText(/^Nombre/)).toBeDisabled();
  });
});
