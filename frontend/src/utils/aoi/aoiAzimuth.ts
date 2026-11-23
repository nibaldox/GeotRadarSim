/**
 * Azimuth rules of the app, mirrored for the automatic orientation towards an AOI.
 *
 * - Bearing from a radar at (rx, ry) to a target node at (cx, cy):
 *   `atan2(cx − rx, cy − ry) · 180/π`, degrees in (−180, 180], 0 = +y (north), 90 = +x (east).
 *   Same expression as the LOS engines (`workers/losWorker.ts` isInsideAzimuth,
 *   `rust/radar-core/src/los.rs` is_inside_azimuth with fdlibm atan2).
 * - Window: `normalizeAzimuthRange(center, width)` from `services/api.ts`, copied verbatim
 *   (a differential test compares both), so this module does not import the API module.
 *   width ≥ 360 gives null = full circle.
 * - Membership: inclusive `[start, end]`, wrapping through ±180 when start > end, exactly as
 *   the engines test it.
 *
 * How the app applies an azimuth override (`services/api.ts` runLOSAnalysis): when
 * `az_center_deg` or `az_width_deg` is set, the effective window is
 * `normalizeAzimuthRange(az_center_deg ?? 0, az_width_deg ?? radar.h_beam_width_deg)` and the
 * scan pattern becomes RAR. So the width used here must be the effective one:
 * the user's `azWidthOverride`, or else the model's `h_beam_width_deg`.
 */

/** Verbatim copy of `normalizeAzimuthRange` (`services/api.ts`). */
export function aoiAzimuthWindow(center: number, width: number): [number, number] | null {
  if (!Number.isFinite(center)) {
    throw new RangeError("Azimuth center must be finite");
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError("Azimuth width must be finite and greater than 0");
  }
  if (width >= 360) return null;

  const normalizeAngle = (angle: number): number => {
    const normalized = ((angle % 360) + 360) % 360;
    return normalized > 180 ? normalized - 360 : normalized;
  };
  const normalizedCenter = normalizeAngle(center);
  const halfWidth = width / 2;

  return [
    normalizeAngle(normalizedCenter - halfWidth),
    normalizeAngle(normalizedCenter + halfWidth),
  ];
}

/** Engine bearing, degrees, from the radar to the target (dx = target − radar). */
export function bearingDeg(dx: number, dy: number): number {
  return Math.atan2(dx, dy) * (180 / Math.PI);
}

/** Engine membership test of a bearing in a window (null = full circle). */
export function isBearingInWindow(azimuth: number, window: readonly [number, number] | null): boolean {
  if (!window) return true;
  const [start, end] = window;
  return start <= end
    ? azimuth >= start && azimuth <= end
    : azimuth >= start || azimuth <= end;
}

/**
 * Smallest arc, degrees, that contains every bearing (0 for one bearing, up to < 360).
 * Bearings in (−180, 180]; computed from the largest circular gap between sorted bearings.
 */
export function angularSpreadDeg(bearings: readonly number[]): number {
  if (bearings.length <= 1) return 0;
  const sorted = Float64Array.from(bearings).sort();
  let largestGap = sorted[0]! + 360 - sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i++) largestGap = Math.max(largestGap, sorted[i]! - sorted[i - 1]!);
  return 360 - largestGap;
}
