/**
 * Export Engine Service.
 *
 * Provides pure functions to generate PDF reports and CSV data for LOS coverage.
 * An optional quality-report context (captured at the export click and verified
 * against the exact snapshot/result) adds the geometric-v2 useful-coverage and
 * quality metadata; without it the legacy report is generated untouched and no
 * quality summary is invented.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";
import { metricLabel } from "../utils/qualityMetrics";
import { validateQualityExportContext } from "../utils/qualityReport";
import type { QualityExportContext } from "../utils/qualityReport";

function formatNullablePercent(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(2)} %` : "Sin datos";
}

function formatPercentValue(value: number | null): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : "N/A";
}

function formatFinite(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "Sin datos";
}

function formatRadarOverrides(overrides: AnalysisSnapshot["radars"][number]["overrides"]): string {
  return ([
    ["rangeMin", overrides.rangeMin],
    ["rangeMax", overrides.rangeMax],
    ["elMin", overrides.elMin],
    ["elMax", overrides.elMax],
    ["azCenter", overrides.azCenter],
    ["azWidth", overrides.azWidth],
  ] as const)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${Number.isFinite(value) ? value : "Sin datos"}`)
    .join("; ");
}

function analysisIdsLabel(snapshot: AnalysisSnapshot): string {
  return snapshot.sourceAnalysisIds.length > 0 ? snapshot.sourceAnalysisIds.join(", ") : "Sin datos";
}

function cellStateName(state: number): string {
  switch (state) {
    case LOSCellState.NODATA: return "NODATA";
    case LOSCellState.OUT_OF_RANGE: return "OUT_OF_RANGE";
    case LOSCellState.OUTSIDE_FOV: return "OUTSIDE_FOV";
    case LOSCellState.UNKNOWN_RAY: return "UNKNOWN_RAY";
    case LOSCellState.SHADOW: return "SHADOW";
    case LOSCellState.VISIBLE: return "VISIBLE";
    default: return "UNKNOWN_RAY";
  }
}

/**
 * Verified context for the exact snapshot/result being exported, or null for a
 * direct legacy call. Any provided context that does not belong to this export
 * is rejected instead of being reported.
 */
function verifiedContext(
  context: QualityExportContext | undefined,
  snapshot: AnalysisSnapshot,
  losResult: LOSResponse,
): QualityExportContext | null {
  return context === undefined ? null : validateQualityExportContext(context, snapshot, losResult);
}

/** Measured v2 index cell value (0..1); blank for non-visible or missing indices. */
function measuredIndex(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value.toFixed(4) : "";
}

function qualityDistributionRows(context: QualityExportContext, losResult: LOSResponse): string[][] {
  const { summary, target, policy, metric, qualityModel } = context;
  const dist = summary.distribution;
  const distCell = (pct: number, count: number): string => `${pct.toFixed(2)} % (${count})`;
  return [
    ["Modelo de calidad", qualityModel],
    ["Métrica del índice", metricLabel(metric)],
    ["Umbrales de clasificación", `media >= ${policy.mediumMin}; alta >= ${policy.highMin} (provisional; no certificado)`],
    ["Objetivo común", target.label],
    ["Celdas objetivo", String(target.cellCount)],
    ["Área nominal (planar)", `${formatFinite(target.nominalAreaM2, 2)} m²`],
    ["Cobertura útil", formatNullablePercent(summary.usefulCoveragePct)],
    ["Área útil", summary.usefulAreaM2 === null ? "Sin datos" : `${formatFinite(summary.usefulAreaM2, 2)} m²`],
    ["Media + alta de lo visible", formatNullablePercent(summary.mediumHighAmongVisiblePct)],
    ["Distribución de lo visible — Baja", dist ? distCell(dist.lowPct, dist.lowCount) : "Sin datos"],
    ["Distribución de lo visible — Media", dist ? distCell(dist.mediumPct, dist.mediumCount) : "Sin datos"],
    ["Distribución de lo visible — Alta", dist ? distCell(dist.highPct, dist.highCount) : "Sin datos"],
    ["Sin índice (visible)", dist ? distCell(dist.noIndexPct, dist.noIndexCount) : "Sin datos"],
    ["Visibilidad (candidatos)", formatNullablePercent(losResult.coverage_pct)],
  ];
}

export function generatePDFBlob(
  snapshot: AnalysisSnapshot,
  losResult: LOSResponse,
  context?: QualityExportContext
): Blob {
  const qualityContext = verifiedContext(context, snapshot, losResult);
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  doc.setFontSize(18);
  doc.setTextColor(30, 40, 80);
  doc.text("GeotRadarSim — Coverage Analysis Report", 14, 20);

  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  let metadataY = 28;
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, metadataY);
  metadataY += 6;
  doc.text(`Terrain ID: ${snapshot.terrainKey.terrain_id}`, 14, metadataY);
  metadataY += 6;
  doc.text(`Terrain Epoch: ${snapshot.terrainKey.epoch}`, 14, metadataY);
  metadataY += 6;
  doc.text(`Analysis ID${snapshot.sourceAnalysisIds.length === 1 ? "" : "s"}: ${analysisIdsLabel(snapshot)}`, 14, metadataY);
  metadataY += 6;
  doc.text(`Analysis Generation: ${snapshot.generation}`, 14, metadataY);
  metadataY += 6;
  if (losResult.quality_model) {
    doc.text(`Quality Model: ${losResult.quality_model}`, 14, metadataY);
    metadataY += 6;
  }

  for (const [index, radar] of snapshot.radars.entries()) {
    const prefix = snapshot.radars.length > 1 ? `Radar ${index + 1}` : "Radar";
    doc.text(`${prefix} ID: ${radar.radarId}`, 14, metadataY);
    metadataY += 6;
    doc.text(`${prefix} Model: ${radar.radarModelId}`, 14, metadataY);
    metadataY += 6;
    doc.text(
      `${prefix} Position: X=${formatFinite(radar.position.x, 1)}  Y=${formatFinite(radar.position.y, 1)}  Z=${formatFinite(radar.position.z, 1)}`,
      14,
      metadataY
    );
    metadataY += 6;
    const overrides = formatRadarOverrides(radar.overrides);
    if (overrides) {
      doc.text(`${prefix} Overrides: ${overrides}`, 14, metadataY);
      metadataY += 6;
    }
  }

  doc.setDrawColor(180, 180, 180);
  doc.line(14, metadataY, 196, metadataY);
  metadataY += 8;

  let sectionY = metadataY;
  if (qualityContext) {
    doc.setFontSize(12);
    doc.setTextColor(30, 40, 80);
    doc.text("Cobertura útil y calidad", 14, sectionY);
    autoTable(doc, {
      startY: sectionY + 4,
      head: [["Concepto", "Valor"]],
      body: [
        ...qualityDistributionRows(qualityContext, losResult),
        ["Completitud", formatNullablePercent(losResult.completeness_pct)],
      ],
      styles: { fontSize: 10 },
      headStyles: { fillColor: [30, 120, 80] },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 70 } },
    });
    sectionY = ((doc as any).lastAutoTable?.finalY ?? sectionY + 40) + 10;
  }

  doc.setFontSize(12);
  doc.setTextColor(30, 40, 80);
  doc.text("Summary", 14, sectionY);
  const summaryStartY = sectionY + 4;


  const visibleArea = Number.isFinite(losResult.visible_area_m2)
    ? `${losResult.visible_area_m2.toFixed(2)} m²`
    : "Sin datos";
  autoTable(doc, {
    startY: summaryStartY,
    head: [["Metric", "Value"]],
    body: [
      ["Visibilidad (candidatos)", formatNullablePercent(losResult.coverage_pct)],
      ["Completitud", formatNullablePercent(losResult.completeness_pct)],
      ["Visible Area", visibleArea],
      ["Resolution", Number.isFinite(losResult.resolution) ? `${losResult.resolution} m` : "Sin datos"],
      ["Shadow Zones", String(losResult.shadow_zones.length)],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 40, 120] },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 60 } },
  });

  if (losResult.shadow_zones.length > 0) {
    const afterSummary = (doc as any).lastAutoTable?.finalY ?? 100;
    doc.setFontSize(12);
    doc.setTextColor(30, 40, 80);
    doc.text("Shadow Zones", 14, afterSummary + 10);
    autoTable(doc, {
      startY: afterSummary + 14,
      head: [["Zone ID", "Cell Count"]],
      body: losResult.shadow_zones.map((zone) => [String(zone.zone_id), String(zone.cell_count)]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [160, 60, 60] },
    });
  }

  return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
}

export function generateCSVBlob(
  snapshot: AnalysisSnapshot,
  losResult: LOSResponse,
  context?: QualityExportContext
): Blob {
  const qualityContext = verifiedContext(context, snapshot, losResult);
  const rows: string[] = [];
  rows.push("# GeotRadarSim — Coverage Analysis");
  rows.push(`# Generated,${new Date().toLocaleString()}`);
  rows.push(`# Terrain ID,${snapshot.terrainKey.terrain_id}`);
  rows.push(`# Terrain Epoch,${snapshot.terrainKey.epoch}`);
  rows.push(`# Analysis ID${snapshot.sourceAnalysisIds.length === 1 ? "" : "s"},${analysisIdsLabel(snapshot)}`);
  rows.push(`# Analysis Generation,${snapshot.generation}`);
  snapshot.radars.forEach((radar, index) => {
    const prefix = snapshot.radars.length > 1 ? `Radar ${index + 1}` : "Radar";
    rows.push(`# ${prefix} ID,${radar.radarId}`);
    rows.push(`# ${prefix} Model,${radar.radarModelId}`);
    rows.push(`# ${prefix} Position X,${formatFinite(radar.position.x, 3)}`);
    rows.push(`# ${prefix} Position Y,${formatFinite(radar.position.y, 3)}`);
    rows.push(`# ${prefix} Position Z,${formatFinite(radar.position.z, 3)}`);
    const overrides = formatRadarOverrides(radar.overrides);
    if (overrides) rows.push(`# ${prefix} Overrides,${overrides}`);
  });
  rows.push(`# Visibilidad (candidatos) %,${formatPercentValue(losResult.coverage_pct)}`);
  rows.push(`# Completitud %,${formatPercentValue(losResult.completeness_pct)}`);
  rows.push(`# Visible Area m2,${formatFinite(losResult.visible_area_m2, 2)}`);
  rows.push(`# Resolution m,${formatFinite(losResult.resolution, 3)}`);
  rows.push(`# Grid Dimensions,${losResult.grid_rows}x${losResult.grid_cols}`);
  rows.push(`# Shadow Zones,${losResult.shadow_zones.length}`);
  if (losResult.quality_model) rows.push(`# Quality Model,${losResult.quality_model}`);

  if (qualityContext) {
    const { summary, target, policy, metric, qualityModel } = qualityContext;
    const dist = summary.distribution;
    const distShare = (pct: number, count: number): string => `${pct.toFixed(2)} (${count})`;
    rows.push("");
    rows.push("# Informe de calidad (cobertura útil)");
    rows.push(`# Modelo de calidad,${qualityModel}`);
    rows.push(`# Métrica del índice,${metricLabel(metric)}`);
    rows.push(`# Umbrales de clasificación,media >= ${policy.mediumMin}; alta >= ${policy.highMin} (provisional; no certificado)`);
    rows.push(`# Objetivo común,${target.label}`);
    rows.push(`# Celdas objetivo,${target.cellCount}`);
    rows.push(`# Área nominal m2,${formatFinite(target.nominalAreaM2, 2)}`);
    rows.push(`# Cobertura útil %,${formatPercentValue(summary.usefulCoveragePct)}`);
    rows.push(`# Área útil m2,${summary.usefulAreaM2 === null ? "N/A" : formatFinite(summary.usefulAreaM2, 2)}`);
    rows.push(`# Media + alta de lo visible %,${formatPercentValue(summary.mediumHighAmongVisiblePct)}`);
    rows.push(`# Distribución baja %,${dist ? distShare(dist.lowPct, dist.lowCount) : "N/A"}`);
    rows.push(`# Distribución media %,${dist ? distShare(dist.mediumPct, dist.mediumCount) : "N/A"}`);
    rows.push(`# Distribución alta %,${dist ? distShare(dist.highPct, dist.highCount) : "N/A"}`);
    rows.push(`# Sin índice %,${dist ? distShare(dist.noIndexPct, dist.noIndexCount) : "N/A"}`);
    rows.push(`# Visibilidad (candidatos) %,${formatPercentValue(losResult.coverage_pct)}`);
    rows.push(`# Completitud %,${formatPercentValue(losResult.completeness_pct)}`);
  }

  rows.push("");
  const v2Columns = losResult.quality_model === "geometric-v2";
  if (v2Columns) {
    rows.push("# Cell States (row,col,state,incidence,projection,shadowed)");
    rows.push("# incidence/projection: solo celdas VISIBLE con índice medido; vacío = no visible o sin índice");
    rows.push("row,col,state,incidence,projection,shadowed");
  } else {
    rows.push("# Cell States (row,col,state,quality,shadowed)");
    rows.push("row,col,state,quality,shadowed");
  }

  const rowsCount = losResult.grid_rows;
  const colsCount = losResult.grid_cols;
  for (let row = 0; row < rowsCount; row++) {
    for (let col = 0; col < colsCount; col++) {
      const idx = row * colsCount + col;
      const state = losResult.cell_states?.[idx] ?? LOSCellState.UNKNOWN_RAY;
      const stateName = cellStateName(state);
      const shadowed = state === LOSCellState.SHADOW ? "1" : "0";
      if (v2Columns) {
        const incidence = state === LOSCellState.VISIBLE ? measuredIndex(losResult.flat_quality_grid?.[idx]) : "";
        const projection = state === LOSCellState.VISIBLE ? measuredIndex(losResult.flat_projection_grid?.[idx]) : "";
        rows.push(`${row},${col},${stateName},${incidence},${projection},${shadowed}`);
      } else {
        const qualityValue = losResult.quality_grid?.[row]?.[col] ?? losResult.flat_quality_grid?.[idx];
        const quality = (state === LOSCellState.VISIBLE || state === LOSCellState.SHADOW)
          && qualityValue !== undefined && Number.isFinite(qualityValue)
          ? qualityValue.toFixed(4)
          : "";
        rows.push(`${row},${col},${stateName},${quality},${shadowed}`);
      }
    }
  }

  return new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
}
