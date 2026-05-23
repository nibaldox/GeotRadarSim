/**
 * Tests for the vector synthesis Zustand store and its interactions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useVectorStore } from "./vectorStore";

// Mock the API client module
vi.mock("../services/api", () => ({
  runVectorAnalysis: vi.fn(),
  runSensitivityAnalysis: vi.fn(),
  getLOSJob: vi.fn(),
}));

import { runVectorAnalysis, runSensitivityAnalysis, getLOSJob } from "../services/api";
import type { Point3D } from "../types/api";

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
    selectedCell: null,
    selectedCellLocal: null,
    trueSlideMagnitude: 50.0,
    noiseLevel: 1.0,
    reconstructionResult: null,
    sensitivityGrid: null,
    visualizationMode: "QUALITY",
    loading: false,
    error: null,
  });
});

const mockGrid = [
  [10, 10, 10],
  [10, 15, 10],
  [10, 10, 10],
];

const mockBounds = {
  min_x: 0,
  min_y: 0,
  min_z: 0,
  max_x: 300,
  max_y: 300,
  max_z: 50,
};

describe("useVectorStore — Default State & Setters", () => {
  it("initializes with default values", () => {
    const state = useVectorStore.getState();
    expect(state.trueSlideMagnitude).toBe(50.0);
    expect(state.noiseLevel).toBe(1.0);
    expect(state.reconstructionResult).toBeNull();
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
      selectedCell: { x: 100, y: 100, z: 10 },
      selectedCellLocal: { x: 10, y: 10, z: 5 },
      reconstructionResult: {
        trueVector: [1, 2, 3],
        reconstructedVector: [1.1, 1.9, 3.2],
        apparentSingleVector: [0.5, 0.5, 0.5],
        determinant: 1.0,
        sensitivity: 0.8
      } as any,
      error: "some-error"
    });

    const store = useVectorStore.getState();
    store.reset();

    const state = useVectorStore.getState();
    expect(state.selectedCell).toBeNull();
    expect(state.selectedCellLocal).toBeNull();
    expect(state.reconstructionResult).toBeNull();
    expect(state.error).toBeNull();
  });
});

describe("useVectorStore — Actions", () => {
  it("handles updateMagnitude without triggering analysis if no cell selected", async () => {
    const store = useVectorStore.getState();
    await store.updateMagnitude(75.0, mockGrid, mockBounds, 2.0);
    expect(useVectorStore.getState().trueSlideMagnitude).toBe(75.0);
    expect(runVectorAnalysis).not.toHaveBeenCalled();
  });

  it("handles updateNoise without triggering analysis if no cell selected", async () => {
    const store = useVectorStore.getState();
    await store.updateNoise(3.5, mockGrid, mockBounds, 2.0);
    expect(useVectorStore.getState().noiseLevel).toBe(3.5);
    expect(runVectorAnalysis).not.toHaveBeenCalled();
  });

  it("triggers vector analysis on cell selection", async () => {
    vi.mocked(runVectorAnalysis).mockResolvedValueOnce({ job_id: "job-v123", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValueOnce({
      job_id: "job-v123",
      status: "COMPLETED",
      result: {
        trueVector: [50, 0, 0],
        reconstructedVector: [49.5, 0.2, -0.1],
        apparentSingleVector: [25, 0, 0],
        determinant: 0.85,
        sensitivity: 0.92
      } as any
    });

    const store = useVectorStore.getState();
    const cellLocal: Point3D = { x: 2, y: 15, z: -2 }; // r=1, c=1 (resolution 2.0)
    
    // Select cell
    await store.selectCell(cellLocal, mockGrid, mockBounds, 2.0);

    // Assert cell selected state is georeferenced
    const state = useVectorStore.getState();
    expect(state.selectedCellLocal).toEqual(cellLocal);
    expect(state.selectedCell).toEqual({
      x: 2 + mockBounds.min_x,
      y: mockBounds.min_y - (-2),
      z: 15 + mockBounds.min_z,
    });

    // Check API was called
    expect(runVectorAnalysis).toHaveBeenCalled();
    
    // Wait for the polling macro-task
    await new Promise((resolve) => setTimeout(resolve, 300));
    
    expect(useVectorStore.getState().reconstructionResult).not.toBeNull();
    expect(useVectorStore.getState().reconstructionResult?.sensitivity).toBe(0.92);
  });
});
