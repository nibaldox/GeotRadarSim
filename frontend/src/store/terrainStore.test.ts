/**
 * Tests for the terrain Zustand store and its interactions.
 *
 * The store manages: terrain metadata, grid data, loading state, and errors.
 * It calls the API client functions and updates state accordingly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerrainStore } from "../store/terrainStore";

// Mock the API client module
vi.mock("../services/api", () => ({
  generateSynthetic: vi.fn(),
  getTerrainGrid: vi.fn(),
  uploadDXF: vi.fn(),
  uploadSTL: vi.fn(),
}));

import {
  generateSynthetic,
  getTerrainGrid,
  uploadDXF,
  uploadSTL,
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

// ────────────────────────────────────────────
// generateSynthetic action
// ────────────────────────────────────────────
describe("useTerrainStore — generateSynthetic", () => {
  it("sets loading, calls API, stores metadata on success", async () => {
    vi.mocked(generateSynthetic).mockResolvedValueOnce(sampleMetadata);

    const store = useTerrainStore.getState();
    await store.generateSynthetic({ size_x: 200, size_y: 200, depth: 30 });

    // API was called with correct params
    expect(generateSynthetic).toHaveBeenCalledWith({
      size_x: 200,
      size_y: 200,
      depth: 30,
    });

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
    const file = new File(["dxf-content"], "test.dxf", {
      type: "application/dxf",
    });

    await useTerrainStore.getState().uploadDXF(file);

    expect(uploadDXF).toHaveBeenCalledWith(file);
    const state = useTerrainStore.getState();
    expect(state.metadata).toEqual(sampleMetadata);
    expect(state.error).toBeNull();
  });

  it("stores error on upload failure", async () => {
    vi.mocked(uploadDXF).mockRejectedValueOnce(
      new Error("No elevation data in DXF"),
    );
    const file = new File(["bad"], "bad.dxf", { type: "application/dxf" });

    await useTerrainStore.getState().uploadDXF(file);

    const state = useTerrainStore.getState();
    expect(state.metadata).toBeNull();
    expect(state.error).toBe("No elevation data in DXF");
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
    const file = new File(["stl-content"], "terrain.stl", {
      type: "application/octet-stream",
    });

    await useTerrainStore.getState().uploadSTL(file);

    expect(uploadSTL).toHaveBeenCalledWith(file);
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
