import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { ExportPanel } from "../components/ExportPanel";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { prepareExport, ExportError, isCurrentExport } from "./exportActions";
import * as api from "./api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

// Captured from the original ExportPanel on commit 98ad400 with the same fixture and clock.
const baselineCSV = "IyBHZW90UmFkYXJTaW0g4oCUIENvdmVyYWdlIEFuYWx5c2lzCiMgR2VuZXJhdGVkLGZpeGVkIGV4cG9ydCB0aW1lCiMgVGVycmFpbiBJRCx0MQojIFRlcnJhaW4gRXBvY2gsMQojIEFuYWx5c2lzIElELGpvYi1vcmlnaW5hbAojIEFuYWx5c2lzIEdlbmVyYXRpb24sNwojIFJhZGFyIElELHJhZGFyCiMgUmFkYXIgTW9kZWwscmFkYXIKIyBSYWRhciBQb3NpdGlvbiBYLDEwLjAwMAojIFJhZGFyIFBvc2l0aW9uIFksMjAuMDAwCiMgUmFkYXIgUG9zaXRpb24gWiwzLjAwMAojIFZpc2liaWxpZGFkIChjYW5kaWRhdG9zKSAlLDgwLjAwCiMgQ29tcGxldGl0dWQgJSw4Mi41MAojIFZpc2libGUgQXJlYSBtMiwxMi4wMAojIFJlc29sdXRpb24gbSwyLjAwMAojIEdyaWQgRGltZW5zaW9ucywyeDMKIyBTaGFkb3cgWm9uZXMsMQojIFF1YWxpdHkgTW9kZWwsZ2VvbWV0cmljLXYyCgojIEluZm9ybWUgZGUgY2FsaWRhZCAoY29iZXJ0dXJhIMO6dGlsKQojIE1vZGVsbyBkZSBjYWxpZGFkLGdlb21ldHJpYy12MgojIE3DqXRyaWNhIGRlbCDDrW5kaWNlLEluY2lkZW5jaWEgc3VwZXJmaWNpYWwKIyBVbWJyYWxlcyBkZSBjbGFzaWZpY2FjacOzbixtZWRpYSA+PSAwLjM7IGFsdGEgPj0gMC43IChwcm92aXNpb25hbDsgbm8gY2VydGlmaWNhZG8pCiMgUHJlY2lzacOzbiBkZSBjbGFzaWZpY2FjacOzbixGbG9hdDMyICjDrW5kaWNlcyB5IHVtYnJhbGVzOyBjb21wYXJhciBlbiBGbG9hdDMyIHBhcmEgcmVwcm9kdWNpcikKIyBPYmpldGl2byBjb23Dum4sVG9wb2dyYWbDrWEgdsOhbGlkYSBjb21wbGV0YQojIENlbGRhcyBvYmpldGl2byw1CiMgw4FyZWEgbm9taW5hbCBtMiwyMC4wMAojIENvYmVydHVyYSDDunRpbCAlLDIwLjAwCiMgw4FyZWEgw7p0aWwgbTIsNC4wMAojIE1lZGlhICsgYWx0YSBkZSBsbyB2aXNpYmxlICUsMzMuMzMKIyBEaXN0cmlidWNpw7NuIGJhamEgJSwzMy4zMyAoMSkKIyBEaXN0cmlidWNpw7NuIG1lZGlhICUsMzMuMzMgKDEpCiMgRGlzdHJpYnVjacOzbiBhbHRhICUsMC4wMCAoMCkKIyBTaW4gw61uZGljZSAlLDMzLjMzICgxKQojIFZpc2liaWxpZGFkIChjYW5kaWRhdG9zKSAlLDgwLjAwCiMgQ29tcGxldGl0dWQgJSw4Mi41MAoKIyBDZWxsIFN0YXRlcyAocm93LGNvbCxzdGF0ZSxpbmNpZGVuY2UscHJvamVjdGlvbixzaGFkb3dlZCkKIyBpbmNpZGVuY2UvcHJvamVjdGlvbjogc29sbyBjZWxkYXMgVklTSUJMRSBjb24gw61uZGljZSBtZWRpZG87IHZhY8OtbyA9IG5vIHZpc2libGUgbyBzaW4gw61uZGljZTsgdmFsb3JlcyBGbG9hdDMyIGRlIHByZWNpc2nDs24gY29tcGxldGEKcm93LGNvbCxzdGF0ZSxpbmNpZGVuY2UscHJvamVjdGlvbixzaGFkb3dlZAowLDAsVklTSUJMRSwwLCwwCjAsMSxWSVNJQkxFLDAuNSwwLjgsMAowLDIsVklTSUJMRSwsMC4yNSwwCjEsMCxTSEFET1csLCwxCjEsMSxOT0RBVEEsLCwwCjEsMixPVVRfT0ZfUkFOR0UsLCww";
const bytes64 = async (blob: Blob) => btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), (b) => String.fromCharCode(b)).join(""));

const snapshot: AnalysisSnapshot = {
  terrainKey: { terrain_id: "t1", epoch: 1 }, analysisId: "job-original",
  sourceAnalysisIds: ["job-original"], generation: 7,
  radars: [{ radarId: "radar", radarModelId: "radar", position: { x: 10, y: 20, z: 3 },
    overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }],
};
const result: LOSResponse = {
  shadow_grid: [[false, false, false], [true, false, false]], cell_states: new Uint8Array([5, 5, 5, 4, 0, 1]),
  grid_rows: 2, grid_cols: 3, resolution: 2, coverage_polygon: [], coverage_pct: 80,
  completeness_pct: 82.5, visible_area_m2: 12, shadow_zones: [{ zone_id: 1, cell_count: 1 }],
  quality_grid: [[0, 0.5, 0], [0, 0, 0]], flat_quality_grid: new Float32Array([0, 0.5, NaN, -1, -1, -1]),
  flat_projection_grid: new Float32Array([NaN, 0.8, 0.25, NaN, NaN, NaN]), quality_model: "geometric-v2",
};

beforeEach(() => {
  vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("fixed export time");
  useAnalysisStore.setState({ losResult: result, activeSnapshot: snapshot, terrainKey: snapshot.terrainKey, terrainTransitioning: false });
  useTerrainStore.setState({ metadata: { terrain_id: "t1", bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 }, resolution: 2, grid_rows: 2, grid_cols: 3 }, grid: [[0, 0, 0], [0, NaN, 0]], terrainKey: snapshot.terrainKey });
  useVectorStore.setState({ visualizationMode: "QUALITY" });
  useQualityPolicyStore.getState().resetPolicy();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("export actions", () => {
  it("keeps the original CSV bytes through the UI", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", class extends URL { static createObjectURL(blob: Blob) { blobs.push(blob); return "blob:test"; } static revokeObjectURL() {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^csv$/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(await bytes64(blobs[0]!)).toBe(baselineCSV);
  });
  it("prepares CSV with exactly the original bytes without downloading", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const prepared = await prepareExport("csv");
    expect(await bytes64(prepared.blob)).toBe(baselineCSV);
    expect(prepared.filename).toBe("coverage-data-t1.csv");
    expect(prepared.provenance.snapshot).toBe(snapshot);
    expect(isCurrentExport(prepared.provenance.snapshot, prepared.provenance.result)).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });
  it("rejects an invalid runtime format rather than producing a CSV", async () => {
    await expect(prepareExport("bad" as "csv")).rejects.toMatchObject({ code: "INVALID_FORMAT" });
  });
  it("returns typed failure when no active analysis exists", async () => {
    useAnalysisStore.setState({ activeSnapshot: null });
    await expect(prepareExport("csv")).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });
  it("prepares a PDF and surfaces exporter failure with its cause", async () => {
    const pdf = new Blob(["pdf"]);
    const spy = vi.spyOn(api, "exportPDF").mockResolvedValueOnce(pdf).mockRejectedValueOnce(new Error("failure"));
    const prepared = await prepareExport("pdf");
    expect(prepared.blob).toBe(pdf);
    expect(prepared.filename).toBe("coverage-report-t1.pdf");
    await expect(prepareExport("pdf")).rejects.toMatchObject({ code: "EXPORT_FAILED", cause: expect.objectContaining({ message: "failure" }) });
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("drops an in-flight export if the terrain epoch changes", async () => {
    let finish!: (blob: Blob) => void;
    vi.spyOn(api, "exportCSV").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = prepareExport("csv");
    useTerrainStore.setState({ terrainKey: { terrain_id: "t1", epoch: 2 } });
    finish(new Blob(["stale"]));
    await expect(pending).rejects.toMatchObject({ code: "SUPERSEDED" });
  });
  it("prepares PNG and refuses a stale callback", async () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    let finish!: BlobCallback;
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => { finish = callback; });
    const pending = prepareExport("png");
    const png = new Blob(["png"], { type: "image/png" });
    finish(png);
    const prepared = await pending;
    expect(prepared.blob).toBe(png);
    expect(prepared.filename).toBe("terrain-snapshot-t1.png");
    const stale = prepareExport("png");
    useAnalysisStore.setState({ terrainTransitioning: true });
    finish(png);
    await expect(stale).rejects.toMatchObject({ code: "SUPERSEDED" });
    canvas.remove();
  });
  it("distinguishes missing canvas and empty PNG", async () => {
    await expect(prepareExport("png")).rejects.toBeInstanceOf(ExportError);
    await expect(prepareExport("png")).rejects.toMatchObject({ code: "CANVAS_NOT_FOUND" });
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(null));
    await expect(prepareExport("png")).rejects.toMatchObject({ code: "IMAGE_EMPTY" });
    canvas.remove();
  });

});
