import { beforeEach, describe, expect, it } from "vitest";
import { useQualityPolicyStore } from "./qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";

beforeEach(() => {
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
});

describe("useQualityPolicyStore — shared editable thresholds", () => {
  it("starts from the provisional 0.3 / 0.7 legend bands", () => {
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.3, highMin: 0.7 });
  });

  it("applies valid threshold edits without touching any analysis data", () => {
    expect(useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.25, highMin: 0.75 })).toBe(true);
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.25, highMin: 0.75 });
  });

  it("rejects invalid changes and never silently reorders thresholds", () => {
    const before = useQualityPolicyStore.getState().policy;
    expect(useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.8, highMin: 0.2 })).toBe(false);
    expect(useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.5, highMin: 0.5 })).toBe(false);
    expect(useQualityPolicyStore.getState().setPolicy({ mediumMin: -0.2, highMin: 0.5 })).toBe(false);
    expect(useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.5, highMin: 1.5 })).toBe(false);
    expect(useQualityPolicyStore.getState().setPolicy({ mediumMin: Number.NaN, highMin: 0.7 })).toBe(false);
    expect(useQualityPolicyStore.getState().policy).toEqual(before);
  });

  it("restores the shared default policy", () => {
    useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.1, highMin: 0.9 });
    useQualityPolicyStore.getState().resetPolicy();
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.3, highMin: 0.7 });
  });
});
