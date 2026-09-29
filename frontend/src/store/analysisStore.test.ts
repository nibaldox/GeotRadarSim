/**
 * Tests for the analysis Zustand store.
 *
 * The store manages: radar list, current radar selection, LOS analysis results,
 * loading state, and errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAnalysisStore } from "../store/analysisStore";

// Mock the API client
vi.mock("../services/api", () => ({
  runLOSAnalysis: vi.fn(),
  listRadars: vi.fn(),
  getRadar: vi.fn(),
  getLOSJob: vi.fn(),
  releaseLOSJob: vi.fn(),
  cancelLOSAnalysis: vi.fn(),
}));

import { runLOSAnalysis, listRadars, getLOSJob, releaseLOSJob, cancelLOSAnalysis } from "../services/api";
import type { RadarConfig, LOSResponse } from "../types/api";

beforeEach(() => {
  vi.clearAllMocks();
  useAnalysisStore.setState({
    radars: [],
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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  cell_states: new Uint8Array([5, 4, 5, 5, 5, 4, 4, 5, 5]),
  grid_rows: 3,
  grid_cols: 3,
  resolution: 1,
  coverage_polygon: [[0, 0], [200, 0], [200, 200], [0, 200]],
  coverage_pct: 66.67,
  completeness_pct: 100,
  visible_area_m2: 6,
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

  it("ignores radar placement while a terrain transition is in progress", () => {
    const positionOnA = { x: 10, y: 20, z: 3 };
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-A", epoch: 1 });
    useAnalysisStore.getState().setRadarPosition(positionOnA);
    useAnalysisStore.getState().beginTerrainTransition();

    useAnalysisStore.getState().setRadarPosition({ x: 90, y: 80, z: 7 });

    expect(useAnalysisStore.getState().radarPosition).toBeNull();
  });

  it("activates terrain B without a position attempted during its transition", () => {
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-A", epoch: 1 });
    useAnalysisStore.getState().setRadarPosition({ x: 10, y: 20, z: 3 });
    useAnalysisStore.getState().beginTerrainTransition();
    useAnalysisStore.getState().setRadarPosition({ x: 90, y: 80, z: 7 });

    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-B", epoch: 2 });

    expect(useAnalysisStore.getState()).toMatchObject({
      terrainKey: { terrain_id: "terrain-B", epoch: 2 },
      terrainTransitioning: false,
      radarPosition: null,
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
    vi.mocked(releaseLOSJob).mockImplementationOnce(() => {
      expect(useAnalysisStore.getState()).toMatchObject({
        losResult: sampleLOS,
        activeSnapshot: { analysisId: "job-1" },
        history: [expect.objectContaining({ result: sampleLOS, snapshot: expect.any(Object) })],
      });
    });
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
    expect(state.activeSnapshot).toMatchObject({
      terrainKey: { terrain_id: "terrain-1", epoch: 0 },
      analysisId: "job-1",
      sourceAnalysisIds: ["job-1"],
      radars: [{
        radarModelId: "groundprobe-ssr-fx",
        position: { x: 100, y: 100, z: 5 },
        overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null },
      }],
    });
    expect(Object.isFrozen(state.activeSnapshot)).toBe(true);
    expect(Object.isFrozen(state.activeSnapshot?.terrainKey)).toBe(true);
    expect(state.history[0]?.snapshot).toBe(state.activeSnapshot);
    expect(releaseLOSJob).toHaveBeenCalledOnce();
    expect(releaseLOSJob).toHaveBeenCalledWith("job-1");

    const publishedSnapshot = state.activeSnapshot;
    useAnalysisStore.getState().selectRadar("radar-B");
    expect(useAnalysisStore.getState()).toMatchObject({ losResult: null, activeSnapshot: null });
    useAnalysisStore.getState().restoreHistoryEntry(0);
    expect(useAnalysisStore.getState().activeSnapshot).toBe(publishedSnapshot);
    expect(useAnalysisStore.getState().selectedRadarId).toBe("groundprobe-ssr-fx");
    expect(useAnalysisStore.getState().radarPosition).toEqual({ x: 100, y: 100, z: 5 });

    useAnalysisStore.getState().beginTerrainTransition();
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-B", epoch: 2 });
    useAnalysisStore.getState().selectRadar("radar-B");
    expect(useAnalysisStore.getState()).toMatchObject({
      terrainKey: { terrain_id: "terrain-B", epoch: 2 },
      losResult: null,
      activeSnapshot: null,
    });
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

  it("releases a failed LOS job after preserving its visible error", async () => {
    vi.mocked(runLOSAnalysis).mockResolvedValueOnce({ job_id: "job-failed", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-failed", status: "FAILED", error: "worker failed", created_at: "now",
    });
    vi.mocked(releaseLOSJob).mockImplementationOnce(() => {
      expect(useAnalysisStore.getState().error).toBe("worker failed");
    });
    useAnalysisStore.setState({
      selectedRadarId: "groundprobe-ssr-fx",
      radarPosition: { x: 100, y: 100, z: 5 },
    });
    vi.useFakeTimers();

    const run = useAnalysisStore.getState().runAnalysis("terrain-failed");
    await vi.advanceTimersByTimeAsync(1100);
    await run;

    expect(useAnalysisStore.getState()).toMatchObject({ error: "worker failed", loading: false });
    expect(releaseLOSJob).toHaveBeenCalledWith("job-failed");
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
      cell_states: new Uint8Array([5, 4, 5, 5]),
      grid_rows: 2,
      grid_cols: 2,
      resolution: 10,
      quality_grid: [[0.8, 0], [0.9, 0.7]],
      coverage_polygon: [[10, 10]],
      coverage_pct: 75,
      completeness_pct: 100,
      visible_area_m2: 300,
      shadow_zones: [{ zone_id: 1, cell_count: 1 }],
    };

    const losResult2: LOSResponse = {
      shadow_grid: [[true, false], [false, true]],
      cell_states: new Uint8Array([4, 5, 5, 4]),
      grid_rows: 2,
      grid_cols: 2,
      resolution: 10,
      quality_grid: [[0, 0.6], [0.5, 0]],
      coverage_polygon: [[20, 20]],
      coverage_pct: 50,
      completeness_pct: 100,
      visible_area_m2: 200,
      shadow_zones: [{ zone_id: 1, cell_count: 2 }],
    };

    vi.mocked(runLOSAnalysis)
      .mockResolvedValueOnce({ job_id: "job-r1", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-r2", status: "PENDING" });

    vi.mocked(getLOSJob)
      .mockResolvedValueOnce({ job_id: "job-r1", status: "COMPLETED", created_at: "now", result: losResult1 })
      .mockResolvedValueOnce({ job_id: "job-r2", status: "COMPLETED", created_at: "now", result: losResult2 });
    const assertMultiResultsStored = () => {
      const current = useAnalysisStore.getState();
      expect(current.deployedRadars.map((radar) => radar.result)).toEqual([losResult1, losResult2]);
      expect(current.unifiedLos).toBeDefined();
      expect(current.losResult).toBe(current.unifiedLos);
    };
    vi.mocked(releaseLOSJob)
      .mockImplementationOnce(assertMultiResultsStored)
      .mockImplementationOnce(assertMultiResultsStored);

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
    
    // Every cell is VISIBLE for at least one radar, so the union has no SHADOW state.
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
    expect(releaseLOSJob).toHaveBeenCalledTimes(2);
    expect(releaseLOSJob).toHaveBeenCalledWith("job-r1");
    expect(releaseLOSJob).toHaveBeenCalledWith("job-r2");
  });
});

describe("useAnalysisStore — NODATA-aware network union", () => {
  const networkResult = (states: number[], resolution = 2) => ({
    cell_states: new Uint8Array(states),
    grid_rows: 1,
    grid_cols: states.length,
    resolution,
    shadow_grid: [states.map((state) => state === 4)],
    quality_grid: [states.map((state) => state === 5 ? 0.7 : 0)],
    flat_quality_grid: new Float32Array(states.map((state) => state === 5 ? 0.7 : -1)),
    coverage_polygon: [],
    coverage_pct: 50,
    completeness_pct: 100,
    visible_area_m2: states.filter((state) => state === 5).length * resolution * resolution,
    shadow_zones: [],
  }) as unknown as LOSResponse;

  const selectForNetworkMerge = (first: LOSResponse, second: LOSResponse) => {
    useAnalysisStore.setState({
      terrainKey: { terrain_id: "terrain-network-test", epoch: 1 },
      terrainTransitioning: false,
      history: [
        { position: { x: 0, y: 0, z: 1 }, coveragePct: first.coverage_pct, timestamp: "a", result: first, radarId: "a", selected: true, terrain_id: "terrain-network-test", terrain_epoch: 1 },
        { position: { x: 1, y: 0, z: 1 }, coveragePct: second.coverage_pct, timestamp: "b", result: second, radarId: "b", selected: false, terrain_id: "terrain-network-test", terrain_epoch: 1 },
      ],
      losResult: first,
    });
    useAnalysisStore.getState().toggleHistoryEntrySelection(1);
    return useAnalysisStore.getState().losResult!;
  };

  it("merges rectangular states by VISIBLE > UNKNOWN_RAY > SHADOW and counts visible area once", () => {
    const first = networkResult([0, 1, 2, 4, 5, 4]);
    const second = networkResult([0, 2, 1, 3, 3, 4]);

    const merged = selectForNetworkMerge(first, second);

    expect(merged.cell_states).toEqual(new Uint8Array([0, 2, 2, 3, 5, 4]));
    expect(merged.shadow_grid).toEqual([[false, false, false, false, false, true]]);
    expect(merged.coverage_pct).toBe(33.33);
    expect(merged.completeness_pct).toBe(66.67);
    expect(merged.visible_area_m2).toBe(4);
    expect(merged.grid_rows).toBe(1);
    expect(merged.grid_cols).toBe(6);
    expect(merged.resolution).toBe(2);
    expect(merged.shadow_zones).toEqual([{ zone_id: 1, cell_count: 1 }]);
  });

  it("reports null coverage and completeness when the network has no candidates", () => {
    const merged = selectForNetworkMerge(networkResult([0, 1]), networkResult([0, 2]));

    expect(merged.coverage_pct).toBeNull();
    expect(merged.completeness_pct).toBeNull();
    expect(merged.visible_area_m2).toBe(0);
  });

  it("rejects network results with different grid dimensions or resolution", () => {
    const first = networkResult([5, 4]);
    const second = { ...networkResult([5, 4]), resolution: 3 } as LOSResponse;

    expect(() => selectForNetworkMerge(first, second)).toThrow(/resolution|grid/i);
  });
});

describe("useAnalysisStore — stale request protection", () => {
  const position = { x: 10, y: 20, z: 3 };

  const activate = (epoch: number) => {
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-same-id", epoch });
    useAnalysisStore.setState({ selectedRadarId: "radar-A", radarPosition: position });
  };

  it("does not publish a completed job from an earlier terrain epoch over the current result", async () => {
    const stalePoll = deferred<any>();
    const currentResult = { ...sampleLOS, coverage_pct: 22 };
    vi.useFakeTimers();
    vi.mocked(runLOSAnalysis)
      .mockResolvedValueOnce({ job_id: "job-old", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-current", status: "PENDING" });
    vi.mocked(getLOSJob)
      .mockReturnValueOnce(stalePoll.promise)
      .mockResolvedValueOnce({ job_id: "job-current", status: "COMPLETED", created_at: "now", result: currentResult });

    activate(1);
    await useAnalysisStore.getState().runAnalysis("terrain-same-id");
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLOSJob).toHaveBeenCalledWith("job-old");

    useAnalysisStore.getState().beginTerrainTransition();
    expect(cancelLOSAnalysis).toHaveBeenCalledWith("job-old");
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-same-id", epoch: 2 });
    useAnalysisStore.setState({ selectedRadarId: "radar-A", radarPosition: position });
    await useAnalysisStore.getState().runAnalysis("terrain-same-id");
    await vi.advanceTimersByTimeAsync(1000);

    expect(useAnalysisStore.getState().losResult).toEqual(currentResult);
    expect(useAnalysisStore.getState().history).toHaveLength(1);
    expect(useAnalysisStore.getState().history[0]).toMatchObject({ terrain_id: "terrain-same-id", terrain_epoch: 2 });

    stalePoll.resolve({ job_id: "job-old", status: "COMPLETED", created_at: "now", result: sampleLOS });
    await Promise.resolve();
    await Promise.resolve();

    expect(useAnalysisStore.getState().losResult).toEqual(currentResult);
    expect(useAnalysisStore.getState().history).toHaveLength(1);
    expect(useAnalysisStore.getState().history[0]?.terrain_epoch).toBe(2);
    expect(useAnalysisStore.getState().loading).toBe(false);
  });

  it("does not let an obsolete FAILED poll clear the newer result or error state", async () => {
    const stalePoll = deferred<any>();
    const currentResult = { ...sampleLOS, coverage_pct: 33 };
    vi.useFakeTimers();
    vi.mocked(runLOSAnalysis)
      .mockResolvedValueOnce({ job_id: "job-old-failed", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-current", status: "PENDING" });
    vi.mocked(getLOSJob)
      .mockReturnValueOnce(stalePoll.promise)
      .mockResolvedValueOnce({ job_id: "job-current", status: "COMPLETED", created_at: "now", result: currentResult });

    activate(4);
    await useAnalysisStore.getState().runAnalysis("terrain-same-id");
    await vi.advanceTimersByTimeAsync(1000);
    useAnalysisStore.getState().setRadarPosition({ x: 99, y: 20, z: 3 });
    expect(cancelLOSAnalysis).toHaveBeenCalledWith("job-old-failed");
    useAnalysisStore.getState().setRadarPosition(position);
    await useAnalysisStore.getState().runAnalysis("terrain-same-id");
    await vi.advanceTimersByTimeAsync(1000);

    stalePoll.resolve({ job_id: "job-old-failed", status: "FAILED", error: "obsolete failure", created_at: "now" });
    await Promise.resolve();
    await Promise.resolve();

    expect(useAnalysisStore.getState()).toMatchObject({ losResult: currentResult, error: null, loading: false });
  });

  it("clears the active result and history selection when the selected radar changes", () => {
    useAnalysisStore.setState({
      selectedRadarId: "radar-A",
      radarPosition: position,
      losResult: sampleLOS,
      history: [{
        position, coveragePct: sampleLOS.coverage_pct, timestamp: "old", result: sampleLOS,
        radarId: "radar-A", selected: true, terrain_id: "terrain-same-id", terrain_epoch: 2,
      }],
    });

    useAnalysisStore.getState().selectRadar("radar-B");

    expect(useAnalysisStore.getState()).toMatchObject({ losResult: null, loading: false, selectedRadarId: "radar-B" });
    expect(useAnalysisStore.getState().history.every((entry) => !entry.selected)).toBe(true);
  });

  it("does not merge selectable history entries from different epochs of the same terrain id", () => {
    const oldResult = { ...sampleLOS, coverage_pct: 10 };
    const currentResult = { ...sampleLOS, coverage_pct: 90 };
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-same-id", epoch: 2 });
    useAnalysisStore.setState({
      history: [
        { position, coveragePct: 10, timestamp: "old", result: oldResult, radarId: "radar-A", selected: true, terrain_id: "terrain-same-id", terrain_epoch: 1 },
        { position, coveragePct: 90, timestamp: "current", result: currentResult, radarId: "radar-B", selected: false, terrain_id: "terrain-same-id", terrain_epoch: 2 },
      ],
      losResult: oldResult,
    });

    useAnalysisStore.getState().toggleHistoryEntrySelection(1);

    expect(useAnalysisStore.getState().history.map((entry) => entry.selected)).toEqual([false, true]);
    expect(useAnalysisStore.getState().losResult).toEqual(currentResult);
  });

  it("does not publish network results after a deployed radar is removed", async () => {
    const firstPoll = deferred<any>();
    const secondPoll = deferred<any>();
    const radar1 = { id: "radar-1", modelId: "model-1", position, color: "#f00" };
    const radar2 = { id: "radar-2", modelId: "model-2", position: { x: 30, y: 40, z: 5 }, color: "#0f0" };
    vi.useFakeTimers();
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-network", epoch: 1 });
    useAnalysisStore.setState({ deployedRadars: [radar1, radar2] });
    vi.mocked(runLOSAnalysis)
      .mockResolvedValueOnce({ job_id: "job-radar-1", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-radar-2", status: "PENDING" });
    vi.mocked(getLOSJob)
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(secondPoll.promise);

    const run = useAnalysisStore.getState().runMultiAnalysis("terrain-network");
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLOSJob).toHaveBeenCalledTimes(2);

    useAnalysisStore.getState().removeDeployedRadar("radar-2");
    expect(cancelLOSAnalysis).toHaveBeenCalledWith("job-radar-1");
    expect(cancelLOSAnalysis).toHaveBeenCalledWith("job-radar-2");
    firstPoll.resolve({ job_id: "job-radar-1", status: "COMPLETED", created_at: "now", result: sampleLOS });
    secondPoll.resolve({ job_id: "job-radar-2", status: "COMPLETED", created_at: "now", result: sampleLOS });
    await run;

    const state = useAnalysisStore.getState();
    expect(state.deployedRadars.map((radar) => radar.id)).toEqual(["radar-1"]);
    expect(state.deployedRadars[0]).not.toHaveProperty("result");
    expect(state).toMatchObject({ unifiedLos: null, losResult: null, multiLoading: false });
  });
});

