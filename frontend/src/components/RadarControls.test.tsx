/**
 * Tests for RadarControls component.
 *
 * Tests the model selector and position display
 * using @testing-library/react with jsdom.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RadarControls } from "../components/RadarControls";
import { useAnalysisStore } from "../store/analysisStore";
import type { RadarConfig } from "../types/api";
import { listRadars } from "../services/api";

beforeEach(() => {
  useAnalysisStore.setState({
    radars: [],
    selectedRadarId: null,
    radarPosition: null,
    loading: false,
    error: null,
    losResult: null,
  });
});

const radarConfigs: RadarConfig[] = [
  {
    model_id: "groundprobe-ssr-fx",
    min_range_m: 0,
    display_name: "GroundProbe SSR-FX",
    manufacturer: "GroundProbe",
    max_range_m: 850,
    h_beam_width_deg: 120,
    v_beam_width_deg: 30,
    elevation_min_deg: -30,
    elevation_max_deg: 30,
    scan_pattern: "RAR",
    azimuth_range_deg: [-60, 60],
  },
  {
    model_id: "ibis-arcsar360",
    min_range_m: 10,
    display_name: "IBIS-ArcSAR360",
    manufacturer: "IDS GeoRadar",
    max_range_m: 4000,
    h_beam_width_deg: 360,
    v_beam_width_deg: 30,
    elevation_min_deg: -15,
    elevation_max_deg: 15,
    scan_pattern: "SAR360",
    azimuth_range_deg: null,
  },
];

describe("RadarControls", () => {
  it("pliega Parámetros y permite abrirlos con teclado mostrando los ajustes reales", async () => {
    localStorage.removeItem("geotradar-collapse-radar-params");
    useAnalysisStore.setState({ radars: radarConfigs, selectedRadarId: radarConfigs[0]!.model_id, rangeMinOverride: 0, rangeMaxOverride: 900, elMinOverride: -20, elMaxOverride: null, azCenterOverride: null, azWidthOverride: null, terrainTransitioning: false });
    render(<RadarControls />);
    const toggle = screen.getByRole("button", { name: /Parámetros.*2 ajustados/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("spinbutton", { name: /Rango máx/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/modelo de radar/i)).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: /^E/ })).toBeInTheDocument();
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("spinbutton", { name: /Rango máx/i })).toHaveValue(900);
    expect(localStorage.getItem("geotradar-collapse-radar-params")).toBe("false");
    useAnalysisStore.setState({ rangeMinOverride: null, rangeMaxOverride: null, elMinOverride: null, elMaxOverride: null, azCenterOverride: null, azWidthOverride: null });
  });

  it("compara azimut y apertura con el rango de fábrica del modelo", () => {
    localStorage.removeItem("geotradar-collapse-radar-params");
    const model = { ...radarConfigs[0]!, azimuth_range_deg: [-75, 75] as [number, number] };
    useAnalysisStore.setState({ radars: [model], selectedRadarId: model.model_id, rangeMinOverride: null, rangeMaxOverride: null, elMinOverride: null, elMaxOverride: null, azCenterOverride: 30, azWidthOverride: 150, terrainTransitioning: false });
    render(<RadarControls />);
    expect(screen.getByRole("button", { name: /Parámetros.*1 ajustado/i })).toBeInTheDocument();
    useAnalysisStore.setState({ azCenterOverride: null, azWidthOverride: null });
  });

  it("muestra la apertura del sector de fábrica (150° del SSR-FX), la misma que usa el LOS", async () => {
    localStorage.setItem("geotradar-collapse-radar-params", "false");
    const catalog = await listRadars();
    useAnalysisStore.setState({ radars: catalog, selectedRadarId: "groundprobe-ssr-fx", rangeMinOverride: null, rangeMaxOverride: null, elMinOverride: null, elMaxOverride: null, azCenterOverride: null, azWidthOverride: null, terrainTransitioning: false });
    render(<RadarControls />);
    expect(screen.getByRole("button", { name: /Radar.*GroundProbe SSR-FX.*50–2500 m.*150°/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /120°/ })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Apertura/ })).toHaveAttribute("placeholder", "150");
    expect(screen.getByRole("spinbutton", { name: /Azimut/ })).toHaveAttribute("placeholder", "0");
    expect(screen.getByText(/Fábrica: rango 50–2500 m, apertura 150° \(azimut 0°\)/)).toBeInTheDocument();
    expect(screen.queryByText(/haz/)).not.toBeInTheDocument();
  });

  it("toma el centro y la apertura de fábrica de azimuth_range_deg, no de un valor fijo", () => {
    localStorage.setItem("geotradar-collapse-radar-params", "false");
    const model = { ...radarConfigs[0]!, azimuth_range_deg: [10, 100] as [number, number] };
    useAnalysisStore.setState({ radars: [model], selectedRadarId: model.model_id, azCenterOverride: null, azWidthOverride: null, terrainTransitioning: false });
    render(<RadarControls />);
    expect(screen.getByRole("button", { name: /Radar.*90°/ })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Apertura/ })).toHaveAttribute("placeholder", "90");
    expect(screen.getByRole("spinbutton", { name: /Azimut/ })).toHaveAttribute("placeholder", "55");
  });

  it("reconoce el círculo completo de fábrica sin marcar su apertura como ajustada", () => {
    localStorage.removeItem("geotradar-collapse-radar-params");
    const model = { ...radarConfigs[0]!, azimuth_range_deg: [-180, 180] as [number, number] };
    useAnalysisStore.setState({ radars: [model], selectedRadarId: model.model_id, azCenterOverride: null, azWidthOverride: 360, terrainTransitioning: false });
    render(<RadarControls />);
    expect(screen.getByRole("button", { name: /Parámetros.*de fábrica/i })).toBeInTheDocument();
    useAnalysisStore.setState({ azWidthOverride: null });
  });

  it.each([undefined, null])("muestra el resumen sin fallar con azimuth_range_deg %s", (range) => {
    const model = { ...radarConfigs[1]!, azimuth_range_deg: range } as RadarConfig;
    useAnalysisStore.setState({ radars: [model], selectedRadarId: model.model_id });
    render(<RadarControls />);
    expect(screen.getByRole("button", { name: /Radar.*IBIS-ArcSAR360.*10–4000 m.*360°/i })).toBeInTheDocument();
  });

  it("renders radar model options from store", () => {
    useAnalysisStore.setState({ radars: radarConfigs });

    render(<RadarControls />);

    const select = screen.getByLabelText(/modelo de radar/i);
    expect(select).toBeInTheDocument();

    const options = screen.getAllByRole("option");
    // 2 radar models + 1 placeholder option
    expect(options).toHaveLength(3);
    expect(options[1]).toHaveTextContent("GroundProbe SSR-FX");
    expect(options[2]).toHaveTextContent("IBIS-ArcSAR360");
  });

  it("calls selectRadar when a model is chosen", () => {
    useAnalysisStore.setState({ radars: radarConfigs });
    const spy = vi.spyOn(useAnalysisStore.getState(), "selectRadar");

    render(<RadarControls />);

    const select = screen.getByLabelText(/modelo de radar/i);
    fireEvent.change(select, { target: { value: "ibis-arcsar360" } });

    expect(spy).toHaveBeenCalledWith("ibis-arcsar360");
  });

  it("displays radar position when set", () => {
    useAnalysisStore.setState({
      radars: radarConfigs,
      radarPosition: { x: 50.5, y: 10.2, z: 75.3 },
    });

    render(<RadarControls />);

    expect(screen.getByDisplayValue("50.5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10.2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("75.3")).toBeInTheDocument();
  });

  it("shows helper message when radar not placed", () => {
    useAnalysisStore.setState({ radars: radarConfigs });

    render(<RadarControls />);

    expect(screen.getByText(/Haz clic en el terreno con «Agregar radar» para ubicarlo/i)).toBeInTheDocument();
  });

  it("allows manual coordinate entry and calls setRadarPosition when Apply is clicked", () => {
    useAnalysisStore.setState({
      radars: radarConfigs,
      selectedRadarId: "groundprobe-ssr-fx",
      radarPosition: null,
    });

    const spy = vi.spyOn(useAnalysisStore.getState(), "setRadarPosition");

    render(<RadarControls />);

    const inputX = screen.getByPlaceholderText(/Este/i);
    const inputY = screen.getByPlaceholderText(/Norte/i);
    const inputZ = screen.getByPlaceholderText(/Cota/i);
    const applyBtn = screen.getByRole("button", { name: /Aplicar/i });

    fireEvent.change(inputX, { target: { value: "100.5" } });
    fireEvent.change(inputY, { target: { value: "200.2" } });
    fireEvent.change(inputZ, { target: { value: "15.0" } });
    fireEvent.click(applyBtn);

    expect(spy).toHaveBeenCalledWith({ x: 100.5, y: 200.2, z: 15.0 });
  });

  it("disables radar configuration and manual placement controls during terrain transitions", () => {
    useAnalysisStore.setState({
      radars: radarConfigs,
      selectedRadarId: "groundprobe-ssr-fx",
      terrainTransitioning: true,
    });

    localStorage.setItem("geotradar-collapse-radar-params", "false");
    render(<RadarControls />);

    expect(screen.getByLabelText(/modelo de radar/i)).toBeDisabled();
    expect(screen.getAllByRole("spinbutton").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByRole("button", { name: /Aplicar/i })).toBeDisabled();
  });
});
