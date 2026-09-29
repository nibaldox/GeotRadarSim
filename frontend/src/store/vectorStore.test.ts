import { describe, it, expect, vi, beforeEach } from "vitest";
import { useVectorStore } from "./vectorStore";
import type { HistoryEntry } from "./analysisStore";
import type { AnalysisSnapshot, LOSResponse, SensitivityMapResponse } from "../types/api";

const { analysisState, analysisSubscribers } = vi.hoisted(() => ({
  analysisState: { history: [] as any[], terrainKey: null as any, terrainTransitioning: false },
  analysisSubscribers: [] as Array<(state: any, previous: any) => void>,
}));

vi.mock("../services/api", () => ({
  runSensitivityAnalysis: vi.fn(),
  getLOSJob: vi.fn(),
  cancelSensitivityAnalysis: vi.fn(),
  releaseSensitivityJob: vi.fn(),
}));

vi.mock("./analysisStore", () => ({
  useAnalysisStore: {
    getState: () => analysisState,
    subscribe: (listener: (state: any, previous: any) => void) => {
      analysisSubscribers.push(listener);
      return () => {
        const index = analysisSubscribers.indexOf(listener);
        if (index >= 0) analysisSubscribers.splice(index, 1);
      };
    },
  },
}));

import { cancelSensitivityAnalysis, getLOSJob, releaseSensitivityJob, runSensitivityAnalysis } from "../services/api";

const terrainKey = { terrain_id: "terrain-store", epoch: 4 } as const;
const emptyOverrides = { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } as const;

function makeLOSResult(cellStates: number[]): LOSResponse {
  return {
    shadow_grid: [[false, false], [false, false]],
    cell_states: new Uint8Array(cellStates),
    grid_rows: 2,
    grid_cols: 2,
    resolution: 1,
    coverage_polygon: [],
    coverage_pct: 50,
    completeness_pct: 70,
    visible_area_m2: 2,
    shadow_zones: [],
  };
}

function makeEntry(
  analysisId: string,
  selected: boolean,
  states: number[],
  overrides: { terrainKey?: { terrain_id: string; epoch: number }; radarId?: string; position?: { x: number; y: number; z: number } } = {},
): HistoryEntry {
  const position = overrides.position ?? { x: analysisId.length * 10, y: 25, z: 15 };
  const radarModelId = overrides.radarId ?? "groundprobe-ssr-fx";
  const key = overrides.terrainKey ?? terrainKey;
  const snapshot: AnalysisSnapshot = {
    terrainKey: key,
    analysisId,
    sourceAnalysisIds: [analysisId],
    generation: analysisId.length,
    radars: [{ radarId: `stable-${analysisId}`, radarModelId, position, overrides: emptyOverrides }],
  };
  return {
    position,
    coveragePct: 50,
    timestamp: `time-${analysisId}`,
    result: makeLOSResult(states),
    radarId: radarModelId,
    selected,
    terrain_id: key.terrain_id,
    terrain_epoch: key.epoch,
    snapshot,
  };
}

function publishAnalysisState(next: Partial<typeof analysisState>) {
  const previous = { ...analysisState };
  Object.assign(analysisState, next);
  for (const subscriber of analysisSubscribers) subscriber(analysisState, previous);
}

const responseFor = (ids: string[], counts = [1, 1, 0, 1]): SensitivityMapResponse => ({
  terrainKey,
  sourceAnalysisIds: ids,
  grid_rows: 2,
  grid_cols: 2,
  resolution: 1,
  flat_sensitivity_grid: new Float32Array([0.5, 0.25, Number.NaN, 0].map((value, index) => counts[index] === 0 ? Number.NaN : value)),
  observer_count: new Uint16Array(counts),
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  const previous = { ...analysisState };
  Object.assign(analysisState, { history: [], terrainKey, terrainTransitioning: false });
  for (const subscriber of analysisSubscribers) subscriber(analysisState, previous);
  useVectorStore.getState().reset();
  vi.clearAllMocks();
});

describe("useVectorStore — geometric sensitivity", () => {
  it("initializes with no stale map and preserves explicit visualization mode", () => {
    const state = useVectorStore.getState();
    expect(state.sensitivityMap).toBeNull();
    expect(state.visualizationMode).toBe("QUALITY");
    expect(state.loading).toBe(false);
  });

  it("does not schedule work when there are no selected individual analyses", async () => {
    useVectorStore.setState({ sensitivityMap: responseFor(["old"]), loading: true });

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);

    expect(runSensitivityAnalysis).not.toHaveBeenCalled();
    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(useVectorStore.getState().loading).toBe(false);
  });

  it("passes each selected HistoryEntry's own provenance and cell mask", async () => {
    const first = makeEntry("analysis-first", true, [5, 4, 3, 0]);
    const second = makeEntry("analysis-second", true, [1, 5, 2, 5], { radarId: "reutech-msr" });
    publishAnalysisState({ history: [first, second] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-vector", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-vector",
      status: "COMPLETED",
      created_at: "now",
      result: responseFor(["analysis-first", "analysis-second"]),
    });
    let mapPublishedBeforeRelease = false;
    vi.mocked(releaseSensitivityJob).mockImplementationOnce(() => {
      mapPublishedBeforeRelease = useVectorStore.getState().sensitivityMap !== null && !useVectorStore.getState().loading;
    });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);

    const request = vi.mocked(runSensitivityAnalysis).mock.calls[0]![0];
    expect(request.terrainKey).toEqual(terrainKey);
    expect(request.observations.map((observation) => observation.analysisId)).toEqual(["analysis-first", "analysis-second"]);
    expect(request.observations.map((observation) => Array.from(observation.cell_states))).toEqual([
      [5, 4, 3, 0],
      [1, 5, 2, 5],
    ]);
    expect(request.observations[0]!.snapshot.radars[0]!.position).toEqual(first.position);
    expect(request.observations[1]!.snapshot.radars[0]!.radarId).toBe("stable-analysis-second");
    expect(useVectorStore.getState().sensitivityMap?.observer_count).toEqual(new Uint16Array([1, 1, 0, 1]));
    expect(useVectorStore.getState().sensitivityMap?.flat_sensitivity_grid[3]).toBe(0);
    expect(Number.isNaN(useVectorStore.getState().sensitivityMap?.flat_sensitivity_grid[2])).toBe(true);
    expect(useVectorStore.getState().loading).toBe(false);
    expect(releaseSensitivityJob).toHaveBeenCalledWith("job-vector");
    expect(mapPublishedBeforeRelease).toBe(true);
  });

  it("releases each terminal job after successive successful computations", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-repeat", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis)
      .mockResolvedValueOnce({ job_id: "job-repeat-A", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-repeat-B", status: "PENDING" });
    vi.mocked(getLOSJob)
      .mockResolvedValueOnce({
        job_id: "job-repeat-A",
        status: "COMPLETED",
        created_at: "now",
        result: responseFor(["analysis-repeat"], [1, 0, 0, 0]),
      })
      .mockResolvedValueOnce({
        job_id: "job-repeat-B",
        status: "COMPLETED",
        created_at: "now",
        result: responseFor(["analysis-repeat"], [1, 0, 0, 0]),
      });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);
    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);

    expect(vi.mocked(releaseSensitivityJob).mock.calls).toEqual([["job-repeat-A"], ["job-repeat-B"]]);
    expect(useVectorStore.getState().sensitivityMap?.sourceAnalysisIds).toEqual(["analysis-repeat"]);
  });

  it("publishes a worker failure before releasing its terminal job", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-failed", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-failed", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-failed",
      status: "FAILED",
      error: "worker failed",
      created_at: "now",
    });
    let errorAtRelease: string | null = null;
    vi.mocked(releaseSensitivityJob).mockImplementationOnce(() => {
      errorAtRelease = useVectorStore.getState().error;
    });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);

    expect(errorAtRelease).toBe("worker failed");
    expect(releaseSensitivityJob).toHaveBeenCalledWith("job-failed");
    expect(useVectorStore.getState().loading).toBe(false);
  });

  it("refuses selected legacy history without an immutable analysis snapshot", async () => {
    const legacy = makeEntry("legacy", true, [5, 5, 5, 5]);
    delete legacy.snapshot;
    publishAnalysisState({ history: [legacy] });

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);

    expect(runSensitivityAnalysis).not.toHaveBeenCalled();
    expect(useVectorStore.getState().error).toMatch(/snapshot|provenance|analysis/i);
  });

  it("refuses a stale epoch even when the terrain ID is unchanged", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-old-epoch", true, [5, 5, 5, 5], {
      terrainKey: { terrain_id: terrainKey.terrain_id, epoch: terrainKey.epoch - 1 },
    })] });

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);

    expect(runSensitivityAnalysis).not.toHaveBeenCalled();
    expect(useVectorStore.getState().error).toMatch(/terrain|epoch|snapshot/i);
  });

  it("rejects returned counts larger than individual VISIBLE masks", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-mask", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-mask", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-mask",
      status: "COMPLETED",
      created_at: "now",
      result: responseFor(["analysis-mask"], [0, 1, 0, 1]),
    });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);

    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(useVectorStore.getState().error).toMatch(/mask|observer|sensitivity/i);
  });

  it("accepts fewer contributing observers than visible masks when the DEM gradient is unavailable", async () => {
    const entry = makeEntry("analysis-partial-contributors", true, [5, 5, 3, 0]);
    publishAnalysisState({ history: [entry] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-partial", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-partial",
      status: "COMPLETED",
      created_at: "now",
      result: responseFor(["analysis-partial-contributors"], [0, 1, 0, 0]),
    });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);

    expect(useVectorStore.getState().error).toBeNull();
    expect(useVectorStore.getState().sensitivityMap?.observer_count).toEqual(new Uint16Array([0, 1, 0, 0]));
    expect(Number.isNaN(useVectorStore.getState().sensitivityMap?.flat_sensitivity_grid[0])).toBe(true);
  });

  it("rejects a partial contributor count when multiple visible analyses share one cell gradient", async () => {
    const first = makeEntry("analysis-partial-one", true, [5, 0, 0, 0]);
    const second = makeEntry("analysis-partial-two", true, [5, 0, 0, 0]);
    publishAnalysisState({ history: [first, second] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-partial-forged", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-partial-forged",
      status: "COMPLETED",
      created_at: "now",
      result: responseFor(["analysis-partial-one", "analysis-partial-two"], [1, 0, 0, 0]),
    });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);

    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(useVectorStore.getState().error).toMatch(/observer|sensitivity/i);
  });

  it("rejects forged sensitivity counts, values, and provenance", async () => {
    const invalidResponses: Array<{ analysisId: string; result: SensitivityMapResponse }> = [];
    const noContributorValue = responseFor(["analysis-forged-zero"], [0, 0, 0, 0]);
    noContributorValue.flat_sensitivity_grid[0] = 0;
    invalidResponses.push({ analysisId: "analysis-forged-zero", result: noContributorValue });
    const contributorWithoutValue = responseFor(["analysis-forged-nan"], [1, 0, 0, 0]);
    contributorWithoutValue.flat_sensitivity_grid[0] = Number.NaN;
    invalidResponses.push({ analysisId: "analysis-forged-nan", result: contributorWithoutValue });
    const outOfRange = responseFor(["analysis-forged-range"], [1, 0, 0, 0]);
    outOfRange.flat_sensitivity_grid[0] = 1.1;
    invalidResponses.push({ analysisId: "analysis-forged-range", result: outOfRange });
    const spoofedProvenance = responseFor(["analysis-forged-provenance"]);
    spoofedProvenance.sourceAnalysisIds = ["different-analysis"];
    invalidResponses.push({ analysisId: "analysis-forged-provenance", result: spoofedProvenance });
    vi.useFakeTimers();

    for (const [index, invalid] of invalidResponses.entries()) {
      publishAnalysisState({ history: [makeEntry(invalid.analysisId, true, [5, 4, 3, 0])] });
      const jobId = `job-forged-${index}`;
      vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: jobId, status: "PENDING" });
      vi.mocked(getLOSJob).mockResolvedValueOnce({
        job_id: jobId,
        status: "COMPLETED",
        created_at: "now",
        result: invalid.result,
      });

      await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
      await vi.advanceTimersByTimeAsync(250);

      expect(useVectorStore.getState().sensitivityMap).toBeNull();
      expect(useVectorStore.getState().error).toMatch(/mask|observer|sensitivity|provenance/i);
    }
  });

  it("cancels worker and polling when selected history changes", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-cancel", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-cancel", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValue({
      job_id: "job-cancel",
      status: "PENDING",
      created_at: "now",
    });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    expect(useVectorStore.getState().loading).toBe(true);
    publishAnalysisState({ history: [] });
    await vi.advanceTimersByTimeAsync(1000);

    expect(cancelSensitivityAnalysis).toHaveBeenCalledWith("job-cancel");
    expect(getLOSJob).not.toHaveBeenCalled();
    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(useVectorStore.getState().loading).toBe(false);
  });

  it("discards a completed response that resolves after a terrain epoch transition", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-late", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-late", status: "PENDING" });
    let resolveStatus!: (status: any) => void;
    vi.mocked(getLOSJob).mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    const polling = vi.advanceTimersByTimeAsync(250);
    publishAnalysisState({ terrainKey: { terrain_id: terrainKey.terrain_id, epoch: terrainKey.epoch + 1 } });
    resolveStatus({
      job_id: "job-late",
      status: "COMPLETED",
      created_at: "now",
      result: responseFor(["analysis-late"]),
    });
    await polling;

    expect(cancelSensitivityAnalysis).toHaveBeenCalledWith("job-late");
    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(useVectorStore.getState().loading).toBe(false);
  });

  it("keeps job B active when an older job A poll resolves late", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-race", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis)
      .mockResolvedValueOnce({ job_id: "job-A", status: "PENDING" })
      .mockResolvedValueOnce({ job_id: "job-B", status: "PENDING" });
    let resolveStatusA!: (status: Awaited<ReturnType<typeof getLOSJob>>) => void;
    const statusA = new Promise<Awaited<ReturnType<typeof getLOSJob>>>((resolve) => {
      resolveStatusA = resolve;
    });
    vi.mocked(getLOSJob).mockReturnValueOnce(statusA);
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    await vi.advanceTimersByTimeAsync(250);
    expect(getLOSJob).toHaveBeenCalledWith("job-A");

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);

    expect(useVectorStore.getState().loading).toBe(true);
    expect(useVectorStore.getState().sensitivityMap).toBeNull();

    resolveStatusA({
      job_id: "job-A",
      status: "COMPLETED",
      created_at: "now",
      result: responseFor(["analysis-race"]),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useVectorStore.getState().loading).toBe(true);
    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(releaseSensitivityJob).toHaveBeenCalledWith("job-A");

    useVectorStore.getState().reset();

    expect(cancelSensitivityAnalysis).toHaveBeenCalledWith("job-B");
    expect(useVectorStore.getState().loading).toBe(false);
    expect(useVectorStore.getState().sensitivityMap).toBeNull();
  });

  it("cancels an active job when the store resets", async () => {
    publishAnalysisState({ history: [makeEntry("analysis-reset", true, [5, 4, 3, 0])] });
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-reset", status: "PENDING" });
    vi.useFakeTimers();

    await useVectorStore.getState().computeSensitivityMap(terrainKey.terrain_id);
    useVectorStore.getState().reset();

    expect(cancelSensitivityAnalysis).toHaveBeenCalledWith("job-reset");
    expect(useVectorStore.getState().sensitivityMap).toBeNull();
    expect(useVectorStore.getState().loading).toBe(false);
  });
});
