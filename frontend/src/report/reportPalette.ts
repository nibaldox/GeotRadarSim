import type { QualityPolicy } from "../utils/qualityMetrics";
import type { ReportMetric } from "./types";

type RGB = readonly [number, number, number];
const incidence: readonly RGB[] = [[0.9, 0.1, 0.1], [1, 0.8, 0], [0, 0.9, 0.2]];
const projection: readonly RGB[] = [[0.5, 0, 0.5], [0.1, 0.2, 0.8], [0, 0.8, 0.8], [0, 0.9, 0.2]];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (c: RGB): string => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;

/** Shader colors at the midpoint of each policy interval. */
export function reportBandColors(metric: ReportMetric, policy: QualityPolicy): [string, string, string] {
  const centers = [policy.mediumMin / 2, (policy.mediumMin + policy.highMin) / 2, (policy.highMin + 1) / 2];
  return centers.map(q => {
    if (metric === "INCIDENCE") {
      if (q === policy.mediumMin) return hex(mix(incidence[0]!, incidence[1]!, 0.5));
      if (q === policy.highMin) return hex(mix(incidence[1]!, incidence[2]!, 0.5));
      if (q <= centers[0]!) return hex(incidence[0]!);
      if (q <= centers[1]!) return hex(mix(incidence[0]!, incidence[1]!, (q - centers[0]!) / (centers[1]! - centers[0]!)));
      return hex(mix(incidence[1]!, incidence[2]!, (q - centers[1]!) / (centers[2]! - centers[1]!)));
    }
    if (q < 0.2) return hex(mix(projection[0]!, projection[1]!, q / 0.2));
    if (q < 0.6) return hex(mix(projection[1]!, projection[2]!, (q - 0.2) / 0.4));
    return hex(mix(projection[2]!, projection[3]!, (q - 0.6) / 0.4));
  }) as [string, string, string];
}
