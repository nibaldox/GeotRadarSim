import { createHash } from 'node:crypto';

export function hashBytes(view: ArrayBufferView): string {
  return createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}
export function flattenGrid(grid: number[][]): Float64Array {
  const cols = grid[0]?.length;
  if (!cols || !grid.length || grid.some(row => row.length !== cols)) throw new Error('Invalid rectangular grid');
  const flat = new Float64Array(grid.length * cols);
  for (let row = 0; row < grid.length; row++) flat.set(grid[row]!, row * cols);
  return flat;
}
export function outputPath(requested: string | undefined, tmp: string, stamp: string): string {
  const path = requested ?? `${tmp}/geot-bench-${stamp}`;
  if (path.includes('w1a-frozen')) throw new Error('Refusing w1a-frozen output');
  return path;
}
export function firstCellDifference(a: Uint8Array | Uint16Array | Float32Array, b: Uint8Array | Uint16Array | Float32Array): number {
  if (a.length !== b.length || a.BYTES_PER_ELEMENT !== b.BYTES_PER_ELEMENT) return 0;
  const aa = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return Math.floor(i / a.BYTES_PER_ELEMENT);
  return -1;
}
function quantile(values: number[], p: number): number {
  const a = [...values].sort((x, y) => x-y), i = (a.length-1)*p, lo = Math.floor(i);
  return a[lo]! + (a[Math.ceil(i)]! - a[lo]!) * (i-lo);
}
export function summarize(ts: number[], wasm: number[]) {
  const stats = (a: number[]) => ({ median: quantile(a, .5), min: Math.min(...a), p10: quantile(a, .1), p90: quantile(a, .9), samples: a.length });
  let state = 0x12345678;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const ratios: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const a = ts.map(() => ts[Math.floor(random()*ts.length)]!), b = wasm.map(() => wasm[Math.floor(random()*wasm.length)]!);
    ratios.push(quantile(a, .5) / quantile(b, .5));
  }
  const a = stats(ts), b = stats(wasm);
  return { ts: a, wasm: b, ratio: a.median / b.median, bootstrap_95: [quantile(ratios, .025), quantile(ratios, .975)], bootstrap_seed: '0x12345678', bootstrap_replicates: 10000 };
}
