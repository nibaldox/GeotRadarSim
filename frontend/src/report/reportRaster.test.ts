import { describe, expect, it } from "vitest";
import { LOSCellState as S } from "../types/api";
import { reportFixture1, reportFixture3 } from "./fixtures";
import { renderReportRaster, unionQualityCounts } from "./reportRaster";
import { reportBandColors } from "./reportPalette";
import type { ReportModel, ReportRaster } from "./types";

function grid(rows: number, cols: number): ReportModel {
  const model = reportFixture3();
  const size = rows * cols;
  model.terrain = { ...model.terrain, rows, cols, resolution: 10,
    bounds: { min_x: 100, max_x: 100 + (cols - 1) * 10, min_y: 200, max_y: 200 + (rows - 1) * 10, min_z: 0, max_z: 0 },
    elevations: new Float32Array(size) };
  model.radars = model.radars.map(r => ({ ...r, cellStates: new Uint8Array(size).fill(S.OUT_OF_RANGE), qualityValues: new Float32Array(size).fill(NaN) }));
  model.union = { ...model.union!, cellStates: new Uint8Array(size).fill(S.OUT_OF_RANGE), visibleCount: new Uint8Array(size) };
  return model;
}
function pixel(r: ReportRaster, x: number, y: number): number[] {
  return [...r.rgba.slice((y * r.width + x) * 4, (y * r.width + x + 1) * 4)];
}
function blend(hex: string, gray: number): number[] {
  const rgb = hex.match(/[\da-f]{2}/gi)!.map(c => parseInt(c, 16));
  return [...rgb.map(c => Math.round(c * 0.75 + gray * 0.25)), 255];
}

describe("renderReportRaster", () => {
  it("orients a rectangular grid north-up and maps all four corner nodes", () => {
    const m = grid(3, 5); const r0 = m.radars[0]!;
    r0.cellStates[2 * 5 + 1] = S.VISIBLE; r0.qualityValues![11] = 0.9;
    const r = renderReportRaster(m, { kind: "radar", index: 0 });
    expect([r.width, r.height, r.metersPerPx]).toEqual([5, 3, 10]);
    expect(r.worldToPx(100, 220)).toEqual({ px: 0, py: 0 });
    expect(r.worldToPx(140, 220)).toEqual({ px: 4, py: 0 });
    expect(r.worldToPx(100, 200)).toEqual({ px: 0, py: 2 });
    expect(r.worldToPx(140, 200)).toEqual({ px: 4, py: 2 });
    expect(pixel(r, 1, 0)).toEqual(blend(r.legend[2]!.color, 180));
    expect(pixel(r, 1, 2)).toEqual([180, 180, 180, 255]);
  });
  it("paints bands, missing index and leaves shadow and out of range uncolored; NODATA white", () => {
    const m = grid(1, 7); const radar = m.radars[0]!;
    radar.cellStates.set([S.VISIBLE, S.VISIBLE, S.VISIBLE, S.VISIBLE, S.SHADOW, S.OUT_OF_RANGE, S.NODATA]);
    radar.qualityValues!.set([0, 0.3, 0.7, NaN, 0.8, 0.8, 0.8]); m.terrain.elevations[6] = NaN;
    const r = renderReportRaster(m, { kind: "radar", index: 0 });
    expect(r.legend.map(x => x.label)).toEqual(["Calidad baja", "Calidad media", "Calidad alta", "Visible sin índice"]);
    for (let x = 0; x < 4; x++) expect(pixel(r, x, 0)).toEqual(blend(r.legend[x]!.color, 180));
    expect(r.legend[3]!.color).toBe("#9e9e9e");
    expect(pixel(r, 4, 0)).toEqual([180, 180, 180, 255]);
    expect(pixel(r, 5, 0)).toEqual([180, 180, 180, 255]);
    expect(pixel(r, 6, 0)).toEqual([255, 255, 255, 255]);
  });
  it("renders count 1, 2 and 3 or more in the union", () => {
    const m = grid(1, 4); m.union!.cellStates.set([S.VISIBLE, S.VISIBLE, S.VISIBLE, S.VISIBLE]); m.union!.visibleCount.set([1, 2, 3, 8]);
    const r = renderReportRaster(m, { kind: "union" });
    expect(r.legend.map(x => x.color)).toEqual(["#9ecae1", "#4292c6", "#08519c"]);
    expect(r.legend.map(x => x.label)).toEqual(["Visto por 1 radar", "Visto por 2 radares", "Visto por 3 o más radares"]);
    [0, 1, 2, 2].forEach((c, x) => expect(pixel(r, x, 0)).toEqual(blend(r.legend[c]!.color, 180)));
  });
  it("reduces blocks with half-visible threshold and higher-band tie break", () => {
    const m = grid(2, 4); const a = m.radars[0]!;
    a.cellStates.set([S.VISIBLE, S.SHADOW, S.VISIBLE, S.SHADOW, S.VISIBLE, S.SHADOW, S.OUT_OF_RANGE, S.SHADOW]);
    a.qualityValues!.set([0.1, NaN, 0.9, NaN, 0.8, NaN, NaN, NaN]);
    const r = renderReportRaster(m, { kind: "radar", index: 0 }, { maxPx: 2 });
    expect([r.width, r.height, r.metersPerPx]).toEqual([2, 1, 20]);
    expect(pixel(r, 0, 0)).toEqual(blend(r.legend[2]!.color, 180));
    expect(pixel(r, 1, 0)).toEqual([180, 180, 180, 255]);
    expect(r.worldToPx(130, 200)).toEqual({ px: 1.5, py: 0.5 });
  });
  it("reduces union counts by mode with highest tie, excluding NODATA", () => {
    const m = grid(2, 2); m.terrain.elevations[0] = NaN;
    m.union!.cellStates.set([S.NODATA, S.VISIBLE, S.VISIBLE, S.SHADOW]); m.union!.visibleCount.set([0, 1, 2, 0]);
    const r = renderReportRaster(m, { kind: "union" }, { maxPx: 1 });
    expect(pixel(r, 0, 0)).toEqual(blend("#4292c6", 180));
  });
  it("renders shared one- and three-radar fixtures without mutating them", () => {
    for (const m of [reportFixture1(), reportFixture3()]) {
      const before = [...m.terrain.elevations];
      const r = renderReportRaster(m, { kind: "radar", index: 0 });
      expect([r.width, r.height]).toEqual([40, 30]); expect(pixel(r, 0, 0)).toEqual([255, 255, 255, 255]);
      if (m.union) expect(renderReportRaster(m, { kind: "union" }).rgba).toHaveLength(4800);
      expect([...m.terrain.elevations]).toEqual(before);
    }
  });
  it("measures eight radar rasters plus union at one million cells", () => {
    const m = grid(1000, 1000);
    const base = m.radars[0]!;
    base.cellStates.fill(S.VISIBLE); base.qualityValues!.fill(0.5);
    m.radars = Array.from({ length: 8 }, (_, index) => ({ ...base, index }));
    m.union!.cellStates.fill(S.VISIBLE); m.union!.visibleCount.fill(3);
    const start = performance.now();
    for (let index = 0; index < 8; index++) expect(renderReportRaster(m, { kind: "radar", index }).rgba.length).toBe(4_000_000);
    expect(renderReportRaster(m, { kind: "union" }).rgba.length).toBe(4_000_000);
    console.info(`Raster benchmark: ${(performance.now() - start).toFixed(1)} ms (8 radars + union, 1000x1000)`);
  });
  it("paints the combined union quality by band with the per-radar colours; non-visible stays uncoloured", () => {
    for (const metric of ["INCIDENCE", "PROJECTION"] as const) {
      const m = grid(1, 7); m.metric = metric; const u = m.union!;
      u.cellStates.set([S.VISIBLE, S.VISIBLE, S.VISIBLE, S.VISIBLE, S.SHADOW, S.OUT_OF_RANGE, S.NODATA]);
      u.qualityValues = new Float32Array([0, 0.3, 0.7, NaN, 0.8, 0.8, 0.8]); m.terrain.elevations[6] = NaN;
      u.visibleCount.set([3, 3, 3, 3, 0, 0, 0]);
      const r = renderReportRaster(m, { kind: "unionQuality" });
      expect(r.legend.map(x => x.label)).toEqual(["Calidad baja", "Calidad media", "Calidad alta", "Visible sin índice"]);
      expect(r.legend.map(x => x.color)).toEqual([...reportBandColors(metric, m.policy), "#9e9e9e"]);
      expect(r.legend.map(x => x.color)).toEqual(renderReportRaster(m, { kind: "radar", index: 0 }).legend.map(x => x.color));
      for (let x = 0; x < 4; x++) expect(pixel(r, x, 0)).toEqual(blend(r.legend[x]!.color, 180));
      expect(pixel(r, 4, 0)).toEqual([180, 180, 180, 255]);
      expect(pixel(r, 5, 0)).toEqual([180, 180, 180, 255]);
      expect(pixel(r, 6, 0)).toEqual([255, 255, 255, 255]);
    }
    const incidence = reportBandColors("INCIDENCE", { mediumMin: 0.3, highMin: 0.7 });
    expect(incidence).toEqual(["#e61a1a", "#ffcc00", "#00e633"]);
  });
  it("counts union bands exactly as the painted cells (useful = medium + high)", () => {
    const m = grid(6, 5); const u = m.union!; const size = 30;
    u.qualityValues = new Float32Array(size).fill(NaN);
    const states = [S.VISIBLE, S.VISIBLE, S.VISIBLE, S.VISIBLE, S.SHADOW, S.OUT_OF_RANGE, S.OUTSIDE_FOV, S.UNKNOWN_RAY];
    const values = [0.05, 0.3, 0.55, 0.7, 0.99, NaN, 1, Math.fround(0.3) - 1e-7];
    for (let i = 0; i < size; i++) { u.cellStates[i] = states[i % states.length]!; u.qualityValues[i] = values[(i + Math.floor(i / 8)) % values.length]!; }
    u.cellStates[29] = S.NODATA; m.terrain.elevations[29] = NaN;
    const counts = unionQualityCounts(m)!;
    const r = renderReportRaster(m, { kind: "unionQuality" });
    const painted = [0, 0, 0, 0];
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const p = pixel(r, x, y), hit = r.legend.findIndex(item => blend(item.color, 180).every((c, i) => c === p[i]));
      if (hit >= 0) painted[hit]!++;
    }
    expect(painted).toEqual([counts.low, counts.medium, counts.high, counts.noIndex]);
    expect(counts.visible).toBe(counts.low + counts.medium + counts.high + counts.noIndex);
    expect(counts.useful).toBe(counts.medium + counts.high);
    expect(counts.visible).toBeGreaterThan(0); expect(counts.low * counts.medium * counts.high * counts.noIndex).toBeGreaterThan(0);
    expect(unionQualityCounts(reportFixture1())).toBeNull();
  });
  it("matches the shared three-radar fixture's union figures", () => {
    const m = reportFixture3(); const counts = unionQualityCounts(m)!; const cell = m.terrain.resolution ** 2;
    expect(counts.useful * cell).toBe(m.union!.metrics.usefulAreaM2);
    expect(counts.visible * cell).toBe(m.union!.metrics.visibleAreaM2);
    const pct = (n: number) => 100 * n / counts.visible;
    expect([pct(counts.low), pct(counts.medium), pct(counts.high), pct(counts.noIndex)])
      .toEqual([m.union!.metrics.bandsPct!.low, m.union!.metrics.bandsPct!.medium, m.union!.metrics.bandsPct!.high, m.union!.metrics.bandsPct!.noIndex]);
  });
  it("shades opposing terrain slopes differently with north-west illumination", () => {
    const m = grid(3, 3); m.terrain.elevations.set([0, 10, 20, 0, 10, 20, 0, 10, 20]);
    const east = pixel(renderReportRaster(m, { kind: "radar", index: 0 }), 1, 1)[0]!;
    m.terrain.elevations.set([20, 10, 0, 20, 10, 0, 20, 10, 0]);
    const west = pixel(renderReportRaster(m, { kind: "radar", index: 0 }), 1, 1)[0]!;
    expect(east).toBeGreaterThan(west); expect(west).toBeGreaterThanOrEqual(70); expect(east).toBeLessThanOrEqual(225);
  });
});
