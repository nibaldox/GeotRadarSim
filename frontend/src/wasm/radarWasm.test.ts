import { describe, expect, it } from 'vitest';
import { loadRadarWasm } from './loader';

function reference(values: number[]) {
  const finite = values.filter(Number.isFinite);
  return { finite_count: finite.length, nan_count: values.length - finite.length,
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
    mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null };
}

describe('radar WASM', () => {
  it.each([[1, NaN, -2, Infinity, 4, -Infinity], [NaN, Infinity, -Infinity, NaN]])('matches TS for %s', async (...values) => {
    const wasm = await loadRadarWasm();
    expect(wasm.grid_summary(new Float64Array(values), 2, values.length / 2)).toEqual(reference(values));
    expect(wasm.core_version()).toBe('0.1.0');
  });
  it.each([
    [1, 2, 'INVALID_DIMENSIONS'],
    [16385, 2, 'LIMIT_EXCEEDED'],
    [2, 2, 'LENGTH_MISMATCH'],
  ] as const)('returns typed error %s %s', async (rows, cols, code) => {
    const wasm = await loadRadarWasm();
    try { wasm.grid_summary(new Float64Array(0), rows, cols); throw new Error('no error'); }
    catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe(code); expect((error as Error & { code: string }).code).toBe(code); }
  });
});
