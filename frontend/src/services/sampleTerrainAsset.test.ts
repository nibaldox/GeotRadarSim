/**
 * The bundled sample asset in public/samples/ (Node only: reads the files from disk).
 * Expected figures come from the app's STL importer at 2 m on the synthetic pit
 * (topo-sintetica-rajo.stl, SHA-256 c335f690…), as written by scripts/build-sample-terrain.mjs.
 */
import { describe, it, expect } from "vitest";
import {
  SAMPLE_TERRAIN_DATA_FILE,
  SAMPLE_TERRAIN_MANIFEST_FILE,
  decodeSampleTerrain,
  parseSampleTerrainManifest,
  resampleSampleTerrain,
  sha256Hex,
} from "./sampleTerrain";
import { MAX_TERRAIN_GRID_CELLS } from "../utils/terrainLimits";

// No @types/node in this project: load node:fs through an untyped dynamic import. Vitest runs from
// frontend/ (vitest.config.ts), so the asset path is relative to the working directory.
const nodeFs = "node:fs";
async function readSample(name: string): Promise<Uint8Array<ArrayBuffer>> {
  const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string) => Uint8Array };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  const raw = fs.readFileSync(`${cwd}/public/samples/${name}`);
  return new Uint8Array(raw);
}

describe("bundled sample pit asset", () => {
  it("matches its manifest and the importer's 2 m figures", async () => {
    const manifestBytes = await readSample(SAMPLE_TERRAIN_MANIFEST_FILE);
    const manifest = parseSampleTerrainManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const data = await readSample(SAMPLE_TERRAIN_DATA_FILE);

    expect(manifest.source.sha256).toBe("c335f6902922fa515167f73803b9c3c913857c45ac6bd7ef35faf919938eb55b");
    expect(manifest.source.triangles).toBe(647_760);
    expect(manifest.source.header).toBe("GeotRadarSim synthetic open pit v1");
    expect(await sha256Hex(data)).toBe(manifest.data.sha256);
    expect(manifest.data.sha256).toBe("a4cb642b399a17e694bebd144dea5fa7b8ed7fbf0f5d7f24bdc918ee9a07b792");
    expect(data.byteLength).toBe(728_960);
    expect(data.byteLength).toBeLessThan(1_000_000);

    expect(manifest.nx).toBe(680);
    expect(manifest.ny).toBe(536);
    expect(manifest.resolution).toBe(2);
    expect(manifest.valid_cells).toBe(320_705);
    expect(manifest.quantization.max_abs_error_m).toBeLessThanOrEqual(0.005);

    const terrain = await decodeSampleTerrain(manifest, data.buffer);
    const { bounds } = terrain.metadata;
    // Header «Rango Z» (bounds) is the importer's source-point range: 301.0 m.
    expect(bounds.max_z - bounds.min_z).toBe(301.022216796875);
    expect(bounds.max_x - bounds.min_x).toBe(1358);
    expect(bounds.max_y - bounds.min_y).toBe(1070);
    let valid = 0;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const row of terrain.grid) {
      for (const z of row) {
        if (Number.isNaN(z)) continue;
        valid++;
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    expect(valid).toBe(320_705);
    expect(minZ).toBe(manifest.z0);
    expect(maxZ - minZ).toBeCloseTo(300.86, 2);
  });

  it.each([
    [4, 340, 268],
    [5, 272, 215],
    [8, 170, 134],
  ])("resamples to %d m with the importer's node counts", async (res, cols, rows) => {
    const manifest = parseSampleTerrainManifest(
      JSON.parse(new TextDecoder().decode(await readSample(SAMPLE_TERRAIN_MANIFEST_FILE))),
    );
    const terrain = await decodeSampleTerrain(manifest, (await readSample(SAMPLE_TERRAIN_DATA_FILE)).buffer);
    const out = resampleSampleTerrain(terrain, manifest.source_extent, res);
    expect([out.metadata.grid_cols, out.metadata.grid_rows]).toEqual([cols, rows]);
    expect(cols * rows).toBeLessThanOrEqual(MAX_TERRAIN_GRID_CELLS);
  });
});
