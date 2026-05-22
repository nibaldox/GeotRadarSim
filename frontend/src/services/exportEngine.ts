/**
 * Export Engine Service.
 * 
 * Provides pure functions to generate PDF reports (using jsPDF) and CSV data
 * representing slope monitoring radar coverage analysis results.
 * This decouples business logic from React components to enable unit testing.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Point3D, LOSResponse } from "../types/api";

export function generatePDFBlob(
  terrainId: string | undefined,
  selectedRadarId: string | null,
  radarPosition: Point3D | null,
  losResult: LOSResponse
): Blob {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // Header
  doc.setFontSize(18);
  doc.setTextColor(30, 40, 80);
  doc.text("GeotRadarSim — Coverage Analysis Report", 14, 20);

  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);
  doc.text(`Terrain ID: ${terrainId ?? "—"}`, 14, 34);
  doc.text(`Radar Model: ${selectedRadarId ?? "—"}`, 14, 40);

  if (radarPosition) {
    doc.text(
      `Radar Position: X=${radarPosition.x.toFixed(1)}  Y=${radarPosition.y.toFixed(1)}  Z=${radarPosition.z.toFixed(1)}`,
      14,
      46
    );
  }

  doc.setDrawColor(180, 180, 180);
  doc.line(14, 51, 196, 51);

  // Summary table
  doc.setFontSize(12);
  doc.setTextColor(30, 40, 80);
  doc.text("Summary", 14, 59);

  autoTable(doc, {
    startY: 63,
    head: [["Metric", "Value"]],
    body: [
      ["Coverage", `${losResult.coverage_pct.toFixed(2)} %`],
      ["Visible Area", `${losResult.visible_area_m2.toFixed(0)} m²`],
      ["Shadow Zones", String(losResult.shadow_zones.length)],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 40, 120] },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 60 } },
  });

  // Shadow zones table
  if (losResult.shadow_zones.length > 0) {
    const afterSummary = (doc as any).lastAutoTable?.finalY ?? 100;
    doc.setFontSize(12);
    doc.setTextColor(30, 40, 80);
    doc.text("Shadow Zones", 14, afterSummary + 10);

    autoTable(doc, {
      startY: afterSummary + 14,
      head: [["Zone ID", "Cell Count"]],
      body: losResult.shadow_zones.map((z) => [String(z.zone_id), String(z.cell_count)]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [160, 60, 60] },
    });
  }

  // jsPDF's output() can return an ArrayBuffer which we wrap in a Blob
  const pdfOutput = doc.output("arraybuffer");
  return new Blob([pdfOutput], { type: "application/pdf" });
}

export function generateCSVBlob(
  terrainId: string | undefined,
  selectedRadarId: string | null,
  radarPosition: Point3D | null,
  losResult: LOSResponse
): Blob {
  const rows: string[] = [];

  // Metadata header
  rows.push(`# GeotRadarSim — Coverage Analysis`);
  rows.push(`# Generated,${new Date().toLocaleString()}`);
  rows.push(`# Terrain ID,${terrainId ?? ""}`);
  rows.push(`# Radar Model,${selectedRadarId ?? ""}`);
  if (radarPosition) {
    rows.push(`# Radar Position X,${radarPosition.x.toFixed(3)}`);
    rows.push(`# Radar Position Y,${radarPosition.y.toFixed(3)}`);
    rows.push(`# Radar Position Z,${radarPosition.z.toFixed(3)}`);
  }
  rows.push(`# Coverage %,${losResult.coverage_pct.toFixed(2)}`);
  rows.push(`# Visible Area m2,${losResult.visible_area_m2.toFixed(0)}`);
  rows.push(`# Shadow Zones,${losResult.shadow_zones.length}`);
  rows.push("");

  // Quality grid
  rows.push("# Quality Grid (row,col,quality,shadowed)");
  rows.push("row,col,quality,shadowed");

  const shadowGrid = losResult.shadow_grid;
  const qualityGrid = losResult.quality_grid ?? [];

  for (let r = 0; r < shadowGrid.length; r++) {
    const shadowRow = shadowGrid[r];
    if (!shadowRow) continue;
    for (let c = 0; c < shadowRow.length; c++) {
      const shadowed = shadowRow[c] ? "1" : "0";
      const quality = qualityGrid[r]?.[c]?.toFixed(4) ?? "0.0000";
      rows.push(`${r},${c},${quality},${shadowed}`);
    }
  }

  return new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
}
