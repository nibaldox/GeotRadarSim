/**
 * Export Engine Service.
 *
 * Provides pure functions to generate PDF reports and CSV data for LOS coverage.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

function formatNullablePercent(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(2)} %` : "Sin datos";
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

export function generatePDFBlob(
  snapshot: AnalysisSnapshot,
  losResult: LOSResponse
): Blob {
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
  doc.setFontSize(12);
  doc.setTextColor(30, 40, 80);
  doc.text("Summary", 14, metadataY);
  const summaryStartY = metadataY + 4;


  const visibleArea = Number.isFinite(losResult.visible_area_m2)
    ? `${losResult.visible_area_m2.toFixed(2)} m²`
    : "Sin datos";
  autoTable(doc, {
    startY: summaryStartY,
    head: [["Metric", "Value"]],
    body: [
      ["Coverage", formatNullablePercent(losResult.coverage_pct)],
      ["Completeness", formatNullablePercent(losResult.completeness_pct)],
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
  losResult: LOSResponse
): Blob {
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
  rows.push(`# Coverage %,${losResult.coverage_pct === null || !Number.isFinite(losResult.coverage_pct) ? "N/A" : losResult.coverage_pct.toFixed(2)}`);
  rows.push(`# Completeness %,${losResult.completeness_pct === null || !Number.isFinite(losResult.completeness_pct) ? "N/A" : losResult.completeness_pct.toFixed(2)}`);
  rows.push(`# Visible Area m2,${formatFinite(losResult.visible_area_m2, 2)}`);
  rows.push(`# Resolution m,${formatFinite(losResult.resolution, 3)}`);
  rows.push(`# Grid Dimensions,${losResult.grid_rows}x${losResult.grid_cols}`);
  rows.push(`# Shadow Zones,${losResult.shadow_zones.length}`);
  rows.push("");
  rows.push("# Cell States (row,col,state,quality,shadowed)");
  rows.push("row,col,state,quality,shadowed");

  const rowsCount = losResult.grid_rows;
  const colsCount = losResult.grid_cols;
  for (let row = 0; row < rowsCount; row++) {
    for (let col = 0; col < colsCount; col++) {
      const idx = row * colsCount + col;
      const state = losResult.cell_states?.[idx] ?? LOSCellState.UNKNOWN_RAY;
      const stateName = cellStateName(state);
      const qualityValue = losResult.quality_grid?.[row]?.[col] ?? losResult.flat_quality_grid?.[idx];
      const quality = (state === LOSCellState.VISIBLE || state === LOSCellState.SHADOW)
        && qualityValue !== undefined && Number.isFinite(qualityValue)
        ? qualityValue.toFixed(4)
        : "";
      const shadowed = state === LOSCellState.SHADOW ? "1" : "0";
      rows.push(`${row},${col},${stateName},${quality},${shadowed}`);
    }
  }

  return new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
}
