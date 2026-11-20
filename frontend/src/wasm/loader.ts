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
