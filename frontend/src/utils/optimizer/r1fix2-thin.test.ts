/**
 * R1C-WP7-1 (INFO): `thinNodes` validates its resolution like `validateOptimizerGrid`
 * (finite, > 0, and a finite cell area res² > 0). The subnormal case that hangs is in
 * `r1fix2-subnormal.test.ts`, so this file can run without a process deadline.
 */
import { describe, expect, it } from "vitest";
import { thinNodes } from "./candidates";

describe("R1C-WP7-1: thinNodes validates the resolution", () => {
  const pool = Array.from({ length: 1000 }, (_, i) => i);
  for (const resolution of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1e200]) {
    it(`R1C-WP7-1: resolution ${resolution} throws RangeError`, () => {
      expect(() => thinNodes(pool, 100, resolution, 0, 160, 1.25)).toThrow(RangeError);
    });
  }

  it("R1C-WP7-1: the smallest resolution with a representable cell area (1e-160, res² = 1e-320 > 0) still thins and ends", () => {
    const result = thinNodes(pool, 100, 1e-160, 0, 160, 1.25);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThanOrEqual(160);
    expect(result.boxSideM).toBeGreaterThan(0);
  });
});
