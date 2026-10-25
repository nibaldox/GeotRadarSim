/**
 * Tests for ExportPanel component.
 *
 * Tests that export buttons render with correct enabled/disabled states
 * based on whether analysis has been run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportPanel } from "../components/ExportPanel";
import { TerrainViewer } from "../components/TerrainViewer";

vi.mock("@react-three/fiber", async () => {
  const React = await import("react");
  return {
    Canvas: ({ children }: { children: import("react").ReactNode }) => React.createElement(
      "div",
      { "data-testid": "webgl-canvas" },
      React.createElement("canvas", { "data-testid": "webgl-capture-canvas" }),
      React.createElement("div", { "data-testid": "terrain-scene" }, children),
    ),
    useThree: () => ({
      camera: {
        position: { set: () => undefined },
        lookAt: () => undefined,
        updateProjectionMatrix: () => undefined,
      },
    }),
  };
});

vi.mock("@react-three/drei", async () => {
  return {
    OrbitControls: () => null,
    GizmoHelper: () => null,
    GizmoViewport: () => null,
  };
});
import { useAnalysisStore } from "../store/analysisStore";
import type { HistoryEntry } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import type { AnalysisSnapshot } from "../types/api";
import * as api from "../services/api";
import type { LOSResponse } from "../types/api";

beforeEach(() => {
  useAnalysisStore.setState({
    losResult: null,
    activeSnapshot: null,
    terrainKey: null,
    terrainTransitioning: false,
    loading: false,
    error: null,
    radars: [],
    selectedRadarId: null,
    radarPosition: null,
  });
  useQualityPolicyStore.getState().resetPolicy();
  useVectorStore.setState({ sensitivityMap: null, visualizationMode: "QUALITY", loading: false, error: null });
  useTerrainStore.setState({
    metadata: null,
    grid: null,
    terrainKey: null,
    terrainEpoch: 0,
    loading: false,
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sampleLOS: LOSResponse = {
  shadow_grid: [[false]],
  cell_states: new Uint8Array([5]),
  grid_rows: 1,
  grid_cols: 1,
  resolution: 1,
  coverage_polygon: [[0, 0]],
  coverage_pct: 100,
  completeness_pct: 100,
  visible_area_m2: 1,
  shadow_zones: [],
};

const exportSnapshot: AnalysisSnapshot = Object.freeze({
  terrainKey: Object.freeze({ terrain_id: "t1", epoch: 1 }),
  analysisId: "job-original",
  sourceAnalysisIds: Object.freeze(["job-original"]),
  generation: 7,
  radars: Object.freeze([Object.freeze({
    radarId: "groundprobe-ssr-fx",
    radarModelId: "groundprobe-ssr-fx",
    position: Object.freeze({ x: 10, y: 20, z: 3 }),
    overrides: Object.freeze({ rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null }),
  })]),
});

const multiRadarSnapshot: AnalysisSnapshot = Object.freeze({
  ...exportSnapshot,
  radars: Object.freeze([
    Object.freeze({ ...exportSnapshot.radars[0]!, radarId: "radar-east", position: Object.freeze({ x: 11, y: 95, z: 22 }) }),
    Object.freeze({ ...exportSnapshot.radars[0]!, radarId: "radar-west", position: Object.freeze({ x: 14, y: 100, z: 23 }) }),
  ]),
});

function terrainMetadata(terrainId: string) {
  return {
    terrain_id: terrainId,
    bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
    resolution: 1,
    grid_rows: 1,
    grid_cols: 1,
  };
}

function setExportableAnalysis(snapshot = exportSnapshot, result = sampleLOS) {
  const radar = snapshot.radars[0]!;
  useAnalysisStore.setState({
    losResult: result,
    activeSnapshot: snapshot,
    terrainKey: snapshot.terrainKey,
    terrainTransitioning: false,
    selectedRadarId: radar.radarModelId,
    radarPosition: radar.position,
  });
  useTerrainStore.setState({
    metadata: terrainMetadata(snapshot.terrainKey.terrain_id),
    grid: [[0]],
    terrainKey: snapshot.terrainKey,
    terrainEpoch: snapshot.terrainKey.epoch,
  });
}

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
    setExportableAnalysis();
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
    setExportableAnalysis();
    useTerrainStore.setState({
      metadata: { terrain_id: "t1", bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 }, resolution: 1, grid_rows: 1, grid_cols: 1 },
    });

    render(<ExportPanel />);

    expect(screen.getByText(/Visibilidad \(candidatos\):/).parentElement).toHaveTextContent("100.0%");
  });

  it("shows no-data instead of zero coverage for an empty candidate set", () => {
    setExportableAnalysis(exportSnapshot, { ...sampleLOS, coverage_pct: null, completeness_pct: null } as LOSResponse);
    useTerrainStore.setState({
      metadata: { terrain_id: "t1", bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 }, resolution: 1, grid_rows: 1, grid_cols: 1 },
    });

    render(<ExportPanel />);

    expect(screen.getAllByText("Sin datos")).toHaveLength(2);
    expect(screen.queryByText(/0\.0%/)).not.toBeInTheDocument();
  });

  it("shows no-data message when analysis has not been run", () => {
    render(<ExportPanel />);

    expect(screen.getByText(/no analysis data/i)).toBeInTheDocument();
  });

  it("rejects an A snapshot on terrain B even when both terrains have identical grid dimensions", () => {
    setExportableAnalysis();
    const terrainB = { terrain_id: "t2", epoch: 2 };
    useAnalysisStore.setState({ terrainKey: terrainB });
    useTerrainStore.setState({
      metadata: terrainMetadata("t2"),
      terrainKey: terrainB,
      terrainEpoch: 2,
    });

    render(<ExportPanel />);

    expect(screen.getByRole("button", { name: /pdf report/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /csv data/i })).toBeDisabled();
  });

  it.each([
    ["PDF", "exportPDF", /pdf report/i, "coverage-report-t1.pdf"],
    ["CSV", "exportCSV", /csv data/i, "coverage-data-t1.csv"],
  ] as const)("exports %s from the immutable analysis snapshot", async (_label, method, buttonName, expectedFilename) => {
    const exporter = vi.spyOn(api, method).mockResolvedValue(new Blob(["export"]));
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:export");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const downloadedFilenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilenames.push(this.download);
    });
    setExportableAnalysis();

    render(<ExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    const [exportedSnapshot, exportedResult] = exporter.mock.calls[0]!;
    expect(exportedSnapshot).toEqual(exportSnapshot);
    expect(exportedSnapshot).not.toBe(exportSnapshot);
    expect(exportedResult).toBe(sampleLOS);
    await waitFor(() => expect(downloadedFilenames).toEqual([expectedFilename]));
  });

  it.each([
    ["PDF", "exportPDF", /pdf report/i, "coverage-report-t1.pdf"],
    ["CSV", "exportCSV", /csv data/i, "coverage-data-t1.csv"],
  ] as const)("exports the restored history snapshot for %s", async (_label, method, buttonName, expectedFilename) => {
    const exporter = vi.spyOn(api, method).mockResolvedValue(new Blob(["restored export"]));
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:restored");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const downloadedFilenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilenames.push(this.download);
    });
    const historyEntry: HistoryEntry = {
      position: { x: 10, y: 20, z: 3 },
      coveragePct: sampleLOS.coverage_pct,
      timestamp: "saved",
      result: sampleLOS,
      radarId: "groundprobe-ssr-fx",
      selected: false,
      terrain_id: "t1",
      terrain_epoch: 1,
      snapshot: exportSnapshot,
    };
    useAnalysisStore.setState({
      history: [historyEntry],
      terrainKey: exportSnapshot.terrainKey,
      terrainTransitioning: false,
      selectedRadarId: "groundprobe-ssr-fx",
      radarPosition: { x: 99, y: 98, z: 7 },
    });
    useTerrainStore.setState({
      metadata: terrainMetadata("t1"),
      grid: [[0]],
      terrainKey: exportSnapshot.terrainKey,
      terrainEpoch: 1,
    });

    useAnalysisStore.getState().selectRadar("radar-B");
    expect(useAnalysisStore.getState().activeSnapshot).toBeNull();
    useAnalysisStore.getState().restoreHistoryEntry(0);
    expect(useAnalysisStore.getState().activeSnapshot).toBe(exportSnapshot);
    expect(useAnalysisStore.getState().selectedRadarId).toBe("groundprobe-ssr-fx");

    render(<ExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    const [exportedSnapshot, exportedResult] = exporter.mock.calls[0]!;
    expect(exportedSnapshot).toEqual(exportSnapshot);
    expect(exportedSnapshot).not.toBe(exportSnapshot);
    expect(exportedResult).toBe(sampleLOS);
    await waitFor(() => expect(downloadedFilenames).toEqual([expectedFilename]));
  });

  it.each([
    ["PDF", "exportPDF", /pdf report/i],
    ["CSV", "exportCSV", /csv data/i],
  ] as const)("does not download %s if terrain changes while the export is pending", async (_label, method, buttonName) => {
    let resolveExport!: (blob: Blob) => void;
    const delayed = new Promise<Blob>((resolve) => { resolveExport = resolve; });
    const exporter = vi.spyOn(api, method).mockReturnValue(delayed);
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:export");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    setExportableAnalysis();
    render(<ExportPanel />);

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());

    await act(async () => {
      useAnalysisStore.getState().beginTerrainTransition();
      useAnalysisStore.getState().activateTerrain({ terrain_id: "t2", epoch: 2 });
      useTerrainStore.setState({
        metadata: terrainMetadata("t2"),
        grid: [[0]],
        terrainKey: { terrain_id: "t2", epoch: 2 },
        terrainEpoch: 2,
      });
      resolveExport(new Blob(["late export"]));
      await delayed;
    });

    expect(click).not.toHaveBeenCalled();
    expect(MockURL.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not download an image captured from a stale terrain snapshot", async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:image");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    setExportableAnalysis();
    const canvas = document.createElement("canvas");
    let imageCallback: BlobCallback | null = null;
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback) => { imageCallback = callback; },
    });
    document.body.appendChild(canvas);
    render(<ExportPanel />);

    fireEvent.click(screen.getByRole("button", { name: /image \(png\)/i }));
    expect(imageCallback).toBeTypeOf("function");
    await act(async () => {
      useAnalysisStore.getState().beginTerrainTransition();
      useAnalysisStore.getState().activateTerrain({ terrain_id: "t2", epoch: 2 });
      useTerrainStore.setState({
        metadata: terrainMetadata("t2"),
        grid: [[0]],
        terrainKey: { terrain_id: "t2", epoch: 2 },
        terrainEpoch: 2,
      });
      imageCallback?.(new Blob(["old image"]));
    });

    expect(click).not.toHaveBeenCalled();
    expect(MockURL.createObjectURL).not.toHaveBeenCalled();
    canvas.remove();
  });

  it.each([
    ["PDF", "exportPDF", /pdf report/i],
    ["CSV", "exportCSV", /csv data/i],
  ] as const)("does not download when asynchronous %s export rejects", async (_label, method, buttonName) => {
    const exporter = vi.spyOn(api, method).mockRejectedValue(new Error("export failed"));
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:rejected");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setExportableAnalysis();
    render(<ExportPanel />);

    fireEvent.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    await waitFor(() => expect(alert).toHaveBeenCalledOnce());
    expect(click).not.toHaveBeenCalled();
    expect(MockURL.createObjectURL).not.toHaveBeenCalled();
  });

  it("detaches mutable radar overrides before starting an asynchronous export", async () => {
    let resolveExport!: (blob: Blob) => void;
    const delayed = new Promise<Blob>((resolve) => { resolveExport = resolve; });
    const exporter = vi.spyOn(api, "exportPDF").mockReturnValue(delayed);
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:mutable-snapshot");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const mutableOverrides = { rangeMin: null, rangeMax: 450, elMin: null, elMax: null, azCenter: null, azWidth: null };
    const mutableSnapshot = {
      ...exportSnapshot,
      radars: [{ ...exportSnapshot.radars[0]!, overrides: mutableOverrides }],
    } as unknown as AnalysisSnapshot;
    setExportableAnalysis(mutableSnapshot);
    render(<ExportPanel />);

    fireEvent.click(screen.getByRole("button", { name: /pdf report/i }));
    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    const exportedSnapshot = exporter.mock.calls[0]![0];
    mutableOverrides.rangeMax = 900;

    expect(exportedSnapshot).not.toBe(mutableSnapshot);
    expect(exportedSnapshot.radars[0]!.overrides).not.toBe(mutableOverrides);
    expect(exportedSnapshot.radars[0]!.overrides.rangeMax).toBe(450);
    resolveExport(new Blob(["detached export"]));
    await waitFor(() => expect(MockURL.createObjectURL).toHaveBeenCalledOnce());
  });

  it("does not download a deferred PNG after the placed radar changes", async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:stale-radar-image");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    setExportableAnalysis();
    const canvas = document.createElement("canvas");
    let imageCallback: BlobCallback | null = null;
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback) => { imageCallback = callback; },
    });
    document.body.appendChild(canvas);
    render(<ExportPanel />);

    fireEvent.click(screen.getByRole("button", { name: /image \(png\)/i }));
    expect(imageCallback).toBeTypeOf("function");
    useAnalysisStore.getState().setRadarPosition({ x: 15, y: 25, z: 5 });
    await act(async () => imageCallback?.(new Blob(["stale radar image"])));

    expect(click).not.toHaveBeenCalled();
    expect(MockURL.createObjectURL).not.toHaveBeenCalled();
    canvas.remove();
  });

  it("captures both radar markers from the multi-radar snapshot in the PNG scene", async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:multi-radar-image");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const downloadedFilenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilenames.push(this.download);
    });
    setExportableAnalysis(multiRadarSnapshot);
    const radarEast = multiRadarSnapshot.radars[0]!;
    useAnalysisStore.setState({
      history: [{
        position: { ...radarEast.position },
        coveragePct: sampleLOS.coverage_pct,
        timestamp: "selected-network-history",
        result: sampleLOS,
        radarId: radarEast.radarId,
        selected: true,
        terrain_id: "t1",
        terrain_epoch: 1,
        snapshot: multiRadarSnapshot,
      }],
    });
    useTerrainStore.setState({
      metadata: {
        ...terrainMetadata("t1"),
        bounds: { min_x: 10, min_y: 90, min_z: 20, max_x: 20, max_y: 110, max_z: 30 },
      },
      grid: [[0, 0], [0, 0]],
      terrainKey: multiRadarSnapshot.terrainKey,
      terrainEpoch: 1,
    });

    render(<><TerrainViewer /><ExportPanel /></>);
    const scene = screen.getByTestId("terrain-scene");
    const canvas = screen.getByTestId("webgl-capture-canvas") as HTMLCanvasElement;
    const toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(["multi-radar-png"])));
    Object.defineProperty(canvas, "toBlob", { configurable: true, value: toBlob });

    fireEvent.click(screen.getByRole("button", { name: /image \(png\)/i }));

    const markers = Array.from(scene.querySelectorAll('group[name^="radar-snapshot-"]'));
    expect(markers.map((marker) => [marker.getAttribute("name"), marker.getAttribute("position")])).toEqual([
      ["radar-snapshot-radar-east", "1,2,-5"],
      ["radar-snapshot-radar-west", "4,3,-10"],
    ]);
    expect(scene.querySelectorAll('group[name^="radar-history-"]')).toHaveLength(0);
    expect(scene.querySelector('mesh[name="radar-current-marker"]')).toBeNull();
    expect(scene.querySelectorAll("mesh")).toHaveLength(5);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    await waitFor(() => expect(downloadedFilenames).toEqual(["terrain-snapshot-t1.png"]));
  });
});

// ─── Quality-report context captured at the click (geometric-v2) ────────────

const v2TerrainGrid = [[0, 0, 0], [0, Number.NaN, 0]];

function v2Result(): LOSResponse {
  return {
    shadow_grid: [[false, false, false], [true, false, false]],
    cell_states: new Uint8Array([5, 5, 5, 4, 0, 1]),
    grid_rows: 2,
    grid_cols: 3,
    resolution: 2,
    coverage_polygon: [],
    coverage_pct: 80,
    completeness_pct: 82.5,
    visible_area_m2: 12,
    shadow_zones: [{ zone_id: 1, cell_count: 1 }],
    quality_grid: [[0, 0.5, 0], [0, 0, 0]],
    flat_quality_grid: new Float32Array([0, 0.5, Number.NaN, -1, -1, -1]),
    flat_projection_grid: new Float32Array([Number.NaN, 0.8, 0.25, Number.NaN, Number.NaN, Number.NaN]),
    quality_model: "geometric-v2",
  };
}

function setV2ExportableAnalysis(result = v2Result()) {
  useAnalysisStore.setState({
    losResult: result,
    activeSnapshot: exportSnapshot,
    terrainKey: exportSnapshot.terrainKey,
    terrainTransitioning: false,
    selectedRadarId: "groundprobe-ssr-fx",
    radarPosition: exportSnapshot.radars[0]!.position,
  });
  useTerrainStore.setState({
    metadata: {
      terrain_id: "t1",
      bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
      resolution: 2,
      grid_rows: 2,
      grid_cols: 3,
    },
    grid: v2TerrainGrid,
    terrainKey: exportSnapshot.terrainKey,
    terrainEpoch: 1,
  });
}

describe("ExportPanel quality context", () => {
  it("captures metric, policy and summary at click time, before the export resolves", async () => {
    let resolveExport!: (blob: Blob) => void;
    const delayed = new Promise<Blob>((resolve) => { resolveExport = resolve; });
    const exporter = vi.spyOn(api, "exportPDF").mockReturnValue(delayed);
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => "blob:quality-context");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.4, highMin: 0.8 });
    useVectorStore.setState({ visualizationMode: "SENSITIVITY" });
    setV2ExportableAnalysis();

    render(<ExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /pdf report/i }));
    await waitFor(() => expect(exporter).toHaveBeenCalledOnce());

    // policy edits after the click must never reach the captured report
    useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.1, highMin: 0.2 });

    const context = exporter.mock.calls[0]![2];
    expect(context).toBeDefined();
    expect(context!.metric).toBe("PROJECTION");
    expect(context!.policy).toEqual({ mediumMin: 0.4, highMin: 0.8 });
    expect(context!.summary.policy).toEqual({ mediumMin: 0.4, highMin: 0.8 });
    expect(context!.summary.metric).toBe("PROJECTION");
    expect(context!.target.label).toBe("Topografía válida completa");
    expect(context!.target.cellCount).toBe(5);
    expect(context!.summary.visibleCount).toBe(3);
    expect(context!.summary.usefulCount).toBe(1);
    expect(context!.terrainKey).toEqual({ terrain_id: "t1", epoch: 1 });
    expect(context!.sourceAnalysisIds).toEqual(["job-original"]);

    resolveExport(new Blob(["late quality export"]));
    await waitFor(() => expect(MockURL.createObjectURL).toHaveBeenCalledOnce());
  });

  it("downloads the CSV with the useful-coverage report through the real export path", async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn((_blob: Blob) => "blob:real-csv");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    const downloadedFilenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilenames.push(this.download);
    });
    setV2ExportableAnalysis();

    render(<ExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /csv data/i }));

    await waitFor(() => expect(MockURL.createObjectURL).toHaveBeenCalledOnce());
    const blob = MockURL.createObjectURL.mock.calls[0]![0] as Blob;
    const csv = await blob.text();
    expect(csv).toContain("# Informe de calidad (cobertura útil)");
    expect(csv).toContain("# Métrica del índice,Incidencia superficial");
    expect(csv).toContain("# Cobertura útil %,20.00");
    expect(csv).toContain("row,col,state,incidence,projection,shadowed");
    await waitFor(() => expect(downloadedFilenames).toEqual(["coverage-data-t1.csv"]));
  });

  it("exports the projection metric when the sensitivity layer is selected", async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn((_blob: Blob) => "blob:projection-csv");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    useVectorStore.setState({ visualizationMode: "SENSITIVITY" });
    setV2ExportableAnalysis();

    render(<ExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /csv data/i }));

    await waitFor(() => expect(MockURL.createObjectURL).toHaveBeenCalledOnce());
    const csv = await (MockURL.createObjectURL.mock.calls[0]![0] as Blob).text();
    expect(csv).toContain("# Métrica del índice,Proyección del movimiento");
    expect(csv).toContain("# Distribución alta %,33.33 (1)");
    expect(csv).toContain("# Sin índice %,33.33 (1)");
  });

  it("downloads the legacy report without inventing a quality summary for unversioned results", async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn((_blob: Blob) => "blob:legacy-csv");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", MockURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    setExportableAnalysis();

    render(<ExportPanel />);
    expect(screen.getByText(/no incluyen cobertura útil/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /csv data/i }));

    await waitFor(() => expect(MockURL.createObjectURL).toHaveBeenCalledOnce());
    const csv = await (MockURL.createObjectURL.mock.calls[0]![0] as Blob).text();
    expect(csv).toContain("row,col,state,quality,shadowed");
    expect(csv).toContain("# Visibilidad (candidatos) %,100.00");
    expect(csv).not.toContain("# Informe de calidad");
    expect(csv).not.toContain("# Cobertura útil %");
  });

  it("tells the user the PDF/CSV reports include useful coverage for v2 results", () => {
    setV2ExportableAnalysis();
    render(<ExportPanel />);
    expect(screen.getByText(/incluyen cobertura útil/i)).toBeInTheDocument();
  });
});
