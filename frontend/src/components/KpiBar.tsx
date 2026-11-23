/**
 * KpiBar — figures bar over the viewer.
 *
 * Shows exactly what «Resultados» shows, read from the same source
 * (`useGlobalQuality`): useful coverage, visibility over candidates, useful
 * area (in ha) and, only while the area coverage is current, the useful
 * percentage of the area to monitor. The dots carry the viewer marker colors
 * of the radars in the active union. Hidden without a summary and while the
 * figures are guarded (loading, terrain transition or stale data).
 */

import { useGlobalQuality } from "../hooks/useGlobalQuality";

/** Same percent format as «Resultados» (QualitySummaryView / AoiCoverageView). */
export function formatKpiPercent(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Sin datos";
}

/** Useful area in hectares from the same m² figure «Resultados» shows. */
export function formatKpiHectares(areaM2: number | null): string {
  return areaM2 !== null && Number.isFinite(areaM2) ? `${(areaM2 / 10000).toFixed(2)} ha` : "Sin datos";
}

export function KpiBar() {
  const { summary, guarded, visibility, aoi, radarColors } = useGlobalQuality();
  if (!summary || guarded) return null;

  const items: Array<{ key: string; label: string; value: string }> = [
    { key: "useful", label: "Cobertura útil", value: formatKpiPercent(summary.usefulCoveragePct) },
    { key: "visibility", label: "Visibilidad", value: formatKpiPercent(visibility) },
    { key: "area", label: "Área útil", value: formatKpiHectares(summary.usefulAreaM2) },
  ];
  if (aoi) items.push({ key: "aoi", label: "Área a monitorear", value: formatKpiPercent(aoi.usefulPct) });

  return (
    <div className="kpi-bar" role="group" aria-label="Cifras del análisis" data-testid="kpi-bar">
      {items.map((item) => (
        <div className="kpi-bar-item" key={item.key} data-kpi={item.key}>
          <div className="kpi-bar-label">{item.label}</div>
          <div className="kpi-bar-value">{item.value}</div>
        </div>
      ))}
      {radarColors.length > 0 && (
        <div className="kpi-bar-radars" aria-label={`${radarColors.length} ${radarColors.length === 1 ? "radar" : "radares"} en la unión`}>
          {radarColors.map((color, index) => (
            <span
              key={`${color}-${index}`}
              className="kpi-bar-dot"
              data-testid="kpi-radar-dot"
              data-color={color}
              title={`Radar ${index + 1}`}
              style={{ background: color }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
