import { describe, expect, it } from "vitest";
import { reportFixture1, reportFixture3 } from "./fixtures";
import { generateManagementReportPdf } from "./reportPdf";
import type { ReportRaster } from "./types";

const raster = (): ReportRaster => ({ width: 4, height: 3, rgba: new Uint8ClampedArray(48).fill(190), worldToPx: (x, y) => ({ px: x / 65, py: 2 - y / 72.5 }), metersPerPx: 65, legend: [{ label: "Calidad baja", color: "#ff0000" }] });
const pdf = async (blob: Blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let result = ""; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768)); return result; };

describe("informe gerencial", () => {
  it("integra el raster por defecto y presenta secciones legibles", async () => {
    const text = await pdf(generateManagementReportPdf(reportFixture3()));
    for (const section of ["Ubicación", "Cobertura", "Unión", "Por radar", "Cómo leer", "Definiciones", "Limitaciones", "Procedencia"]) expect(text).toContain(section);
    const sizes = [...text.matchAll(/\/(?:F\d+)\s+([\d.]+)\s+Tf/g)].map(m => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(8);
  });
  it("explica el azimut y presenta una apertura sin restricción", async () => {
    const model = reportFixture1();
    const radar = { ...model.radars[0]!, azimuthDeg: null, apertureDeg: 360 };
    const result = await pdf(generateManagementReportPdf({ ...model, radars: [radar] }, { render: raster }));
    expect(result).toContain("Sin restricción \\(360°\\)");
    expect(result).toContain("0° es el norte");
    const absent = await pdf(generateManagementReportPdf({ ...model, radars: [{ ...radar, apertureDeg: null }] }, { render: raster }));
    expect(absent).not.toContain("az. Sin datos");
    expect(absent).toContain("(Sin datos) Tj");
    const directed = await pdf(generateManagementReportPdf({ ...model, radars: [{ ...radar, azimuthDeg: -45, apertureDeg: 90 }] }, { render: raster }));
    expect(directed).toContain("az. -45,0° · apertura 90,0°");
  });
  it("usa el área del polígono en la portada y página de resultados", async () => {
    const model = { ...reportFixture1(), createdAtIso: new Date(2026, 0, 1, 12).toISOString() };
    const result = await pdf(generateManagementReportPdf({ ...model, aoi: { vertices: model.aoi!.vertices, areaM2: 123400 } }, { render: raster }));
    expect(result.match(/Área a monitorear: 12,34 ha/g)?.length).toBe(2);
    expect(result).toContain("1 de enero de 2026 · 1 radar · Área a monitorear: 12,34 ha");
    const without = await pdf(generateManagementReportPdf({ ...model, aoi: null }, { render: raster }));
    expect(without).toContain("1 de enero de 2026 · 1 radar");
    expect(without).not.toContain("Área a monitorear:");
  });
  it("dibuja una escala redonda y coordenadas abreviadas", async () => {
    const result = await pdf(generateManagementReportPdf(reportFixture1(), { render: raster }));
    expect(result).toContain("(50 m) Tj");
    expect(result).toContain("(N 145) Tj");
    expect(result).toContain("(E 195) Tj");
    expect(result).not.toContain("Este 195,0 m");
  });
  it("genera cuatro páginas para un radar y siete para tres", async () => {
    for (const [model, count] of [[reportFixture1(), 4], [reportFixture3(), 7]] as const) {
      const text = await pdf(generateManagementReportPdf(model, { render: raster }));
      expect(text).toContain(`/Count ${count}`);
      expect(text).toContain(`Página 1 de ${count}`);
      expect(text).toContain("Uso interno: contiene coordenadas de ubicación");
      expect(text).toContain("Sin datos");
      expect(text).not.toMatch(/≥|detección|SNR|precisión|tiempo real/i);
      if (count === 7) {
        expect(text).toContain("Visible por 2 o más radares");
        expect(text).toContain(`${(model.union!.overlapAreaM2 / 10000).toFixed(2).replace(".", ",")} ha`);
        for (const radar of model.radars) {
          expect(text).toContain(`E ${radar.position.x.toFixed(1).replace(".", ",")}  N ${radar.position.y.toFixed(1).replace(".", ",")}`);
        }
      } else expect(text).not.toContain("Cobertura consolidada");
    }
  });
  it("solicita el mapa consolidado e individual y proyecta radares y contorno", () => {
    const model = reportFixture3();
    const targets: string[] = [], projected: string[] = [];
    const render = (_model: typeof model, target: { kind: "union" } | { kind: "radar"; index: number }): ReportRaster => {
      targets.push(target.kind === "union" ? "union" : `radar-${target.index}`);
      return { ...raster(), worldToPx: (x, y) => { projected.push(`${x},${y}`); return { px: x / 65, py: 2 - y / 72.5 }; } };
    };
    generateManagementReportPdf(model, { render });
    expect(targets).toEqual(["union", "radar-0", "radar-1", "radar-2", "union"]);
    for (const r of model.radars) expect(projected).toContain(`${r.position.x},${r.position.y}`);
    for (const v of model.aoi!.vertices) expect(projected).toContain(`${v.x},${v.y}`);
  });
  it("mantiene bajo 15 MB el documento con ocho radares y mapa sintético de 1600 píxeles", () => {
    const model = reportFixture3();
    const eight = { ...model, radars: Array.from({ length: 8 }, (_, i) => ({ ...model.radars[i % 3]!, index: i, label: `Radar ${i + 1}` })) };
    const width = 1600, height = 1200, rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4, shade = 100 + ((x + y) % 100);
      rgba[p] = shade; rgba[p + 1] = shade; rgba[p + 2] = shade; rgba[p + 3] = 255;
    }
    const render = (): ReportRaster => ({ width, height, rgba, worldToPx: (x, y) => ({ px: x * 8, py: height - y * 8 }), metersPerPx: 0.125, legend: [] });
    const blob = generateManagementReportPdf(eight, { render });
    expect(blob.size).toBeLessThan(15_000_000);
  });
  it("conserva ambas tablas en la misma página con ocho radares", async () => {
    const model = reportFixture3();
    const radars = Array.from({ length: 8 }, (_, i) => ({ ...model.radars[i % 3]!, index: i, label: `Radar ${i + 1}` }));
    const result = await pdf(generateManagementReportPdf({ ...model, radars }, { render: raster }));
    expect(result).toContain("/Count 12");
    const page2 = result.split("endstream")[1]!;
    expect(page2).toContain("Ubicación");
    expect(page2).toContain("Cobertura");
    expect(page2).toContain("Radar 8");
  });
  it("acepta imagen de portada codificada", () => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNImXYCAAMkAcMgVWSjAAAAAElFTkSuQmCC"), c => c.charCodeAt(0));
    expect(generateManagementReportPdf(reportFixture1(), { render: raster, cover: { bytes, format: "PNG", width: 1, height: 1 } }).size).toBeGreaterThan(0);
  });
});


it("omite identificadores internos y explica las áreas visibles", async () => {
  const model = reportFixture3();
  const result = await pdf(generateManagementReportPdf({ ...model, terrain: { ...model.terrain, terrainId: "dtm-stl-import-secreto" }, provenance: { generation: 987654321, sourceAnalysisIds: ["los-job-secreto", "import-secreto", "stl-secreto"] } }, { render: raster }));
  for (const forbidden of ["dtm-", "stl-", "los-job-", "import-", "987654321", model.terrain.terrainId]) expect(result).not.toContain(forbidden);
  expect(result).toContain(`Terreno: malla ${model.terrain.cols} × ${model.terrain.rows} celdas de`);
  expect(result).toContain("Análisis: 3 seleccionados en el historial");
  expect(result).toContain("Área visible exclusiva");
  expect(result).toContain("Visible solo por Radar 1");
  expect(result).toContain("Visible por 2 o más radares");
});


it("usa singular para un análisis seleccionado", async () => {
  const text = await pdf(generateManagementReportPdf(reportFixture1(), { render: raster }));
  expect(text).toContain("Análisis: 1 seleccionado en el historial");
  expect(text).not.toContain("1 seleccionados");
});


it("coloca la portada predeterminada en el recuadro completo sin bandas apreciables", async () => {
  const { REPORT_COVER_SLOT } = await import("./reportCover3d");
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNImXYCAAMkAcMgVWSjAAAAAElFTkSuQmCC"), c => c.charCodeAt(0));
  const width = 2400, height = Math.round(width * REPORT_COVER_SLOT.height / REPORT_COVER_SLOT.width);
  const text = await pdf(generateManagementReportPdf(reportFixture1(), { render: raster, cover: { bytes, format: "PNG", width, height } }));
  const transform = text.match(/q\s+([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\s+\/I0 Do/);
  expect(transform).not.toBeNull();
  const scale = 72 / 25.4;
  expect(Number(transform![1]) / scale).toBeCloseTo(REPORT_COVER_SLOT.width, 1);
  expect(Number(transform![2]) / scale).toBeCloseTo(REPORT_COVER_SLOT.height, 1);
  expect(Number(transform![3]) / scale).toBeCloseTo(REPORT_COVER_SLOT.x, 1);
});
