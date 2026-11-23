/**
 * terrainStore.loadSamplePit: the «Terreno sintético» action. It goes through the same activation
 * path as the other terrain loads (fence, release, restore on failure).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerrainStore } from "./terrainStore";
import { useAnalysisStore } from "./analysisStore";

vi.mock("../services/api", () => ({
  generateSynthetic: vi.fn(),
  loadSampleTerrain: vi.fn(),
  getTerrainGrid: vi.fn(),
  uploadDXF: vi.fn(),
  uploadSTL: vi.fn(),
  activateTerrain: vi.fn(),
  releaseTerrain: vi.fn(),
  previewTerrainBounds: vi.fn(),
}));

import { generateSynthetic, getTerrainGrid, loadSampleTerrain, releaseTerrain } from "../services/api";
import { SAMPLE_TERRAIN_LOAD_ERROR } from "../services/sampleTerrain";
import type { DTMMetadata } from "../types/api";

const meta = (id: string, res: number, rows: number, cols: number): DTMMetadata => ({
  terrain_id: id,
  bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: (cols - 1) * res, max_y: (rows - 1) * res, max_z: 1 },
  resolution: res,
  grid_rows: rows,
  grid_cols: cols,
});

const gridOf = (rows: number, cols: number) => Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

beforeEach(() => {
  vi.clearAllMocks();
  useTerrainStore.setState({
    metadata: null, grid: null, loading: false, error: null, terrainKey: null, terrainEpoch: 0,
    preferredResolution: 1.0, uploadPreview: null, uploadPreviewLoading: false, uploadPreviewError: null,
  });
  useAnalysisStore.setState({
    terrainKey: null, terrainTransitioning: false, losResult: null, history: [], deployedRadars: [],
    unifiedLos: null, loading: false, multiLoading: false, error: null,
  });
  vi.mocked(getTerrainGrid).mockImplementation(async (id: string) => {
    const m = id.startsWith("sample") ? meta(id, 2, 536, 680) : meta(id, 2, 101, 101);
    return { terrain_id: id, metadata: m, grid: gridOf(m.grid_rows, m.grid_cols) };
  });
});

describe("terrainStore.loadSamplePit", () => {
  it.each([
    [0.5, 2],
    [1, 2],
    [2, 2],
    [4, 4],
  ])("loads the sample at max(%s, 2) = %s m", async (pref, expected) => {
    useTerrainStore.getState().setPreferredResolution(pref);
    vi.mocked(loadSampleTerrain).mockResolvedValueOnce(meta("sample-pit-x", expected, 536, 680));
    await useTerrainStore.getState().loadSamplePit();
    expect(loadSampleTerrain).toHaveBeenCalledWith(expected);
    expect(generateSynthetic).not.toHaveBeenCalled();
  });

  it("activates the sample grid and metadata together", async () => {
    vi.mocked(loadSampleTerrain).mockResolvedValueOnce(meta("sample-pit-2-import-1", 2, 536, 680));
    await useTerrainStore.getState().loadSamplePit();
    const state = useTerrainStore.getState();
    expect(state.metadata?.terrain_id).toBe("sample-pit-2-import-1");
    expect(state.grid?.length).toBe(536);
    expect(state.grid?.[0]?.length).toBe(680);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.terrainKey).toEqual({ terrain_id: "sample-pit-2-import-1", epoch: 1 });
  });

  it("shows the Spanish error and restores the previous terrain when loading fails", async () => {
    vi.mocked(generateSynthetic).mockResolvedValueOnce(meta("synthetic-prev", 2, 101, 101));
    await useTerrainStore.getState().generateSynthetic({ size_x: 200, size_y: 200, depth: 30 });
    const before = useTerrainStore.getState();
    expect(before.terrainKey?.terrain_id).toBe("synthetic-prev");

    vi.mocked(loadSampleTerrain).mockRejectedValueOnce(new Error(SAMPLE_TERRAIN_LOAD_ERROR));
    await useTerrainStore.getState().loadSamplePit();

    const after = useTerrainStore.getState();
    expect(after.error).toBe(SAMPLE_TERRAIN_LOAD_ERROR);
    expect(after.loading).toBe(false);
    expect(after.metadata?.terrain_id).toBe("synthetic-prev");
    expect(after.terrainKey).toEqual(before.terrainKey);
    expect(useAnalysisStore.getState().terrainKey).toEqual(before.terrainKey);
    expect(useAnalysisStore.getState().terrainTransitioning).toBe(false);
  });

  it("releases a sample that a newer terrain request superseded", async () => {
    let resolveSample!: (m: DTMMetadata) => void;
    vi.mocked(loadSampleTerrain).mockImplementationOnce(() => new Promise((r) => { resolveSample = r; }));
    const pending = useTerrainStore.getState().loadSamplePit();
    vi.mocked(generateSynthetic).mockResolvedValueOnce(meta("synthetic-newer", 2, 101, 101));
    await useTerrainStore.getState().generateSynthetic({ size_x: 200, size_y: 200, depth: 30 });
    resolveSample(meta("sample-pit-late", 2, 536, 680));
    await pending;
    expect(releaseTerrain).toHaveBeenCalledWith("sample-pit-late");
    expect(useTerrainStore.getState().metadata?.terrain_id).toBe("synthetic-newer");
  });
});
