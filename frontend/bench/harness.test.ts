import { describe, expect, it } from 'vitest';
import { hashBytes, flattenGrid, outputPath, summarize, firstCellDifference } from './harness';
import { finestResolution, buildManifest } from './runner';
import { gridNodeCountForSpan } from '../src/utils/terrainLimits';

describe('frozen manifest', () => {
  it('writes the v1 schema with keys in v1 order', () => {
    expect(JSON.stringify(buildManifest('abc', 'LE', { 'a/b': { x: 1 } }))).toBe('{"schema":"geot-ts-baseline-v1","code_sha":"abc","endian":"LE","cases":{"a/b":{"x":1}}}');
  });
});

describe('benchmark controls', () => {
  it('defaults to scratch and refuses frozen paths', () => {
    expect(outputPath(undefined, '/scratch', 'stamp')).toBe('/scratch/geot-bench-stamp');
    expect(() => outputPath('/any/w1a-frozen/nested', '/scratch', 'stamp')).toThrow(/w1a-frozen/);
  });
  it('reports the first changed cell even in a float array', () => {
    expect(firstCellDifference(new Float32Array([1, 2, 3]), new Float32Array([1, 4, 5]))).toBe(1);
    expect(firstCellDifference(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(-1);
  });
  it('computes deterministic summary and bootstrap ratio', () => {
    const s = summarize([2, 4, 6], [1, 2, 3]);
    expect(s.ts.median).toBe(4);
    expect(s.wasm.median).toBe(2);
    expect(s.ratio).toBe(2);
    expect(s).toEqual(summarize([2, 4, 6], [1, 2, 3]));
  });
});

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
