import { describe, expect, it } from "vitest";
import { regressionDigests } from "./regression.cases";
import { BASE_4207380_DIGESTS } from "./regression.fixture";

describe("WP14 regression: without an AOI the optimizer output is identical to 4207380", () => {
  it("reproduces every seeded digest recorded on the WP7 base", () => {
    expect(BASE_4207380_DIGESTS).toHaveLength(96);
    expect(regressionDigests()).toEqual(BASE_4207380_DIGESTS);
  });
});
