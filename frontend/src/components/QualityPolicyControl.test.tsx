import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QualityPolicyControl } from "./QualityPolicyControl";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";

beforeEach(() => {
  useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
});

describe("QualityPolicyControl", () => {
  it("shows the shared provisional thresholds and applies valid edits", () => {
    render(<QualityPolicyControl />);

    const medium = screen.getByLabelText("Media mínima") as HTMLInputElement;
    const high = screen.getByLabelText("Alta mínima") as HTMLInputElement;
    expect(medium.value).toBe("0.3");
    expect(high.value).toBe("0.7");

    fireEvent.change(medium, { target: { value: "0.25" } });
    fireEvent.change(high, { target: { value: "0.75" } });
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.25, highMin: 0.75 });
    expect(screen.queryByText(/umbrales no válidos/i)).not.toBeInTheDocument();
  });

  it("rejects invalid changes visibly and keeps the previous policy without reordering", () => {
    render(<QualityPolicyControl />);

    fireEvent.change(screen.getByLabelText("Media mínima"), { target: { value: "0.9" } });

    expect(screen.getByText(/umbrales no válidos/i)).toBeInTheDocument();
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.3, highMin: 0.7 });
  });

  it("restores the provisional default bands", () => {
    useQualityPolicyStore.getState().setPolicy({ mediumMin: 0.1, highMin: 0.9 });
    render(<QualityPolicyControl />);

    fireEvent.click(screen.getByRole("button", { name: /restablecer/i }));
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.3, highMin: 0.7 });
  });

  it("states that band edits reclassify existing scores without rerunning LOS", () => {
    render(<QualityPolicyControl />);
    expect(screen.getByText(/reclasifica los resultados existentes sin recalcular el LOS/i)).toBeInTheDocument();
    expect(screen.getByText(/provisionales/i)).toBeInTheDocument();
    expect(screen.getByText(/no certificadas por equipo/i)).toBeInTheDocument();
  });

  it("keeps empty fields as visible drafts without mutating the policy", () => {
    render(<QualityPolicyControl />);

    const medium = screen.getByLabelText("Media mínima") as HTMLInputElement;
    fireEvent.change(medium, { target: { value: "" } });

    expect(medium.value).toBe("");
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.3, highMin: 0.7 });
    expect(screen.getByRole("alert")).toHaveTextContent(/complete ambos umbrales/i);

    // A later valid edit recovers and applies normally.
    fireEvent.change(medium, { target: { value: "0.2" } });
    expect(useQualityPolicyStore.getState().policy).toEqual({ mediumMin: 0.2, highMin: 0.7 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
