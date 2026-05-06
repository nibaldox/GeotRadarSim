/**
 * Tests for ExportPanel component.
 *
 * Tests that export buttons render with correct enabled/disabled states
 * based on whether analysis has been run.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExportPanel } from "../components/ExportPanel";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import type { LOSResponse } from "../types/api";

beforeEach(() => {
  useAnalysisStore.setState({
    losResult: null,
    loading: false,
    error: null,
    radars: [],
    selectedRadarId: null,
    radarPosition: null,
  });
  useTerrainStore.setState({
    metadata: null,
    grid: null,
    loading: false,
    error: null,
  });
});

const sampleLOS: LOSResponse = {
  shadow_grid: [[false]],
  coverage_polygon: [[0, 0]],
  coverage_pct: 100,
  visible_area_m2: 1000,
  shadow_zones: [],
};

describe("ExportPanel", () => {
  it("disables all buttons when no analysis has been run", () => {
    render(<ExportPanel />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);

    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it("enables buttons when analysis result exists", () => {
    useAnalysisStore.setState({ losResult: sampleLOS });
    useTerrainStore.setState({
      metadata: { terrain_id: "t1", bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 }, resolution: 1, grid_rows: 1, grid_cols: 1 },
    });

    render(<ExportPanel />);

    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).not.toBeDisabled();
    }
  });

  it("renders PDF, CSV, and Image buttons", () => {
    render(<ExportPanel />);

    expect(screen.getByText(/pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/csv/i)).toBeInTheDocument();
    expect(screen.getByText(/image/i)).toBeInTheDocument();
  });

  it("shows coverage percentage when analysis exists", () => {
    useAnalysisStore.setState({ losResult: sampleLOS });
    useTerrainStore.setState({
      metadata: { terrain_id: "t1", bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 }, resolution: 1, grid_rows: 1, grid_cols: 1 },
    });

    render(<ExportPanel />);

    expect(screen.getByText(/100\.0%/)).toBeInTheDocument();
  });

  it("shows no-data message when analysis has not been run", () => {
    render(<ExportPanel />);

    expect(screen.getByText(/no analysis data/i)).toBeInTheDocument();
  });
});
