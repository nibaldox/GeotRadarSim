import { describe, expect, it } from 'vitest';
import { hashBytes, flattenGrid } from './harness';
import { finestResolution } from './runner';
import { gridNodeCountForSpan } from '../src/utils/terrainLimits';

describe('baseline fingerprints', () => {
  it('hashes only logical bytes of a typed-array view', () => {
    const view = new Uint8Array([8, 97, 98, 99, 9]).subarray(1, 4);
    expect(hashBytes(view)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('flattens rectangular grids in row-major float64 order', () => {
    expect(Array.from(flattenGrid([[1, 2, 3], [4, 5, 6]]))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('finds a fine resolution under the actual node limit', () => {
    const r = finestResolution(1370, 1085, 2);
    expect(gridNodeCountForSpan(1370, r) * gridNodeCountForSpan(1085, r)).toBeLessThanOrEqual(1_000_000);
    expect(gridNodeCountForSpan(1370, r * (1 - 1e-12)) * gridNodeCountForSpan(1085, r * (1 - 1e-12))).toBeGreaterThan(1_000_000);
  });
  it('rejects ragged grids', () => {
    expect(() => flattenGrid([[1, 2], [3]])).toThrow();
  });
});
