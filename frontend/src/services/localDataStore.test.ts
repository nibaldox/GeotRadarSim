import { beforeEach, describe, expect, it } from "vitest";
import type { DTMMetadata } from "../types/api";
import {
  activateLocalTerrain,
  acquireLocalTerrainLease,
  clearLocalTerrainCache,
  getLocalTerrain,
  getLocalTerrainCacheSize,
  identifyLocalTerrainImport,
  releaseLocalTerrain,
  saveLocalTerrain,
} from "./localDataStore";

const metadata: DTMMetadata = {
  terrain_id: "terrain-cache-entry",
  bounds: { min_x: 0, min_y: 0, min_z: 0, max_x: 1, max_y: 1, max_z: 1 },
  resolution: 1,
  grid_rows: 1,
  grid_cols: 1,
};

beforeEach(() => clearLocalTerrainCache());

describe("local terrain cache identity", () => {
  it("does not let a second write replace the grid for an existing terrain ID", () => {
    const terrainA = { metadata, grid: [[11]] };
    saveLocalTerrain(terrainA);

    expect(() => saveLocalTerrain({ metadata: { ...metadata }, grid: [[22]] }))
      .toThrow(/already cached/i);
    expect(getLocalTerrain(metadata.terrain_id)).toBe(terrainA);
    expect(getLocalTerrain(metadata.terrain_id)?.grid).toEqual([[11]]);
  });

  it("evicts the previous active terrain once its last lease is released", () => {
    const terrainA = { metadata: { ...metadata, terrain_id: "terrain-A" }, grid: [[11]] };
    const terrainB = { metadata: { ...metadata, terrain_id: "terrain-B" }, grid: [[22]] };
    saveLocalTerrain(terrainA);
    activateLocalTerrain(terrainA.metadata.terrain_id);
    const releaseLeaseA = acquireLocalTerrainLease(terrainA.metadata.terrain_id);
    saveLocalTerrain(terrainB);
    activateLocalTerrain(terrainB.metadata.terrain_id);

    expect(getLocalTerrain(terrainA.metadata.terrain_id)).toBe(terrainA);
    expect(getLocalTerrain(terrainB.metadata.terrain_id)).toBe(terrainB);
    expect(getLocalTerrainCacheSize()).toBe(2);

    releaseLeaseA();
    releaseLeaseA();

    expect(getLocalTerrain(terrainA.metadata.terrain_id)).toBeUndefined();
    expect(getLocalTerrain(terrainB.metadata.terrain_id)).toBe(terrainB);
    expect(getLocalTerrainCacheSize()).toBe(1);
  });

  it("holds an import provisionally until it is activated or explicitly released", () => {
    const candidate = { metadata: { ...metadata, terrain_id: "terrain-candidate" }, grid: [[33]] };
    saveLocalTerrain(candidate);

    expect(getLocalTerrain(candidate.metadata.terrain_id)).toBe(candidate);
    releaseLocalTerrain(candidate.metadata.terrain_id);

    expect(getLocalTerrain(candidate.metadata.terrain_id)).toBeUndefined();
    expect(getLocalTerrainCacheSize()).toBe(0);
  });

  it("does not reuse generated terrain IDs after eviction or cache clearing", () => {
    const first = identifyLocalTerrainImport(metadata);
    saveLocalTerrain({ metadata: first, grid: [[1]] });
    activateLocalTerrain(first.terrain_id);

    const second = identifyLocalTerrainImport(metadata);
    saveLocalTerrain({ metadata: second, grid: [[2]] });
    activateLocalTerrain(second.terrain_id);
    expect(getLocalTerrain(first.terrain_id)).toBeUndefined();

    const third = identifyLocalTerrainImport(metadata);
    clearLocalTerrainCache();
    const fourth = identifyLocalTerrainImport(metadata);

    expect(new Set([first.terrain_id, second.terrain_id, third.terrain_id, fourth.terrain_id]).size).toBe(4);
  });
});
