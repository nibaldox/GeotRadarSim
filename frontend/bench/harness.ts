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
