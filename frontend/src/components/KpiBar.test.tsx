import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { KpiBar, formatKpiHectares, formatKpiPercent } from "./KpiBar";
import { QualityDashboard } from "./QualityDashboard";
import { AoiCoverageView } from "./AoiCoverageView";
import { radarMarkerColor, resetGlobalQualityCacheForTests } from "../hooks/useGlobalQuality";
import { useAnalysisStore, RADAR_COLORS } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useAoiStore } from "../store/aoiStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const key = { terrain_id: "t", epoch: 1 };

const radar = (id: string, x: number): AnalysisSnapshot["radars"][number] => ({
  radarId: id,
  radarModelId: "modelo-sintetico",
  position: { x, y: 0.5, z: 1 },
  overrides: {} as AnalysisSnapshot["radars"][number]["overrides"],
});

function setup({ radars = [radar("r1", 0.1)], polygon = true }: { radars?: AnalysisSnapshot["radars"]; polygon?: boolean } = {}) {
  const grid = [[0, 0], [0, 0]];
  const bounds = { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 0 };
  const result = {
    grid_rows: 2, grid_cols: 2, resolution: 1, quality_model: "geometric-v2", coverage_pct: 75, completeness_pct: 100,
    cell_states: Uint8Array.from([5, 5, 4, 5]),
    flat_quality_grid: Float32Array.from([0.8, 0.4, 0, 0.1]),
    flat_projection_grid: Float32Array.from([0.8, 0.8, 0, 0.8]),
  } as LOSResponse;
  useTerrainStore.setState({ terrainKey: key, grid, metadata: { terrain_id: "t", bounds, resolution: 1, grid_rows: 2, grid_cols: 2 }, loading: false });
  if (polygon) {
    const a = useAoiStore.getState(); a.clear(); a.startDrawing();
    a.addVertex({ x: 0, y: 0 }); a.addVertex({ x: 1, y: 0 }); a.addVertex({ x: 1, y: 1 }); a.addVertex({ x: 0, y: 1 }); a.closePolygon();
  }
  const snapshot: AnalysisSnapshot = { terrainKey: key, analysisId: null, sourceAnalysisIds: radars.map((r) => r.radarId), generation: 1, radars };
  useAnalysisStore.setState({ terrainKey: key, activeSnapshot: snapshot, losResult: result, loading: false, multiLoading: false, terrainTransitioning: false });
  useVectorStore.setState({ visualizationMode: "QUALITY" });
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
  return { snapshot };
}

const value = (k: string) => document.querySelector(`[data-kpi="${k}"] .kpi-bar-value`)?.textContent ?? null;

beforeEach(() => {
  resetGlobalQualityCacheForTests();
  useAoiStore.getState().clear();
  useAnalysisStore.setState({ losResult: null, activeSnapshot: null, loading: false, multiLoading: false, terrainTransitioning: false, history: [], terrainKey: null });
  useTerrainStore.setState({ grid: null, metadata: null, terrainKey: null, loading: false });
});

describe("KpiBar", () => {
  it("shows the four figures with Spanish labels when the summary and the area are current", () => {
    setup();
    render(<KpiBar />);
    const bar = within(screen.getByRole("group", { name: "Cifras del análisis" }));
    expect(bar.getByText("Cobertura útil")).toBeInTheDocument();
    expect(bar.getByText("Visibilidad")).toBeInTheDocument();
    expect(bar.getByText("Área útil")).toBeInTheDocument();
    expect(bar.getByText("Área a monitorear")).toBeInTheDocument();
    expect(value("visibility")).toBe("75.0%");
    expect(value("area")).toMatch(/^\d+\.\d{2} ha$/);
  });

  it("matches «Resultados» (QualityDashboard + AoiCoverageView) number for number", () => {
    setup();
    render(<><QualityDashboard /><KpiBar /></>);
    const dash = within(screen.getByRole("region", { name: "Resumen global de calidad" }));
    const useful = dash.getByText(/Cobertura útil/).parentElement!.textContent!;
    expect(useful).toContain(` ${value("useful")} del objetivo común`);
    expect(dash.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent(value("visibility")!);
    const areaM2 = Number(/Área útil:\s*(\d+) m²/.exec(dash.getByText("Área útil:", { selector: "strong" }).parentElement!.textContent!)![1]);
    expect(value("area")).toBe(formatKpiHectares(areaM2));
    const aoiText = screen.getByText(/^Área útil: \d/).textContent!;
    expect(aoiText).toBe(`Área útil: ${value("aoi")}`);
  });

  it("is hidden without a summary", () => {
    render(<KpiBar />);
    expect(screen.queryByTestId("kpi-bar")).not.toBeInTheDocument();
    act(() => { setup(); useAnalysisStore.setState({ activeSnapshot: null }); });
    expect(screen.queryByTestId("kpi-bar")).not.toBeInTheDocument();
  });

  it.each([["loading"], ["multiLoading"], ["terrainTransitioning"]] as const)("is hidden while %s", (flag) => {
    setup();
    render(<KpiBar />);
    expect(screen.getByTestId("kpi-bar")).toBeInTheDocument();
    act(() => useAnalysisStore.setState({ [flag]: true }));
    expect(screen.queryByTestId("kpi-bar")).not.toBeInTheDocument();
  });

  it("omits «Área a monitorear» when no area is drawn or the area is not current", () => {
    setup({ polygon: false });
    const { unmount } = render(<KpiBar />);
    expect(screen.getByTestId("kpi-bar")).toBeInTheDocument();
    expect(value("aoi")).toBeNull();
    unmount();

    setup();
    render(<><KpiBar /><AoiCoverageView current /></>);
    expect(value("aoi")).not.toBeNull();
    // Analysis key of another epoch: the area view pauses and the bar drops the area figure, not the others.
    act(() => useAnalysisStore.setState({ terrainKey: { ...key, epoch: 2 } }));
    expect(screen.getByText("Ejecuta un análisis vigente para consultar el área.")).toBeInTheDocument();
    expect(value("aoi")).toBeNull();
    expect(value("useful")).not.toBeNull();
  });

  it("paints one dot per union radar with the viewer marker colors", () => {
    const radars = Array.from({ length: 10 }, (_, i) => radar(`r${i}`, i * 0.05));
    setup({ radars });
    render(<KpiBar />);
    const dots = screen.getAllByTestId("kpi-radar-dot");
    expect(dots).toHaveLength(10);
    dots.forEach((dot, i) => {
      // TerrainViewer: RADAR_COLORS[index % RADAR_COLORS.length] || "#ff4444".
      const expected = RADAR_COLORS[i % RADAR_COLORS.length] || "#ff4444";
      expect(dot.getAttribute("data-color")).toBe(expected);
      expect(radarMarkerColor(i)).toBe(expected);
    });
  });

  it("formats like «Resultados»", () => {
    expect(formatKpiPercent(33.333)).toBe("33.3%");
    expect(formatKpiPercent(null)).toBe("Sin datos");
    expect(formatKpiPercent(Number.NaN)).toBe("Sin datos");
    expect(formatKpiHectares(334_300)).toBe("33.43 ha");
    expect(formatKpiHectares(null)).toBe("Sin datos");
  });
});
