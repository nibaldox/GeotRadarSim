/**
 * Tests for RadarControls component.
 *
 * Tests the model selector and position display
 * using @testing-library/react with jsdom.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RadarControls } from "../components/RadarControls";
import { useAnalysisStore } from "../store/analysisStore";
import type { RadarConfig } from "../types/api";

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
  it("renders radar model options from store", () => {
    useAnalysisStore.setState({ radars: radarConfigs });

    render(<RadarControls />);

    const select = screen.getByLabelText(/radar model/i);
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

    const select = screen.getByLabelText(/radar model/i);
    fireEvent.change(select, { target: { value: "ibis-arcsar360" } });

    expect(spy).toHaveBeenCalledWith("ibis-arcsar360");
  });

  it("displays radar position when set", () => {
    useAnalysisStore.setState({
      radars: radarConfigs,
      radarPosition: { x: 50.5, y: 10.2, z: 75.3 },
    });

    render(<RadarControls />);

    expect(screen.getByText(/50\.5/)).toBeInTheDocument();
    expect(screen.getByText(/10\.2/)).toBeInTheDocument();
    expect(screen.getByText(/75\.3/)).toBeInTheDocument();
  });

  it("shows no position message when radar not placed", () => {
    useAnalysisStore.setState({ radars: radarConfigs });

    render(<RadarControls />);

    expect(screen.getByText(/click on terrain/i)).toBeInTheDocument();
  });
});
