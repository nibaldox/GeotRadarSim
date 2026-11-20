import { describe, it } from 'vitest';
import { run } from './runner';

if (process.env.GEOT_BENCH_MODE) {
  describe('TS baseline', () => {
    it('runs the requested cases', async () => { await run(); }, 700_000);
  });
}
