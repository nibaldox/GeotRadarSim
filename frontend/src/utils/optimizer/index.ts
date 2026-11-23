/**
 * Pure radar-position optimizer (WP7): candidates, coarse grid, objective and greedy.
 * No Workers and no WASM here; the LOS engine is injected (WP8 plugs in WASM).
 * WP14 adds the area to monitor (AOI); its polygon, mask and metric live in `utils/aoi`.
 */

export * from "./types";
export {
  CANDIDATE_DEFAULTS,
  DEFAULT_HEIGHT_ABOVE_GROUND_M,
  DEFAULT_MIN_SEPARATION_M,
  MAX_THINNING_GROWTH,
  MAX_THINNING_PASSES,
  MIN_THINNING_GROWTH,
  classifyCandidateNodes,
  generateCandidates,
  slopeDegreesGrid,
  squaredDistanceToMask,
  thinNodes,
} from "./candidates";
export type { CandidateGenerationOptions, CandidateGenerationResult, CandidateParams, ExtentNodes, NodeClassification } from "./candidates";
export { MAX_COARSE_NODES, chooseCoarsenFactor, coarseNodeCount, coarseRadarZ, coarsenGrid, validateOptimizerGrid } from "./coarsen";
export type { CoarseGrid } from "./coarsen";
export {
  UnionState,
  assertOptimizerObjective,
  assertQualityPolicy,
  evaluateUnion,
  objectiveQualityMetric,
  objectiveValueFromAoiCoverage,
  objectiveValueFromSummary,
  popcount32,
  resolveAoiMask,
  scoreLosOutput,
} from "./objective";
export type { CoverageScore } from "./objective";
export { GREEDY_GUARANTEE_SCOPE, MAX_UNION_RADARS, assertGreedyArguments, greedySelect } from "./greedy";
export type {
  GreedyCandidateInput,
  GreedyGuarantee,
  GreedyGuaranteeScope,
  GreedyOptions,
  GreedyResult,
  GreedyStep,
  GreedyStopReason,
  UnionMember,
} from "./greedy";
export { optimizeCoarse } from "./optimize";
export type {
  AoiCandidateInfo,
  AoiNoCandidatesReason,
  CoarseAoiResult,
  CoarseOptimizationInput,
  CoarseOptimizationResult,
  CoarseOptimizationStatus,
  OptimizerProgress,
} from "./optimize";
export {
  AOI_RANGE_RELATIVE_TOLERANCE,
  aoiRangeFilter,
  coarsenAoiMask,
  orientTowardsAoi,
  prepareAoiCells,
  validateAoiMaskForGrid,
  validateAoiProfile,
} from "./aoi";
export type { AoiCells, AoiOrientation, OptimizerAoiInput, OptimizerAoiProfile } from "./aoi";
