import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisHistory } from "./AnalysisHistory";
import { useAnalysisStore } from "../store/analysisStore";

beforeEach(() => {
  useAnalysisStore.setState({
    history: [{
      position: { x: 0, y: 0, z: 1 },
      coveragePct: null,
      timestamp: "now",
      result: { coverage_pct: null },
      radarId: "test-radar",
      selected: true,
    }] as any,
  });
});

describe("AnalysisHistory NODATA display", () => {
  it("shows no-data for a result with no candidate cells", () => {
    render(<AnalysisHistory />);

    expect(screen.getByText("Sin datos")).toBeInTheDocument();
    expect(screen.queryByText(/NaN|Infinity|0\.0%/)).not.toBeInTheDocument();
  });
});
