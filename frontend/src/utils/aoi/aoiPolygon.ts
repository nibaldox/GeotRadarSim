/**
 * Area to monitor (AOI): a simple polygon in the terrain's own horizontal frame.
 *
 * Coordinate system: the same as `analysisStore.radarPosition` and the LOS engine, i.e. the
 * frame of the terrain metadata bounds. x is Easting and y is Northing; DEM node (row, col)
 * sits at (bounds.min_x + col·res, bounds.min_y + row·res) with no half-cell offset
 * (`workers/losWorker.ts` computeLOS: `cy = bounds.min_y + r * resolution`,
 * `cx = bounds.min_x + c * resolution`, `dx = cx - rx`). A click on the viewer becomes
 * `{ x: point.x + min_x, y: min_y - point.z }` (`App.tsx` handleTerrainClick), and the
 * mesh puts node (r, c) at local (c·res, −r·res) (`TerrainViewer.tsx` "Local X/Z of a DEM node").
 *
 * Validation (all failures are {@link AoiError}, a RangeError with a code):
 * - 3 to 64 vertices after dropping an explicit closing vertex equal to the first;
 * - finite coordinates with |x|, |y| ≤ 1e12 (`AOI_COORDINATES_TOO_LARGE`): terrain coordinates
 *   are metres (UTM ≈ 1e7), and beyond that the products of the orientation tests can overflow;
 * - no repeated vertex;
 * - finite signed area (shoelace);
 * - simple: no two non-adjacent edges touch or cross, and no two adjacent edges fold back
 *   over each other (so collinear "polygons" fail here). Orientation tests use double
 *   arithmetic on the given coordinates;
 * - non-zero area (shoelace relative to the first vertex, so absolute UTM coordinates do not
 *   cancel a small area).
 *
 * Canonical ring (R14 WP14-8): the validated vertices are counter-clockwise and start at the
 * lexicographically smallest vertex (smallest x, then smallest y). Every later computation
 * (the mask, the distances) runs on that ring, so the result does not depend on the order or
 * the direction in which the user drew the vertices.
 *
 * Point membership is closed: a point on an edge or a vertex is inside. The test is exact
 * for points that lie on an edge in double arithmetic (cross product exactly 0), which
 * includes every vertex and every node on an axis-aligned edge; elsewhere the even-odd
 * crossing rule decides.
 */

export interface AoiVertex {
  readonly x: number;
  readonly y: number;
}

export interface AoiPolygon {
  readonly vertices: ReadonlyArray<AoiVertex>;
}

export const AOI_MIN_VERTICES = 3;
export const AOI_MAX_VERTICES = 64;
/** Largest accepted |coordinate|, metres (see the module doc). */
export const AOI_MAX_ABS_COORDINATE = 1e12;

export type AoiErrorCode =
  | "AOI_INVALID"
  | "AOI_TOO_FEW_VERTICES"
  | "AOI_TOO_MANY_VERTICES"
  | "AOI_NON_FINITE"
  | "AOI_COORDINATES_TOO_LARGE"
  | "AOI_DUPLICATE_VERTEX"
  | "AOI_ZERO_AREA"
  | "AOI_SELF_INTERSECTION"
  | "AOI_GRID_INVALID"
  | "AOI_OUTSIDE_TERRAIN"
  | "AOI_NO_VALID_CELLS";

/** Typed validation error of the AOI. `code` is stable; the message is for logs. */
export class AoiError extends RangeError {
  readonly code: AoiErrorCode;
  constructor(code: AoiErrorCode, message: string) {
    super(message);
    this.name = "AoiError";
    this.code = code;
  }
}

/** Validated polygon: open ring (no closing duplicate), 3–64 vertices, simple, non-zero area. */
export interface ValidatedAoiPolygon {
  readonly vertices: ReadonlyArray<AoiVertex>;
  /** Signed shoelace area, m² (positive = counter-clockwise in x/y). */
  readonly signedAreaM2: number;
  readonly bbox: Readonly<{ min_x: number; min_y: number; max_x: number; max_y: number }>;
}

const cross = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
  (bx - ax) * (py - ay) - (by - ay) * (px - ax);

const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

/** p lies on the closed segment a–b, given that a, b, p are collinear. */
const withinBox = (a: AoiVertex, b: AoiVertex, p: AoiVertex): boolean =>
  Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) &&
  Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);

/** Closed segments a–b and c–d share at least one point. */
export function segmentsTouch(a: AoiVertex, b: AoiVertex, c: AoiVertex, d: AoiVertex): boolean {
  const o1 = sign(cross(a.x, a.y, b.x, b.y, c.x, c.y));
  const o2 = sign(cross(a.x, a.y, b.x, b.y, d.x, d.y));
  const o3 = sign(cross(c.x, c.y, d.x, d.y, a.x, a.y));
  const o4 = sign(cross(c.x, c.y, d.x, d.y, b.x, b.y));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && withinBox(a, b, c)) return true;
  if (o2 === 0 && withinBox(a, b, d)) return true;
  if (o3 === 0 && withinBox(c, d, a)) return true;
  if (o4 === 0 && withinBox(c, d, b)) return true;
  return false;
}

/** Twice the signed area, relative to the first vertex (avoids cancellation at UTM coordinates). */
function shoelace(vertices: readonly AoiVertex[]): number {
  const n = vertices.length;
  const x0 = vertices[0]!.x;
  const y0 = vertices[0]!.y;
  let twiceArea = 0;
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    twiceArea += (a.x - x0) * (b.y - y0) - (b.x - x0) * (a.y - y0);
  }
  return twiceArea;
}

/** Counter-clockwise ring starting at the lexicographically smallest vertex (x, then y). */
function canonicalRing(vertices: readonly AoiVertex[]): AoiVertex[] {
  const ring = shoelace(vertices) < 0 ? [...vertices].reverse() : [...vertices];
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    const v = ring[i]!;
    const s = ring[start]!;
    if (v.x < s.x || (v.x === s.x && v.y < s.y)) start = i;
  }
  return [...ring.slice(start), ...ring.slice(0, start)];
}

export function validateAoiPolygon(polygon: AoiPolygon): ValidatedAoiPolygon {
  if (!polygon || typeof polygon !== "object" || !Array.isArray(polygon.vertices)) {
    throw new AoiError("AOI_INVALID", "AOI must be an object with a vertices array");
  }
  const raw = polygon.vertices;
  for (const vertex of raw) {
    if (!vertex || typeof vertex !== "object" || !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
      throw new AoiError("AOI_NON_FINITE", "AOI vertex coordinates must be finite numbers");
    }
    if (Math.abs(vertex.x) > AOI_MAX_ABS_COORDINATE || Math.abs(vertex.y) > AOI_MAX_ABS_COORDINATE) {
      throw new AoiError("AOI_COORDINATES_TOO_LARGE", `AOI vertex coordinates must be within ±${AOI_MAX_ABS_COORDINATE} m`);
    }
  }
  let vertices: AoiVertex[] = raw.map((vertex) => ({ x: vertex.x, y: vertex.y }));
  if (vertices.length >= 2) {
    const first = vertices[0]!;
    const last = vertices[vertices.length - 1]!;
    if (first.x === last.x && first.y === last.y) vertices = vertices.slice(0, -1);
  }
  if (vertices.length < AOI_MIN_VERTICES) {
    throw new AoiError("AOI_TOO_FEW_VERTICES", `AOI needs at least ${AOI_MIN_VERTICES} distinct vertices`);
  }
  if (vertices.length > AOI_MAX_VERTICES) {
    throw new AoiError("AOI_TOO_MANY_VERTICES", `AOI accepts at most ${AOI_MAX_VERTICES} vertices`);
  }
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (vertices[i]!.x === vertices[j]!.x && vertices[i]!.y === vertices[j]!.y) {
        throw new AoiError("AOI_DUPLICATE_VERTEX", `AOI vertices ${i} and ${j} coincide`);
      }
    }
  }
  vertices = canonicalRing(vertices);
  const signedAreaM2 = shoelace(vertices) / 2;
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    // Adjacent edge (shares b): only b may be common, so the next vertex must not fold back onto a–b.
    const c = vertices[(i + 2) % n]!;
    if (cross(a.x, a.y, b.x, b.y, c.x, c.y) === 0 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) {
      throw new AoiError("AOI_SELF_INTERSECTION", `AOI edges ${i} and ${(i + 1) % n} overlap`);
    }
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through vertex 0
      const d = vertices[j]!;
      const e = vertices[(j + 1) % n]!;
      if (segmentsTouch(a, b, d, e)) {
        throw new AoiError("AOI_SELF_INTERSECTION", `AOI edges ${i} and ${j} intersect`);
      }
    }
  }
  // A simple polygon always has a non-zero area; this guards rounding to exactly 0.
  if (signedAreaM2 === 0) throw new AoiError("AOI_ZERO_AREA", "AOI area must be greater than zero");
  let min_x = Infinity;
  let min_y = Infinity;
  let max_x = -Infinity;
  let max_y = -Infinity;
  for (const { x, y } of vertices) {
    min_x = Math.min(min_x, x);
    min_y = Math.min(min_y, y);
    max_x = Math.max(max_x, x);
    max_y = Math.max(max_y, y);
  }
  return { vertices, signedAreaM2, bbox: { min_x, min_y, max_x, max_y } };
}

/** Closed point-in-polygon test (boundary is inside) on a validated polygon. */
export function pointInAoiPolygon(polygon: ValidatedAoiPolygon, px: number, py: number): boolean {
  const { vertices, bbox } = polygon;
  if (px < bbox.min_x || px > bbox.max_x || py < bbox.min_y || py > bbox.max_y) return false;
  const n = vertices.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = vertices[j]!;
    const b = vertices[i]!;
    if (cross(a.x, a.y, b.x, b.y, px, py) === 0 && withinBox(a, b, { x: px, y: py })) return true;
    if ((b.y > py) !== (a.y > py)) {
      const xCross = b.x + ((py - b.y) * (a.x - b.x)) / (a.y - b.y);
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Horizontal distance range from (x, y) to the closed polygon: `min` is 0 inside (or on the
 * boundary), else the distance to the nearest edge; `max` is the distance to the farthest vertex.
 * The polygon is connected, so every distance in [min, max] is reached by some point of it.
 * O(V); computed in double on the absolute coordinates.
 */
export function aoiPolygonDistanceRange(polygon: ValidatedAoiPolygon, x: number, y: number): { min: number; max: number } {
  const { vertices } = polygon;
  const n = vertices.length;
  let max = 0;
  for (const v of vertices) max = Math.max(max, Math.hypot(v.x - x, v.y - y));
  if (pointInAoiPolygon(polygon, x, y)) return { min: 0, max };
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (y - a.y) * ey) / len2)) : 0;
    min = Math.min(min, Math.hypot(a.x + t * ex - x, a.y + t * ey - y));
  }
  return { min, max };
}
