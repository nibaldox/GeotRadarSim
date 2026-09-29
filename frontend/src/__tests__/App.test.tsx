/**
 * Tests for App component.
 *
 * Tests:
 * 1. DXF upload UI renders (file input + upload button)
 * 2. After generateSynthetic succeeds, loadGrid is called automatically
 * 3. After DXF upload succeeds, loadGrid is called automatically
 *
 * R3F Canvas is mocked because jsdom doesn't support WebGL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import App from "../App";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

// Mock R3F — jsdom has no WebGL, so Canvas crashes
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="r3f-canvas-mock">{children}</div>
  ),
  useThree: () => ({
    camera: { position: { set: vi.fn() }, lookAt: vi.fn(), updateProjectionMatrix: vi.fn() },
  }),
}));

vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  GizmoHelper: ({ children }: any) => <div data-testid="gizmo-helper">{children}</div>,
  GizmoViewport: () => null,
}));

vi.mock("../components/TerrainViewer", () => ({
  TerrainViewer: ({ onTerrainClick }: { onTerrainClick?: (point: { x: number; y: number; z: number }) => void }) => (
    <button data-testid="terrain-placement" onClick={() => onTerrainClick?.({ x: 1, y: 2, z: 3 })}>
      Place radar
    </button>
  ),
}));

// Mock the API client
vi.mock("../services/api", () => ({
  generateSynthetic: vi.fn(),
  getTerrainGrid: vi.fn(),
  uploadDXF: vi.fn(),
  uploadSTL: vi.fn(),
  runLOSAnalysis: vi.fn(),
  getLOSJob: vi.fn(),
  listRadars: vi.fn(),
  getRadar: vi.fn(),
  exportPDF: vi.fn(),
  exportCSV: vi.fn(),
}));

import {
  generateSynthetic,
  getTerrainGrid,
  uploadDXF,
  uploadSTL,
  listRadars,
  runLOSAnalysis,
  getLOSJob,
} from "../services/api";
import type { DTMMetadata, TerrainGridResponse } from "../types/api";

const sampleMetadata: DTMMetadata = {
  terrain_id: "terrain-syn-1",
  bounds: { min_x: 0, min_y: 0, min_z: -30, max_x: 200, max_y: 200, max_z: 0 },
  resolution: 2.0,
  grid_rows: 101,
  grid_cols: 101,
};

const sampleGrid: TerrainGridResponse = {
  terrain_id: "terrain-syn-1",
  grid: [[10, 20], [30, 40]],
  metadata: sampleMetadata,
};

beforeEach(() => {
  vi.clearAllMocks();
  useTerrainStore.setState({
    metadata: null,
    grid: null,
    loading: false,
    error: null,
    terrainKey: null,
    terrainEpoch: 0,
  });
  useAnalysisStore.setState({
    radars: [],
    selectedRadarId: null,
    radarPosition: null,
    losResult: null,
    loading: false,
    error: null,
    terrainKey: null,
    terrainTransitioning: false,
  });
  vi.mocked(listRadars).mockResolvedValue([]);
});

describe("App — Terrain Upload UI", () => {
  it("renders a file input for terrain upload (DXF/STL)", () => {
    render(<App />);

    const fileInput = screen.getByLabelText(/upload terrain/i);
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).toHaveAttribute("type", "file");
    expect(fileInput).toHaveAttribute("accept", ".dxf,.stl");
  });

  it("renders an Upload Terrain button", () => {
    render(<App />);

    const uploadBtn = screen.getByRole("button", { name: /upload dxf \/ stl/i });
    expect(uploadBtn).toBeInTheDocument();
  });
});

describe("App — Auto loadGrid after generateSynthetic", () => {
  it("calls loadGrid after generateSynthetic succeeds", async () => {
    vi.mocked(generateSynthetic).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    render(<App />);

    const generateBtn = screen.getByRole("button", { name: /generate synthetic/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(generateSynthetic).toHaveBeenCalledWith({
        size_x: 200,
        size_y: 200,
        depth: 30,
        resolution: 1.0,
      });
    });

    await waitFor(() => {
      // loadGrid should be called automatically with the terrain ID
      expect(getTerrainGrid).toHaveBeenCalledWith("terrain-syn-1");
    });
  });
});

describe("App — Auto loadGrid after DXF upload", () => {
  it("calls loadGrid after DXF upload succeeds (auto-detected)", async () => {
    vi.mocked(uploadDXF).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    render(<App />);

    const fileInput = screen.getByLabelText(/upload terrain/i);
    const file = new File(["dxf-content"], "test.dxf", { type: "application/dxf" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(uploadDXF).toHaveBeenCalledWith(file, 1.0);
    });

    await waitFor(() => {
      expect(getTerrainGrid).toHaveBeenCalledWith("terrain-syn-1");
    });
  });
});

it("shows a FAILED polling response as a visible analysis alert", async () => {
  vi.useFakeTimers();
  vi.mocked(runLOSAnalysis).mockResolvedValueOnce({ job_id: "job-poll-failed", status: "PENDING" });
  vi.mocked(getLOSJob).mockResolvedValueOnce({
    job_id: "job-poll-failed",
    status: "FAILED",
    error: "polling reported a worker failure",
    created_at: "2026-09-28T00:00:00.000Z",
  });
  useAnalysisStore.setState({
    selectedRadarId: "ibis-arcsar360",
    radarPosition: { x: 1, y: 2, z: 3 },
  });

  render(<App />);
  await act(async () => {
    await useAnalysisStore.getState().runAnalysis(sampleMetadata.terrain_id);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(getLOSJob).toHaveBeenCalledWith("job-poll-failed");
  expect(screen.getByRole("alert")).toHaveTextContent("polling reported a worker failure");
  vi.useRealTimers();
});

it("keeps terrain A visible and does not reload its grid when importing terrain B fails", async () => {
  const terrainA: DTMMetadata = { ...sampleMetadata, terrain_id: "terrain-A" };
  const gridA = [[11, 12]];
  useTerrainStore.setState({
    metadata: terrainA,
    grid: gridA,
    terrainKey: { terrain_id: "terrain-A", epoch: 1 },
    terrainEpoch: 1,
  });
  useAnalysisStore.getState().activateTerrain({ terrain_id: "terrain-A", epoch: 1 });
  vi.mocked(uploadDXF).mockRejectedValueOnce(new Error("terrain B import failed"));

  render(<App />);
  const fileInput = screen.getByLabelText(/upload terrain/i);
  await act(async () => {
    fireEvent.change(fileInput, {
      target: { files: [new File(["bad"], "terrain-B.dxf", { type: "application/dxf" })] },
    });
  });

  await waitFor(() => expect(screen.getByText("terrain-A")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText(/terrain B import failed/)).toBeInTheDocument());

  expect(getTerrainGrid).not.toHaveBeenCalled();
  expect(useTerrainStore.getState()).toMatchObject({ metadata: terrainA, grid: gridA, error: "terrain B import failed" });
});

it("ignores terrain placement clicks while terrain B is transitioning", () => {
  act(() => {
    useTerrainStore.setState({ metadata: { ...sampleMetadata, terrain_id: "terrain-A" }, grid: [[11, 12]] });
    useAnalysisStore.setState({
      radars: [{ model_id: "ibis-arcsar360", display_name: "IBIS" } as any],
      selectedRadarId: "ibis-arcsar360",
      radarPosition: null,
      terrainTransitioning: true,
    });
  });

  render(<App />);
  fireEvent.click(screen.getByTestId("terrain-placement"));

  expect(useAnalysisStore.getState().radarPosition).toBeNull();
  expect(runLOSAnalysis).not.toHaveBeenCalled();
});

// ────────────────────────────────────────────
// STL Upload (auto-detected via single button)
// ────────────────────────────────────────────
describe("App — Auto loadGrid after STL upload", () => {
  it("calls uploadSTL and loadGrid when .stl file is uploaded (auto-detected)", async () => {
    vi.mocked(uploadSTL).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    render(<App />);

    const fileInput = screen.getByLabelText(/upload terrain/i);
    const stlFile = new File(["stl-content"], "terrain.stl", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [stlFile] } });

    await waitFor(() => {
      expect(uploadSTL).toHaveBeenCalledWith(stlFile, 1.0);
    });

    await waitFor(() => {
      expect(getTerrainGrid).toHaveBeenCalledWith("terrain-syn-1");
    });
  });
});
