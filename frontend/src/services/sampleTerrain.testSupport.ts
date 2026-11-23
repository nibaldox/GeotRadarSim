/**
 * Builds a small sample-terrain asset (manifest + bytes) with the production encoder, for tests
 * that must not depend on the real bundled asset.
 */
import {
  SAMPLE_TERRAIN_BASE_RESOLUTION,
  SAMPLE_TERRAIN_DATA_FILE,
  buildSampleTerrainManifest,
  encodeSampleTerrain,
  sha256Hex,
  type SampleTerrainManifest,
} from "./sampleTerrain";
import type { TerrainPointExtent } from "../workers/terrainDtm";

export interface SampleFixture {
  manifest: SampleTerrainManifest;
  bytes: Uint8Array;
  buffer: ArrayBuffer;
}

/** A rows × cols tilted plane at 2 m with an optional NaN block; origin (1000.25, 2000.75). */
export function sampleFixtureGrid(rows: number, cols: number, nanCells: Array<[number, number]> = []): number[][] {
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) row.push(100.123 + 0.37 * c - 0.21 * r + 0.0049 * ((r * 7 + c * 3) % 5));
    grid.push(row);
  }
  for (const [r, c] of nanCells) grid[r]![c] = NaN;
  return grid;
}

export async function buildSampleFixture(grid: number[][], extent?: TerrainPointExtent): Promise<SampleFixture> {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const res = SAMPLE_TERRAIN_BASE_RESOLUTION;
  const minX = 1000.25;
  const minY = 2000.75;
  const finite = grid.flat().filter(Number.isFinite);
  const sourceExtent: TerrainPointExtent = extent ?? {
    minX,
    maxX: minX + (cols - 1) * res + 0.5,
    minY,
    maxY: minY + (rows - 1) * res + 0.3,
    minZ: Math.min(...finite) - 0.2,
    maxZ: Math.max(...finite) + 0.2,
  };
  const metadata = {
    terrain_id: "dtm-fixture",
    bounds: {
      min_x: sourceExtent.minX,
      min_y: sourceExtent.minY,
      min_z: sourceExtent.minZ,
      max_x: sourceExtent.minX + (cols - 1) * res,
      max_y: sourceExtent.minY + (rows - 1) * res,
      max_z: sourceExtent.maxZ,
    },
    resolution: res,
    grid_rows: rows,
    grid_cols: cols,
  };
  const encoded = encodeSampleTerrain(grid);
  const sha256 = await sha256Hex(encoded.bytes);
  const manifest = buildSampleTerrainManifest({
    metadata,
    encoded,
    dataSha256: sha256,
    sourceExtent,
    source: { file: "fixture.stl", sha256: "0".repeat(64), bytes: 0, triangles: 0, header: "fixture" },
  });
  const buffer = encoded.bytes.buffer.slice(
    encoded.bytes.byteOffset,
    encoded.bytes.byteOffset + encoded.bytes.byteLength,
  ) as ArrayBuffer;
  return { manifest: { ...manifest, data: { ...manifest.data, file: SAMPLE_TERRAIN_DATA_FILE } }, bytes: encoded.bytes, buffer };
}
