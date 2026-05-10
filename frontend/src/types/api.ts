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

export interface LOSResponse {
  shadow_grid: boolean[][];
  coverage_polygon: [number, number][];
  coverage_pct: number;
  visible_area_m2: number;
  shadow_zones: ShadowZone[];
  quality_grid?: number[][];
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

export interface JobResponse {
  job_id: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
}

export interface JobStatusResponse {
  job_id: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  created_at: string;
  result?: LOSResponse;
  error?: string;
}

