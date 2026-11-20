import { describe, it } from 'vitest';
import { run } from './runner';

if (process.env.GEOT_BENCH_MODE) {
  describe('TS/WASM benchmark', () => {
    it('runs the requested cases', async () => { await run(); }, 1_500_000);
  });
}
