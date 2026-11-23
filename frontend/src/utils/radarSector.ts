/**
 * Factory azimuth sector of a radar profile — the single source for what the UI shows.
 *
 * It follows the LOS Worker's own rule (`losWorker.ts` / `radar-core` los.rs):
 * the azimuth is limited only when `scan_pattern !== "SAR360"` and `azimuth_range_deg`
 * is set; otherwise the radar covers the full circle. Azimuth is measured clockwise
 * from north (+y), degrees in (−180, 180].
 */
import type { RadarConfig } from "../types/api";

export interface AzimuthSector {
  /** Sector centre in (−180, 180]; null when the radar covers the full circle. */
  centerDeg: number | null;
  /** Sector width (aperture) in degrees; 360 = full circle. */
  widthDeg: number;
}

const normalizeDeg = (angle: number): number => {
  const wrapped = ((angle % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
};

export function factoryAzimuthSector(
  radar: Pick<RadarConfig, "azimuth_range_deg" | "scan_pattern">,
): AzimuthSector {
  const range = radar.azimuth_range_deg;
  if (radar.scan_pattern === "SAR360" || !range) return { centerDeg: null, widthDeg: 360 };
  const [start, end] = range;
  const widthDeg = end >= start ? end - start : end - start + 360;
  return { centerDeg: normalizeDeg(start + widthDeg / 2), widthDeg };
}
