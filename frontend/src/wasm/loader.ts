/// <reference types="vite/client" />
import init, { initSync } from './pkg/radar_wasm';
import * as radar from './pkg/radar_wasm';

let initialization: Promise<typeof radar> | undefined;
export function loadRadarWasm(): Promise<typeof radar> {
  return initialization ??= (async () => {
    if (import.meta.env.MODE === 'test') {
      const fsModule = 'node:fs/promises';
      const fs = await import(/* @vite-ignore */ fsModule);
      // Resolve next to this module, independent of the process working directory. The module
      // URL goes through a variable because Vite rewrites the literal
      // `new URL('./pkg/…', import.meta.url)` pattern to an http://localhost URL under vitest.
      const urlModule = 'node:url';
      const { fileURLToPath } = await import(/* @vite-ignore */ urlModule);
      const moduleUrl = import.meta.url;
      const wasmPath = fileURLToPath(new URL('./pkg/radar_wasm_bg.wasm', moduleUrl).href);
      const bytes = await fs.readFile(wasmPath);
      initSync({ module: bytes });
    } else {
      await init({ module_or_path: new URL('./pkg/radar_wasm_bg.wasm', import.meta.url) });
    }
    return radar;
  })();
}

/**
 * Flatten a `number[][]` DEM row-major into the `Float64Array` the Rust core expects.
 *
 * The length is the real sum of the row lengths, so a ragged grid that bypassed the TS guard
 * still fails the Rust `rows * cols` length check ("LOS grid must be rectangular") instead of
 * being padded. Any entry that is not a `number` becomes `NaN`: the TS workers read every DEM
 * value through `Number.isFinite`, which is false for all non-numbers, while a typed-array
 * store would coerce `null`, booleans and numeric strings to finite values.
 */
export function flattenGridForWasm(grid: readonly (readonly unknown[])[]): Float64Array {
  let total = 0;
  for (const row of grid) total += row.length;
  const values = new Float64Array(total);
  let offset = 0;
  for (const row of grid) {
    for (let col = 0; col < row.length; col++) {
      const value = row[col];
      values[offset++] = typeof value === "number" ? value : Number.NaN;
    }
  }
  return values;
}
