/**
 * R1C-WP7-1 (INFO, arbitration `evidence/r1/ARBITRAJE-cierre.md`): with a subnormal resolution
 * (res² = 0) the box-skip loop of `thinNodes` never ends, because `side × growth` rounds back to
 * `side`. Before the fix this file never finishes: it must be run under a process deadline,
 * `timeout 60 npx vitest run src/utils/optimizer/r1fix2-subnormal.test.ts`. A synchronous loop
 * cannot be interrupted by the vitest testTimeout, so the deadline is the process one.
 */
import { describe, expect, it } from "vitest";
import { thinNodes } from "./candidates";

describe("R1C-WP7-1: subnormal resolutions are rejected instead of looping forever", () => {
  const pool = Array.from({ length: 1000 }, (_, i) => i); // > 4 · 160, so the skip loop runs
  for (const resolution of [5e-324, 1e-323]) {
    it(`R1C-WP7-1: resolution ${resolution} (res² = 0) throws RangeError`, () => {
      expect(() => thinNodes(pool, 100, resolution, 0, 160, 1.25)).toThrow(RangeError);
    });
  }
});
