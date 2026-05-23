/**
 * Tests for the vector synthesis Zustand store and its interactions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useVectorStore } from "./vectorStore";

// Mock the API client module
vi.mock("../services/api", () => ({
  runSensitivityAnalysis: vi.fn(),
  getLOSJob: vi.fn(),
}));

import { runSensitivityAnalysis, getLOSJob } from "../services/api";

vi.mock("./analysisStore", () => ({
  useAnalysisStore: {
    getState: () => ({
      history: [
        {
          timestamp: "rad-1",
          radarId: "groundprobe-ssr-fx",
          position: { x: 50, y: 30, z: 10 },
          selected: true,
          coveragePct: 80,
          result: {} as any
        },
        {
          timestamp: "rad-2",
          radarId: "reutech-msr",
          position: { x: 150, y: 30, z: 15 },
          selected: true,
          coveragePct: 75,
          result: {} as any
        }
      ],
      selectedRadarId: "groundprobe-ssr-fx",
    })
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset Zustand store between tests
  useVectorStore.setState({
    sensitivityGrid: null,
    flat_sensitivity_grid: null,
    visualizationMode: "QUALITY",
    loading: false,
    error: null,
  });
});

describe("useVectorStore — Default State & Setters", () => {
  it("initializes with default values", () => {
    const state = useVectorStore.getState();
    expect(state.sensitivityGrid).toBeNull();
    expect(state.visualizationMode).toBe("QUALITY");
    expect(state.loading).toBe(false);
  });

  it("updates visualization mode", () => {
    const store = useVectorStore.getState();
    store.setVisualizationMode("SENSITIVITY");
    expect(useVectorStore.getState().visualizationMode).toBe("SENSITIVITY");
  });

  it("resets store variables to default", () => {
    useVectorStore.setState({
      sensitivityGrid: [[1, 2], [3, 4]],
      visualizationMode: "SENSITIVITY",
      error: "some-error"
    });

    const store = useVectorStore.getState();
    store.reset();

    const state = useVectorStore.getState();
    expect(state.sensitivityGrid).toBeNull();
    expect(state.error).toBeNull();
    expect(state.visualizationMode).toBe("QUALITY");
  });
});

describe("useVectorStore — Actions", () => {
  it("triggers sensitivity analysis map computation", async () => {
    vi.mocked(runSensitivityAnalysis).mockResolvedValueOnce({ job_id: "job-s123", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-s123",
      status: "COMPLETED",
      created_at: new Date().toISOString(),
      result: {
        sensitivityGrid: [[0.5, 0.6], [0.7, 0.8]],
        flat_sensitivity_grid: new Float32Array([0.5, 0.6, 0.7, 0.8])
      } as any
    });

    const store = useVectorStore.getState();
    await store.computeSensitivityMap("terrain-1");

    expect(runSensitivityAnalysis).toHaveBeenCalledWith({
      terrainId: "terrain-1",
      radarPositions: [{ x: 50, y: 30, z: 10 }, { x: 150, y: 30, z: 15 }]
    });

    // Wait for the polling macro-task
    await new Promise((resolve) => setTimeout(resolve, 300));

    const state = useVectorStore.getState();
    expect(state.sensitivityGrid).toEqual([[0.5, 0.6], [0.7, 0.8]]);
    expect(state.flat_sensitivity_grid).toEqual(new Float32Array([0.5, 0.6, 0.7, 0.8]));
    expect(state.loading).toBe(false);
  });
});
