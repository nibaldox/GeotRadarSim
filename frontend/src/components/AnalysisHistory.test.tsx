import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AnalysisHistory } from "./AnalysisHistory";
import { RADAR_COLORS, useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

beforeEach(() => {
  useAnalysisStore.setState({
    history: [{
      position: { x: 0, y: 0, z: 1 },
      coveragePct: null,
      timestamp: "now",
      result: { coverage_pct: null },
      radarId: "test-radar",
      selected: true,
    }] as any,
  });
});

describe("AnalysisHistory NODATA display", () => {
  it("shows no-data for a result with no candidate cells", () => {
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));

    expect(screen.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("Sin datos");
    expect(screen.getByText(/Completitud/).parentElement).toHaveTextContent("Sin datos");
    expect(screen.queryByText(/NaN|Infinity|0\.0%/)).not.toBeInTheDocument();
  });
});

// ─── Geometric quality summary cards ─────────────────────────────────────────

const entryKey = { terrain_id: "terrain-card", epoch: 3 };

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

function cardSnapshot(key = entryKey): AnalysisSnapshot {
  return {
    terrainKey: key,
    analysisId: "job-card",
    sourceAnalysisIds: ["job-card"],
    generation: 1,
    radars: [],
  };
}

function setupCard(snapshotKey = entryKey) {
  useTerrainStore.setState({
    grid: [[0, 1, 2], [3, 4, 5]],
    metadata: {
      terrain_id: entryKey.terrain_id,
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 5 },
      resolution: 2,
      grid_rows: 2,
      grid_cols: 3,
    },
    terrainKey: entryKey,
    terrainEpoch: entryKey.epoch,
  });
  useAnalysisStore.setState({
    terrainKey: entryKey,
    terrainTransitioning: false,
    history: [{
      position: { x: 0, y: 0, z: 1 },
      coveragePct: 66.7,
      timestamp: "card",
      result: v2Result,
      radarId: "test-radar",
      selected: true,
      terrain_id: entryKey.terrain_id,
      terrain_epoch: snapshotKey.epoch,
      snapshot: cardSnapshot(snapshotKey),
    }] as any,
  });
  useVectorStore.setState({ visualizationMode: "QUALITY" });
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
}

describe("AnalysisHistory quality summary cards", () => {
  it("leads with useful incidence coverage of the shared common target", () => {
    setupCard();
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));

    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("Incidencia superficial");
    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("33.3%");
    expect(screen.getByText(/Media \+ alta de lo visible/).parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText(/baja 25\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/sin índice 25\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/Área útil/).parentElement).toHaveTextContent("8 m²");
    // Historical metrics stay visible and clearly labelled.
    expect(screen.getByText(/Completitud/).parentElement).toHaveTextContent("100.0%");
    expect(screen.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("66.7%");
  });

  it("switches to the movement-projection metric identity", () => {
    setupCard();
    useVectorStore.setState({ visualizationMode: "SENSITIVITY" });
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));

    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("Proyección del movimiento");
    // Projection [0.75, 0.75, NaN, 0.5] over 6 target cells: 3 useful.
    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText(/Media \+ alta de lo visible/).parentElement).toHaveTextContent("75.0%");
    expect(screen.getByText(/sin índice 25\.0%/)).toBeInTheDocument();
  });

  it("reclassifies card metrics after a policy edit without rerunning LOS", () => {
    setupCard();
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));
    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("33.3%");

    act(() => {
      useQualityPolicyStore.setState({ policy: { mediumMin: 0.25, highMin: 0.75 } });
    });

    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText(/media 50\.0%/)).toBeInTheDocument();
  });

  it("shows no current quality summary for an entry from another terrain epoch", () => {
    setupCard({ terrain_id: entryKey.terrain_id, epoch: 2 });
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));

    expect(screen.getByText(/no disponible/i)).toBeInTheDocument();
    expect(screen.getByText(/Recalcular el análisis/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cobertura útil/)).not.toBeInTheDocument();
    // Historical visibility is kept for the old result.
    expect(screen.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("66.7%");
  });

  it("expects the ACTIVE terrain metadata resolution, not the result's own", () => {
    setupCard();
    useTerrainStore.setState({
      metadata: { ...useTerrainStore.getState().metadata!, resolution: 4 },
    });
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));

    expect(screen.getByText(/no disponible/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });

  it("does not treat a missing entry snapshot as proof of currency", () => {
    setupCard();
    useAnalysisStore.setState({
      history: [{ ...useAnalysisStore.getState().history[0]!, snapshot: undefined }] as any,
    });
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));

    expect(screen.getByText(/no disponible/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cobertura útil/)).not.toBeInTheDocument();
  });
});


describe("historial compacto", () => {
  it("muestra cifras y resumen en una fila cerrada", () => {
    setupCard();
    render(<AnalysisHistory />);
    expect(screen.getByText("1 de 1 seleccionados")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /R 1/ });
    expect(row).toHaveTextContent("útil 33.3% · vis 66.7%");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("quality-summary")).not.toBeInTheDocument();
  });
  it("selecciona con la casilla sin abrir el detalle", () => {
    setupCard();
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("checkbox", { name: /seleccionar radar 1/i }));
    expect(useAnalysisStore.getState().history[0]!.selected).toBe(false);
    expect(screen.getByRole("button", { name: /R 1/ })).toHaveAttribute("aria-expanded", "false");
  });
  it("abre el detalle sin cambiar la selección", () => {
    setupCard();
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: /R 1/ }));
    expect(useAnalysisStore.getState().history[0]!.selected).toBe(true);
    expect(screen.getByText(/E 0 · N 0 · Cota 1 m/)).toBeInTheDocument();
    expect(screen.getByText("card")).toBeInTheDocument();
    expect(screen.getByTestId("quality-summary")).toBeInTheDocument();
  });
  it("quita la entrada", () => {
    setupCard();
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: "Quitar del historial" }));
    expect(useAnalysisStore.getState().history).toHaveLength(0);
  });
  it("permite abrir y cerrar el detalle con teclado", () => {
    setupCard();
    render(<AnalysisHistory />);
    const row = screen.getByRole("button", { name: /R 1/ });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(row, { key: " " });
    expect(row).toHaveAttribute("aria-expanded", "false");
  });
  it("mantiene los colores del visor para la unión activa", () => {
    setupCard();
    const first = useAnalysisStore.getState().history[0]!;
    useAnalysisStore.setState({
      history: [first, { ...first, radarId: "otro", timestamp: "otro" }],
      activeSnapshot: { ...cardSnapshot(), radars: [
        { radarId: "otro", position: first.position },
        { radarId: "test-radar", position: first.position },
      ] } as any,
    });
    const { container } = render(<AnalysisHistory />);
    const dots = container.querySelectorAll<HTMLElement>(".history-color");
    expect(dots[0]).toHaveStyle({ backgroundColor: RADAR_COLORS[1] });
    expect(dots[1]).toHaveStyle({ backgroundColor: RADAR_COLORS[0] });
  });
  it("borra todo sin cambiar el estado plegado persistido", () => {
    setupCard();
    localStorage.setItem("geotradar-collapse-history", "false");
    render(<AnalysisHistory />);
    fireEvent.click(screen.getByRole("button", { name: "Borrar todo" }));
    expect(useAnalysisStore.getState().history).toHaveLength(0);
    expect(localStorage.getItem("geotradar-collapse-history")).toBe("false");
    expect(screen.queryByRole("region", { name: /Historial/ })).not.toBeInTheDocument();
  });

});
