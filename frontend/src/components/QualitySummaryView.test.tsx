import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QualitySummaryView } from "./QualitySummaryView";
import { DEFAULT_QUALITY_POLICY, QUALITY_MODEL_V2 } from "../utils/qualityMetrics";
import type { QualitySummary } from "../utils/qualityMetrics";

const summary: QualitySummary = {
  metric: "INCIDENCE",
  qualityModel: QUALITY_MODEL_V2,
  policy: { ...DEFAULT_QUALITY_POLICY },
  target: { label: "Topografía válida completa", cellCount: 6, nominalAreaM2: 24 },
  usefulCount: 2,
  usefulCoveragePct: (2 / 6) * 100,
  usefulAreaM2: 8,
  visibleCount: 4,
  mediumHighAmongVisiblePct: 50,
  distribution: {
    lowCount: 1, mediumCount: 1, highCount: 1, noIndexCount: 1,
    lowPct: 25, mediumPct: 25, highPct: 25, noIndexPct: 25,
  },
};

describe("QualitySummaryView", () => {
  it("labels useful coverage with the selected metric and the shared common target", () => {
    render(
      <QualitySummaryView
        summary={summary}
        metricLabel="Incidencia superficial"
        coveragePct={66.7}
        completenessPct={100}
      />,
    );

    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("Incidencia superficial");
    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("33.3%");
    expect(screen.getByText(/del objetivo común/)).toBeInTheDocument();
    expect(screen.getByText(/Topografía válida completa/)).toHaveTextContent("6 celdas");
    expect(screen.getByText(/Topografía válida completa/)).toHaveTextContent("24");
    expect(screen.getByText(/Media \+ alta de lo visible/).parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText(/baja 25/)).toBeInTheDocument();
    expect(screen.getByText(/sin índice 25/)).toBeInTheDocument();
    expect(screen.getByText(/Área útil/).parentElement).toHaveTextContent("8 m²");
  });

  it("keeps historical visibility and completeness clearly labelled apart", () => {
    render(
      <QualitySummaryView
        summary={summary}
        metricLabel="Incidencia superficial"
        coveragePct={66.7}
        completenessPct={100}
      />,
    );

    expect(screen.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("66.7%");
    expect(screen.getByText(/Completitud/).parentElement).toHaveTextContent("100.0%");
  });

  it("shows no current quality summary for legacy or mismatched results", () => {
    render(
      <QualitySummaryView
        summary={null}
        metricLabel="Proyección del movimiento"
        coveragePct={50}
        completenessPct={100}
      />,
    );

    expect(screen.getByText(/no disponible/i)).toBeInTheDocument();
    expect(screen.getByText(/recalcular/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cobertura útil/)).not.toBeInTheDocument();
    // Old visibility metrics stay visible but clearly labelled.
    expect(screen.getByText(/Visibilidad \(candidatos\)/).parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText(/Completitud/).parentElement).toHaveTextContent("100.0%");
  });

  it("renders measured-none numbers without inventing data", () => {
    render(
      <QualitySummaryView
        summary={{ ...summary, usefulCoveragePct: 0, mediumHighAmongVisiblePct: null, distribution: null }}
        metricLabel="Incidencia superficial"
        coveragePct={null}
        completenessPct={null}
      />,
    );

    expect(screen.getByText(/Cobertura útil/).parentElement).toHaveTextContent("0.0%");
    expect(screen.getByText(/Media \+ alta de lo visible/).parentElement).toHaveTextContent("Sin datos");
  });

  it("renders a compact stacked band bar with readable labels", () => {
    render(
      <QualitySummaryView
        summary={summary}
        metricLabel="Incidencia superficial"
        coveragePct={66.7}
        completenessPct={100}
      />,
    );

    const bar = screen.getByTestId("quality-distribution-bar");
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining("baja 25.0%"));
    expect(within(bar).getByText("Baja")).toBeInTheDocument();
    expect(within(bar).getByText("Media")).toBeInTheDocument();
    expect(within(bar).getByText("Alta")).toBeInTheDocument();
    expect(within(bar).getByText("Sin índice")).toBeInTheDocument();
    // The numeric distribution line stays the single source of percentages.
    expect(screen.getByText(/baja 25\.0%/)).toBeInTheDocument();
  });
});
