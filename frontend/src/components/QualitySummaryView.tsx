/**
 * QualitySummaryView — shared summary block for history cards and the global
 * summary: useful coverage over the common target with its metric identity,
 * media+alta over visible cells, the compact distribution with the explicit
 * Sin índice bucket, useful area, and the original visibility/completeness
 * metrics clearly labelled as historical.
 */

import type { QualityDistribution, QualitySummary } from "../utils/qualityMetrics";

function formatPercent(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Sin datos";
}

function distributionLine(distribution: QualityDistribution | null): string {
  if (!distribution) return "Sin datos";
  return `baja ${distribution.lowPct.toFixed(1)}% · media ${distribution.mediumPct.toFixed(1)}% · ` +
    `alta ${distribution.highPct.toFixed(1)}% · sin índice ${distribution.noIndexPct.toFixed(1)}%`;
}

const BAND_COLORS = {
  low: "var(--error, #e74c3c)",
  medium: "var(--warning, #f1c40f)",
  high: "var(--success, #2ecc71)",
  none: "var(--text-secondary, #888888)",
} as const;

/** Compact stacked band bar; readable labels stay distinct from the numeric line. */
function DistributionBar({ distribution }: { distribution: QualityDistribution }) {
  const segments = [
    { label: "Baja", pct: distribution.lowPct, color: BAND_COLORS.low },
    { label: "Media", pct: distribution.mediumPct, color: BAND_COLORS.medium },
    { label: "Alta", pct: distribution.highPct, color: BAND_COLORS.high },
    { label: "Sin índice", pct: distribution.noIndexPct, color: BAND_COLORS.none },
  ];
  return (
    <div data-testid="quality-distribution-bar" role="img" aria-label={distributionLine(distribution)}>
      <div style={{ display: "flex", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
        {segments.map((segment) => (
          <div
            key={segment.label}
            title={`${segment.label}: ${segment.pct.toFixed(1)}%`}
            style={{ width: `${segment.pct}%`, background: segment.color }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "9px", opacity: 0.85, marginTop: "2px" }}>
        {segments.map((segment) => (
          <span key={segment.label} style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
            <span aria-hidden="true" style={{ width: "8px", height: "8px", borderRadius: "2px", background: segment.color, display: "inline-block" }} />
            {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface QualitySummaryViewProps {
  /** null = current quality unavailable (legacy/unversioned, wrong version or mismatched terrain). */
  summary: QualitySummary | null;
  /** Explicit metric identity: "Incidencia superficial" or "Proyección del movimiento". */
  metricLabel: string;
  /** Historical visibility over candidates. */
  coveragePct: number | null;
  completenessPct: number | null;
  compact?: boolean;
}

export function QualitySummaryView({
  summary,
  metricLabel,
  coveragePct,
  completenessPct,
  compact = false,
}: QualitySummaryViewProps) {
  return (
    <div
      data-testid="quality-summary"
      className="text-sm"
      style={compact ? { fontFamily: "var(--font-mono)", fontSize: "10px", display: "flex", flexDirection: "column", gap: "2px" } : undefined}
    >
      {summary ? (
        <>
          <div>
            <strong>Cobertura útil</strong> ({metricLabel}): {formatPercent(summary.usefulCoveragePct)} del objetivo común
          </div>
          <div>
            Objetivo común: {summary.target.label} — {summary.target.cellCount} celdas ·{" "}
            {Number.isFinite(summary.target.nominalAreaM2) ? `${summary.target.nominalAreaM2.toFixed(0)} m²` : "Sin datos"} (nominal)
          </div>
          <div>
            <strong>Media + alta de lo visible:</strong> {formatPercent(summary.mediumHighAmongVisiblePct)}
          </div>
          <div>
            <strong>Visible:</strong> {distributionLine(summary.distribution)}
          </div>
          {summary.distribution && <DistributionBar distribution={summary.distribution} />}
          <div>
            <strong>Área útil:</strong>{" "}
            {summary.usefulAreaM2 !== null && Number.isFinite(summary.usefulAreaM2)
              ? `${summary.usefulAreaM2.toFixed(0)} m²`
              : "Sin datos"}
          </div>
        </>
      ) : (
        <div>
          Índice geométrico no disponible (resultado anterior, versión no vigente o terreno distinto).
          Recalcular el análisis para obtener el resumen de calidad.
        </div>
      )}
      <div>
        <strong>Completitud:</strong> {formatPercent(completenessPct)}
      </div>
      <div>
        <strong>Visibilidad (candidatos):</strong> {formatPercent(coveragePct)}
      </div>
    </div>
  );
}
