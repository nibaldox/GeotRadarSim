import { describe, expect, it } from "vitest";
import { normalizeAzimuthRange } from "../../services/api";
import { seededRandom } from "../optimizer/optimizer.testSupport";
import { angularSpreadDeg, aoiAzimuthWindow, bearingDeg, isBearingInWindow } from "./aoiAzimuth";
import { AOI_MAX_VERTICES, AoiError, pointInAoiPolygon, validateAoiPolygon } from "./aoiPolygon";
import type { AoiErrorCode, AoiPolygon } from "./aoiPolygon";

const poly = (...points: Array<[number, number]>): AoiPolygon => ({ vertices: points.map(([x, y]) => ({ x, y })) });

function expectAoiError(fn: () => unknown, code: AoiErrorCode): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AoiError);
  expect(caught).toBeInstanceOf(RangeError);
  expect((caught as AoiError).code).toBe(code);
}

describe("validateAoiPolygon", () => {
  it("accepts a simple polygon and drops an explicit closing vertex", () => {
    const square = validateAoiPolygon(poly([0, 0], [4, 0], [4, 3], [0, 3], [0, 0]));
    expect(square.vertices).toHaveLength(4);
    expect(square.signedAreaM2).toBe(12);
    expect(square.bbox).toEqual({ min_x: 0, min_y: 0, max_x: 4, max_y: 3 });
    // R14 WP14-8: the ring is canonicalised counter-clockwise, so the area is always positive.
    expect(validateAoiPolygon(poly([0, 0], [0, 3], [4, 3], [4, 0])).signedAreaM2).toBe(12);
  });

  it("accepts 3 and 64 vertices and rejects 2 and 65", () => {
    expect(validateAoiPolygon(poly([0, 0], [1, 0], [0, 1])).vertices).toHaveLength(3);
    const ring = (n: number) => ({
      vertices: Array.from({ length: n }, (_, i) => ({ x: 100 * Math.cos((2 * Math.PI * i) / n), y: 100 * Math.sin((2 * Math.PI * i) / n) })),
    });
    expect(validateAoiPolygon(ring(AOI_MAX_VERTICES)).vertices).toHaveLength(64);
    expectAoiError(() => validateAoiPolygon(ring(65)), "AOI_TOO_MANY_VERTICES");
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [1, 0])), "AOI_TOO_FEW_VERTICES");
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [1, 0], [0, 0])), "AOI_TOO_FEW_VERTICES");
  });

  it("rejects non-finite coordinates, malformed input, repeated vertices and zero area", () => {
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [Number.NaN, 0], [0, 1])), "AOI_NON_FINITE");
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [Infinity, 0], [0, 1])), "AOI_NON_FINITE");
    expectAoiError(() => validateAoiPolygon({ vertices: [{ x: 0, y: 0 }, { x: "1", y: 0 } as never, { x: 0, y: 1 }] }), "AOI_NON_FINITE");
    expectAoiError(() => validateAoiPolygon(null as never), "AOI_INVALID");
    expectAoiError(() => validateAoiPolygon({} as never), "AOI_INVALID");
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [2, 0], [2, 0], [0, 2])), "AOI_DUPLICATE_VERTEX");
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [2, 0], [1, 1], [2, 0.5], [2, 0])), "AOI_DUPLICATE_VERTEX");
    // Collinear vertices fold back onto themselves: not simple.
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [1, 1], [2, 2])), "AOI_SELF_INTERSECTION");
    // R14 WP14-9: an overflowing coordinate now has its own code (it was reported as AOI_ZERO_AREA).
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [1e200, 0], [0, 1e200])), "AOI_COORDINATES_TOO_LARGE");
  });

  it("rejects self-intersections: a bow tie, a touching vertex and an edge folding back", () => {
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [2, 2], [2, 0], [0, 2])), "AOI_SELF_INTERSECTION");
    // Vertex (2, 0) of a later edge touches edge (0,0)–(4,0).
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [4, 0], [4, 4], [2, 0], [0, 4])), "AOI_SELF_INTERSECTION");
    // Edge (4,0)→(2,0) folds back over (0,0)→(4,0); the area is still non-zero.
    expectAoiError(() => validateAoiPolygon(poly([0, 0], [4, 0], [2, 0], [2, 3])), "AOI_SELF_INTERSECTION");
  });
});

describe("pointInAoiPolygon (closed)", () => {
  const concave = validateAoiPolygon(poly([0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]));

  it("counts vertices and edge points as inside", () => {
    for (const vertex of concave.vertices) expect(pointInAoiPolygon(concave, vertex.x, vertex.y)).toBe(true);
    expect(pointInAoiPolygon(concave, 3, 0)).toBe(true);
    expect(pointInAoiPolygon(concave, 3, 2)).toBe(true);
    expect(pointInAoiPolygon(concave, 2, 4)).toBe(true);
    expect(pointInAoiPolygon(concave, 6, 3)).toBe(true);
  });

  it("separates the notch of a concave polygon", () => {
    expect(pointInAoiPolygon(concave, 1, 4)).toBe(true);
    expect(pointInAoiPolygon(concave, 5, 4)).toBe(true);
    expect(pointInAoiPolygon(concave, 3, 4)).toBe(false);
    expect(pointInAoiPolygon(concave, 3, 1)).toBe(true);
    expect(pointInAoiPolygon(concave, -0.001, 3)).toBe(false);
    expect(pointInAoiPolygon(concave, 3, 6)).toBe(false);
  });
});

describe("azimuth rules of the app", () => {
  it("copies normalizeAzimuthRange exactly (10 000 seeded cases and the error paths)", () => {
    const random = seededRandom(14);
    const specials = [0, 180, -180, 360, -360, 540, 75, -75, 179.99999999999997, 1e-12, 720.5];
    for (let i = 0; i < 10_000; i++) {
      const center = i < specials.length ? specials[i]! : (random() - 0.5) * 2000;
      const width = i % 7 === 0 ? [150, 360, 359.9999, 0.001, 1e-300, 720][i % 6]! : random() * 400 + 1e-9;
      const expected = normalizeAzimuthRange(center, width);
      const actual = aoiAzimuthWindow(center, width);
      if (expected === null) expect(actual).toBeNull();
      else {
        expect(Object.is(actual![0], expected[0])).toBe(true);
        expect(Object.is(actual![1], expected[1])).toBe(true);
      }
    }
    for (const [center, width] of [[Number.NaN, 10], [0, 0], [0, -1], [0, Number.NaN], [Infinity, 10]] as const) {
      expect(() => normalizeAzimuthRange(center, width)).toThrow(RangeError);
      expect(() => aoiAzimuthWindow(center, width)).toThrow(RangeError);
    }
  });

  it("uses the engine bearing: 0 = north (+y), 90 = east (+x), clockwise", () => {
    expect(bearingDeg(0, 10)).toBe(0);
    expect(bearingDeg(10, 0)).toBe(90);
    expect(bearingDeg(0, -10)).toBe(180);
    expect(bearingDeg(-10, 0)).toBe(-90);
    expect(bearingDeg(5, 5)).toBeCloseTo(45, 12);
  });

  it("tests window membership inclusively and wraps through ±180", () => {
    expect(isBearingInWindow(75, [-75, 75])).toBe(true);
    expect(isBearingInWindow(75.000001, [-75, 75])).toBe(false);
    expect(isBearingInWindow(180, [170, -170])).toBe(true);
    expect(isBearingInWindow(-175, [170, -170])).toBe(true);
    expect(isBearingInWindow(0, [170, -170])).toBe(false);
    expect(isBearingInWindow(123, null)).toBe(true);
  });

  it("measures the smallest arc that holds every bearing", () => {
    expect(angularSpreadDeg([])).toBe(0);
    expect(angularSpreadDeg([42])).toBe(0);
    expect(angularSpreadDeg([-10, 10])).toBe(20);
    expect(angularSpreadDeg([170, -170])).toBe(20);
    expect(angularSpreadDeg([0, 90, 180, -90])).toBe(270);
  });
});
