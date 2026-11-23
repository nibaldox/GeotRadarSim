import type { QualityPolicy } from "../utils/qualityMetrics";

export type ReportMetric = "INCIDENCE" | "PROJECTION";
export type ReportErrorCode =
  | "NO_ACTIVE_ANALYSIS" | "TRANSITION" | "STALE" | "MISSING_RADAR_RESULT"
  | "MISMATCHED_RADAR_RESULT" | "INVALID_QUALITY_CONTEXT" | "TOO_MANY_RADARS";

export class ReportError extends Error {
  constructor(readonly code: ReportErrorCode, message: string) { super(message); this.name = "ReportError"; }
}

export interface ReportAoiMetrics { areaM2: number; visiblePct: number | null; usefulPct: number | null; }

export interface ReportCoverageMetrics {
  visiblePct: number | null;          // visibilidad sobre candidatos (coverage_pct)
  visibleAreaM2: number;
  usefulPct: number | null;           // cobertura útil sobre el objetivo común (igual que el dashboard)
  usefulAreaM2: number | null;
  bandsPct: { low: number; medium: number; high: number; noIndex: number } | null; // sobre lo visible
  aoi: ReportAoiMetrics | null;
}

export interface ReportRadar {
  index: number;                      // orden en snapshot.radars, base 0
  label: string;                      // "Radar 1"
  radarId: string;
  modelId: string;
  modelName: string | null;
  color: string;                      // "#rrggbb", RADAR_COLORS[index % RADAR_COLORS.length]
  position: { x: number; y: number; z: number };
  groundZ: number | null;
  heightAboveGround: number | null;
  rangeM: number | null;              // alcance efectivo usado
  azimuthDeg: number | null;
  apertureDeg: number | null;
  analysisId: string;
  cellStates: Uint8Array;             // copia del estado LOS individual, fila mayor
  qualityValues: Float32Array | null; // índice de la métrica vigente por celda, NaN si falta
  metrics: ReportCoverageMetrics;
  exclusiveAreaM2: number | null;     // null cuando hay un solo radar
}

export interface ReportUnion {
  cellStates: Uint8Array;
  visibleCount: Uint8Array;
  qualityValues: Float32Array | null;
  metrics: ReportCoverageMetrics;
  overlapAreaM2: number;
}

export interface ReportTerrain {
  terrainId: string;
  epoch: number;
  rows: number;
  cols: number;
  resolution: number;
  bounds: { min_x: number; max_x: number; min_y: number; max_y: number; min_z: number; max_z: number };
  elevations: Float32Array;           // fila mayor; fila r → y = min_y + r·res; NaN = NODATA
}

export interface ReportModel {
  version: 1;
  createdAtIso: string;
  title: string;
  terrain: ReportTerrain;
  policy: QualityPolicy;
  metric: ReportMetric;
  qualityModel: string | null;
  radars: readonly ReportRadar[];     // 1..8
  union: ReportUnion | null;          // null si hay un solo radar
  aoi: { vertices: readonly { x: number; y: number }[]; areaM2: number } | null;
  provenance: { generation: number; sourceAnalysisIds: readonly string[] };
}

/** Raster en planta con el norte arriba. Los textos y vectores los dibuja el PDF, no el raster. */
export interface ReportRaster {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;            // width·height·4
  /** Mundo (x, y) del archivo → píxel. Fila 0 = max_y. */
  worldToPx(x: number, y: number): { px: number; py: number };
  metersPerPx: number;
  legend: readonly { label: string; color: string }[];
}

export type ReportMapTarget = { kind: "radar"; index: number } | { kind: "union" };

/** Imagen 3D de portada ya codificada; la produce el navegador (sección 4b). */
export interface ReportCoverImage {
  format: "JPEG" | "PNG";
  bytes: Uint8Array;
  width: number;
  height: number;
}
