// Builds the bundled sample terrain (public/samples/rajo-sintetico-2m.{bin,json}) from the synthetic
// open-pit STL, running the app's own STL importer (src/workers/terrainWorker.ts → generateDTM) at 2 m.
//
//   GEOT_SAMPLE_STL=/ruta/topo-sintetica-rajo.stl node scripts/build-sample-terrain.mjs
//
// Optional: GEOT_SAMPLE_COMPARE=4,8 also imports the STL at those resolutions and prints how far the
// app's resampling of the 2 m asset is from each import (nothing is written in that mode).
// The source STL's SHA-256 is pinned below; any other file is rejected.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_STL_SHA256 = 'c335f6902922fa515167f73803b9c3c913857c45ac6bd7ef35faf919938eb55b';
const RESOLUTION = 2;

const frontend = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(frontend, 'public/samples');

const stlPath = process.env.GEOT_SAMPLE_STL;
if (!stlPath) {
  console.error('Define GEOT_SAMPLE_STL con la ruta del STL sintético (topo-sintetica-rajo.stl).');
  process.exit(1);
}
const stl = readFileSync(stlPath);
const stlSha = createHash('sha256').update(stl).digest('hex');
if (stlSha !== EXPECTED_STL_SHA256) {
  console.error(`SHA-256 del STL inesperado: ${stlSha} (se esperaba ${EXPECTED_STL_SHA256}).`);
  process.exit(1);
}

// Bundle the real Worker and the sample codec for Node, then drive the Worker's onmessage directly.
const bundle = await build({
  stdin: {
    contents: [
      "import './src/workers/terrainWorker.ts';",
      "export * from './src/services/sampleTerrain.ts';",
    ].join('\n'),
    resolveDir: frontend,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
});
let lastMessage;
globalThis.self = { postMessage: (message) => { lastMessage = message; } };
const code = bundle.outputFiles[0].text;
const lib = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

async function importStl(resolution) {
  lastMessage = undefined;
  const fileData = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
  await globalThis.self.onmessage({ data: { fileData, filename: basename(stlPath), resolution } });
  if (!lastMessage || lastMessage.error) throw new Error(`El importador falló: ${lastMessage?.error ?? 'sin respuesta'}`);
  return lastMessage;
}

function pointExtent() {
  // Same parse as the importer (binary STL, every `step`-th triangle above 500 000 triangles).
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const triangles = view.getUint32(80, true);
  const step = triangles > 500_000 ? Math.ceil(triangles / 500_000) : 1;
  const e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let t = 0; t < triangles; t += step) {
    for (let v = 0; v < 3; v++) {
      const o = 84 + t * 50 + 12 + v * 12;
      const x = view.getFloat32(o, true), y = view.getFloat32(o + 4, true), z = view.getFloat32(o + 8, true);
      if (x < e.minX) e.minX = x; if (x > e.maxX) e.maxX = x;
      if (y < e.minY) e.minY = y; if (y > e.maxY) e.maxY = y;
      if (z < e.minZ) e.minZ = z; if (z > e.maxZ) e.maxZ = z;
    }
  }
  return { triangles, extent: e };
}

const t0 = performance.now();
const base = await importStl(RESOLUTION);
const importMs = performance.now() - t0;
const { triangles, extent } = pointExtent();
const b = base.metadata.bounds;
if (b.min_x !== extent.minX || b.min_y !== extent.minY || b.min_z !== extent.minZ || b.max_z !== extent.maxZ) {
  throw new Error('La envolvente de puntos no coincide con los metadatos del importador.');
}

const encoded = lib.encodeSampleTerrain(base.grid);
const dataSha = createHash('sha256').update(encoded.bytes).digest('hex');
const header = stl.subarray(0, 80).toString('latin1').replace(/[\0\s]+$/u, '');
const manifest = {
  ...lib.buildSampleTerrainManifest({
    metadata: base.metadata,
    encoded,
    dataSha256: dataSha,
    sourceExtent: extent,
    source: { file: basename(stlPath), sha256: stlSha, bytes: stl.byteLength, triangles, header },
  }),
  importer: `generateDTM (src/workers/terrainDtm.ts) vía terrainWorker, ${RESOLUTION} m`,
  generator: 'frontend/scripts/build-sample-terrain.mjs',
};

// Self-check: the decoded asset reproduces the importer grid within the quantization error.
const decoded = await lib.decodeSampleTerrain(lib.parseSampleTerrainManifest(manifest), encoded.bytes.buffer);
let maxErr = 0;
for (let r = 0; r < base.grid.length; r++) {
  for (let c = 0; c < base.grid[r].length; c++) {
    const want = base.grid[r][c], got = decoded.grid[r][c];
    if (Number.isNaN(want) !== Number.isNaN(got)) throw new Error(`Nodata distinto en (${r}, ${c}).`);
    if (!Number.isNaN(want)) maxErr = Math.max(maxErr, Math.abs(want - got));
  }
}
if (maxErr !== encoded.maxAbsError) throw new Error('El error de cuantización no se reproduce.');

const compare = process.env.GEOT_SAMPLE_COMPARE;
if (compare) {
  for (const res of compare.split(',').map(Number)) {
    const imported = await importStl(res);
    const t1 = performance.now();
    const resampled = lib.resampleSampleTerrain(decoded, extent, res);
    const resampleMs = performance.now() - t1;
    const m = resampled.metadata, im = imported.metadata;
    const sameShape = m.grid_rows === im.grid_rows && m.grid_cols === im.grid_cols;
    const diffs = [];
    let onlyResampled = 0;
    let onlyImported = 0;
    for (let r = 0; sameShape && r < m.grid_rows; r++) {
      for (let c = 0; c < m.grid_cols; c++) {
        const a = resampled.grid[r][c], z = imported.grid[r][c];
        if (Number.isNaN(z) && !Number.isNaN(a)) onlyResampled++;
        else if (Number.isNaN(a) && !Number.isNaN(z)) onlyImported++;
        else if (!Number.isNaN(a)) diffs.push(Math.abs(a - z));
      }
    }
    diffs.sort((x, y) => x - y);
    const q = (p) => diffs[Math.min(diffs.length - 1, Math.floor(p * diffs.length))];
    console.log(JSON.stringify({
      resolution: res,
      resampled: `${m.grid_cols}x${m.grid_rows}`,
      imported: `${im.grid_cols}x${im.grid_rows}`,
      sameBounds: JSON.stringify(m.bounds) === JSON.stringify(im.bounds),
      validOnlyInResampled: onlyResampled,
      validOnlyInImport: onlyImported,
      compared: diffs.length,
      meanAbs_m: diffs.reduce((s, d) => s + d, 0) / diffs.length,
      p50_m: q(0.5), p95_m: q(0.95), p99_m: q(0.99), max_m: diffs[diffs.length - 1],
      resampleMs: Math.round(resampleMs),
    }));
  }
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, manifest.data.file), encoded.bytes);
writeFileSync(resolve(outDir, 'rajo-sintetico-2m.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const finite = base.grid.flat().filter((z) => !Number.isNaN(z));
console.log(JSON.stringify({
  grid: `${base.metadata.grid_cols}x${base.metadata.grid_rows}`,
  validCells: encoded.validCells,
  zRange_m: b.max_z - b.min_z,
  gridZRange_m: finite.reduce((a, z) => Math.max(a, z), -Infinity) - finite.reduce((a, z) => Math.min(a, z), Infinity),
  binBytes: encoded.bytes.byteLength,
  binSha256: dataSha,
  maxQuantizationError_m: encoded.maxAbsError,
  importMs: Math.round(importMs),
}));
