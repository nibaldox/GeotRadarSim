/** TypeScript types mirroring backend domain models. */

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  min_x: number;
  min_y: number;
  min_z: number;
  max_x: number;
  max_y: number;
  max_z: number;
}

export interface DTMMetadata {
  terrain_id: string;
  bounds: BoundingBox;
  resolution: number;
  grid_rows: number;
  grid_cols: number;
}

export interface RadarConfig {
  model_id: string;
  display_name: string;
  manufacturer: string;
  min_range_m: number;
  max_range_m: number;
  h_beam_width_deg: number;
  v_beam_width_deg: number;
  elevation_min_deg: number;
  elevation_max_deg: number;
  scan_pattern: "RAR" | "SAR360";
  azimuth_range_deg: [number, number] | null;
}

export interface ShadowZone {
  zone_id: number;
  cell_count: number;
}

/** Stable row-major cell-state codes transported as Uint8Array. */
export const LOSCellState = {
  NODATA: 0,
  OUT_OF_RANGE: 1,
  OUTSIDE_FOV: 2,
  UNKNOWN_RAY: 3,
  SHADOW: 4,
  VISIBLE: 5,
} as const;
export type LOSCellState = (typeof LOSCellState)[keyof typeof LOSCellState];

export interface LOSResponse {
  shadow_grid: boolean[][];
  /** Row-major state code per terrain cell; the source of LOS semantics. */
  cell_states: Uint8Array;
  grid_rows: number;
  grid_cols: number;
  resolution: number;
  coverage_polygon: [number, number][];
  /** Visible / (visible + shadow + unknown ray), or null when there are no candidates. */
  coverage_pct: number | null;
  /** (visible + shadow) / (visible + shadow + unknown ray), or null without candidates. */
  completeness_pct: number | null;
  visible_area_m2: number;
  shadow_zones: ShadowZone[];
  quality_grid?: number[][];
  /** Flat quality values; -1 is non-visible, while cell_states identifies its reason. */
  flat_quality_grid?: Float32Array;
}

export interface TerrainGridResponse {
  terrain_id: string;
  grid: number[][];
  metadata: DTMMetadata;
}

export interface SyntheticTerrainRequest {
  size_x: number;
  size_y: number;
  depth: number;
  resolution?: number;
}

export interface LOSRequest {
  terrain_id: string;
  radar_position: Point3D;
  radar_model_id: string;
  range_min_m?: number;
  range_max_m?: number;
  el_min_deg?: number;
  el_max_deg?: number;
  az_center_deg?: number;
  az_width_deg?: number;
}

export interface AnalysisRadarOverrides {
  readonly rangeMin: number | null;
  readonly rangeMax: number | null;
  readonly elMin: number | null;
  readonly elMax: number | null;
  readonly azCenter: number | null;
  readonly azWidth: number | null;
}

export interface AnalysisRadarSnapshot {
  readonly radarId: string;
  readonly radarModelId: string;
  readonly position: Readonly<Point3D>;
  readonly overrides: AnalysisRadarOverrides;
}

/** Immutable provenance for an LOS result (or an explicitly merged set). */
export interface AnalysisSnapshot {
  readonly terrainKey: Readonly<{ terrain_id: string; epoch: number }>;
  /** Backend job id for a single analysis; null when the result is a merge. */
  readonly analysisId: string | null;
  readonly sourceAnalysisIds: readonly string[];
  readonly generation: number;
  readonly radars: readonly AnalysisRadarSnapshot[];
}

export interface JobResponse {
  job_id: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
}

export interface JobStatusResponse {
  job_id: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  created_at: string;
  result?: any; // Can contain LOSResponse, VectorReconstructionResponse, or SensitivityMapResponse
  error?: string;
}

export interface SensitivityObservation {
  /** Stable source analysis identity; must equal snapshot.analysisId. */
  analysisId: string;
  /** Full immutable radar/terrain provenance for this individual LOS result. */
  snapshot: AnalysisSnapshot;
  grid_rows: number;
  grid_cols: number;
  resolution: number;
  /** The individual analysis mask, never a merged LOS mask. */
  cell_states: Uint8Array;
}

export interface SensitivityMapRequest {
  terrainKey: AnalysisSnapshot["terrainKey"];
  observations: readonly SensitivityObservation[];
}

export interface SensitivityMapResponse {
  terrainKey: AnalysisSnapshot["terrainKey"];
  sourceAnalysisIds: readonly string[];
  grid_rows: number;
  grid_cols: number;
  resolution: number;
  /** Row-major geometric sensitivity; NaN with observer_count=0 means no data, while finite 0 is measured. */
  flat_sensitivity_grid: Float32Array;
  /** Contributing individual observations per cell: LOS is VISIBLE and both gradient axes are finite from central or one-sided neighbors. */
  observer_count: Uint16Array;
}




