import { loadRadarWasm } from '../wasm/loader';

self.onmessage = async () => {
  try {
    const wasm = await loadRadarWasm();
    self.postMessage({ ok: true, result: wasm.grid_summary(new Float64Array([1, 2, 3, 4]), 2, 2), version: wasm.core_version() });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
};
