/// <reference types="vite/client" />
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportPanel } from "../components/ExportPanel";
import { AoiCoverageView } from "../components/AoiCoverageView";
import * as api from "../services/api";
import { RADAR_COLORS, mergeResults, useAnalysisStore } from "../store/analysisStore";
import type { DeployedRadar, HistoryEntry } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useVectorStore } from "../store/vectorStore";
import { LOSCellState } from "../types/api";
import type { AnalysisRadarOverrides, AnalysisSnapshot, LOSResponse, RadarConfig } from "../types/api";
import { computeQualitySummary } from "../utils/qualityMetrics";
import { reportFixture3 } from "./fixtures";
import { ReportError } from "./types";
import type { ReportModel } from "./types";
import {
  DEFAULT_REPORT_TITLE,
  bilinearGroundZ,
  buildReportModel,
  captureReportInputs,
  isCurrentReportState,
  resolveRadarParameters,
} from "./reportModel";
import type { ReportInputs } from "./reportModel";

const KEY = Object.freeze({ terrain_id: "dtm-report-test", epoch: 3 });
const NO_OVERRIDES: AnalysisRadarOverrides = Object.freeze({
  rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null,
});
const MODELS = ["groundprobe-ssr-fx", "ibis-arcsar360", "reutech-msr"];
let catalog: RadarConfig[] = [];

const fixture = reportFixture3();
const { rows: ROWS, cols: COLS, resolution: RES } = fixture.terrain;
const SIZE = ROWS * COLS;

function terrainGrid(): number[][] {
  return Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col) => fixture.terrain.elevations[row * COLS + col]!));
}

/** Individual v2 LOS result built from a fixture radar (incidence -1 outside VISIBLE). */
function losFor(index: number): LOSResponse {
  const radar = fixture.radars[index]!;
  const cell_states = radar.cellStates.slice();
  const flat_quality_grid = new Float32Array(SIZE).fill(-1);
  const flat_projection_grid = new Float32Array(SIZE).fill(Number.NaN);
  let visible = 0, shadow = 0;
  for (let idx = 0; idx < SIZE; idx++) {
    if (cell_states[idx] === LOSCellState.SHADOW) shadow++;
    if (cell_states[idx] !== LOSCellState.VISIBLE) continue;
    visible++;
    flat_quality_grid[idx] = radar.qualityValues![idx]!;
    if (idx % 7 !== 0) flat_projection_grid[idx] = (idx % 10) / 10;
  }
  return {
    shadow_grid: Array.from({ length: ROWS }, (_, row) =>
      Array.from({ length: COLS }, (_, col) => cell_states[row * COLS + col] === LOSCellState.SHADOW)),
    cell_states, grid_rows: ROWS, grid_cols: COLS, resolution: RES, coverage_polygon: [],
    coverage_pct: Number(((visible / (visible + shadow)) * 100).toFixed(2)),
    completeness_pct: 100, visible_area_m2: visible * RES * RES, shadow_zones: [],
    flat_quality_grid, quality_model: "geometric-v2", flat_projection_grid,
  };
}

const positionOf = (index: number) => ({ ...fixture.radars[index]!.position });

function singleSnapshot(index: number, overrides: AnalysisRadarOverrides = NO_OVERRIDES): AnalysisSnapshot {
  const model = MODELS[index % MODELS.length]!;
  return Object.freeze({
    terrainKey: KEY, analysisId: `job-${index + 1}`, sourceAnalysisIds: Object.freeze([`job-${index + 1}`]),
    generation: index + 1,
    radars: Object.freeze([Object.freeze({ radarId: model, radarModelId: model, position: positionOf(index), overrides })]),
  });
}

function historyEntry(index: number): HistoryEntry {
  const result = losFor(index);
  return {
    position: positionOf(index), coveragePct: result.coverage_pct, timestamp: "12:00:00", result,
    radarId: MODELS[index % MODELS.length]!, selected: false, terrain_id: KEY.terrain_id, terrain_epoch: KEY.epoch,
    snapshot: singleSnapshot(index),
  };
}

function setTerrain(): void {
  useTerrainStore.setState({
    metadata: {
      terrain_id: KEY.terrain_id, resolution: RES, grid_rows: ROWS, grid_cols: COLS,
      bounds: { ...fixture.terrain.bounds },
    },
    grid: terrainGrid(), terrainKey: { ...KEY }, terrainEpoch: KEY.epoch, loading: false, error: null,
  });
  useAnalysisStore.setState({
    terrainKey: { ...KEY }, terrainTransitioning: false, loading: false, multiLoading: false, error: null,
    radars: catalog, history: [], deployedRadars: [], unifiedLos: null, losResult: null, activeSnapshot: null,
  });
}

/** History path through the store's own selection action (real union and snapshot). */
function setHistory(selected: number[]): HistoryEntry[] {
  setTerrain();
  const history = [0, 1, 2].map(historyEntry);
  useAnalysisStore.setState({ history });
  for (const index of selected) useAnalysisStore.getState().toggleHistoryEntrySelection(index);
  return history;
}

/** Multi-radar path exactly as `runMultiAnalysis` publishes it. */
function setMulti(count: number, overrides: Partial<DeployedRadar> = {}): DeployedRadar[] {
  setTerrain();
  const deployed: DeployedRadar[] = Array.from({ length: count }, (_, index) => ({
    id: `radar-${100 + index}`, modelId: MODELS[index % MODELS.length]!, position: positionOf(index % 3),
    color: RADAR_COLORS[index % RADAR_COLORS.length]!, result: losFor(index % 3), ...overrides,
  }));
  return publishMulti(deployed);
}

/** Publish already deployed radars (with results) as `runMultiAnalysis` does. */
function publishMulti(deployed: DeployedRadar[]): DeployedRadar[] {
  const count = deployed.length;
  const unified = mergeResults(deployed.map((radar) => radar.result!));
  const snapshot: AnalysisSnapshot = Object.freeze({
    terrainKey: Object.freeze({ ...KEY }), analysisId: count === 1 ? "multi-job-0" : null,
    sourceAnalysisIds: Object.freeze(deployed.map((_, index) => `multi-job-${index}`)), generation: 42,
    radars: Object.freeze(deployed.map((radar) => Object.freeze({
      radarId: radar.id, radarModelId: radar.modelId, position: Object.freeze({ ...radar.position }),
      overrides: Object.freeze({
        rangeMin: radar.rangeMin ?? null, rangeMax: radar.rangeMax ?? null, elMin: radar.elMin ?? null,
        elMax: radar.elMax ?? null, azCenter: radar.azCenter ?? null, azWidth: radar.azWidth ?? null,
      }),
    }))),
  });
  useAnalysisStore.setState({ deployedRadars: deployed, unifiedLos: unified, losResult: unified, activeSnapshot: snapshot });
  return deployed;
}

function setAoi(key: { terrain_id: string; epoch: number } = KEY): void {
  useAoiStore.setState({
    polygon: { vertices: fixture.aoi!.vertices }, vertices: fixture.aoi!.vertices, terrainKey: { ...key },
    drawing: false, error: null,
  });
}

const NOW = new Date("2026-11-22T12:00:00.000Z");
const build = (opts?: { title?: string }): ReportModel => buildReportModel(captureReportInputs(), { now: NOW, ...opts });

function expectReportError(fn: () => unknown, code: ReportError["code"]): ReportError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    expect((error as ReportError).code).toBe(code);
    expect((error as ReportError).message).toMatch(/[a-záéíóúñ]/);
    return error as ReportError;
  }
  throw new Error(`Expected ReportError ${code}`);
}

function entriesOf(inputs: ReportInputs): readonly HistoryEntry[] {
  if (inputs.source.kind !== "history") throw new Error("Expected the history path");
  return inputs.source.entries;
}

function expectUnionInvariant(model: ReportModel): void {
  const exclusive = model.radars.reduce((sum, radar) => sum + radar.exclusiveAreaM2!, 0);
  expect(exclusive + model.union!.overlapAreaM2).toBe(model.union!.metrics.visibleAreaM2);
}

beforeAll(async () => {
  catalog = await api.listRadars();
});

beforeEach(() => {
  useQualityPolicyStore.getState().resetPolicy();
  useVectorStore.setState({ visualizationMode: "QUALITY" });
  useAoiStore.getState().clear();
  setTerrain();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildReportModel: éxito", () => {
  it("historial con 3 radares: orden, unión, áreas exclusivas e invariante", () => {
    setHistory([0, 1, 2]);
    const model = build();
    expect(model.version).toBe(1);
    expect(model.title).toBe(DEFAULT_REPORT_TITLE);
    expect(model.createdAtIso).toBe(NOW.toISOString());
    expect(model.radars.map((radar) => radar.analysisId)).toEqual(["job-1", "job-2", "job-3"]);
    expect(model.provenance.sourceAnalysisIds).toEqual(["job-1", "job-2", "job-3"]);
    expect(model.radars.map((radar) => radar.label)).toEqual(["Radar 1", "Radar 2", "Radar 3"]);
    expect(model.radars.map((radar) => radar.color)).toEqual(fixture.radars.map((radar) => radar.color));
    expect(model.union).not.toBeNull();
    // Same exclusive/overlap areas as the hand-written fixture.
    expect(model.radars.map((radar) => radar.exclusiveAreaM2)).toEqual(fixture.radars.map((radar) => radar.exclusiveAreaM2));
    expect(model.union!.overlapAreaM2).toBe(fixture.union!.overlapAreaM2);
    expect([...model.union!.visibleCount]).toEqual([...fixture.union!.visibleCount]);
    expect(model.radars.every((radar) => radar.exclusiveAreaM2! > 0)).toBe(true);
    expectUnionInvariant(model);
    expect(model.terrain).toMatchObject({ terrainId: KEY.terrain_id, epoch: KEY.epoch, rows: ROWS, cols: COLS });
    expect(model.qualityModel).toBe("geometric-v2");
    expect(model.metric).toBe("INCIDENCE");
  });

  it("historial con 1 radar: sin unión y sin área exclusiva", () => {
    setHistory([1]);
    const model = build({ title: "  Rajo norte  " });
    expect(model.title).toBe("Rajo norte");
    expect(model.radars).toHaveLength(1);
    expect(model.union).toBeNull();
    expect(model.radars[0]!.exclusiveAreaM2).toBeNull();
    expect(model.radars[0]!.analysisId).toBe("job-2");
  });

  it("multiradar con 3 radares: resultados de deployedRadars en el orden del snapshot", () => {
    setMulti(3);
    const model = build();
    expect(model.radars.map((radar) => radar.radarId)).toEqual(["radar-100", "radar-101", "radar-102"]);
    expect(model.radars.map((radar) => radar.analysisId)).toEqual(["multi-job-0", "multi-job-1", "multi-job-2"]);
    expect(model.provenance.generation).toBe(42);
    expectUnionInvariant(model);
    expect(model.union!.overlapAreaM2).toBe(fixture.union!.overlapAreaM2);
  });

  it("multiradar: al quitar un radar del medio, los colores siguen siendo los del visor", () => {
    setMulti(4);
    const removed = useAnalysisStore.getState().deployedRadars[1]!.id;
    // Real store action: it keeps each remaining radar's color and clears the results.
    useAnalysisStore.getState().removeDeployedRadar(removed);
    const remaining = useAnalysisStore.getState().deployedRadars;
    expect(remaining.map((radar) => radar.color)).toEqual([RADAR_COLORS[0], RADAR_COLORS[2], RADAR_COLORS[3]]);
    publishMulti(remaining.map((radar, index) => ({ ...radar, result: losFor(index % 3) })));
    const model = build();
    expect(model.radars.map((radar) => radar.color)).toEqual(remaining.map((radar) => radar.color));
    expect(model.radars.map((radar) => radar.label)).toEqual(["Radar 1", "Radar 2", "Radar 3"]);
  });

  it("historial: colores por índice, como el visor", () => {
    setHistory([0, 2]);
    expect(build().radars.map((radar) => radar.color)).toEqual([RADAR_COLORS[0], RADAR_COLORS[1]]);
  });

  it("multiradar con 1 radar: unión nula", () => {
    setMulti(1);
    const model = build();
    expect(model.union).toBeNull();
    expect(model.radars[0]!.exclusiveAreaM2).toBeNull();
  });

  it("coordenadas del snapshot, cota bilineal y altura sobre el terreno", () => {
    setHistory([0, 1, 2]);
    const model = build();
    model.radars.forEach((radar, index) => {
      expect(radar.position).toEqual(fixture.radars[index]!.position);
      expect(radar.groundZ).toBe(fixture.radars[index]!.groundZ);
      expect(radar.heightAboveGround).toBeCloseTo(5, 9);
    });
  });

  it("parámetros del catálogo y overrides", () => {
    setMulti(2, { rangeMax: 900, azCenter: 270, azWidth: 90 });
    const model = build();
    expect(model.radars[0]).toMatchObject({ modelName: "GroundProbe SSR-FX", rangeM: 900, azimuthDeg: -90, apertureDeg: 90 });
    setHistory([0, 1]);
    const plain = build();
    // History order: entry 0 is the first radar of the snapshot.
    expect(plain.radars[0]).toMatchObject({ modelName: "GroundProbe SSR-FX", rangeM: 2500, azimuthDeg: 0, apertureDeg: 150 });
    expect(plain.radars[1]).toMatchObject({ modelName: "IBIS-ArcSAR360", rangeM: 2500, azimuthDeg: null, apertureDeg: 360 });
  });
});

describe("buildReportModel: cifras iguales al dashboard", () => {
  it.each(["QUALITY", "SENSITIVITY"] as const)("modo %s: radar, unión y área a monitorear", (mode) => {
    useVectorStore.setState({ visualizationMode: mode });
    useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.4, highMin: 0.8 });
    const history = setHistory([0, 1, 2]);
    setAoi();
    const model = build();
    const metric = mode === "SENSITIVITY" ? "PROJECTION" : "INCIDENCE";
    const terrain = useTerrainStore.getState();
    const analysis = useAnalysisStore.getState();
    const policy = useQualityPolicyStore.getState().policy;
    expect(model.metric).toBe(metric);
    expect(model.policy).toEqual({ mediumMin: 0.4, highMin: 0.8 });
    // Same inputs as AnalysisHistory (per entry) and QualityDashboard (active result).
    history.forEach((entry, index) => {
      const summary = computeQualitySummary({
        metric, policy, losResult: entry.result, terrainGrid: terrain.grid!, terrainResolution: RES,
        terrainKey: terrain.terrainKey, snapshot: entry.snapshot,
      })!;
      const radar = model.radars[index]!;
      expect(Object.is(radar.metrics.usefulPct, summary.usefulCoveragePct)).toBe(true);
      expect(Object.is(radar.metrics.usefulAreaM2, summary.usefulAreaM2)).toBe(true);
      expect(radar.metrics.bandsPct).toEqual({
        low: summary.distribution!.lowPct, medium: summary.distribution!.mediumPct,
        high: summary.distribution!.highPct, noIndex: summary.distribution!.noIndexPct,
      });
      expect(radar.metrics.visiblePct).toBe(entry.result.coverage_pct);
      expect(radar.metrics.visibleAreaM2).toBe(entry.result.visible_area_m2);
      expect(radar.metrics.aoi).not.toBeNull();
    });
    const unionSummary = computeQualitySummary({
      metric, policy, losResult: analysis.losResult!, terrainGrid: terrain.grid!, terrainResolution: RES,
      terrainKey: terrain.terrainKey, snapshot: analysis.activeSnapshot,
    })!;
    expect(Object.is(model.union!.metrics.usefulPct, unionSummary.usefulCoveragePct)).toBe(true);
    expect(model.union!.metrics.visibleAreaM2).toBe(analysis.losResult!.visible_area_m2);
    // AoiCoverageView renders the union's area coverage with one decimal.
    render(createElement(AoiCoverageView, { current: true }));
    const view = screen.getByLabelText("Cobertura del área");
    expect(view).toHaveTextContent(`Área útil: ${model.union!.metrics.aoi!.usefulPct!.toFixed(1)}%`);
    expect(view).toHaveTextContent(`Área visible: ${model.union!.metrics.aoi!.visiblePct!.toFixed(1)}%`);
    expect(model.aoi!.areaM2).toBe(fixture.aoi!.areaM2);
    expect(model.aoi!.vertices).toHaveLength(4);
  });

  it("área a monitorear nula si su clave de terreno no coincide", () => {
    setHistory([0, 1, 2]);
    setAoi({ terrain_id: KEY.terrain_id, epoch: KEY.epoch + 1 });
    const model = build();
    expect(model.aoi).toBeNull();
    expect(model.radars.every((radar) => radar.metrics.aoi === null)).toBe(true);
    expect(model.union!.metrics.aoi).toBeNull();
  });

  it("sin área dibujada, aoi es null", () => {
    setHistory([0]);
    expect(build().aoi).toBeNull();
  });
});

describe("buildReportModel: copias inmutables", () => {
  it("mutar el store después no cambia el modelo", () => {
    const history = setHistory([0, 1, 2]);
    const model = build();
    const before = {
      states: [...model.radars[0]!.cellStates], quality: [...model.radars[0]!.qualityValues!],
      union: [...model.union!.cellStates], elevations: [...model.terrain.elevations],
    };
    history[0]!.result.cell_states.fill(LOSCellState.SHADOW);
    history[0]!.result.flat_quality_grid!.fill(0.99);
    useAnalysisStore.getState().losResult!.cell_states.fill(LOSCellState.NODATA);
    useTerrainStore.getState().grid![0]![0] = -999;
    expect([...model.radars[0]!.cellStates]).toEqual(before.states);
    expect([...model.radars[0]!.qualityValues!]).toEqual(before.quality);
    expect([...model.union!.cellStates]).toEqual(before.union);
    expect([...model.terrain.elevations]).toEqual(before.elevations);
  });
});

describe("ReportError", () => {
  it("NO_ACTIVE_ANALYSIS sin análisis", () => {
    expectReportError(() => captureReportInputs(), "NO_ACTIVE_ANALYSIS");
  });

  it("TRANSITION con una transición o carga en curso", () => {
    setHistory([0]);
    useAnalysisStore.setState({ terrainTransitioning: true });
    expectReportError(() => captureReportInputs(), "TRANSITION");
    useAnalysisStore.setState({ terrainTransitioning: false });
    useTerrainStore.setState({ loading: true });
    expectReportError(() => captureReportInputs(), "TRANSITION");
  });

  it("STALE con un resultado obsoleto", () => {
    setHistory([0, 1]);
    useTerrainStore.setState({ terrainKey: { ...KEY, epoch: KEY.epoch + 1 } });
    expectReportError(() => captureReportInputs(), "STALE");
    setHistory([0, 1]);
    const inputs = captureReportInputs();
    const old = { ...entriesOf(inputs)[1]!, terrain_epoch: KEY.epoch - 1 };
    const source = { kind: "history" as const, entries: [entriesOf(inputs)[0]!, old] };
    expectReportError(() => buildReportModel({ ...inputs, source }), "STALE");
  });

  it("MISSING_RADAR_RESULT con un ID faltante", () => {
    setHistory([0, 1, 2]);
    const inputs = captureReportInputs();
    const entries = entriesOf(inputs);
    const error = expectReportError(
      () => buildReportModel({ ...inputs, source: { kind: "history", entries: [entries[0]!, entries[2]!] } }),
      "MISSING_RADAR_RESULT");
    expect(error.message).toContain("Radar 2");
    const deployed = setMulti(3);
    useAnalysisStore.setState({ deployedRadars: deployed.map((radar, index) => index === 2 ? { ...radar, result: undefined } : radar) });
    expectReportError(() => build(), "MISSING_RADAR_RESULT");
  });

  it("MISMATCHED_RADAR_RESULT con un orden distinto", () => {
    setHistory([0, 1, 2]);
    const inputs = captureReportInputs();
    const entries = entriesOf(inputs);
    expectReportError(
      () => buildReportModel({ ...inputs, source: { kind: "history", entries: [entries[1]!, entries[0]!, entries[2]!] } }),
      "MISMATCHED_RADAR_RESULT");
    const deployed = setMulti(3);
    useAnalysisStore.setState({ deployedRadars: [deployed[1]!, deployed[0]!, deployed[2]!] });
    expectReportError(() => build(), "MISMATCHED_RADAR_RESULT");
  });

  it("MISMATCHED_RADAR_RESULT si la unión publicada no es la de los resultados", () => {
    const deployed = setMulti(3);
    useAnalysisStore.setState({ deployedRadars: deployed.map((radar, index) => index === 0 ? { ...radar, result: losFor(1) } : radar) });
    expectReportError(() => build(), "MISMATCHED_RADAR_RESULT");
  });

  it("TOO_MANY_RADARS con 9 radares", () => {
    setMulti(9);
    expectReportError(() => build(), "TOO_MANY_RADARS");
    setMulti(8);
    expect(build().radars).toHaveLength(8);
  });

  it("INVALID_QUALITY_CONTEXT con un resultado sin modelo de calidad", () => {
    setTerrain();
    const entry = historyEntry(0);
    delete entry.result.quality_model;
    useAnalysisStore.setState({ history: [entry] });
    useAnalysisStore.getState().toggleHistoryEntrySelection(0);
    expectReportError(() => build(), "INVALID_QUALITY_CONTEXT");
  });
});

describe("guardas de vigencia equivalentes a isCurrentExport", () => {
  const sample: LOSResponse = {
    shadow_grid: [[false]], cell_states: new Uint8Array([5]), grid_rows: 1, grid_cols: 1, resolution: 1,
    coverage_polygon: [[0, 0]], coverage_pct: 100, completeness_pct: 100, visible_area_m2: 1, shadow_zones: [],
  };
  const snap: AnalysisSnapshot = Object.freeze({
    terrainKey: Object.freeze({ terrain_id: "t1", epoch: 1 }), analysisId: "job", sourceAnalysisIds: ["job"],
    generation: 1, radars: [{ radarId: "m", radarModelId: "m", position: { x: 0, y: 0, z: 0 }, overrides: NO_OVERRIDES }],
  });
  const meta = (id: string) => ({ terrain_id: id, bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 }, resolution: 1, grid_rows: 1, grid_cols: 1 });
  const perturbations: Array<[string, () => void]> = [
    ["sin cambios", () => undefined],
    ["transición", () => useAnalysisStore.setState({ terrainTransitioning: true })],
    ["época del análisis", () => useAnalysisStore.setState({ terrainKey: { terrain_id: "t1", epoch: 2 } })],
    ["clave del análisis nula", () => useAnalysisStore.setState({ terrainKey: null })],
    ["época del terreno", () => useTerrainStore.setState({ terrainKey: { terrain_id: "t1", epoch: 2 } })],
    ["id del terreno", () => useTerrainStore.setState({ terrainKey: { terrain_id: "t2", epoch: 1 } })],
    ["id de la metadata", () => useTerrainStore.setState({ metadata: meta("t2") })],
    ["metadata nula", () => useTerrainStore.setState({ metadata: null })],
    ["otro snapshot", () => useAnalysisStore.setState({ activeSnapshot: { ...snap } })],
    ["otro resultado", () => useAnalysisStore.setState({ losResult: { ...sample } })],
  ];

  it.each(perturbations)("%s", async (_label, perturb) => {
    useAnalysisStore.setState({ losResult: sample, activeSnapshot: snap, terrainKey: { terrain_id: "t1", epoch: 1 }, terrainTransitioning: false });
    useTerrainStore.setState({ metadata: meta("t1"), grid: [[0]], terrainKey: { terrain_id: "t1", epoch: 1 }, loading: false });
    let resolveExport!: (blob: Blob) => void;
    const delayed = new Promise<Blob>((resolve) => { resolveExport = resolve; });
    const exporter = vi.spyOn(api, "exportPDF").mockReturnValue(delayed);
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:export");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(createElement(ExportPanel));
    fireEvent.click(screen.getByRole("button", { name: /pdf técnico/i }));
    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    let expected = false;
    await act(async () => {
      perturb();
      expected = isCurrentReportState(
        { analysis: useAnalysisStore.getState(), terrain: useTerrainStore.getState() }, snap, sample);
      resolveExport(new Blob(["pdf"]));
      await delayed;
    });
    // The real panel's post-await guard and ours agree for each clause.
    expect(download.mock.calls.length > 0).toBe(expected);
    expect(expected).toBe(_label === "sin cambios");
    // Capture fails on the same clauses (identity clauses capture the new pair instead).
    if (!_label.startsWith("otro")) {
      let captured = true;
      try { captureReportInputs(); } catch (error) {
        captured = false;
        expect(["STALE", "TRANSITION"]).toContain((error as ReportError).code);
      }
      expect(captured).toBe(expected);
    }
  });
});

describe("cota bilineal", () => {
  const grid = [[0, 10, 20], [100, 110, Number.NaN]];
  const bounds = { min_x: 1000, min_y: 2000 };
  const z = (x: number, y: number) => bilinearGroundZ(grid, bounds, 5, x, y);

  it("esquinas, bordes y centro", () => {
    expect(z(1000, 2000)).toBe(0);
    expect(z(1010, 2000)).toBe(20);
    expect(z(1000, 2005)).toBe(100);
    expect(z(1005, 2005)).toBe(110);
    expect(z(1002.5, 2000)).toBe(5);
    expect(z(1000, 2002.5)).toBe(50);
    expect(z(1002.5, 2002.5)).toBe(55);
    // Within the edge snap the last node still counts as inside.
    expect(z(1010 + 1e-12, 2000)).toBe(20);
  });

  it("NaN en una esquina usada o fuera de la grilla da null", () => {
    expect(z(1007.5, 2002.5)).toBeNull();
    expect(z(1010, 2005)).toBeNull();
    expect(z(1010, 2002.5)).toBeNull();
    expect(z(999.9, 2000)).toBeNull();
    expect(z(1000, 2005.1)).toBeNull();
    expect(z(Number.NaN, 2000)).toBeNull();
  });
});

describe("precedencia de parámetros fijada contra services/api.ts", () => {
  it("el código de runLOSAnalysis mantiene la precedencia replicada", () => {
    const sources = import.meta.glob(["../services/api.ts"], { query: "?raw", import: "default", eager: true });
    const source = Object.values(sources)[0] as string;
    for (const line of [
      "if (req.range_max_m !== undefined) effectiveRadar.max_range_m = req.range_max_m;",
      "if (req.az_center_deg !== undefined || req.az_width_deg !== undefined) {",
      "const center = req.az_center_deg !== undefined ? req.az_center_deg : 0;",
      "const width = req.az_width_deg !== undefined ? req.az_width_deg : radar.h_beam_width_deg;",
      "effectiveRadar.azimuth_range_deg = normalizeAzimuthRange(center, width);",
    ]) expect(source).toContain(line);
    // The store passes null overrides as undefined, so null means "use the catalog".
    const store = Object.values(import.meta.glob(["../store/analysisStore.ts"], { query: "?raw", import: "default", eager: true }))[0] as string;
    expect(store).toContain("range_max_m: snapshot.overrides.rangeMax ?? undefined,");
    expect(store).toContain("az_center_deg: snapshot.overrides.azCenter ?? undefined,");
  });

  it("resuelve catálogo, overrides y valores desconocidos", () => {
    const o = (patch: Partial<AnalysisRadarOverrides>) => ({ ...NO_OVERRIDES, ...patch });
    expect(resolveRadarParameters("groundprobe-ssr-fx", NO_OVERRIDES, catalog))
      .toEqual({ modelName: "GroundProbe SSR-FX", rangeM: 2500, azimuthDeg: 0, apertureDeg: 150 });
    expect(resolveRadarParameters("groundprobe-ssr-fx", o({ azCenter: 45 }), catalog))
      .toMatchObject({ azimuthDeg: 45, apertureDeg: 150 });
    expect(resolveRadarParameters("ibis-arcsar360", o({ azCenter: 10 }), catalog))
      .toMatchObject({ azimuthDeg: null, apertureDeg: 360 });
    expect(resolveRadarParameters("ibis-arcsar360", o({ azWidth: 120 }), catalog))
      .toMatchObject({ azimuthDeg: 0, apertureDeg: 120 });
    expect(resolveRadarParameters("desconocido", o({ rangeMax: 800 }), catalog))
      .toEqual({ modelName: null, rangeM: 800, azimuthDeg: null, apertureDeg: null });
    expect(resolveRadarParameters("desconocido", o({ azCenter: 30, azWidth: 60 }), catalog))
      .toMatchObject({ azimuthDeg: 30, apertureDeg: 60 });
  });
});

describe("tipo ReportInputs", () => {
  it("captura la fuente correcta según la ruta", () => {
    setHistory([0, 2]);
    const fromHistory: ReportInputs = captureReportInputs();
    expect(fromHistory.source.kind).toBe("history");
    setMulti(2);
    expect(captureReportInputs().source.kind).toBe("multi");
  });
});


describe("reportStateSignature", () => {
  it("compara la captura real del historial con el estado vivo y detecta edición de área", async () => {
    const { reportStateSignature } = await import("./reportModel");
    setHistory([0, 1, 2]);
    setAoi();
    const inputs = captureReportInputs();
    const captured = reportStateSignature(inputs);
    expect(captured).toBe(reportStateSignature());
    const area = useAoiStore.getState();
    useAoiStore.setState({ polygon: { vertices: area.polygon!.vertices.map((p, i) => i ? p : { ...p, x: p.x + 1 }) } });
    expect(reportStateSignature()).not.toBe(captured);
  });
  it("detecta alteraciones y reordenamiento de radares desplegados", async () => {
    const { reportStateSignature } = await import("./reportModel");
    const deployed = setMulti(3);
    const captured = reportStateSignature(captureReportInputs());
    expect(reportStateSignature()).toBe(captured);
    useAnalysisStore.setState({ deployedRadars: [{ ...deployed[0]!, color: "#123456" }, ...deployed.slice(1)] });
    expect(reportStateSignature()).not.toBe(captured);
    useAnalysisStore.setState({ deployedRadars: [...deployed].reverse() });
    expect(reportStateSignature()).not.toBe(captured);
  });
  it("detecta el reordenamiento de los identificadores del historial", async () => {
    const { reportStateSignature } = await import("./reportModel");
    setHistory([0, 1, 2]);
    const captured = reportStateSignature(captureReportInputs());
    useAnalysisStore.setState({ history: [...useAnalysisStore.getState().history].reverse() });
    expect(reportStateSignature()).not.toBe(captured);
  });
});
