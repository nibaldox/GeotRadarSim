import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnalysisStore } from "./analysisStore";
import { useVectorStore } from "./vectorStore";
import { runLOSAnalysis, getLOSJob } from "../services/api";

vi.mock("../services/api", () => ({
  runLOSAnalysis: vi.fn(), getLOSJob: vi.fn(), listRadars: vi.fn(),
  cancelLOSAnalysis: vi.fn(), releaseLOSJob: vi.fn(),
  runSensitivityAnalysis: vi.fn(), cancelSensitivityAnalysis: vi.fn(), releaseSensitivityJob: vi.fn(),
}));

const los = { shadow_grid: [[false]], cell_states: new Uint8Array([5]), grid_rows: 1, grid_cols: 1,
  resolution: 1, coverage_polygon: [], coverage_pct: 100, completeness_pct: 100,
  visible_area_m2: 1, shadow_zones: [] };

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  useAnalysisStore.getState().beginTerrainTransition();
  useAnalysisStore.getState().activateTerrain({ terrain_id: "t", epoch: 1 });
  useAnalysisStore.getState().selectRadar("r");
  useAnalysisStore.getState().setRadarPosition({ x: 1, y: 2, z: 3 });
});
afterEach(() => { useVectorStore.getState().reset(); vi.useRealTimers(); });

describe("agent store hooks", () => {
  it("waits for publication and records agent origin", async () => {
    vi.mocked(runLOSAnalysis).mockResolvedValue({ job_id: "a", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValue({ job_id: "a", status: "COMPLETED", result: los, created_at: "now" });
    const promise = useAnalysisStore.getState().runAnalysisAndWait("t");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toEqual({ status: "published", analysisId: "a", error: null, terrainId: "t", epoch: 1 });
    expect(useAnalysisStore.getState().history[0]?.origin).toBe("agent");
  });
  it.each(["override", "model", "terrain"])("supersedes in-flight LOS on %s", async (change) => {
    vi.mocked(runLOSAnalysis).mockResolvedValue({ job_id: "a", status: "PENDING" });
    const promise = useAnalysisStore.getState().runAnalysisAndWait("t");
    await Promise.resolve();
    const state = useAnalysisStore.getState();
    if (change === "override") state.setRangeOverrides(1, 2);
    if (change === "model") state.selectRadar("other");
    if (change === "selection") state.setHistorySelection([]);
    if (change === "terrain") { state.beginTerrainTransition(); state.activateTerrain({ terrain_id: "t", epoch: 2 }); }
    expect(await promise).toEqual({ status: "superseded", analysisId: null, error: null, terrainId: "t", epoch: 1 });
    expect(useAnalysisStore.getState().losResult).toBeNull();
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });
  it("updates overrides in one notification", () => {
    const listener = vi.fn(); const unsubscribe = useAnalysisStore.subscribe(listener);
    useAnalysisStore.getState().setOverrides({ rangeMin: 1, rangeMax: 2, elMin: -5 });
    unsubscribe(); expect(listener).toHaveBeenCalledTimes(1);
    expect(useAnalysisStore.getState()).toMatchObject({ rangeMinOverride: 1, rangeMaxOverride: 2, elMinOverride: -5 });
  });
  it("selects multiple history IDs in one notification", async () => {
    vi.mocked(runLOSAnalysis).mockResolvedValueOnce({ job_id: "a", status: "PENDING" }).mockResolvedValueOnce({ job_id: "b", status: "PENDING" });
    vi.mocked(getLOSJob).mockImplementation(async (id) => ({ job_id: id, status: "COMPLETED", result: los, created_at: "now" }));
    const a = useAnalysisStore.getState().runAnalysisAndWait("t"); await vi.advanceTimersByTimeAsync(1000); await a;
    const b = useAnalysisStore.getState().runAnalysisAndWait("t"); await vi.advanceTimersByTimeAsync(1000); await b;
    const listener = vi.fn(); const unsubscribe = useAnalysisStore.subscribe(listener);
    expect(useAnalysisStore.getState().setHistorySelection(["a", "b"])).toBe(true);
    unsubscribe(); expect(listener).toHaveBeenCalledTimes(1);
    expect(useAnalysisStore.getState().history.filter((entry) => entry.selected)).toHaveLength(2);
    expect(useAnalysisStore.getState().activeSnapshot?.sourceAnalysisIds).toEqual(["b", "a"]);
  });
  it("rejects nonexistent selection without changing state", () => {
    const state = useAnalysisStore.getState();
    expect(state.setHistorySelection(["missing"])).toBe(false);
    expect(useAnalysisStore.getState()).toBe(state);
  });
  it("fences inverse LOS completion order", async () => {
    let releaseOld!: (value: Awaited<ReturnType<typeof getLOSJob>>) => void;
    vi.mocked(runLOSAnalysis).mockResolvedValueOnce({ job_id: "old", status: "PENDING" }).mockResolvedValueOnce({ job_id: "new", status: "PENDING" });
    vi.mocked(getLOSJob).mockImplementation((id) => id === "old" ? new Promise((resolve) => { releaseOld = resolve; }) : Promise.resolve({ job_id: id, status: "COMPLETED", result: los, created_at: "now" }));
    const old = useAnalysisStore.getState().runAnalysisAndWait("t");
    await vi.advanceTimersByTimeAsync(1000);
    const newer = useAnalysisStore.getState().runAnalysisAndWait("t");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await newer).analysisId).toBe("new");
    releaseOld({ job_id: "old", status: "COMPLETED", result: los, created_at: "now" });
    await Promise.resolve();
    expect((await old).status).toBe("superseded");
    expect(useAnalysisStore.getState().history.map((entry) => entry.snapshot?.analysisId)).toEqual(["new"]);
  });
});
