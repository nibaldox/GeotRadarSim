import { LOSCellState } from "../types/api";
import { classifyQualityValue } from "../utils/qualityMetrics";
import { reportBandColors } from "./reportPalette";
import type { QualityPolicy } from "../utils/qualityMetrics";
import type { ReportMapTarget, ReportModel, ReportRaster } from "./types";

/** Quality category of a VISIBLE cell: 0 no index, 1 low, 2 medium, 3 high (ascending precedence). */
function qualityCategory(value: number, policy: QualityPolicy): 0 | 1 | 2 | 3 {
  const band = classifyQualityValue(value, policy);
  return band === "low" ? 1 : band === "medium" ? 2 : band === "high" ? 3 : 0;
}

export interface UnionQualityCounts { visible: number; low: number; medium: number; high: number; noIndex: number; useful: number }

/**
 * Cell counts of the union by combined quality band, with the same per-cell rule the
 * `unionQuality` map paints. `union.qualityValues` is the app's merge (`mergeResults`):
 * max incidence or RMS projection, so `useful` × resolution² is the union's useful area.
 */
export function unionQualityCounts(model: ReportModel): UnionQualityCounts | null {
  const union = model.union;
  if (!union) return null;
  const counts = [0, 0, 0, 0];
  const { elevations } = model.terrain;
  for (let i = 0; i < union.cellStates.length; i++) {
    if (union.cellStates[i] !== LOSCellState.VISIBLE || !Number.isFinite(elevations[i]!)) continue;
    counts[qualityCategory(union.qualityValues?.[i] ?? NaN, model.policy)]!++;
  }
  const [noIndex, low, medium, high] = counts as [number, number, number, number];
  return { visible: noIndex + low + medium + high, low, medium, high, noIndex, useful: medium + high };
}

/** Render a north-up, node-aligned map without browser graphics APIs. */
export function renderReportRaster(model: ReportModel, target: ReportMapTarget, opts: { maxPx?: number } = {}): ReportRaster {
  const { rows, cols, resolution, bounds, elevations } = model.terrain;
  const maxPx = opts.maxPx ?? 1600;
  if (!Number.isFinite(maxPx) || maxPx < 1) throw new RangeError("maxPx must be at least 1");
  const selected = target.kind === "radar" ? model.radars[target.index] : model.union;
  if (!selected) throw new RangeError("Report map target is unavailable");
  // Per-radar pages and the consolidated quality page share bands, colours and labels.
  const byQuality = target.kind !== "union";
  const k = Math.ceil(Math.max(rows, cols) / Math.floor(maxPx));
  const width = Math.ceil(cols / k), height = Math.ceil(rows / k);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const colors = byQuality ? [...reportBandColors(model.metric, model.policy), "#9e9e9e"] : ["#9ecae1", "#4292c6", "#08519c"];
  const labels = byQuality ? ["Calidad baja", "Calidad media", "Calidad alta", "Visible sin índice"] : ["Visto por 1 radar", "Visto por 2 radares", "Visto por 3 o más radares"];
  const legend = colors.map((color, i) => ({ color, label: labels[i]! }));
  const rgb = colors.map(c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const states = selected.cellStates;
  const quality = selected.qualityValues;
  const counts = byQuality ? null : model.union!.visibleCount;
  const invSqrt2 = Math.SQRT1_2;

  // Centered differences where available, otherwise one-sided; gaps never create cliffs.
  function shade(row: number, col: number, z: number): number {
    const west = col > 0 ? elevations[row * cols + col - 1]! : NaN;
    const east = col + 1 < cols ? elevations[row * cols + col + 1]! : NaN;
    const south = row > 0 ? elevations[(row - 1) * cols + col]! : NaN;
    const north = row + 1 < rows ? elevations[(row + 1) * cols + col]! : NaN;
    const dx = Number.isFinite(west) && Number.isFinite(east) ? (east - west) / (2 * resolution) : Number.isFinite(east) ? (east - z) / resolution : Number.isFinite(west) ? (z - west) / resolution : 0;
    const dy = Number.isFinite(south) && Number.isFinite(north) ? (north - south) / (2 * resolution) : Number.isFinite(north) ? (north - z) / resolution : Number.isFinite(south) ? (z - south) / resolution : 0;
    // Light direction for azimuth 315 degrees clockwise from north, elevation 45 degrees.
    const dot = (dx * 0.5 - dy * 0.5 + invSqrt2) / Math.hypot(dx, dy, 1);
    return Math.round(70 + 155 * Math.max(0, Math.min(1, dot)));
  }
  for (let py = 0; py < height; py++) {
    const top = rows - 1 - py * k;
    const bottom = Math.max(0, top - k + 1);
    for (let px = 0; px < width; px++) {
      let valid = 0, visible = 0, sum = 0;
      // Categories in ascending precedence: no-index, low, medium, high.
      const frequencies = [0, 0, 0, 0];
      for (let row = top; row >= bottom; row--) {
        for (let col = px * k; col < Math.min(cols, (px + 1) * k); col++) {
          const i = row * cols + col, z = elevations[i]!;
          if (!Number.isFinite(z) || states[i] === LOSCellState.NODATA) continue;
          valid++; sum += shade(row, col, z);
          if (states[i] !== LOSCellState.VISIBLE) continue;
          visible++;
          if (counts) {
            const count = counts[i]!;
            if (count > 0) frequencies[Math.min(count, 3)]!++;
          } else {
            frequencies[qualityCategory(quality?.[i] ?? NaN, model.policy)]!++;
          }
        }
      }
      const out = (py * width + px) * 4;
      if (!valid) { rgba.set([255, 255, 255, 255], out); continue; }
      const gray = Math.round(sum / valid);
      let winner = -1, best = 0;
      if (visible * 2 >= valid) {
        for (let i = 0; i < 4; i++) if (frequencies[i]! > 0 && frequencies[i]! >= best) { best = frequencies[i]!; winner = i; }
      }
      const colorIndex = counts ? winner - 1 : winner === 0 ? 3 : winner - 1;
      const tint = winner < 0 ? undefined : rgb[colorIndex];
      for (let channel = 0; channel < 3; channel++) rgba[out + channel] = tint ? Math.round(gray * 0.25 + tint[channel]! * 0.75) : gray;
      rgba[out + 3] = 255;
    }
  }
  return { width, height, rgba, metersPerPx: resolution * k, legend,
    worldToPx: (x, y) => ({ px: (x - bounds.min_x) / (resolution * k), py: (bounds.max_y - y) / (resolution * k) }) };
}
