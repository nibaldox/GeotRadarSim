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
  min_range_m: 0,
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

// ────────────────────────────────────────────
// Multi-Radar actions
// ────────────────────────────────────────────
describe("useAnalysisStore — Multi-Radar actions", () => {
  it("deploys the current radar and clears deployed list", () => {
    useAnalysisStore.setState({
      selectedRadarId: "groundprobe-ssr-fx",
      radarPosition: { x: 100, y: 200, z: 15 },
      deployedRadars: [],
    });

    const store = useAnalysisStore.getState();
    store.deployCurrentRadar();

    const state = useAnalysisStore.getState();
    expect(state.deployedRadars).toHaveLength(1);
    expect(state.deployedRadars[0]!.modelId).toBe("groundprobe-ssr-fx");
    expect(state.deployedRadars[0]!.position).toEqual({ x: 100, y: 200, z: 15 });
    expect(state.deployedRadars[0]!.color).toBeDefined();

    // Clear all
    store.clearDeployedRadars();
    expect(useAnalysisStore.getState().deployedRadars).toHaveLength(0);
    expect(useAnalysisStore.getState().unifiedLos).toBeNull();
  });

  it("removes a single deployed radar", () => {
    const radarId = "radar-1";
    useAnalysisStore.setState({
      deployedRadars: [
        { id: radarId, modelId: "groundprobe-ssr-fx", position: { x: 10, y: 20, z: 3 }, color: "#ff4444" },
        { id: "radar-2", modelId: "reutech-msr", position: { x: 40, y: 50, z: 6 }, color: "#44aaff" },
      ],
      unifiedLos: sampleLOS,
    });

    const store = useAnalysisStore.getState();
    store.removeDeployedRadar(radarId);

    const state = useAnalysisStore.getState();
    expect(state.deployedRadars).toHaveLength(1);
    expect(state.deployedRadars[0]!.id).toBe("radar-2");
    expect(state.unifiedLos).toBeNull();
  });

  it("runs multi-radar analysis and merges results", async () => {
    const terrainId = "test-terrain";
    const radar1 = { id: "radar-1", modelId: "groundprobe-ssr-fx", position: { x: 10, y: 20, z: 3 }, color: "#ff4444" };
    const radar2 = { id: "radar-2", modelId: "reutech-msr", position: { x: 40, y: 50, z: 6 }, color: "#44aaff" };

    useAnalysisStore.setState({
      deployedRadars: [radar1, radar2],
      unifiedLos: null,
      losResult: null,
    });

    const losResult1: LOSResponse = {
      shadow_grid: [[false, true], [false, false]],
      quality_grid: [[0.8, 0], [0.9, 0.7]],
      coverage_polygon: [[10, 10]],
      coverage_pct: 75,
      visible_area_m2: 300,
      shadow_zones: [{ zone_id: 1, cell_count: 1 }],
    };

    const losResult2: LOSResponse = {
      shadow_grid: [[true, false], [false, true]],
      quality_grid: [[0, 0.6], [0.5, 0]],
      coverage_polygon: [[20, 20]],
      coverage_pct: 50,
      visible_area_m2: 200,
      shadow_zones: [{ zone_id: 1, cell_count: 2 }],
    };

    vi.mocked(runLOSAnalysis)
      .mockResolvedValueOnce({ job_id: "job-r1", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-r2", status: "PENDING" });

    vi.mocked(getLOSJob)
      .mockResolvedValueOnce({ job_id: "job-r1", status: "COMPLETED", created_at: "now", result: losResult1 })
      .mockResolvedValueOnce({ job_id: "job-r2", status: "COMPLETED", created_at: "now", result: losResult2 });

    vi.useFakeTimers();
    useAnalysisStore.getState().runMultiAnalysis(terrainId);
    
    // Trigger polling checks
    vi.advanceTimersByTime(1100);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const state = useAnalysisStore.getState();
    expect(state.error).toBeNull();
    expect(state.deployedRadars[0]!.result).toEqual(losResult1);
    expect(state.deployedRadars[1]!.result).toEqual(losResult2);

    expect(state.unifiedLos).toBeDefined();
    const unified = state.unifiedLos!;
    
    // Check merged shadow_grid: true only if ALL radars say true
    // res1.shadow_grid: [[false, true], [false, false]]
    // res2.shadow_grid: [[true, false], [false, true]]
    // [0,0]: false || true => false
    // [0,1]: true || false => false
    // [1,0]: false || false => false
    // [1,1]: false || true => false
    // So shadow_grid should be all false!
    expect(unified.shadow_grid).toEqual([[false, false], [false, false]]);

    // Check merged quality_grid: max of visible radars
    // res1.quality_grid: [[0.8, 0], [0.9, 0.7]]
    // res2.quality_grid: [[0, 0.6], [0.5, 0]]
    // [0,0]: max(0.8, 0) => 0.8
    // [0,1]: max(0, 0.6) => 0.6
    // [1,0]: max(0.9, 0.5) => 0.9
    // [1,1]: max(0.7, 0) => 0.7
    expect(unified.quality_grid).toEqual([[0.8, 0.6], [0.9, 0.7]]);

    expect(state.losResult).toEqual(unified);
  });
});

