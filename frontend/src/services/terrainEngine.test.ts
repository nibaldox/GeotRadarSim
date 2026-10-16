import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSyntheticTerrain } from "./terrainEngine";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("synthetic terrain resource limits", () => {
  it("rejects an excessive grid before constructing any large row arrays", () => {
    const realArray = globalThis.Array;
    let oversizedArrayAllocations = 0;
    const observedArray = new Proxy(realArray, {
      apply(target, thisArg, args: [number?]) {
        if (typeof args[0] === "number" && args[0] > 1024) oversizedArrayAllocations++;
        return Reflect.apply(target, thisArg, args);
      },
    });
    vi.stubGlobal("Array", observedArray);

    let caught: unknown;
    try {
      generateSyntheticTerrain(16_385, 1, 1, 1);
    } catch (error) {
      caught = error;
    } finally {
      vi.stubGlobal("Array", realArray);
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(String(caught)).toMatch(/dimension|maximum/i);
    expect(oversizedArrayAllocations).toBe(0);
  });

  it("samples a 200 m by 200 m terrain every 3 m and reports its actual node extent", () => {
    const terrain = generateSyntheticTerrain(200, 200, 30, 3);

    expect(terrain.metadata.grid_rows).toBe(67);
    expect(terrain.metadata.grid_cols).toBe(67);
    expect(terrain.metadata.bounds).toMatchObject({ min_x: 0, min_y: 0, max_x: 198, max_y: 198 });
    expect(terrain.grid[0]![0]).toBe(0);
    expect(terrain.grid[33]![33]).toBe(-30);
    expect(terrain.grid[66]![66]).toBe(0);
  });

  it("includes the node endpoint after an eight-ULP local-origin span shortfall", () => {
    const terrain = generateSyntheticTerrain(1599.7999999999984, 2, 30, 0.1);

    expect(terrain.metadata.grid_cols).toBe(15_999);
    expect(terrain.metadata.grid_rows).toBe(21);
    expect(terrain.metadata.bounds.max_x).toBe(15_998 * 0.1);
  });

  it("includes divisible size endpoints at 2 m resolution", () => {
    const terrain = generateSyntheticTerrain(200, 200, 30, 2);

    expect(terrain.metadata.grid_rows).toBe(101);
    expect(terrain.metadata.grid_cols).toBe(101);
    expect(terrain.metadata.bounds).toMatchObject({
      min_x: 0,
      min_y: 0,
      min_z: -30,
      max_x: 200,
      max_y: 200,
      max_z: 0,
    });
    expect(terrain.grid[50]![50]).toBe(-30);
  });

  it("includes divisible size endpoints at the 0.5 m UI resolution", () => {
    const terrain = generateSyntheticTerrain(200, 200, 30, 0.5);

    expect(terrain.metadata.grid_rows).toBe(401);
    expect(terrain.metadata.grid_cols).toBe(401);
    expect(terrain.metadata.resolution).toBe(0.5);
    expect(terrain.metadata.bounds).toMatchObject({ min_x: 0, min_y: 0, max_x: 200, max_y: 200 });
  });

  it("treats floating-point-near-divisible sizes as endpoint-aligned", () => {
    const terrain = generateSyntheticTerrain(0.3, 0.3, 1, 0.1);

    expect(terrain.metadata.grid_rows).toBe(4);
    expect(terrain.metadata.grid_cols).toBe(4);
    expect(terrain.metadata.bounds.max_x).toBeCloseTo(0.3, 12);
    expect(terrain.metadata.bounds.max_y).toBeCloseTo(0.3, 12);
  });

  it("rejects synthetic dimensions smaller than one grid interval", () => {
    expect(() => generateSyntheticTerrain(1, 20, 30, 2)).toThrow(/at least 2.*nodes|one resolution/i);
  });

  it("rejects negative bowl depth", () => {
    expect(() => generateSyntheticTerrain(200, 200, -30, 2)).toThrow(/depth.*non-negative/i);
  });

  it("preserves zero as a valid synthetic depth", () => {
    const terrain = generateSyntheticTerrain(4, 4, 0, 2);

    expect(terrain.metadata.bounds).toMatchObject({ min_z: 0, max_z: 0 });
    expect(terrain.grid.flat().every((elevation) => elevation === 0)).toBe(true);
  });
});
