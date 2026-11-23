/**
 * Shared types of the pure radar-position optimizer (WP7).
 *
 * Everything here is synchronous and side-effect free: no Workers, no WASM,
 * no stores. The line-of-sight engine is injected as a {@link LosScorer}, so
 * tests use a fake scorer and the optimizer Worker (WP8) plugs in WASM.
 */

/** Optimization target. The default is useful coverage by surface incidence. */
export type OptimizerObjective = "VISIBLE_AREA" | "USEFUL_INCIDENCE" | "USEFUL_PROJECTION";
export const DEFAULT_OPTIMIZER_OBJECTIVE: OptimizerObjective = "USEFUL_INCIDENCE";

/** Requested candidate family (tool argument `candidate_set`). */
export type CandidateSet = "edges_and_berms" | "regular_grid";

/**
 * Why a node is a candidate.
 * - BERM: flat node near a steep face.
 * - CREST: a BERM node at or above the elevation percentile (pit crest, an edge).
 * - PERIMETER: flat node in a band next to the valid-data (NODATA) limit (an edge).
 * - REGULAR: fallback grid of moderately sloped interior nodes.
 * - OPEN_GROUND (R14 WP14-1, AOI runs only): a regular-grid node added next to berms and
 *   edges under the open-ground quota (`generateCandidates` option `openGround`).
 */
export type CandidateKind = "BERM" | "CREST" | "PERIMETER" | "REGULAR" | "OPEN_GROUND";

/** Row-major DEM: node (row, col) sits at (min_x + col·res, min_y + row·res); NaN = NODATA. */
export interface OptimizerGrid {
  readonly grid: readonly (readonly number[])[];
  readonly bounds: Readonly<{ min_x: number; min_y: number }>;
  readonly resolution: number;
}

export interface RadarPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Candidate {
  /** Position in the candidate list (stable, row-major order). */
  readonly index: number;
  /** Full-resolution node. */
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly y: number;
  /** Exact node elevation (the triangulated surface at a node is the node value). */
  readonly groundZ: number;
  /** groundZ + height_above_ground_m. */
  readonly z: number;
  readonly kind: CandidateKind;
  readonly slopeDeg: number;
}

/** Per-cell output of one LOS evaluation, in the layout of the LOS Worker / WASM `compute_los`. */
export interface LosCellOutput {
  readonly cell_states: Uint8Array;
  readonly flat_quality_grid: Float32Array;
  readonly flat_projection_grid: Float32Array;
}

export type LosSubject =
  | { readonly kind: "candidate"; readonly index: number }
  | { readonly kind: "fixed"; readonly index: number };

export interface LosRequest {
  readonly subject: LosSubject;
  readonly position: RadarPosition;
  /** Grid the result must be expressed on (the coarse grid in the coarse pass). */
  readonly grid: OptimizerGrid;
  /**
   * WP14, only present for candidates of a run with an AOI: azimuth centre (degrees, engine
   * convention) the scorer must use, exactly as the app applies `az_center_deg`:
   * `normalizeAzimuthRange(azimuthCenterDeg, az_width_deg ?? h_beam_width_deg)` with scan
   * pattern RAR (`services/api.ts` runLOSAnalysis). Absent = the profile's own azimuth.
   */
  readonly azimuthCenterDeg?: number;
}

/**
 * WP14: AOI mask on the grid a score or union is computed on (1 = AOI cell, 0 = outside),
 * row-major like `cell_states`. Build it with `aoiMaskForGrid` (fine grid) and
 * `coarsenAoiMask` (coarse grid).
 */
export interface OptimizerAoiMask {
  readonly mask: Uint8Array;
}

/**
 * Injected line-of-sight engine. It owns the radar profile; the optimizer only
 * supplies the position and the grid. Must be deterministic for the same input.
 */
export type LosScorer = (request: LosRequest) => LosCellOutput;
