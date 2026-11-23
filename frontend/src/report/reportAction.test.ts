import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useVectorStore } from "../store/vectorStore";
import { useAoiStore } from "../store/aoiStore";
import { reportFixture3 } from "./fixtures";
import * as modelModule from "./reportModel";
import * as coverModule from "./reportCover3d";
import * as rasterModule from "./reportRaster";
import { prepareManagementReport } from "./reportAction";
import type { ReportInputs } from "./reportModel";

const model = { ...reportFixture3(), createdAtIso: new Date(2026, 10, 22, 9, 5).toISOString() };
const key = { terrain_id: "privado-123", epoch: 1 };
const snapshot = { terrainKey: key } as ReportInputs["snapshot"];
const result = {} as ReportInputs["result"];
const cover = { format: "PNG" as const, bytes: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNImXYCAAMkAcMgVWSjAAAAAElFTkSuQmCC"), c => c.charCodeAt(0)), width: 1, height: 1 };

function setup() {
  useAnalysisStore.setState({ activeSnapshot: snapshot, losResult: result, terrainKey: key, terrainTransitioning: false, loading: false, multiLoading: false });
  useTerrainStore.setState({ terrainKey: key, metadata: { terrain_id: key.terrain_id } as never, loading: false });
  vi.spyOn(modelModule, "captureReportInputs").mockReturnValue({ snapshot, result } as ReportInputs);
  vi.spyOn(modelModule, "buildReportModel").mockReturnValue(model);
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("prepareManagementReport", () => {
  it("genera PDF con raster real y portada simulada, con nombre sin datos privados", async () => {
    setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 22, 9, 5));
    vi.spyOn(coverModule, "renderReportCover3d").mockResolvedValue(cover);
    const raster = vi.spyOn(rasterModule, "renderReportRaster");
    const prepared = await prepareManagementReport({ title: "Reunión" });
    expect(modelModule.buildReportModel).toHaveBeenCalledWith(expect.anything(), { title: "Reunión" });
    expect(prepared.blob.type).toBe("application/pdf");
    expect(prepared.blob.size).toBeGreaterThan(1000);
    expect(prepared.filename).toBe("informe-reunion-2026-11-22-0905.pdf");
    expect(raster).toHaveBeenCalled();
  });
  it("usa mapa 2D y no expone el error si falla la portada", async () => {
    setup();
    vi.spyOn(coverModule, "renderReportCover3d").mockRejectedValue(new Error("terreno secreto"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raster = vi.spyOn(rasterModule, "renderReportRaster");
    const prepared = await prepareManagementReport({});
    expect(prepared.blob.type).toBe("application/pdf");
    expect(raster.mock.calls.length).toBeGreaterThan(model.radars.length);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("terreno secreto");
    expect(warn).toHaveBeenCalledOnce();
  });
  it.each(["snapshot", "result", "transition", "loading"])("rechaza el informe si cambia %s durante la portada", async (change) => {
    setup();
    let resolve!: (image: typeof cover) => void;
    vi.spyOn(coverModule, "renderReportCover3d").mockReturnValue(new Promise((r) => { resolve = r; }));
    const promise = prepareManagementReport({});
    if (change === "snapshot") useAnalysisStore.setState({ activeSnapshot: { ...snapshot } });
    if (change === "result") useAnalysisStore.setState({ losResult: { ...result } });
    if (change === "transition") useAnalysisStore.setState({ terrainTransitioning: true });
    if (change === "loading") useAnalysisStore.setState({ loading: true });
    resolve(cover);
    await expect(promise).rejects.toMatchObject({ code: "STALE" });
  });
});


it("integra captura y modelo reales con raster y portada simulada", async () => {
  const terrain = model.terrain;
  const radar = model.radars[0]!;
  const states = radar.cellStates.slice();
  const quality = radar.qualityValues!.slice();
  const los = {
    shadow_grid: Array.from({ length: terrain.rows }, (_, r) => Array.from({ length: terrain.cols }, (_, c) => states[r * terrain.cols + c] === 4)),
    cell_states: states, grid_rows: terrain.rows, grid_cols: terrain.cols, resolution: terrain.resolution,
    coverage_polygon: [], coverage_pct: radar.metrics.visiblePct, completeness_pct: 100,
    visible_area_m2: radar.metrics.visibleAreaM2, shadow_zones: [], quality_model: "geometric-v2",
    flat_quality_grid: quality, flat_projection_grid: quality,
  } as ReportInputs["result"];
  const overrides = { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null };
  const active = { terrainKey: key, analysisId: "job-1", sourceAnalysisIds: ["job-1"], generation: 1,
    radars: [{ radarId: "r1", radarModelId: "model", position: radar.position, overrides }] };
  useAnalysisStore.setState({ activeSnapshot: active, losResult: los, terrainKey: key, terrainTransitioning: false,
    loading: false, multiLoading: false, unifiedLos: null, deployedRadars: [], radars: [],
    history: [{ position: radar.position, coveragePct: los.coverage_pct, timestamp: "", result: los, radarId: "r1",
      selected: true, terrain_id: key.terrain_id, terrain_epoch: key.epoch, snapshot: active }] });
  useTerrainStore.setState({ terrainKey: key, loading: false,
    metadata: { terrain_id: key.terrain_id, bounds: terrain.bounds, resolution: terrain.resolution, grid_rows: terrain.rows, grid_cols: terrain.cols },
    grid: Array.from({ length: terrain.rows }, (_, r) => Array.from({ length: terrain.cols }, (_, c) => terrain.elevations[r * terrain.cols + c]!)) });
  vi.spyOn(coverModule, "renderReportCover3d").mockResolvedValue(cover);
  const output = await prepareManagementReport({ title: "Reunión" });
  expect(output.blob.type).toBe("application/pdf");
  expect(output.blob.size).toBeGreaterThan(1000);
});


describe("vigencia del contexto durante la portada", () => {
  it.each(["política", "métrica", "área", "historial", "radares desplegados"])("rechaza cambios de %s", async (change) => {
    setup();
    useQualityPolicyStore.getState().resetPolicy();
    useVectorStore.setState({ visualizationMode: "QUALITY" });
    useAoiStore.getState().clear();
    useAnalysisStore.setState({ history: [], deployedRadars: [], unifiedLos: change === "radares desplegados" ? result : null });
    let resolve!: (image: typeof cover) => void;
    vi.spyOn(coverModule, "renderReportCover3d").mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = prepareManagementReport({});
    if (change === "política") useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.4, highMin: 0.8 });
    if (change === "métrica") useVectorStore.setState({ visualizationMode: "SENSITIVITY" });
    if (change === "área") useAoiStore.setState({ polygon: { vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }, terrainKey: key });
    if (change === "historial") useAnalysisStore.setState({ history: [{ selected: true, snapshot: { analysisId: "new", sourceAnalysisIds: ["new"] } } as never] });
    if (change === "radares desplegados") useAnalysisStore.setState({ deployedRadars: [{ id: "new", modelId: "m", color: "#ffffff", position: { x: 0, y: 0, z: 0 }, result }] });
    resolve(cover);
    await expect(pending).rejects.toMatchObject({ code: "STALE" });
  });
});


it("usa la misma fecha local en portada, anexo y nombre del archivo", async () => {
  setup();
  const instant = new Date(2026, 10, 22, 23, 30);
  vi.mocked(modelModule.buildReportModel).mockReturnValue({ ...model, createdAtIso: instant.toISOString() });
  vi.spyOn(coverModule, "renderReportCover3d").mockResolvedValue(cover);
  const prepared = await prepareManagementReport({});
  const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  expect(prepared.filename).toBe("informe-reunion-2026-11-22-2330.pdf");
  expect(text.match(/22 de noviembre de 2026/g)).toHaveLength(2);
  expect(text).not.toContain("23 de noviembre de 2026");
});
