import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MultiRadarPanel } from "./MultiRadarPanel";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import type { LOSResponse } from "../types/api";

const noDataResult = {
  shadow_grid: [[false]],
  coverage_polygon: [],
  coverage_pct: null,
  completeness_pct: null,
  visible_area_m2: 0,
  shadow_zones: [],
} as unknown as LOSResponse;

beforeEach(() => {
  useAnalysisStore.setState({
    radars: [],
    deployedRadars: [{
      id: "radar-1",
      modelId: "test-radar",
      position: { x: 0, y: 0, z: 1 },
      color: "#fff",
      result: noDataResult,
    }],
    unifiedLos: noDataResult,
    multiLoading: false,
  });
  useTerrainStore.setState({ metadata: null });
});

describe("MultiRadarPanel NODATA display", () => {
  it("shows no-data for individual and network coverage instead of crashing or showing zero", () => {
    render(<MultiRadarPanel />);

    expect(screen.getByText(/Cobertura: Sin datos/)).toBeInTheDocument();
    expect(screen.getByText("Completitud: Sin datos")).toBeInTheDocument();
    expect(screen.getAllByText("Sin datos")).toHaveLength(2);
    expect(screen.queryByText(/NaN|Infinity|0\.0%/)).not.toBeInTheDocument();
  });
});
