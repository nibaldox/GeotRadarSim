/**
 * Tests for the terrain Zustand store and its interactions.
 *
 * The store manages: terrain metadata, grid data, loading state, and errors.
 * It calls the API client functions and updates state accordingly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

// Mock the API client module
vi.mock("../services/api", () => ({
  generateSynthetic: vi.fn(),
  getTerrainGrid: vi.fn(),
  uploadDXF: vi.fn(),
  uploadSTL: vi.fn(),
  activateTerrain: vi.fn(),
  releaseTerrain: vi.fn(),
}));

import {
  generateSynthetic,
  getTerrainGrid,
  uploadDXF,
  uploadSTL,
  activateTerrain,
  releaseTerrain,
} from "../services/api";
import type { DTMMetadata, TerrainGridResponse } from "../types/api";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset Zustand store between tests
  useTerrainStore.setState({
    metadata: null,
    grid: null,
    loading: false,
    error: null,
    terrainKey: null,
    terrainEpoch: 0,
  });
  useAnalysisStore.setState({
    terrainKey: null,
    terrainTransitioning: false,
    losResult: null,
    history: [],
    deployedRadars: [],
    unifiedLos: null,
    loading: false,
    multiLoading: false,
    error: null,
  });
});

const sampleMetadata: DTMMetadata = {
  terrain_id: "terrain-test-1",
  bounds: {
    min_x: 0, min_y: 0, min_z: -30,
    max_x: 200, max_y: 200, max_z: 0,
  },
  resolution: 2.0,
  grid_rows: 101,
  grid_cols: 101,
};

const sampleGrid: TerrainGridResponse = {
  terrain_id: "terrain-test-1",
  grid: [[10, 20], [30, 40]],
  metadata: sampleMetadata,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ────────────────────────────────────────────
// generateSynthetic action
// ────────────────────────────────────────────
describe("useTerrainStore — generateSynthetic", () => {
  it("sets loading, calls API, stores metadata on success", async () => {
    vi.mocked(generateSynthetic).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    const store = useTerrainStore.getState();
    await store.generateSynthetic({ size_x: 200, size_y: 200, depth: 30 });

    // API was called with correct params
    expect(generateSynthetic).toHaveBeenCalledWith({
      size_x: 200,
      size_y: 200,
      depth: 30,
      resolution: 1.0,
    });
    expect(activateTerrain).toHaveBeenCalledWith(sampleMetadata.terrain_id);

    // State should have metadata and no error
    const state = useTerrainStore.getState();
    expect(state.metadata).toEqual(sampleMetadata);
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("stores error message on API failure", async () => {
    vi.mocked(generateSynthetic).mockRejectedValueOnce(
      new Error("Invalid dimensions"),
    );

    await useTerrainStore.getState().generateSynthetic({
      size_x: -1,
      size_y: 200,
      depth: 30,
    });

    const state = useTerrainStore.getState();
    expect(state.metadata).toBeNull();
    expect(state.error).toBe("Invalid dimensions");
    expect(state.loading).toBe(false);
  });
});

// ────────────────────────────────────────────
// loadGrid action
// ────────────────────────────────────────────
describe("useTerrainStore — loadGrid", () => {
  it("fetches and stores grid data on success", async () => {
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    await useTerrainStore.getState().loadGrid("terrain-test-1");

    expect(getTerrainGrid).toHaveBeenCalledWith("terrain-test-1");
    expect(activateTerrain).toHaveBeenCalledWith("terrain-test-1");

    const state = useTerrainStore.getState();
    expect(state.grid).toEqual(sampleGrid.grid);
    expect(state.error).toBeNull();
  });

  it("stores error on grid fetch failure", async () => {
    vi.mocked(getTerrainGrid).mockRejectedValueOnce(
      new Error("Terrain 'bad-id' not found"),
    );

    await useTerrainStore.getState().loadGrid("bad-id");

    const state = useTerrainStore.getState();
    expect(state.grid).toBeNull();
    expect(state.error).toBe("Terrain 'bad-id' not found");
  });
});

// ────────────────────────────────────────────
// uploadDXF action
// ────────────────────────────────────────────
describe("useTerrainStore — uploadDXF", () => {
  it("uploads file and stores metadata", async () => {
    vi.mocked(uploadDXF).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);
    const file = new File(["dxf-content"], "test.dxf", {
      type: "application/dxf",
    });

    await useTerrainStore.getState().uploadDXF(file);

    expect(uploadDXF).toHaveBeenCalledWith(file, 1.0);
    const state = useTerrainStore.getState();
    expect(state.metadata).toEqual(sampleMetadata);
    expect(state.error).toBeNull();
  });

  it("stores error on upload failure", async () => {
    vi.mocked(uploadDXF).mockRejectedValueOnce(new Error("No elevation data in DXF"));
    const file = new File(["bad"], "bad.dxf", { type: "application/dxf" });

    await useTerrainStore.getState().uploadDXF(file);

    expect(useTerrainStore.getState()).toMatchObject({
      metadata: null,
      error: "No elevation data in DXF",
      loading: false,
    });
  });

  it("releases an imported grid when loading its grid fails and preserves the active terrain", async () => {
    const terrainA: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-A" };
    const gridA = [[11, 12]];
    const keyA = { terrain_id: "terrain-A", epoch: 3 };
    useTerrainStore.setState({ metadata: terrainA, grid: gridA, terrainKey: keyA, terrainEpoch: 3 });
    useAnalysisStore.getState().activateTerrain(keyA);
    vi.mocked(uploadDXF).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockRejectedValueOnce(new Error("grid load failed"));

    await useTerrainStore.getState().uploadDXF(new File(["bad-grid"], "terrain-B.dxf"));

    expect(releaseTerrain).toHaveBeenCalledWith(sampleMetadata.terrain_id);
    expect(activateTerrain).not.toHaveBeenCalledWith(sampleMetadata.terrain_id);
    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainA,
      grid: gridA,
      terrainKey: keyA,
      loading: false,
      error: "grid load failed",
    });
    expect(useAnalysisStore.getState()).toMatchObject({
      terrainKey: keyA,
      terrainTransitioning: false,
    });
  });
});

// ────────────────────────────────────────────
// clearError action
// ────────────────────────────────────────────
describe("useTerrainStore — clearError", () => {
  it("clears error state", () => {
    useTerrainStore.setState({ error: "some error" });

    useTerrainStore.getState().clearError();

    expect(useTerrainStore.getState().error).toBeNull();
  });
});

// ────────────────────────────────────────────
// uploadSTL action
// ────────────────────────────────────────────
describe("useTerrainStore — uploadSTL", () => {
  it("uploads file and stores metadata", async () => {
    vi.mocked(uploadSTL).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);
    const file = new File(["stl-content"], "terrain.stl", {
      type: "application/octet-stream",
    });

    await useTerrainStore.getState().uploadSTL(file);

    expect(uploadSTL).toHaveBeenCalledWith(file, 1.0);
    const state = useTerrainStore.getState();
    expect(state.metadata).toEqual(sampleMetadata);
    expect(state.error).toBeNull();
  });

  it("stores error on upload failure", async () => {
    vi.mocked(uploadSTL).mockRejectedValueOnce(
      new Error("No valid triangles found in STL file"),
    );
    const file = new File(["bad"], "bad.stl", { type: "application/octet-stream" });

    await useTerrainStore.getState().uploadSTL(file);

    const state = useTerrainStore.getState();
    expect(state.metadata).toBeNull();
    expect(state.error).toBe("No valid triangles found in STL file");
  });
});

describe("useTerrainStore — atomic terrain activation", () => {
  it("keeps terrain A active until terrain B metadata and grid are both ready", async () => {
    const terrainA: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-A" };
    const gridA: number[][] = [[11, 12]];
    const terrainB: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-B" };
    const gridB: TerrainGridResponse = { terrain_id: "terrain-B", grid: [[21, 22]], metadata: terrainB };
    const generated = deferred<DTMMetadata>();
    const loadedGrid = deferred<TerrainGridResponse>();

    useTerrainStore.setState({
      metadata: terrainA,
      grid: gridA,
      terrainEpoch: 1,
      terrainKey: { terrain_id: "terrain-A", epoch: 1 },
    });
    useAnalysisStore.setState({
      losResult: { coverage_pct: 50 } as any,
      history: [{
        position: { x: 1, y: 2, z: 3 }, coveragePct: 50, timestamp: "old",
        result: { coverage_pct: 50 } as any, radarId: "radar-old", selected: true,
        terrain_id: "terrain-A", terrain_epoch: 1,
      }],
    });
    vi.mocked(generateSynthetic).mockReturnValueOnce(generated.promise);
    vi.mocked(getTerrainGrid).mockReturnValueOnce(loadedGrid.promise);

    const transition = useTerrainStore.getState().generateSynthetic({ size_x: 200, size_y: 200, depth: 30 });

    expect(useTerrainStore.getState()).toMatchObject({ metadata: terrainA, grid: gridA, loading: true });
    expect(useAnalysisStore.getState().losResult).toBeNull();
    expect(useAnalysisStore.getState().history).toEqual([]);

    generated.resolve(terrainB);
    await Promise.resolve();
    await Promise.resolve();
    expect(getTerrainGrid).toHaveBeenCalledWith("terrain-B");
    expect(useTerrainStore.getState()).toMatchObject({ metadata: terrainA, grid: gridA, loading: true });

    loadedGrid.resolve(gridB);
    await transition;

    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainB,
      grid: gridB.grid,
      terrainEpoch: 2,
      terrainKey: { terrain_id: "terrain-B", epoch: 2 },
      loading: false,
      error: null,
    });
    expect(useAnalysisStore.getState().terrainKey).toEqual({ terrain_id: "terrain-B", epoch: 2 });
  });

  it("restores A's radar position when B fails because terrain A stays active", async () => {
    const terrainA: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-A" };
    const gridA = [[11, 12]];
    const radarPositionA = { x: 17, y: 23, z: 5 };
    useTerrainStore.setState({ metadata: terrainA, grid: gridA, terrainEpoch: 1, terrainKey: { terrain_id: "terrain-A", epoch: 1 } });
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-A", epoch: 1 });
    useAnalysisStore.getState().setRadarPosition(radarPositionA);
    vi.mocked(uploadDXF).mockRejectedValueOnce(new Error("terrain B import failed"));

    await useTerrainStore.getState().uploadDXF(new File(["bad"], "terrain-B.dxf"));

    expect(getTerrainGrid).not.toHaveBeenCalled();
    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainA,
      grid: gridA,
      terrainKey: { terrain_id: "terrain-A", epoch: 1 },
      loading: false,
      error: "terrain B import failed",
    });
    expect(useAnalysisStore.getState()).toMatchObject({
      terrainKey: { terrain_id: "terrain-A", epoch: 1 },
      terrainTransitioning: false,
      radarPosition: radarPositionA,
      history: [],
      losResult: null,
    });
  });

  it("keeps A when the latest transition C fails and obsolete B resolves afterward", async () => {
    const terrainA: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-A" };
    const terrainB: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-B" };
    const gridA = [[11, 12]];
    const uploadB = deferred<DTMMetadata>();
    const uploadC = deferred<DTMMetadata>();
    const keyA = { terrain_id: "terrain-A", epoch: 4 };
    useTerrainStore.setState({ metadata: terrainA, grid: gridA, terrainEpoch: 4, terrainKey: keyA });
    useAnalysisStore.getState().activateTerrain(keyA);
    vi.mocked(uploadDXF)
      .mockReturnValueOnce(uploadB.promise)
      .mockReturnValueOnce(uploadC.promise);

    const firstImport = useTerrainStore.getState().uploadDXF(new File(["b"], "terrain-B.dxf"));
    const latestImport = useTerrainStore.getState().uploadDXF(new File(["c"], "terrain-C.dxf"));
    uploadC.reject(new Error("terrain C failed"));
    await latestImport;

    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainA,
      grid: gridA,
      terrainKey: keyA,
      loading: false,
      error: "terrain C failed",
    });

    uploadB.resolve(terrainB);
    await firstImport;

    expect(releaseTerrain).toHaveBeenCalledWith(terrainB.terrain_id);
    expect(getTerrainGrid).not.toHaveBeenCalled();
    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainA,
      grid: gridA,
      terrainKey: keyA,
      loading: false,
      error: "terrain C failed",
    });
    expect(useAnalysisStore.getState()).toMatchObject({
      terrainKey: keyA,
      terrainTransitioning: false,
    });
  });

  it("does not leak a placement or stale response across overlapping terrain imports", async () => {
    const terrainA: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-A" };
    const terrainB: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-B" };
    const terrainC: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-C" };
    const gridC: TerrainGridResponse = { terrain_id: "terrain-C", grid: [[31, 32]], metadata: terrainC };
    const uploadB = deferred<DTMMetadata>();
    const uploadC = deferred<DTMMetadata>();
    const radarPositionA = { x: 17, y: 23, z: 5 };

    useTerrainStore.setState({
      metadata: terrainA,
      grid: [[11, 12]],
      terrainEpoch: 1,
      terrainKey: { terrain_id: "terrain-A", epoch: 1 },
    });
    useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-A", epoch: 1 });
    useAnalysisStore.getState().setRadarPosition(radarPositionA);
    vi.mocked(uploadDXF)
      .mockReturnValueOnce(uploadB.promise)
      .mockReturnValueOnce(uploadC.promise);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(gridC);

    const firstImport = useTerrainStore.getState().uploadDXF(new File(["b"], "terrain-B.dxf"));
    const secondImport = useTerrainStore.getState().uploadDXF(new File(["c"], "terrain-C.dxf"));
    useAnalysisStore.getState().setRadarPosition({ x: 90, y: 80, z: 7 });

    uploadC.resolve(terrainC);
    await secondImport;
    uploadB.resolve(terrainB);
    await firstImport;

    expect(releaseTerrain).toHaveBeenCalledWith(terrainB.terrain_id);
    expect(getTerrainGrid).toHaveBeenCalledTimes(1);
    expect(getTerrainGrid).toHaveBeenCalledWith("terrain-C");
    expect(useTerrainStore.getState()).toMatchObject({
      metadata: terrainC,
      grid: gridC.grid,
      terrainKey: { terrain_id: "terrain-C", epoch: 2 },
      loading: false,
    });
    expect(useAnalysisStore.getState()).toMatchObject({
      terrainKey: { terrain_id: "terrain-C", epoch: 2 },
      terrainTransitioning: false,
      radarPosition: null,
    });
  });
});
