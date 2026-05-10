import type { DTMMetadata } from "../types/api";

export interface LocalTerrain {
  metadata: DTMMetadata;
  grid: number[][];
}

const terrainCache = new Map<string, LocalTerrain>();

export function saveLocalTerrain(terrain: LocalTerrain) {
  terrainCache.set(terrain.metadata.terrain_id, terrain);
}

export function getLocalTerrain(id: string): LocalTerrain | undefined {
  return terrainCache.get(id);
}

export function clearLocalTerrainCache() {
  terrainCache.clear();
}
