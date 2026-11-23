/**
 * Area to monitor (AOI, WP14): polygon validation, the DEM mask, the «Cobertura del área»
 * metric and the app's azimuth rules. Pure: no stores, Workers or WASM.
 */

export {
  AOI_MAX_ABS_COORDINATE,
  AOI_MAX_VERTICES,
  AOI_MIN_VERTICES,
  AoiError,
  aoiPolygonDistanceRange,
  pointInAoiPolygon,
  segmentsTouch,
  validateAoiPolygon,
} from "./aoiPolygon";
export type { AoiErrorCode, AoiPolygon, AoiVertex, ValidatedAoiPolygon } from "./aoiPolygon";
export { aoiMaskCellCount, aoiMaskFingerprint, aoiMaskForGrid } from "./aoiMask";
export type { AoiGrid } from "./aoiMask";
export { aoiPercent, computeAoiCoverage } from "./aoiCoverage";
export type { AoiCoverage, AoiCoverageContext } from "./aoiCoverage";
export { angularSpreadDeg, aoiAzimuthWindow, bearingDeg, isBearingInWindow } from "./aoiAzimuth";
