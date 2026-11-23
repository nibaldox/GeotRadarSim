/**
 * Bundled sample terrain: a synthetic open pit, precomputed by `scripts/build-sample-terrain.mjs`
 * from its source STL with the app's own importer (`generateDTM`) at 2 m.
 *
 * Asset format (version 1):
 * - `<name>.bin`: `nx × ny` heights, row-major (row = Y index from `min_y`, column = X index from
 *   `min_x`), each an unsigned 16-bit little-endian integer `q` with `z = z0 + q / 100` (metres).
 *   `0xFFFF` marks a node the importer left empty (NaN), and decodes back to NaN.
 * - `<name>.json`: the manifest below, with the exact importer metadata and the SHA-256 of the
 *   `.bin` and of the source STL.
 */
import type { DTMMetadata } from "../types/api";
import { generateDTM, type TerrainPointExtent } from "../workers/terrainDtm";
import { validateTerrainGridDimensions, validateTerrainResolution } from "../utils/terrainLimits";

export const SAMPLE_TERRAIN_FORMAT = "geotradar-sample-dem";
export const SAMPLE_TERRAIN_VERSION = 1;
export const SAMPLE_TERRAIN_BASE_RESOLUTION = 2;
export const SAMPLE_TERRAIN_NODATA = 0xffff;
export const SAMPLE_TERRAIN_SCALE = 0.01;
export const SAMPLE_TERRAIN_MANIFEST_FILE = "rajo-sintetico-2m.json";
export const SAMPLE_TERRAIN_DATA_FILE = "rajo-sintetico-2m.bin";
export const SAMPLE_TERRAIN_DIR = "samples/";
export const SAMPLE_TERRAIN_LOAD_ERROR = "No se pudo cargar el terreno de ejemplo.";
/** Prefix of the terrain IDs of the sample (the importer uses `dtm`). */
export const SAMPLE_TERRAIN_ID_PREFIX = "sample-pit";

const NODATA_SEMANTICS =
  "0xFFFF = nodo sin puntos del STL cerca (el importador lo deja en NaN); se decodifica como NaN.";

export interface SampleTerrainSource {
  file: string;
  sha256: string;
  bytes: number;
  triangles: number;
  header: string;
}

export interface SampleTerrainManifest {
  format: typeof SAMPLE_TERRAIN_FORMAT;
  version: typeof SAMPLE_TERRAIN_VERSION;
  name: string;
  encoding: "uint16le";
  nx: number;
  ny: number;
  resolution: number;
  origin: { x: number; y: number };
  /** Exact metadata bounds the importer produced at 2 m. */
  bounds: DTMMetadata["bounds"];
  /** Envelope of the importer's source points; resampling keeps it so node counts match an import. */
  source_extent: TerrainPointExtent;
  z0: number;
  scale: typeof SAMPLE_TERRAIN_SCALE;
  nodata: typeof SAMPLE_TERRAIN_NODATA;
  nodata_semantics: string;
  valid_cells: number;
  data: { file: string; bytes: number; sha256: string };
  source: SampleTerrainSource;
  quantization: { max_abs_error_m: number };
}

export interface SampleTerrain {
  grid: number[][];
  metadata: DTMMetadata;
}

export interface EncodedSampleTerrain {
  bytes: Uint8Array<ArrayBuffer>;
  z0: number;
  validCells: number;
  maxAbsError: number;
  rows: number;
  cols: number;
}

/** Resolution used for the sample: the user's preference, never finer than the 2 m base. */
export function sampleTerrainResolution(preferred: number): number {
  return Number.isFinite(preferred) ? Math.max(preferred, SAMPLE_TERRAIN_BASE_RESOLUTION) : SAMPLE_TERRAIN_BASE_RESOLUTION;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 no disponible en este navegador.");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Quantize a grid to centimetres above its minimum; NaN becomes 0xFFFF. */
export function encodeSampleTerrain(grid: number[][]): EncodedSampleTerrain {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  validateTerrainGridDimensions(rows, cols, "Sample terrain");
  let z0 = Infinity;
  for (const row of grid) {
    if (row.length !== cols) throw new RangeError("Sample terrain rows must have the same length");
    for (const z of row) if (Number.isFinite(z) && z < z0) z0 = z;
  }
  if (!Number.isFinite(z0)) throw new RangeError("Sample terrain has no valid heights");

  const bytes = new Uint8Array(rows * cols * 2);
  const view = new DataView(bytes.buffer);
  let validCells = 0;
  let maxAbsError = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = grid[r]![c]!;
      let q = SAMPLE_TERRAIN_NODATA;
      if (Number.isFinite(z)) {
        q = Math.round((z - z0) * 100);
        if (q < 0 || q >= SAMPLE_TERRAIN_NODATA) {
          throw new RangeError("Sample terrain height span does not fit in Uint16 centimetres");
        }
        maxAbsError = Math.max(maxAbsError, Math.abs(z0 + q / 100 - z));
        validCells++;
      } else if (!Number.isNaN(z)) {
        throw new RangeError("Sample terrain heights must be finite or NaN");
      }
      view.setUint16((r * cols + c) * 2, q, true);
    }
  }
  return { bytes, z0, validCells, maxAbsError, rows, cols };
}

export function buildSampleTerrainManifest(input: {
  metadata: DTMMetadata;
  encoded: EncodedSampleTerrain;
  dataSha256: string;
  sourceExtent: TerrainPointExtent;
  source: SampleTerrainSource;
  name?: string;
}): SampleTerrainManifest {
  const { metadata, encoded } = input;
  if (metadata.grid_rows !== encoded.rows || metadata.grid_cols !== encoded.cols) {
    throw new RangeError("Sample terrain metadata does not match the encoded grid");
  }
  return {
    format: SAMPLE_TERRAIN_FORMAT,
    version: SAMPLE_TERRAIN_VERSION,
    name: input.name ?? "Rajo sintético de ejemplo",
    encoding: "uint16le",
    nx: encoded.cols,
    ny: encoded.rows,
    resolution: metadata.resolution,
    origin: { x: metadata.bounds.min_x, y: metadata.bounds.min_y },
    bounds: { ...metadata.bounds },
    source_extent: { ...input.sourceExtent },
    z0: encoded.z0,
    scale: SAMPLE_TERRAIN_SCALE,
    nodata: SAMPLE_TERRAIN_NODATA,
    nodata_semantics: NODATA_SEMANTICS,
    valid_cells: encoded.validCells,
    data: { file: SAMPLE_TERRAIN_DATA_FILE, bytes: encoded.bytes.byteLength, sha256: input.dataSha256 },
    source: { ...input.source },
    quantization: { max_abs_error_m: encoded.maxAbsError },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireFinite(obj: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) {
    if (!isFiniteNumber(obj[key])) throw new Error(`Manifiesto de ejemplo inválido: ${label}.${key}`);
  }
}

/** Validate an untrusted manifest (the fetched JSON) and return it typed. */
export function parseSampleTerrainManifest(json: unknown): SampleTerrainManifest {
  const fail = (what: string): never => {
    throw new Error(`Manifiesto de ejemplo inválido: ${what}`);
  };
  if (!isObject(json)) return fail("no es un objeto");
  if (json.format !== SAMPLE_TERRAIN_FORMAT) fail("format");
  if (json.version !== SAMPLE_TERRAIN_VERSION) fail("version");
  if (json.encoding !== "uint16le") fail("encoding");
  if (json.nodata !== SAMPLE_TERRAIN_NODATA) fail("nodata");
  if (json.scale !== SAMPLE_TERRAIN_SCALE) fail("scale");
  if (json.resolution !== SAMPLE_TERRAIN_BASE_RESOLUTION) fail("resolution");
  if (typeof json.name !== "string" || typeof json.nodata_semantics !== "string") fail("name");
  const { nx, ny } = json;
  if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny)) fail("nx/ny");
  validateTerrainGridDimensions(ny as number, nx as number, "Sample terrain");
  if (!isFiniteNumber(json.z0)) fail("z0");
  if (!Number.isSafeInteger(json.valid_cells) || (json.valid_cells as number) < 0 ||
      (json.valid_cells as number) > (nx as number) * (ny as number)) fail("valid_cells");
  for (const key of ["origin", "bounds", "source_extent", "data", "source", "quantization"]) {
    if (!isObject(json[key])) fail(key);
  }
  const origin = json.origin as Record<string, unknown>;
  const bounds = json.bounds as Record<string, unknown>;
  const extent = json.source_extent as Record<string, unknown>;
  const data = json.data as Record<string, unknown>;
  const source = json.source as Record<string, unknown>;
  const quantization = json.quantization as Record<string, unknown>;
  requireFinite(origin, ["x", "y"], "origin");
  requireFinite(bounds, ["min_x", "min_y", "min_z", "max_x", "max_y", "max_z"], "bounds");
  requireFinite(extent, ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"], "source_extent");
  requireFinite(quantization, ["max_abs_error_m"], "quantization");
  if (data.file !== SAMPLE_TERRAIN_DATA_FILE) fail("data.file");
  if (data.bytes !== (nx as number) * (ny as number) * 2) fail("data.bytes");
  if (typeof data.sha256 !== "string" || !SHA256_PATTERN.test(data.sha256)) fail("data.sha256");
  if (typeof source.sha256 !== "string" || !SHA256_PATTERN.test(source.sha256)) fail("source.sha256");
  if (typeof source.file !== "string" || typeof source.header !== "string") fail("source");
  if (!Number.isSafeInteger(source.bytes) || !Number.isSafeInteger(source.triangles)) fail("source");
  return json as unknown as SampleTerrainManifest;
}

/** Verify length, SHA-256 and valid-cell count, then decode to the importer's grid representation. */
export async function decodeSampleTerrain(manifest: SampleTerrainManifest, buffer: ArrayBuffer): Promise<SampleTerrain> {
  const { nx, ny } = manifest;
  if (buffer.byteLength !== manifest.data.bytes || buffer.byteLength !== nx * ny * 2) {
    throw new Error(`Longitud del terreno de ejemplo inválida: ${buffer.byteLength} bytes.`);
  }
  const digest = await sha256Hex(buffer);
  if (digest !== manifest.data.sha256) throw new Error("El SHA-256 del terreno de ejemplo no coincide.");

  const view = new DataView(buffer);
  const { z0 } = manifest;
  const grid: number[][] = new Array(ny);
  let validCells = 0;
  for (let r = 0; r < ny; r++) {
    const row: number[] = new Array(nx);
    for (let c = 0; c < nx; c++) {
      const q = view.getUint16((r * nx + c) * 2, true);
      if (q === SAMPLE_TERRAIN_NODATA) {
        row[c] = NaN;
      } else {
        row[c] = z0 + q / 100;
        validCells++;
      }
    }
    grid[r] = row;
  }
  if (validCells !== manifest.valid_cells) {
    throw new Error("La cantidad de celdas válidas del terreno de ejemplo no coincide.");
  }
  return {
    grid,
    metadata: {
      terrain_id: `${SAMPLE_TERRAIN_ID_PREFIX}-${manifest.resolution}`,
      bounds: { ...manifest.bounds },
      resolution: manifest.resolution,
      grid_rows: ny,
      grid_cols: nx,
    },
  };
}

/**
 * Coarser sample grids are rebuilt from the 2 m base with the importer's own criterion: the valid
 * base nodes become the point cloud for `generateDTM` at the new resolution, inside the source
 * STL's envelope, so node counts, bounds and nodata follow an import of the STL at that resolution.
 * The heights are not identical to importing the STL (the IDW sees 2 m nodes, not STL vertices);
 * the difference at 4 m and 8 m is measured by the build script's comparison mode.
 */
export function resampleSampleTerrain(base: SampleTerrain, extent: TerrainPointExtent, resolution: number): SampleTerrain {
  validateTerrainResolution(resolution, "Sample terrain");
  const baseRes = base.metadata.resolution;
  if (resolution < baseRes) {
    throw new RangeError(`El terreno de ejemplo no admite resoluciones menores que ${baseRes} m.`);
  }
  if (resolution === baseRes) return base;

  const { min_x: minX, min_y: minY } = base.metadata.bounds;
  const points: Array<[number, number, number]> = [];
  for (let r = 0; r < base.grid.length; r++) {
    const row = base.grid[r]!;
    for (let c = 0; c < row.length; c++) {
      const z = row[c]!;
      if (Number.isFinite(z)) points.push([minX + c * baseRes, minY + r * baseRes, z]);
    }
  }
  const result = generateDTM(points, resolution, extent, SAMPLE_TERRAIN_ID_PREFIX);
  return { grid: result.grid, metadata: result.metadata };
}
