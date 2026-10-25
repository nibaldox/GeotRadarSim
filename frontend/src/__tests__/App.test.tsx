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
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
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
  previewTerrainBounds: vi.fn(),
  activateTerrain: vi.fn(),
  releaseTerrain: vi.fn(),
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
  previewTerrainBounds,
  listRadars,
  runLOSAnalysis,
  getLOSJob,
} from "../services/api";
import type { TerrainBoundsPreview } from "../services/api";
import type { AnalysisSnapshot, DTMMetadata, LOSResponse, TerrainGridResponse } from "../types/api";

const sampleBoundsPreview: TerrainBoundsPreview = {
  source: "DXF",
  pointCount: 42,
  bbox: { minX: 0, maxX: 200, minY: 0, maxY: 200, minZ: -30, maxZ: 0 },
  span: { x: 200, y: 200, z: 30 },
};

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
    uploadPreview: null,
    uploadPreviewLoading: false,
    uploadPreviewError: null,
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

describe("App — resumen global de calidad y bandas", () => {
  const key = { terrain_id: "terrain-syn-1", epoch: 1 };

  const v2Result: LOSResponse = {
    shadow_grid: [[false, false, false], [false, false, true]],
    cell_states: Uint8Array.from([5, 5, 5, 5, 4, 3]),
    grid_rows: 2,
    grid_cols: 3,
    resolution: 2,
    coverage_polygon: [],
    coverage_pct: 66.7,
    completeness_pct: 100,
    visible_area_m2: 16,
    shadow_zones: [],
    quality_grid: [[0.25, 0.5, 0.75], [Number.NaN, 0, 0]],
    flat_quality_grid: Float32Array.from([0.25, 0.5, 0.75, Number.NaN, -1, -1]),
    quality_model: "geometric-v2",
    flat_projection_grid: Float32Array.from([0.75, 0.75, Number.NaN, 0.5, Number.NaN, Number.NaN]),
  };

  const snapshot: AnalysisSnapshot = {
    terrainKey: { ...key },
    analysisId: "job-global-app",
    sourceAnalysisIds: ["job-global-app"],
    generation: 1,
    radars: [],
  };

  it("mounts the shared band control and an identifiable global summary section", () => {
    render(<App />);

    expect(screen.getByTestId("quality-policy-control")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Resumen global de calidad" })).toBeInTheDocument();
  });

  it("shows the selected-set summary inside the global section, scoped apart from history cards", async () => {
    useTerrainStore.setState({
      grid: [[0, 1, 2], [3, 4, 5]],
      metadata: {
        terrain_id: key.terrain_id,
        bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 5 },
        resolution: 2,
        grid_rows: 2,
        grid_cols: 3,
      },
      terrainKey: { ...key },
    });
    useAnalysisStore.setState({ losResult: v2Result, activeSnapshot: snapshot });
    render(<App />);

    // Let the mocked radar-catalog request settle so the loading guard lifts.
    await waitFor(() =>
      expect(screen.queryByTestId("quality-global-summary-guarded")).not.toBeInTheDocument(),
    );

    const region = within(screen.getByRole("region", { name: "Resumen global de calidad" }));
    expect(region.getByText(/Cobertura útil/).parentElement).toHaveTextContent("33.3%");
    expect(region.getByText(/Cobertura útil/).parentElement).toHaveTextContent("Incidencia superficial");
    expect(region.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("66.7%");
    // The band control carries no summary numbers, so nothing is confused with cards.
    expect(within(screen.getByTestId("quality-policy-control")).queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });
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
    vi.mocked(previewTerrainBounds).mockResolvedValueOnce({
      ...sampleBoundsPreview,
      source: "DXF",
    });
    vi.mocked(uploadDXF).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    render(<App />);

    const fileInput = screen.getByLabelText(/upload terrain/i);
    const file = new File(["dxf-content"], "test.dxf", { type: "application/dxf" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // File selection triggers the bounds preview, not a direct upload.
    await waitFor(() => {
      expect(previewTerrainBounds).toHaveBeenCalledWith(file);
    });

    // Wait for the dialog to render and click the confirm button to commit.
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    const confirmButton = await screen.findByRole("button", { name: /Cargar con/i });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => {
      expect(uploadDXF).toHaveBeenCalled();
      const callArgs = vi.mocked(uploadDXF).mock.calls[0]!;
      expect(callArgs[0]).toBe(file);
      expect(typeof callArgs[1]).toBe("number");
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
  // The dialog drives the new preview flow: bounds arrive first, then the user
  // confirms and the upload itself fails.
  vi.mocked(previewTerrainBounds).mockResolvedValueOnce({ ...sampleBoundsPreview, source: "DXF" });
  vi.mocked(uploadDXF).mockRejectedValueOnce(new Error("terrain B import failed"));

  render(<App />);
  const fileInput = screen.getByLabelText(/upload terrain/i);
  await act(async () => {
    fireEvent.change(fileInput, {
      target: { files: [new File(["bad"], "terrain-B.dxf", { type: "application/dxf" })] },
    });
  });

  // Wait for the dialog and confirm the upload to drive the failure path.
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  const confirmButton = await screen.findByRole("button", { name: /Cargar con/i });
  await act(async () => {
    fireEvent.click(confirmButton);
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
    vi.mocked(previewTerrainBounds).mockResolvedValueOnce({
      ...sampleBoundsPreview,
      source: "STL",
    });
    vi.mocked(uploadSTL).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    render(<App />);

    const fileInput = screen.getByLabelText(/upload terrain/i);
    const stlFile = new File(["stl-content"], "terrain.stl", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [stlFile] } });

    await waitFor(() => {
      expect(previewTerrainBounds).toHaveBeenCalledWith(stlFile);
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    const confirmButton = await screen.findByRole("button", { name: /Cargar con/i });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => {
      expect(uploadSTL).toHaveBeenCalled();
      const callArgs = vi.mocked(uploadSTL).mock.calls[0]!;
      expect(callArgs[0]).toBe(stlFile);
      expect(typeof callArgs[1]).toBe("number");
    });

    await waitFor(() => {
      expect(getTerrainGrid).toHaveBeenCalledWith("terrain-syn-1");
    });
  });
});

// ────────────────────────────────────────────
// Cancelar análisis (loading-banner cancel control)
// ────────────────────────────────────────────
describe("App — Cancelar análisis", () => {
  const catalogRadar = { model_id: "groundprobe-ssr-fx", display_name: "GroundProbe SSR-FX" } as any;

  it("shows the cancel button while a single analysis is loading and cancels on click", () => {
    act(() => {
      useAnalysisStore.setState({
        radars: [catalogRadar],
        selectedRadarId: "groundprobe-ssr-fx",
        radarPosition: { x: 1, y: 2, z: 3 },
        loading: true,
      });
    });
    render(<App />);

    const cancelBtn = screen.getByRole("button", { name: /cancelar análisis/i });
    expect(cancelBtn).toBeInTheDocument();

    // Spy AFTER the initial render, then flush a re-render so the component
    // subscribes to the spied (pass-through) action reference.
    const cancelSpy = vi.spyOn(useAnalysisStore.getState(), "cancelAnalysis");
    act(() => {
      useAnalysisStore.setState({});
    });

    fireEvent.click(screen.getByRole("button", { name: /cancelar análisis/i }));

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(useAnalysisStore.getState().loading).toBe(false);
    expect(screen.queryByRole("button", { name: /cancelar análisis/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/running analysis/i)).not.toBeInTheDocument();
  });

  it("shows the cancel button while a multi analysis is loading and hides it after cancel", () => {
    act(() => {
      useAnalysisStore.setState({ radars: [catalogRadar], multiLoading: true });
    });
    render(<App />);

    expect(screen.getByText(/running analysis/i)).toBeInTheDocument();
    const cancelBtn = screen.getByRole("button", { name: /cancelar análisis/i });
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.click(cancelBtn);

    expect(useAnalysisStore.getState().multiLoading).toBe(false);
    expect(screen.queryByRole("button", { name: /cancelar análisis/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/running analysis/i)).not.toBeInTheDocument();
  });

  it("does not offer cancel while only the radar catalog is loading", () => {
    act(() => {
      useAnalysisStore.setState({ radars: [], loading: true });
    });
    render(<App />);

    expect(screen.queryByRole("button", { name: /cancelar análisis/i })).not.toBeInTheDocument();
  });
});
