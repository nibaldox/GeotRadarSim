/// <reference types="vite/client" />
import init, { initSync } from './pkg/radar_wasm';
import * as radar from './pkg/radar_wasm';

let initialization: Promise<typeof radar> | undefined;
export function loadRadarWasm(): Promise<typeof radar> {
  return initialization ??= (async () => {
    if (import.meta.env.MODE === 'test') {
      const fsModule = 'node:fs/promises';
      const fs = await import(/* @vite-ignore */ fsModule);
      const bytes = await fs.readFile('src/wasm/pkg/radar_wasm_bg.wasm');
      initSync({ module: bytes });
    } else {
      await init({ module_or_path: new URL('./pkg/radar_wasm_bg.wasm', import.meta.url) });
    }
    return radar;
  })();
}
