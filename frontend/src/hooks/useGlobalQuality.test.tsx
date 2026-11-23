/**
 * Equivalence of the single figures source with the code it replaced.
 *
 * `legacyDashboardSummary` and `legacyAoiCoverage` are verbatim pure copies of
 * the computations that lived in QualityDashboard.tsx:43-58 and
 * AoiCoverageView.tsx:16-27 at 029ea42. For the same stores (the fixtures of
 * QualityDashboard.test.tsx and AoiCoverageView.test.tsx), the hook, the
 * dashboard, the area view and the KPI bar must report the same numbers.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import { useGlobalQuality, useGlobalSummary, resetGlobalQualityCacheForTests } from "./useGlobalQuality";
import { QualityDashboard } from "../components/QualityDashboard";
import { AoiCoverageView } from "../components/AoiCoverageView";
import { KpiBar } from "../components/KpiBar";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useAoiStore } from "../store/aoiStore";
import { computeQualitySummary, DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
import type { QualityMetric } from "../utils/qualityMetrics";
import { aoiMaskForGrid, computeAoiCoverage } from "../utils/aoi";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

// ─── Verbatim legacy computations (029ea42) ─────────────────────────────────

function legacyDashboardSummary() {
  const policy = useQualityPolicyStore.getState().policy;
  const visualizationMode = useVectorStore.getState().visualizationMode;
  const { grid: terrainGrid, metadata: terrainMetadata, terrainKey } = useTerrainStore.getState();
  const { losResult, activeSnapshot, loading, multiLoading, terrainTransitioning } = useAnalysisStore.getState();
  const metric: QualityMetric = visualizationMode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";
  const guarded = loading || multiLoading || terrainTransitioning;
  const summary = (() => {
    if (guarded || !losResult || !terrainGrid || !terrainMetadata) return null;
    const resultKey = activeSnapshot?.terrainKey ?? null;
    if (!terrainKey || !resultKey) return null;
    return computeQualitySummary({
      metric,
      policy,
      losResult,
      terrainGrid,
      terrainResolution: terrainMetadata.resolution,
      terrainKey,
      snapshot: activeSnapshot,
    });
  })();
  return {
    summary,
    guarded,
    coveragePct: losResult ? losResult.coverage_pct ?? null : null,
    completenessPct: losResult ? losResult.completeness_pct ?? null : null,
  };
}

function legacyAoiCoverage(current: boolean) {
  const { polygon, terrainKey: areaKey } = useAoiStore.getState();
  const { grid, metadata, terrainKey, loading: terrainLoading } = useTerrainStore.getState();
  const { losResult, activeSnapshot, terrainKey: analysisKey, loading, multiLoading, terrainTransitioning } = useAnalysisStore.getState();
  const policy = useQualityPolicyStore.getState().policy;
  const mode = useVectorStore.getState().visualizationMode;
  const same = (a: typeof terrainKey, b: typeof terrainKey) => !!a && !!b && a.terrain_id === b.terrain_id && a.epoch === b.epoch;
  let coverage = null;
  if (current && polygon && grid && metadata && losResult && !loading && !multiLoading && !terrainLoading && !terrainTransitioning && same(terrainKey, areaKey) && same(terrainKey, analysisKey) && same(terrainKey, activeSnapshot?.terrainKey ?? null) && metadata.terrain_id === terrainKey?.terrain_id) {
    try {
      const mask = aoiMaskForGrid({ grid, bounds: metadata.bounds, resolution: metadata.resolution }, polygon);
      coverage = computeAoiCoverage(losResult, mask, policy, {
        metric: mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE",
        terrainGrid: grid,
        terrainResolution: metadata.resolution,
        terrainKey,
        snapshot: activeSnapshot,
      });
    } catch { /* The area has no valid grid cells. */ }
  }
  return coverage;
}

// ─── Fixtures (QualityDashboard.test.tsx and AoiCoverageView.test.tsx) ──────

const dashKey = { terrain_id: "terrain-global", epoch: 5 };
const dashResult: LOSResponse = {
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
const dashSnapshot = (key = dashKey): AnalysisSnapshot => ({
  terrainKey: key, analysisId: "job-global", sourceAnalysisIds: ["job-global"], generation: 1, radars: [],
});

function setupDashboard({
  metadataResolution = 2,
  snapshot = dashSnapshot() as AnalysisSnapshot | null,
  loading = false,
  multiLoading = false,
  terrainTransitioning = false,
  mode = "QUALITY" as "QUALITY" | "SENSITIVITY",
} = {}) {
  useTerrainStore.setState({
    grid: [[0, 1, 2], [3, 4, 5]],
    metadata: {
      terrain_id: dashKey.terrain_id,
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 4, max_y: 2, max_z: 5 },
      resolution: metadataResolution,
      grid_rows: 2,
      grid_cols: 3,
    },
    terrainKey: { ...dashKey },
    loading: false,
  });
  useAnalysisStore.setState({ losResult: dashResult, activeSnapshot: snapshot, loading, multiLoading, terrainTransitioning });
  useVectorStore.setState({ visualizationMode: mode });
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
}

const aoiRadar = (id: string, x: number) => ({
  radarId: id, position: { x, y: 0.5, z: 1 },
} as unknown as AnalysisSnapshot["radars"][number]);

function setupAoi(radars: AnalysisSnapshot["radars"] = []) {
  const key = { terrain_id: "t", epoch: 1 };
  const grid = [[0, 0], [0, 0]];
  const bounds = { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 0 };
  const metadata = { terrain_id: "t", bounds, resolution: 1, grid_rows: 2, grid_cols: 2 };
  const result = {
    grid_rows: 2, grid_cols: 2, resolution: 1, quality_model: "geometric-v2", coverage_pct: 75, completeness_pct: 100,
    cell_states: Uint8Array.from([5, 5, 4, 5]),
    flat_quality_grid: Float32Array.from([0.8, 0.4, 0, 0.1]),
    flat_projection_grid: Float32Array.from([0.8, 0.8, 0, 0.8]),
  } as LOSResponse;
  useTerrainStore.setState({ terrainKey: key, grid, metadata, loading: false });
  const a = useAoiStore.getState(); a.clear(); a.startDrawing();
  a.addVertex({ x: 0, y: 0 }); a.addVertex({ x: 1, y: 0 }); a.addVertex({ x: 1, y: 1 }); a.addVertex({ x: 0, y: 1 }); a.closePolygon();
  const snapshot: AnalysisSnapshot = { terrainKey: key, analysisId: "one", sourceAnalysisIds: ["one"], generation: 1, radars };
  useAnalysisStore.setState({ terrainKey: key, activeSnapshot: snapshot, losResult: result, loading: false, multiLoading: false, terrainTransitioning: false });
  useVectorStore.setState({ visualizationMode: "QUALITY" });
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
  return { key, snapshot };
}

const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? "Sin datos" : `${n.toFixed(1)}%`);
const kpiValue = (key: string) =>
  document.querySelector(`[data-kpi="${key}"] .kpi-bar-value`)?.textContent ?? null;

beforeEach(() => {
  resetGlobalQualityCacheForTests();
  useAoiStore.getState().clear();
  useAnalysisStore.setState({
    losResult: null, activeSnapshot: null, loading: false, multiLoading: false, terrainTransitioning: false, history: [], terrainKey: null,
  });
  useTerrainStore.setState({ grid: null, metadata: null, terrainKey: null, loading: false });
});

describe("useGlobalSummary ≡ legacy QualityDashboard computation", () => {
  const cases: Array<[string, Parameters<typeof setupDashboard>[0]]> = [
    ["current INCIDENCE", {}],
    ["current SENSITIVITY", { mode: "SENSITIVITY" }],
    ["active metadata resolution differs", { metadataResolution: 4 }],
    ["missing snapshot", { snapshot: null }],
    ["stale snapshot epoch", { snapshot: dashSnapshot({ terrain_id: dashKey.terrain_id, epoch: 4 }) }],
    ["loading", { loading: true }],
    ["multi loading", { multiLoading: true }],
    ["terrain transitioning", { terrainTransitioning: true }],
  ];

  it.each(cases)("%s: same summary, guard and historical figures", (_label, options) => {
    setupDashboard(options);
    const legacy = legacyDashboardSummary();
    const { result } = renderHook(() => useGlobalSummary());
    expect(result.current.summary).toEqual(legacy.summary);
    expect(result.current.guarded).toBe(legacy.guarded);
    expect(result.current.visibility).toBe(legacy.coveragePct);
    expect(result.current.completeness).toBe(legacy.completenessPct);
  });

  it("three consumers share one summary object for the same store state", () => {
    setupDashboard();
    const a = renderHook(() => useGlobalSummary());
    const b = renderHook(() => useGlobalQuality());
    expect(a.result.current.summary).not.toBeNull();
    expect(b.result.current.summary).toBe(a.result.current.summary);
  });
});

describe("useGlobalQuality aoi ≡ legacy AoiCoverageView computation", () => {
  it("matches in both metrics, and drops to null on stale or incoherent data", () => {
    setupAoi();
    const { result } = renderHook(() => useGlobalQuality());
    const legacy = legacyAoiCoverage(true)!;
    expect(legacy).not.toBeNull();
    expect(result.current.aoi).toEqual({ usefulPct: legacy.usefulPct, visiblePct: legacy.visiblePct, cellCount: legacy.aoiCellCount });

    act(() => useVectorStore.setState({ visualizationMode: "SENSITIVITY" }));
    const projection = legacyAoiCoverage(true)!;
    expect(projection.usefulPct).not.toBe(legacy.usefulPct);
    expect(result.current.aoi?.usefulPct).toBe(projection.usefulPct);

    const { key, snapshot } = { key: useTerrainStore.getState().terrainKey!, snapshot: useAnalysisStore.getState().activeSnapshot! };
    act(() => useAnalysisStore.setState({ activeSnapshot: { ...snapshot, terrainKey: { ...key, epoch: 0 } } }));
    expect(legacyAoiCoverage(true)).toBeNull();
    expect(result.current.aoi).toBeNull();

    act(() => {
      useAnalysisStore.setState({ activeSnapshot: snapshot });
      useTerrainStore.setState({ grid: [[Number.NaN, 0], [0, 0]] });
    });
    expect(legacyAoiCoverage(true)).toBeNull();
    expect(result.current.aoi).toBeNull();
  });
});

describe("KpiBar, QualityDashboard and AoiCoverageView show the same numbers", () => {
  it("dashboard fixture: useful coverage, visibility and useful area", () => {
    setupDashboard();
    const legacy = legacyDashboardSummary();
    render(<><QualityDashboard /><KpiBar /></>);
    const dash = within(screen.getByRole("region", { name: "Resumen global de calidad" }));

    // Same figures as before the change (QualityDashboard.test.tsx expectations).
    expect(dash.getByText(/Cobertura útil/).parentElement).toHaveTextContent("33.3%");
    expect(dash.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("66.7%");
    expect(dash.getByText(/Área útil/).parentElement).toHaveTextContent("8 m²");

    expect(kpiValue("useful")).toBe(pct(legacy.summary!.usefulCoveragePct));
    expect(kpiValue("useful")).toBe("33.3%");
    expect(dash.getByText(/Cobertura útil/).parentElement).toHaveTextContent(kpiValue("useful")!);
    expect(kpiValue("visibility")).toBe("66.7%");
    expect(dash.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent(kpiValue("visibility")!);
    // Same m² figure the dashboard shows, expressed in ha.
    expect(legacy.summary!.usefulAreaM2).toBe(8);
    expect(kpiValue("area")).toBe(`${(8 / 10000).toFixed(2)} ha`);
    // No area drawn: no area figure.
    expect(kpiValue("aoi")).toBeNull();
  });

  it("SENSITIVITY switches both surfaces together", () => {
    setupDashboard({ mode: "SENSITIVITY" });
    render(<><QualityDashboard /><KpiBar /></>);
    const dash = within(screen.getByRole("region", { name: "Resumen global de calidad" }));
    expect(dash.getByText(/Cobertura útil/).parentElement).toHaveTextContent("50.0%");
    expect(kpiValue("useful")).toBe("50.0%");
  });

  it("area fixture: «Área a monitorear» equals «Área útil» of the area view", () => {
    setupAoi([aoiRadar("r1", 0.2), aoiRadar("r2", 0.8)]);
    const legacy = legacyAoiCoverage(true)!;
    render(<><AoiCoverageView current /><KpiBar /></>);
    expect(screen.getByText(`Área útil: ${pct(legacy.usefulPct)}`)).toBeInTheDocument();
    expect(kpiValue("aoi")).toBe(pct(legacy.usefulPct));
    expect(kpiValue("visibility")).toBe("75.0%");
  });
});
