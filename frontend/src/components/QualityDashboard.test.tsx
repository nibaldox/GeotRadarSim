import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { QualityDashboard } from "./QualityDashboard";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const activeKey = { terrain_id: "terrain-global", epoch: 5 };

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

function activeSnapshot(key = activeKey): AnalysisSnapshot {
  return {
    terrainKey: key,
    analysisId: "job-global",
    sourceAnalysisIds: ["job-global"],
    generation: 1,
    radars: [],
  };
}

function setup({
  metadataResolution = 2,
  snapshot = activeSnapshot(),
  loading = false,
  multiLoading = false,
  terrainTransitioning = false,
  mode = "QUALITY",
}: {
  metadataResolution?: number;
  snapshot?: AnalysisSnapshot | null;
  loading?: boolean;
  multiLoading?: boolean;
  terrainTransitioning?: boolean;
  mode?: "QUALITY" | "SENSITIVITY";
} = {}) {
  useTerrainStore.setState({
    grid: [[0, 1, 2], [3, 4, 5]],
    metadata: {
      terrain_id: activeKey.terrain_id,
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 5 },
      resolution: metadataResolution,
      grid_rows: 2,
      grid_cols: 3,
    },
    terrainKey: { ...activeKey },
  });
  useAnalysisStore.setState({
    losResult: v2Result,
    activeSnapshot: snapshot,
    loading,
    multiLoading,
    terrainTransitioning,
  });
  useVectorStore.setState({ visualizationMode: mode });
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
}

function globalSummary() {
  return within(screen.getByRole("region", { name: "Resumen global de calidad" }));
}

beforeEach(() => {
  useAnalysisStore.setState({
    losResult: null,
    activeSnapshot: null,
    loading: false,
    multiLoading: false,
    terrainTransitioning: false,
    history: [],
  });
  useTerrainStore.setState({ grid: null, metadata: null, terrainKey: null });
});

describe("QualityDashboard global summary", () => {
  it("summarizes the current selected set with the selected metric identity", () => {
    setup();
    render(<QualityDashboard />);

    const view = globalSummary();
    expect(view.getByText(/Cobertura útil/).parentElement).toHaveTextContent("Incidencia superficial");
    expect(view.getByText(/Cobertura útil/).parentElement).toHaveTextContent("33.3%");
    expect(view.getByText(/Media \+ alta de lo visible/).parentElement).toHaveTextContent("50.0%");
    expect(view.getByText(/baja 25\.0%/)).toBeInTheDocument();
    expect(view.getByText(/Área útil/).parentElement).toHaveTextContent("8 m²");
    // Historical metrics stay labelled as such.
    expect(view.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("66.7%");
    expect(view.getByText(/Completitud/).parentElement).toHaveTextContent("100.0%");
  });

  it("switches to the movement-projection identity for SENSITIVITY mode", () => {
    setup({ mode: "SENSITIVITY" });
    render(<QualityDashboard />);

    const view = globalSummary();
    expect(view.getByText(/Cobertura útil/).parentElement).toHaveTextContent("Proyección del movimiento");
    // Projection [0.75, 0.75, NaN, 0.5] over 6 target cells: 3 useful.
    expect(view.getByText(/Cobertura útil/).parentElement).toHaveTextContent("50.0%");
  });

  it("uses the ACTIVE metadata resolution as the expected one, not the result's own", () => {
    // Result computed at resolution 2 while the active terrain metadata says 4.
    setup({ metadataResolution: 4 });
    render(<QualityDashboard />);

    expect(globalSummary().getByText(/no disponible/i)).toBeInTheDocument();
    expect(globalSummary().queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });

  it("treats missing result provenance as not current while terrain state is active", () => {
    setup({ snapshot: null });
    render(<QualityDashboard />);

    expect(globalSummary().getByText(/no disponible/i)).toBeInTheDocument();
    expect(globalSummary().queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });

  it("requires the exact terrain epoch of the active snapshot", () => {
    setup({ snapshot: activeSnapshot({ terrain_id: activeKey.terrain_id, epoch: 4 }) });
    render(<QualityDashboard />);

    expect(globalSummary().getByText(/no disponible/i)).toBeInTheDocument();
    expect(globalSummary().queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });

  it("pauses the summary during loading and terrain transitions", () => {
    setup({ loading: true });
    render(<QualityDashboard />);
    expect(screen.getByTestId("quality-global-summary-guarded")).toBeInTheDocument();
    expect(globalSummary().queryByText(/Cobertura útil/)).not.toBeInTheDocument();

    act(() => {
      setup({ terrainTransitioning: true });
    });
    expect(screen.getByTestId("quality-global-summary-guarded")).toBeInTheDocument();
    expect(globalSummary().queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });
});
