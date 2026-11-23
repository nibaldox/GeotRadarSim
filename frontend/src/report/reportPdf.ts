import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { renderReportRaster } from "./reportRaster";
import { REPORT_COVER_SLOT } from "./reportCover3d";
import { zlibSync } from "fflate";
import type { ReportCoverImage, ReportMapTarget, ReportModel, ReportRaster } from "./types";

type RasterRenderer = (model: ReportModel, target: ReportMapTarget, opts?: { maxPx?: number }) => ReportRaster;
type Options = { render?: RasterRenderer; cover?: ReportCoverImage | null };
const num = (n: number | null | undefined, digits: number) => n == null || !Number.isFinite(n) ? "Sin datos" : n.toFixed(digits).replace(".", ",");
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "Sin datos" : `${num(n, 1)} %`;
const ha = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "Sin datos" : `${num(n / 10000, 2)} ha`;
const date = (iso: string) => new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));

// PNG encoding keeps large, smooth maps compressed without a canvas.
function png(raster: ReportRaster): Uint8Array {
  const { width, height, rgba } = raster;
  if (width < 1 || height < 1 || rgba.length !== width * height * 4) throw new Error("Raster inválido");
  const u32 = (n: number) => new Uint8Array([n >>> 24, n >>> 16, n >>> 8, n]);
  const chunk = (name: string, data: Uint8Array) => {
    const type = new TextEncoder().encode(name), body = new Uint8Array(type.length + data.length);
    body.set(type); body.set(data, 4);
    let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const out = new Uint8Array(body.length + 8); out.set(u32(data.length)); out.set(body, 4); out.set(u32((crc ^ 0xffffffff) >>> 0), body.length + 4); return out;
  };
  const ihdr = new Uint8Array(13); ihdr.set(u32(width)); ihdr.set(u32(height), 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const pieces = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(pieces.reduce((a, b) => a + b.length, 0)); let offset = 0;
  for (const part of pieces) { out.set(part, offset); offset += part.length; } return out;
}

export function generateManagementReportPdf(model: ReportModel, opts: Options = {}): Blob {
  const render = opts.render ?? renderReportRaster;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: false });
  const graphicsState = (opacity: number) => new (doc.GState as unknown as new (options: { opacity: number }) => ReturnType<typeof doc.GState>)({ opacity });
  const W = 297, H = 210, M = 12;
  const text = (s: string, x: number, y: number, size = 10, color = "#343c49", style: "normal" | "bold" = "normal") => { doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(color); doc.text(s, x, y); };
  const heading = (s: string) => { text(s, M, 19, 19, "#1f2a44", "bold"); doc.setDrawColor("#cbd2dd"); doc.line(M, 23, W - M, 23); };
  const map = (target: ReportMapTarget, x: number, y: number, w: number, h: number) => {
    const r = render(model, target), b = model.terrain.bounds;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    const northLabels = [`N ${num(b.max_y, 0)}`, `N ${num(b.min_y, 0)}`];
    const left = Math.max(...northLabels.map(label => doc.getTextWidth(label))) + 3;
    const scale = Math.min((w - left) / r.width, (h - 8) / r.height), iw = r.width * scale, ih = r.height * scale;
    const ix = x + left + (w - left - iw) / 2, iy = y + 2 + (h - 8 - ih) / 2;
    doc.addImage(png(r), "PNG", ix, iy, iw, ih, undefined, "FAST");
    const point = (px: number, py: number) => { const p = r.worldToPx(px, py); return { x: ix + p.px * scale, y: iy + p.py * scale }; };
    if (model.aoi && model.aoi.vertices.length > 1) { doc.setDrawColor("#2b2f36"); doc.setLineWidth(0.35); const vs = model.aoi.vertices; vs.forEach((v, i) => { const a = point(v.x, v.y), next = vs[(i + 1) % vs.length]!, b = point(next.x, next.y); doc.line(a.x, a.y, b.x, b.y); }); }
    for (const radar of model.radars) {
      const p = point(radar.position.x, radar.position.y);
      const muted = target.kind === "radar" && radar.index !== target.index;
      doc.saveGraphicsState();
      if (muted) doc.setGState(graphicsState(.45));
      doc.setFillColor(radar.color); doc.circle(p.x, p.y, muted ? 1.2 : 2, "F");
      doc.restoreGraphicsState();
      const label = `${radar.label}  E ${num(radar.position.x, 1)}  N ${num(radar.position.y, 1)}`;
      doc.setFont("helvetica", "bold"); doc.setFontSize(8);
      const lx = Math.max(x, Math.min(p.x + 2.5, x + w - doc.getTextWidth(label) - 2));
      const ly = Math.max(y + 4, Math.min(p.y - 1, y + h - 2));
      doc.saveGraphicsState(); doc.setGState(graphicsState(.85)); doc.setFillColor("#ffffff"); doc.rect(lx - .7, ly - 3, doc.getTextWidth(label) + 1.4, 4, "F"); doc.restoreGraphicsState();
      text(label, lx, ly, 8, "#1f2a44", "bold");
    }
    const worldWidth = iw / scale * r.metersPerPx;
    const exponent = Math.floor(Math.log10(worldWidth * .2));
    const candidates = [-1, 0, 1].flatMap(k => [1, 2, 5].map(n => n * 10 ** (exponent + k)));
    // The discrete 1-2-5 series cannot always hit 15–25%; choose the closest to 20% in that case.
    const inRange = candidates.filter(n => n >= worldWidth * .15 && n <= worldWidth * .25);
    const length = (inRange.length ? inRange : candidates).reduce((best, n) => Math.abs(n / worldWidth - .2) < Math.abs(best / worldWidth - .2) ? n : best);
    const bar = length / r.metersPerPx * scale;
    const label = `${num(length, Math.max(0, Math.min(10, -Math.floor(Math.log10(length)))))} m`;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.saveGraphicsState(); doc.setGState(graphicsState(.85)); doc.setFillColor("#ffffff"); doc.rect(ix + 2, iy + ih - 9, doc.getTextWidth(label) + 2, 4, "F"); doc.restoreGraphicsState();
    doc.setDrawColor("#1f2a44"); doc.setLineWidth(0.5); doc.line(ix + 3, iy + ih - 4, ix + 3 + bar, iy + ih - 4); text(label, ix + 3, iy + ih - 5.5, 8);
    text("Norte", ix + iw - 17, iy + 5, 8, "#1f2a44", "bold"); doc.line(ix + iw - 5, iy + 10, ix + iw - 5, iy + 3); doc.line(ix + iw - 5, iy + 3, ix + iw - 6.3, iy + 5); doc.line(ix + iw - 5, iy + 3, ix + iw - 3.7, iy + 5);
    doc.setDrawColor("#1f2a44"); doc.setLineWidth(0.25);
    for (const tx of [ix, ix + iw]) doc.line(tx, iy + ih, tx, iy + ih + 1.2);
    for (const ty of [iy, iy + ih]) doc.line(ix - 1.2, ty, ix, ty);
    for (const [label, ty] of [[northLabels[0]!, iy + 2], [northLabels[1]!, iy + ih]] as const) { doc.setFont("helvetica", "normal"); doc.setFontSize(8); text(label, ix - 2 - doc.getTextWidth(label), ty, 8); }
    const eastMin = `E ${num(b.min_x, 0)}`, eastMax = `E ${num(b.max_x, 0)}`;
    text(eastMin, ix, iy + ih + 5, 8); doc.setFontSize(8); text(eastMax, ix + iw - doc.getTextWidth(eastMax), iy + ih + 5, 8);
    return r;
  };
  const target: ReportMapTarget = model.union ? { kind: "union" } : { kind: "radar", index: 0 };
  const metrics = model.union?.metrics ?? model.radars[0]!.metrics;
  const slot = REPORT_COVER_SLOT;
  doc.setFillColor("#f5f6f8"); doc.rect(slot.x, slot.y, slot.width, slot.height, "F");
  if (opts.cover) {
    const c = opts.cover, ratio = Math.min(slot.width / c.width, slot.height / c.height), w = c.width * ratio, h = c.height * ratio;
    doc.addImage(c.bytes, c.format, slot.x + (slot.width - w) / 2, slot.y + (slot.height - h) / 2, w, h);
  } else map(target, slot.x, slot.y, slot.width, slot.height - 3);
  text(model.title, M, 137, 22, "#1f2a44", "bold"); doc.setDrawColor("#406b98"); doc.setLineWidth(.6); doc.line(M, 141, 75, 141);
  text(`${date(model.createdAtIso)} · ${model.radars.length} ${model.radars.length === 1 ? "radar" : "radares"}${model.aoi ? ` · Área a monitorear: ${ha(model.aoi.areaM2)}` : ""}`, M, 149, 10, "#6b7280");
  const figures = [[pct(metrics.usefulPct), "Cobertura útil"], [pct(metrics.visiblePct), "Visibilidad"], [ha(metrics.usefulAreaM2), "Área útil"], ...(metrics.aoi ? [[pct(metrics.aoi.usefulPct), "Cobertura útil del área"]] : [])];
  figures.forEach(([v, label], i) => { const x = M + i * 68; text(v!, x, 168, 18, "#1f2a44", "bold"); text(label!, x, 176, 9, "#6b7280"); });
  doc.addPage(); heading("Radares y cobertura");
  const direction = (azimuth: number | null, aperture: number | null) => azimuth == null && aperture == null ? "Sin datos" : azimuth == null && aperture === 360 ? "Sin restricción (360°)" : `az. ${azimuth == null ? "Sin datos" : num(azimuth, 1) + "°"} · apertura ${aperture == null ? "Sin datos" : num(aperture, 1) + "°"}`;
  const tableStyle = { margin: { left: M, right: M, bottom: 15 }, theme: "plain" as const, styles: { font: "helvetica", fontSize: 10, cellPadding: Math.max(1.2, Math.min(3.5, 12 / model.radars.length)), overflow: "linebreak" as const, textColor: [45, 53, 66] as [number, number, number] }, headStyles: { fillColor: [31,42,68] as [number, number, number], textColor: 255, fontStyle: "bold" as const }, alternateRowStyles: { fillColor: [245,246,248] as [number, number, number] } };
  text("Ubicación", M, 30, 11, "#1f2a44", "bold");
  autoTable(doc, { ...tableStyle, startY: 33, head: [["Radar", "Modelo", "Este (m)", "Norte (m)", "Cota (m)", "Altura sobre el terreno (m)", "Alcance (m)", "Azimut y apertura"]], body: model.radars.map(r => [r.label, r.modelName ?? "Sin datos", num(r.position.x,1), num(r.position.y,1), num(r.position.z,1), num(r.heightAboveGround,1), num(r.rangeM,1), direction(r.azimuthDeg,r.apertureDeg)]) });
  const tableEnd = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  text("Cobertura", M, tableEnd + 7, 11, "#1f2a44", "bold");
  autoTable(doc, { ...tableStyle, startY: tableEnd + 10, head: [["Radar", "Visibilidad", "Cobertura útil", "Área útil", "Área visible exclusiva", "Cobertura útil del área"]], body: model.radars.map(r => [r.label, pct(r.metrics.visiblePct), pct(r.metrics.usefulPct), ha(r.metrics.usefulAreaM2), ha(r.exclusiveAreaM2), pct(r.metrics.aoi?.usefulPct)]) });
  for (const radar of model.radars) {
    doc.addPage(); heading(radar.label); const r = map({ kind: "radar", index: radar.index }, M, 30, 180, 153);
    let y = 36; const line = (label: string, value: string) => { text(label, 200, y, 8, "#6b7280"); text(value, 200, y + 5, 10, "#1f2a44", "bold"); y += 14; };
    line("Modelo", radar.modelName ?? "Sin datos"); line("Visibilidad", pct(radar.metrics.visiblePct)); line("Cobertura útil", pct(radar.metrics.usefulPct)); line("Área útil", ha(radar.metrics.usefulAreaM2)); line("Cobertura útil del área", pct(radar.metrics.aoi?.usefulPct)); line("Coordenadas", `E ${num(radar.position.x,1)}  N ${num(radar.position.y,1)}  Cota ${num(radar.position.z,1)} m`);
    if (!model.union && model.aoi) { text(`Área a monitorear: ${ha(model.aoi.areaM2)}`, 200, y, 8); y += 7; }
    text("Colores del mapa", 200, y, 9, "#1f2a44", "bold"); y += 5; for (const item of r.legend) { doc.setFillColor(item.color); doc.rect(200, y - 2.5, 3, 3, "F"); text(item.label, 205, y, 8); y += 5; }
  }
  if (model.union) {
    doc.addPage(); heading("Cobertura consolidada"); const r = map({ kind: "union" }, M, 30, 180, 153); let y = 36;
    text("Unión", 200, y, 10, "#1f2a44", "bold"); y += 6;
    const unionItems = [["Visibilidad", pct(model.union.metrics.visiblePct)], ["Cobertura útil", pct(model.union.metrics.usefulPct)], ["Área útil", ha(model.union.metrics.usefulAreaM2)], ["Visible por 2 o más radares", ha(model.union.overlapAreaM2)], ["Cobertura útil del área", pct(model.union.metrics.aoi?.usefulPct)], ...(model.aoi ? [["Área a monitorear", ha(model.aoi.areaM2)]] : [])];
    const pair = (label: string, value: string, x: number, top: number) => { text(label, x, top, 8, "#6b7280"); text(value, x, top + 4, 11, "#1f2a44", "bold"); };
    unionItems.forEach(([label, value], i) => pair(label!, value!, 200 + (i % 2) * 44, y + Math.floor(i / 2) * 11));
    y += Math.ceil(unionItems.length / 2) * 11 + 4; text("Por radar", 200, y, 10, "#1f2a44", "bold"); y += 6;
    model.radars.forEach((radar, i) => pair(`Visible solo por ${radar.label}`, ha(radar.exclusiveAreaM2), 200 + (i % 2) * 44, y + Math.floor(i / 2) * 11));
    y += Math.ceil(model.radars.length / 2) * 11 + 4;
    for (const item of r.legend) { doc.setFillColor(item.color); doc.rect(200, y - 3, 4, 4, "F"); text(item.label, 206, y, 8); y += 5; }

  }
  doc.addPage(); heading("Anexo · Cómo leer el informe");
  const sections: [string, string[]][] = [
    ["Cómo leer", ["Los colores muestran bandas de calidad geométrica en los mapas individuales y cantidad de radares que ven cada zona en el mapa consolidado.", "El azimut se mide en grados: 0° es el norte."]],
    ["Definiciones", ["Visibilidad: proporción de posiciones candidatas visibles. Cobertura útil: proporción del terreno objetivo que alcanza el umbral de calidad elegido.", "Área visible exclusiva: zona visible solo por un radar. Visible por 2 o más radares: zona vista por varios radares."]],
    ["Limitaciones", ["Es un cálculo geométrico. El área es planimétrica. Las coordenadas usan el sistema del archivo, sin un sistema geodésico declarado."]],
    ["Procedencia", [`Terreno: malla ${model.terrain.cols} × ${model.terrain.rows} celdas de ${num(model.terrain.resolution, 1)} m`, `Análisis: ${model.radars.length} ${model.radars.length === 1 ? "seleccionado" : "seleccionados"} en el historial`, `Política: nivel medio desde ${num(model.policy.mediumMin, 2)}; nivel alto desde ${num(model.policy.highMin, 2)}.`, `Métrica: ${model.metric === "INCIDENCE" ? "incidencia" : "proyección de movimiento"}. Modelo: ${model.qualityModel ?? "Sin datos"}. Fecha: ${date(model.createdAtIso)}.`]]
  ];
  for (const [i, [title, paragraphs]] of sections.entries()) {
    const x = i < 2 ? M : 152, top = i % 2 === 0 ? 34 : 105; let ay = top;
    text(title, x, ay, 11, "#1f2a44", "bold"); ay += 7;
    for (const p of paragraphs) { doc.setFont("helvetica", "normal"); doc.setFontSize(10); const lines: string[] = doc.splitTextToSize(p, 130); for (const l of lines) { text(l, x, ay, 10); ay += 5; } ay += 3; }
  }
  const pages = doc.getNumberOfPages(); for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setDrawColor("#d4d9e0"); doc.line(M, H - 12, W - M, H - 12); text("Uso interno: contiene coordenadas de ubicación", M, H - 7, 8, "#6b7280"); text(`Página ${i} de ${pages}`, W - 34, H - 7, 8, "#6b7280"); }
  return doc.output("blob");
}
