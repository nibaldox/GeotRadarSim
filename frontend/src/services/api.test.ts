/**
 * Tests for the typed API client.
 *
 * Tests verify that each API function:
 * 1. Calls the correct endpoint with the right method
 * 2. Sends the correct body/params
 * 3. Returns typed data on success
 * 4. Throws a descriptive error on failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadDXF,
  uploadSTL,
  generateSynthetic,
  getTerrainGrid,
  runLOSAnalysis,
  listRadars,
  getRadar,
  exportPDF,
  exportCSV,
  setApiBaseUrl,
} from "./api";
import type {
  DTMMetadata,
  TerrainGridResponse,
  RadarConfig,
  LOSResponse,
} from "../types/api";
// --- Mock fetch globally ---
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  setApiBaseUrl("http://localhost:8000");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: create a successful JSON response
function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Helper: create an error response
function jsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────
// uploadDXF
// ────────────────────────────────────────────
describe("uploadDXF", () => {
  it("POSTs file to /api/terrain/upload and returns DTMMetadata", async () => {
    const expected: DTMMetadata = {
      terrain_id: "terrain-1",
      bounds: {
        min_x: 0, min_y: 0, min_z: -50,
        max_x: 100, max_y: 100, max_z: 10,
      },
      resolution: 2.0,
      grid_rows: 51,
      grid_cols: 51,
    };
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const file = new File(["dummy-dxf-content"], "test.dxf", {
      type: "application/dxf",
    });
    const result = await uploadDXF(file);

    expect(result).toEqual(expected);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/terrain/upload");
    expect(options!.method).toBe("POST");
    // Verify FormData contains the file
    const body = options!.body as FormData;
    expect(body.get("file")).toBe(file);
  });

  it("throws with detail message on 422 validation error", async () => {
    mockFetch.mockResolvedValueOnce(jsonError(422, "No elevation data in DXF"));

    const file = new File(["bad"], "bad.dxf", { type: "application/dxf" });
    await expect(uploadDXF(file)).rejects.toThrow("No elevation data in DXF");
  });
});

// ────────────────────────────────────────────
// uploadSTL
// ────────────────────────────────────────────
describe("uploadSTL", () => {
  it("POSTs file to /api/terrain/upload-stl and returns DTMMetadata", async () => {
    const expected: DTMMetadata = {
      terrain_id: "dtm-0-0-2",
      bounds: {
        min_x: 0, min_y: 0, min_z: 0,
        max_x: 20, max_y: 20, max_z: 10,
      },
      resolution: 2.0,
      grid_rows: 11,
      grid_cols: 11,
    };
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const file = new File(["binary-stl-content"], "terrain.stl", {
      type: "application/octet-stream",
    });
    const result = await uploadSTL(file);

    expect(result).toEqual(expected);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/terrain/upload-stl");
    expect(options!.method).toBe("POST");
    const body = options!.body as FormData;
    expect(body.get("file")).toBe(file);
  });

  it("throws with detail message on 422 parse error", async () => {
    mockFetch.mockResolvedValueOnce(jsonError(422, "No valid triangles found in STL file"));

    const file = new File(["bad"], "bad.stl", { type: "application/octet-stream" });
    await expect(uploadSTL(file)).rejects.toThrow("No valid triangles found in STL file");
  });
});

// ────────────────────────────────────────────
// generateSynthetic
// ────────────────────────────────────────────
describe("generateSynthetic", () => {
  it("POSTs params to /api/terrain/synthetic and returns DTMMetadata", async () => {
    const expected: DTMMetadata = {
      terrain_id: "terrain-syn-1",
      bounds: {
        min_x: 0, min_y: 0, min_z: -30,
        max_x: 200, max_y: 200, max_z: 0,
      },
      resolution: 2.0,
      grid_rows: 101,
      grid_cols: 101,
    };
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const result = await generateSynthetic({
      size_x: 200,
      size_y: 200,
      depth: 30,
      resolution: 2.0,
    });

    expect(result).toEqual(expected);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/terrain/synthetic");
    expect(options!.method).toBe("POST");
    expect(options!.headers).toHaveProperty("Content-Type", "application/json");
    const body = JSON.parse(options!.body as string);
    expect(body.size_x).toBe(200);
    expect(body.depth).toBe(30);
  });

  it("uses default resolution when not provided", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonOk({ terrain_id: "t1", bounds: {}, resolution: 2.0, grid_rows: 1, grid_cols: 1 }),
    );

    await generateSynthetic({ size_x: 100, size_y: 100, depth: 20 });

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    // Should NOT include resolution if undefined — backend default applies
    expect(body).not.toHaveProperty("resolution");
  });
});

// ────────────────────────────────────────────
// getTerrainGrid
// ────────────────────────────────────────────
describe("getTerrainGrid", () => {
  it("GETs /api/terrain/{id}/grid and returns grid data", async () => {
    const expected: TerrainGridResponse = {
      terrain_id: "terrain-1",
      grid: [[10.5, 9.2], [8.1, 7.3]],
      metadata: {
        terrain_id: "terrain-1",
        bounds: {
          min_x: 0, min_y: 0, min_z: -5,
          max_x: 4, max_y: 4, max_z: 10,
        },
        resolution: 2.0,
        grid_rows: 2,
        grid_cols: 2,
      },
    };
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const result = await getTerrainGrid("terrain-1");

    expect(result).toEqual(expected);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/terrain/terrain-1/grid");
    expect(options!.method).toBe("GET");
  });

  it("throws on 404 terrain not found", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(404, "Terrain 'nonexistent' not found"),
    );

    await expect(getTerrainGrid("nonexistent")).rejects.toThrow(
      "Terrain 'nonexistent' not found",
    );
  });
});

// ────────────────────────────────────────────
// runLOSAnalysis
// ────────────────────────────────────────────
describe("runLOSAnalysis", () => {
  it("POSTs to /api/analysis/los and returns LOSResponse", async () => {
    const expected: LOSResponse = {
      shadow_grid: [[false, true], [false, false]],
      coverage_polygon: [[0, 0], [100, 0], [100, 100], [0, 100]],
      coverage_pct: 75.0,
      visible_area_m2: 15000,
      shadow_zones: [{ zone_id: 1, cell_count: 1 }],
    };
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const result = await runLOSAnalysis({
      terrain_id: "terrain-1",
      radar_position: { x: 50, y: 50, z: 10 },
      radar_model_id: "groundprobe-ssr-fx",
    });

    expect(result).toEqual(expected);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/analysis/los");
    expect(options!.method).toBe("POST");
    const body = JSON.parse(options!.body as string);
    expect(body.terrain_id).toBe("terrain-1");
    expect(body.radar_position).toEqual({ x: 50, y: 50, z: 10 });
    expect(body.radar_model_id).toBe("groundprobe-ssr-fx");
  });

  it("throws on 404 radar model not found", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(404, "Radar model 'unknown' not found"),
    );

    await expect(
      runLOSAnalysis({
        terrain_id: "t1",
        radar_position: { x: 0, y: 0, z: 0 },
        radar_model_id: "unknown",
      }),
    ).rejects.toThrow("Radar model 'unknown' not found");
  });
});

// ────────────────────────────────────────────
// listRadars / getRadar
// ────────────────────────────────────────────
describe("listRadars", () => {
  it("GETs /api/radars and returns array of RadarConfig", async () => {
    const expected: RadarConfig[] = [
      {
        model_id: "groundprobe-ssr-fx",
        min_range_m: 0,
        display_name: "GroundProbe SSR-FX",
        manufacturer: "GroundProbe",
        max_range_m: 850,
        h_beam_width_deg: 120,
        v_beam_width_deg: 30,
        elevation_min_deg: -30,
        elevation_max_deg: 30,
        scan_pattern: "RAR",
        azimuth_range_deg: [-60, 60],
      },
    ];
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const result = await listRadars();

    expect(result).toEqual(expected);
    expect(mockFetch.mock.calls[0]![0]).toBe("http://localhost:8000/api/radars");
    expect(mockFetch.mock.calls[0]![1]!.method).toBe("GET");
  });
});

describe("getRadar", () => {
  it("GETs /api/radars/{model_id} and returns RadarConfig", async () => {
    const expected: RadarConfig = {
      model_id: "groundprobe-ssr-fx",
      min_range_m: 0,
      display_name: "GroundProbe SSR-FX",
      manufacturer: "GroundProbe",
      max_range_m: 850,
      h_beam_width_deg: 120,
      v_beam_width_deg: 30,
      elevation_min_deg: -30,
      elevation_max_deg: 30,
      scan_pattern: "RAR",
      azimuth_range_deg: [-60, 60],
    };
    mockFetch.mockResolvedValueOnce(jsonOk(expected));

    const result = await getRadar("groundprobe-ssr-fx");

    expect(result).toEqual(expected);
    expect(mockFetch.mock.calls[0]![0]).toBe(
      "http://localhost:8000/api/radars/groundprobe-ssr-fx",
    );
  });

  it("throws on 404 unknown model", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonError(404, "Radar model 'unknown' not found"),
    );
    await expect(getRadar("unknown")).rejects.toThrow(
      "Radar model 'unknown' not found",
    );
  });
});

// ────────────────────────────────────────────
// exportPDF / exportCSV
// ────────────────────────────────────────────
describe("exportPDF", () => {
  it("POSTs to /api/export/pdf with full LOS request body and returns blob", async () => {
    const pdfBlob = new Blob(["fake-pdf"], { type: "application/pdf" });
    mockFetch.mockResolvedValueOnce(
      new Response(pdfBlob, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );

    const result = await exportPDF({
      terrain_id: "terrain-1",
      radar_position: { x: 50, y: 50, z: 10 },
      radar_model_id: "groundprobe-ssr-fx",
    });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("application/pdf");
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/export/pdf");
    expect(options!.method).toBe("POST");
    const body = JSON.parse(options!.body as string);
    expect(body.terrain_id).toBe("terrain-1");
    expect(body.radar_position).toEqual({ x: 50, y: 50, z: 10 });
    expect(body.radar_model_id).toBe("groundprobe-ssr-fx");
  });
});

describe("exportCSV", () => {
  it("POSTs to /api/export/data with full LOS request body and returns blob", async () => {
    const csvBlob = new Blob(["x,y,z\n1,2,3"], { type: "text/csv" });
    mockFetch.mockResolvedValueOnce(
      new Response(csvBlob, {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }),
    );

    const result = await exportCSV({
      terrain_id: "terrain-1",
      radar_position: { x: 50, y: 50, z: 10 },
      radar_model_id: "groundprobe-ssr-fx",
    });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("text/csv");
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/export/data");
    expect(options!.method).toBe("POST");
    const body = JSON.parse(options!.body as string);
    expect(body.terrain_id).toBe("terrain-1");
  });
});
