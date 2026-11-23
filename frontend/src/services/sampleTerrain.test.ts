import { describe, it, expect } from "vitest";
import {
  SAMPLE_TERRAIN_NODATA,
  decodeSampleTerrain,
  encodeSampleTerrain,
  parseSampleTerrainManifest,
  resampleSampleTerrain,
  sampleTerrainResolution,
} from "./sampleTerrain";
import { buildSampleFixture, sampleFixtureGrid } from "./sampleTerrain.testSupport";
import { generateDTM } from "../workers/terrainDtm";
import { MAX_TERRAIN_GRID_CELLS } from "../utils/terrainLimits";

describe("sample terrain encoder/decoder", () => {
  it("round-trips heights within half a centimetre and keeps NaN as nodata", async () => {
    const grid = sampleFixtureGrid(5, 7, [[0, 0], [4, 6], [2, 3]]);
    const fixture = await buildSampleFixture(grid);
    expect(fixture.bytes.byteLength).toBe(5 * 7 * 2);
    expect(fixture.manifest.valid_cells).toBe(5 * 7 - 3);

    const view = new DataView(fixture.buffer);
    expect(view.getUint16((2 * 7 + 3) * 2, true)).toBe(SAMPLE_TERRAIN_NODATA);

    const decoded = await decodeSampleTerrain(fixture.manifest, fixture.buffer);
    expect(decoded.grid.length).toBe(5);
    expect(decoded.grid[0]!.length).toBe(7);
    let maxErr = 0;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 7; c++) {
        const want = grid[r]![c]!;
        const got = decoded.grid[r]![c]!;
        if (Number.isNaN(want)) {
          expect(Number.isNaN(got)).toBe(true);
        } else {
          maxErr = Math.max(maxErr, Math.abs(got - want));
        }
      }
    }
    expect(maxErr).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(maxErr).toBeCloseTo(fixture.manifest.quantization.max_abs_error_m, 9);
    expect(decoded.metadata).toMatchObject({
      resolution: 2,
      grid_rows: 5,
      grid_cols: 7,
      bounds: fixture.manifest.bounds,
    });
  });

  it("uses the grid minimum as z0 and little-endian centimetres above it", () => {
    const encoded = encodeSampleTerrain([[10, 10.5], [NaN, 12.344]]);
    expect(encoded.z0).toBe(10);
    const view = new DataView(encoded.bytes.buffer, encoded.bytes.byteOffset, encoded.bytes.byteLength);
    expect([0, 1, 2, 3].map((i) => view.getUint16(i * 2, true))).toEqual([0, 50, 0xffff, 234]);
    expect(encoded.validCells).toBe(3);
  });

  it("rejects heights whose span does not fit in Uint16 centimetres", () => {
    expect(() => encodeSampleTerrain([[0, 700]])).toThrow(RangeError);
  });

  it("rejects a buffer whose length differs from the manifest", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(3, 4));
    await expect(decodeSampleTerrain(fixture.manifest, fixture.buffer.slice(0, 22))).rejects.toThrow(/longitud/i);
  });

  it("rejects bytes whose SHA-256 differs from the manifest", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(3, 4));
    const tampered = fixture.buffer.slice(0);
    const bytes = new Uint8Array(tampered);
    bytes[5] = bytes[5]! ^ 1;
    await expect(decodeSampleTerrain(fixture.manifest, tampered)).rejects.toThrow(/SHA-256/);
  });

  it("rejects a valid-cell count that differs from the manifest", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(3, 4));
    const manifest = { ...fixture.manifest, valid_cells: 11 };
    await expect(decodeSampleTerrain(manifest, fixture.buffer)).rejects.toThrow(/celdas válidas/i);
  });

  it("validates the manifest shape before decoding", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(3, 4));
    const good = JSON.parse(JSON.stringify(fixture.manifest));
    expect(parseSampleTerrainManifest(good)).toEqual(fixture.manifest);
    const broken: Array<[string, (m: any) => void]> = [
      ["format", (m) => { m.format = "other"; }],
      ["version", (m) => { m.version = 2; }],
      ["encoding", (m) => { m.encoding = "uint16be"; }],
      ["nodata", (m) => { m.nodata = 0; }],
      ["scale", (m) => { m.scale = 0.001; }],
      ["resolution", (m) => { m.resolution = 1; }],
      ["nx", (m) => { m.nx = 3.5; }],
      ["bytes", (m) => { m.data.bytes = 10; }],
      ["sha", (m) => { m.data.sha256 = "xyz"; }],
      ["file", (m) => { m.data.file = "../evil.bin"; }],
      ["z0", (m) => { m.z0 = null; }],
      ["bounds", (m) => { m.bounds.min_x = "a"; }],
      ["extent", (m) => { delete m.source_extent; }],
      ["too big", (m) => { m.nx = 2000; m.ny = 2000; m.data.bytes = 8_000_000; }],
    ];
    for (const [label, mutate] of broken) {
      const copy = JSON.parse(JSON.stringify(fixture.manifest));
      mutate(copy);
      expect(() => parseSampleTerrainManifest(copy), label).toThrow();
    }
    expect(() => parseSampleTerrainManifest(null)).toThrow();
  });
});

describe("sample terrain resolution", () => {
  it("never goes below the 2 m base and ignores non-finite preferences", () => {
    expect(sampleTerrainResolution(0.5)).toBe(2);
    expect(sampleTerrainResolution(1)).toBe(2);
    expect(sampleTerrainResolution(2)).toBe(2);
    expect(sampleTerrainResolution(2.5)).toBe(2.5);
    expect(sampleTerrainResolution(4)).toBe(4);
    expect(sampleTerrainResolution(Number.NaN)).toBe(2);
  });
});

describe("sample terrain resampling", () => {
  // Same footprint as the bundled pit: 680 × 536 nodes at 2 m over a 1359.3 × 1070.6 m source envelope.
  const rows = 536;
  const cols = 680;
  const extent = { minX: 0.4, maxX: 0.4 + 1359.3, minY: -3.1, maxY: -3.1 + 1070.6, minZ: 90, maxZ: 400 };

  const planeTerrain = () => {
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(r < 40 && c < 60 ? NaN : 100 + 0.1 * c + 0.05 * r);
      grid.push(row);
    }
    return {
      grid,
      metadata: {
        terrain_id: "base",
        bounds: {
          min_x: extent.minX, min_y: extent.minY, min_z: extent.minZ,
          max_x: extent.minX + (cols - 1) * 2, max_y: extent.minY + (rows - 1) * 2, max_z: extent.maxZ,
        },
        resolution: 2,
        grid_rows: rows,
        grid_cols: cols,
      },
    };
  };

  it.each([
    [2, 680, 536],
    [4, 340, 268],
    [8, 170, 134],
  ])("gives the importer's node counts at %d m and stays under the cell cap", (res, wantCols, wantRows) => {
    const out = resampleSampleTerrain(planeTerrain(), extent, res);
    expect(out.metadata.grid_cols).toBe(wantCols);
    expect(out.metadata.grid_rows).toBe(wantRows);
    expect(out.grid.length).toBe(wantRows);
    expect(out.grid[0]!.length).toBe(wantCols);
    expect(out.metadata.grid_rows * out.metadata.grid_cols).toBeLessThanOrEqual(MAX_TERRAIN_GRID_CELLS);
    expect(out.metadata.resolution).toBe(res);
    expect(out.metadata.bounds).toMatchObject({ min_x: extent.minX, min_y: extent.minY, min_z: 90, max_z: 400 });
    expect(out.metadata.bounds.max_x).toBe(extent.minX + (wantCols - 1) * res);
  });

  it("returns the base grid unchanged at 2 m", () => {
    const base = planeTerrain();
    const out = resampleSampleTerrain(base, extent, 2);
    expect(out.grid).toBe(base.grid);
    expect(out.metadata).toEqual(base.metadata);
  });

  it("applies the importer's IDW criterion to the base nodes (same function, same envelope)", () => {
    const base = planeTerrain();
    const out = resampleSampleTerrain(base, extent, 8);
    const points: Array<[number, number, number]> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const z = base.grid[r]![c]!;
        if (Number.isFinite(z)) points.push([extent.minX + c * 2, extent.minY + r * 2, z]);
      }
    }
    const expected = generateDTM(points, 8, extent, "sample");
    expect(out.grid).toEqual(expected.grid);
    // A plane stays a plane far from the empty corner, and the far corner of the empty block stays NaN.
    expect(out.grid[100]![100]!).toBeCloseTo(100 + 0.1 * 400 + 0.05 * 400, 6);
    expect(Number.isNaN(out.grid[0]![0]!)).toBe(true);
  });

  it("rejects resolutions finer than the 2 m base", () => {
    expect(() => resampleSampleTerrain(planeTerrain(), extent, 1)).toThrow(RangeError);
  });
});
