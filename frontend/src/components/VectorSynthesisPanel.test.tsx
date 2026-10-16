import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VectorSynthesisPanel } from "./VectorSynthesisPanel";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import type { SensitivityMapResponse } from "../types/api";

const terrainKey = { terrain_id: "terrain-panel", epoch: 2 };

function sensitivityMap(value: number, observers: number): SensitivityMapResponse {
  return {
    terrainKey,
    sourceAnalysisIds: ["analysis-panel"],
    grid_rows: 1,
    grid_cols: 1,
    resolution: 1,
    flat_sensitivity_grid: new Float32Array([value]),
    observer_count: new Uint16Array([observers]),
  };
}

beforeEach(() => {
  localStorage.clear();
  useVectorStore.getState().reset();
  useAnalysisStore.setState({
    terrainKey,
    terrainTransitioning: false,
    history: [{
      timestamp: "panel-entry",
      radarId: "groundprobe-ssr-fx",
      position: { x: 10, y: 20, z: 5 },
      selected: true,
      coveragePct: 50,
      result: { completeness_pct: 70 },
    }] as any,
  });
  useTerrainStore.setState({
    metadata: {
      terrain_id: terrainKey.terrain_id,
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
      resolution: 1,
      grid_rows: 1,
      grid_cols: 1,
    },
  });
});

describe("VectorSynthesisPanel", () => {
  it("waits for the explicit calculate button instead of auto-running", () => {
    const compute = vi.fn().mockResolvedValue(undefined);
    useVectorStore.setState({ computeSensitivityMap: compute });

    render(<VectorSynthesisPanel />);

    expect(compute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Calcular Mapa de Sensibilidad/i }));
    expect(compute).toHaveBeenCalledWith(terrainKey.terrain_id);
  });

  it("shows Sin datos when every cell has zero observers", () => {
    useVectorStore.setState({ sensitivityMap: sensitivityMap(Number.NaN, 0) });

    render(<VectorSynthesisPanel />);

    expect(screen.getByRole("status")).toHaveTextContent(/Sin datos/i);
    expect(screen.getByRole("status")).toHaveTextContent(/gradiente calculable/i);
    expect(screen.queryByText(/0 celdas con datos/i)).not.toBeInTheDocument();
  });

  it("treats a measured zero as observed data, not as no-data", () => {
    useVectorStore.setState({ sensitivityMap: sensitivityMap(0, 1) });

    render(<VectorSynthesisPanel />);

    expect(screen.getByRole("status")).toHaveTextContent(/1 celda con observación/i);
  });
});
