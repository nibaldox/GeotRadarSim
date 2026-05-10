/**
 * Tests for the analysis Zustand store.
 *
 * The store manages: radar list, current radar selection, LOS analysis results,
 * loading state, and errors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAnalysisStore } from "../store/analysisStore";

// Mock the API client
vi.mock("../services/api", () => ({
  runLOSAnalysis: vi.fn(),
  listRadars: vi.fn(),
  getRadar: vi.fn(),
  getLOSJob: vi.fn(),
}));

import { runLOSAnalysis, listRadars, getLOSJob } from "../services/api";
import type { RadarConfig, LOSResponse } from "../types/api";

beforeEach(() => {
  vi.clearAllMocks();
  useAnalysisStore.setState({
    radars: [],
    selectedRadarId: null,
    losResult: null,
    radarPosition: null,
    loading: false,
    error: null,
  });
});

const sampleRadar: RadarConfig = {
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
};

const sampleLOS: LOSResponse = {
  shadow_grid: [
    [false, true, false],
    [false, false, true],
    [true, false, false],
  ],
  coverage_polygon: [[0, 0], [200, 0], [200, 200], [0, 200]],
  coverage_pct: 66.67,
  visible_area_m2: 26668,
  shadow_zones: [
    { zone_id: 1, cell_count: 2 },
  ],
};

// ────────────────────────────────────────────
// loadRadars action
// ────────────────────────────────────────────
describe("useAnalysisStore — loadRadars", () => {
  it("fetches radar list and stores it", async () => {
    const radarList: RadarConfig[] = [
      sampleRadar,
      {
        ...sampleRadar,
        model_id: "ibis-arcsar360",
        display_name: "IBIS-ArcSAR360",
        scan_pattern: "SAR360",
        azimuth_range_deg: null,
      },
    ];
    vi.mocked(listRadars).mockResolvedValueOnce(radarList);

    await useAnalysisStore.getState().loadRadars();

    expect(listRadars).toHaveBeenCalledOnce();
    const state = useAnalysisStore.getState();
    expect(state.radars).toHaveLength(2);
    expect(state.radars[0]!.model_id).toBe("groundprobe-ssr-fx");
    expect(state.radars[1]!.model_id).toBe("ibis-arcsar360");
    expect(state.error).toBeNull();
  });

  it("stores error on failure", async () => {
    vi.mocked(listRadars).mockRejectedValueOnce(new Error("Network error"));

    await useAnalysisStore.getState().loadRadars();

    const state = useAnalysisStore.getState();
    expect(state.radars).toEqual([]);
    expect(state.error).toBe("Network error");
  });
});

// ────────────────────────────────────────────
// selectRadar action
// ────────────────────────────────────────────
describe("useAnalysisStore — selectRadar", () => {
  it("sets the selected radar model ID", () => {
    useAnalysisStore.getState().selectRadar("groundprobe-ssr-fx");

    expect(useAnalysisStore.getState().selectedRadarId).toBe("groundprobe-ssr-fx");
  });

  it("can deselect by passing null", () => {
    useAnalysisStore.getState().selectRadar("groundprobe-ssr-fx");
    useAnalysisStore.getState().selectRadar(null);

    expect(useAnalysisStore.getState().selectedRadarId).toBeNull();
  });
});

// ────────────────────────────────────────────
// setRadarPosition action
// ────────────────────────────────────────────
describe("useAnalysisStore — setRadarPosition", () => {
  it("stores the radar position", () => {
    useAnalysisStore.getState().setRadarPosition({ x: 50, y: 50, z: 10 });

    expect(useAnalysisStore.getState().radarPosition).toEqual({
      x: 50,
      y: 50,
      z: 10,
    });
  });
});

// ────────────────────────────────────────────
// runAnalysis action
// ────────────────────────────────────────────
describe("useAnalysisStore — runAnalysis", () => {
  it("runs LOS analysis and stores result", async () => {
    vi.mocked(runLOSAnalysis).mockResolvedValueOnce({ job_id: "job-1", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({ job_id: "job-1", status: "COMPLETED", created_at: "now", result: sampleLOS });
    useAnalysisStore.setState({
      selectedRadarId: "groundprobe-ssr-fx",
      radarPosition: { x: 100, y: 100, z: 5 },
    });

    vi.useFakeTimers();
    useAnalysisStore.getState().runAnalysis("terrain-1");
    // Advance timers so setTimeout fires
    vi.advanceTimersByTime(1100);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(runLOSAnalysis).toHaveBeenCalledWith({
      terrain_id: "terrain-1",
      radar_position: { x: 100, y: 100, z: 5 },
      radar_model_id: "groundprobe-ssr-fx",
    });
    expect(getLOSJob).toHaveBeenCalledWith("job-1");

    const state = useAnalysisStore.getState();
    expect(state.losResult).toEqual(sampleLOS);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("stores error when terrain/radar not configured", async () => {
    // No radar selected, no position set
    await useAnalysisStore.getState().runAnalysis("terrain-1");

    const state = useAnalysisStore.getState();
    expect(state.losResult).toBeNull();
    expect(state.error).toBe("Radar model and position must be set before analysis");
  });

  it("stores error on API failure", async () => {
    vi.mocked(runLOSAnalysis).mockRejectedValueOnce(
      new Error("Terrain 'bad' not found"),
    );
    useAnalysisStore.setState({
      selectedRadarId: "groundprobe-ssr-fx",
      radarPosition: { x: 0, y: 0, z: 0 },
    });

    await useAnalysisStore.getState().runAnalysis("bad");

    const state = useAnalysisStore.getState();
    expect(state.losResult).toBeNull();
    expect(state.error).toBe("Terrain 'bad' not found");
  });
});

// ────────────────────────────────────────────
// clearResult action
// ────────────────────────────────────────────
describe("useAnalysisStore — clearResult", () => {
  it("clears LOS result", () => {
    useAnalysisStore.setState({ losResult: sampleLOS });

    useAnalysisStore.getState().clearResult();

    expect(useAnalysisStore.getState().losResult).toBeNull();
  });
});
