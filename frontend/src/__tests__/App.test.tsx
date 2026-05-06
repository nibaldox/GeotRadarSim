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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "../App";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";

// Mock R3F — jsdom has no WebGL, so Canvas crashes
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="r3f-canvas-mock">{children}</div>
  ),
  useThree: () => ({
    camera: { position: { set: vi.fn() }, lookAt: vi.fn() },
  }),
}));

vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
}));

// Mock the API client
vi.mock("../services/api", () => ({
  generateSynthetic: vi.fn(),
  getTerrainGrid: vi.fn(),
  uploadDXF: vi.fn(),
  runLOSAnalysis: vi.fn(),
  listRadars: vi.fn(),
  getRadar: vi.fn(),
  exportPDF: vi.fn(),
  exportCSV: vi.fn(),
}));

import {
  generateSynthetic,
  getTerrainGrid,
  uploadDXF,
  listRadars,
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
  });
  useAnalysisStore.setState({
    radars: [],
    selectedRadarId: null,
    radarPosition: null,
    losResult: null,
    loading: false,
    error: null,
  });
  vi.mocked(listRadars).mockResolvedValue([]);
});

describe("App — DXF Upload UI", () => {
  it("renders a file input for DXF upload", () => {
    render(<App />);

    const fileInput = screen.getByLabelText(/upload dxf/i);
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).toHaveAttribute("type", "file");
    expect(fileInput).toHaveAttribute("accept", ".dxf");
  });

  it("renders an Upload DXF button", () => {
    render(<App />);

    const uploadBtn = screen.getByRole("button", { name: /upload dxf/i });
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
        resolution: 2.0,
      });
    });

    await waitFor(() => {
      // loadGrid should be called automatically with the terrain ID
      expect(getTerrainGrid).toHaveBeenCalledWith("terrain-syn-1");
    });
  });
});

describe("App — Auto loadGrid after DXF upload", () => {
  it("calls loadGrid after DXF upload succeeds", async () => {
    vi.mocked(uploadDXF).mockResolvedValueOnce(sampleMetadata);
    vi.mocked(getTerrainGrid).mockResolvedValueOnce(sampleGrid);

    render(<App />);

    const fileInput = screen.getByLabelText(/upload dxf/i);
    const file = new File(["dxf-content"], "test.dxf", { type: "application/dxf" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const uploadBtn = screen.getByRole("button", { name: /upload dxf/i });
    fireEvent.click(uploadBtn);

    await waitFor(() => {
      expect(uploadDXF).toHaveBeenCalledWith(file);
    });

    await waitFor(() => {
      expect(getTerrainGrid).toHaveBeenCalledWith("terrain-syn-1");
    });
  });
});
