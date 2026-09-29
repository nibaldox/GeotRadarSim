import type { DTMMetadata } from "../types/api";

export interface LocalTerrain {
  metadata: DTMMetadata;
  grid: number[][];
}

interface CachedLocalTerrain {
  terrain: LocalTerrain;
  active: boolean;
  provisional: boolean;
  leases: number;
}

const terrainCache = new Map<string, CachedLocalTerrain>();
let activeTerrainId: string | null = null;
let nextTerrainImportSequence = 0n;

/**
 * Assign an imported grid a unique identity for this cache lifetime. Keep the
 * allocator here (rather than in api.ts) so partial API re-evaluation cannot
 * reset it while the terrain cache and its IDs remain alive. The monotonic
 * counter replaces a per-ID tombstone set, so evicted imports leave no history.
 */
export function identifyLocalTerrainImport(metadata: DTMMetadata): DTMMetadata {
  const sequence = nextTerrainImportSequence++;
  return { ...metadata, terrain_id: `${metadata.terrain_id}-import-${sequence.toString(36)}` };
}

/** Save a new grid as a provisional import until activated or released. */
export function saveLocalTerrain(terrain: LocalTerrain): void {
  const id = terrain.metadata.terrain_id;
  if (terrainCache.has(id)) {
    throw new Error(`Terrain '${id}' is already cached; terrain IDs cannot be reused`);
  }
  terrainCache.set(id, { terrain, active: false, provisional: true, leases: 0 });
}

export function getLocalTerrain(id: string): LocalTerrain | undefined {
  return terrainCache.get(id)?.terrain;
}

function evictIfUnowned(id: string, entry: CachedLocalTerrain): void {
  if (terrainCache.get(id) === entry && !entry.active && !entry.provisional && entry.leases === 0) {
    terrainCache.delete(id);
  }
}

/** Make this terrain the active grid, consuming its provisional ownership. */
export function activateLocalTerrain(id: string): void {
  const entry = terrainCache.get(id);
  if (!entry) throw new Error(`Terrain '${id}' is not cached`);

  const previousId = activeTerrainId;
  const previousEntry = previousId ? terrainCache.get(previousId) : undefined;
  if (previousEntry && previousId !== id) previousEntry.active = false;

  activeTerrainId = id;
  entry.active = true;
  entry.provisional = false;

  if (previousId && previousEntry && previousId !== id) {
    evictIfUnowned(previousId, previousEntry);
  }
}

/** Release a caller's provisional import; active terrain remains protected. */
export function releaseLocalTerrain(id: string): void {
  const entry = terrainCache.get(id);
  if (!entry) return;
  entry.provisional = false;
  evictIfUnowned(id, entry);
}

/** Hold a grid while a worker uses it; the returned release is idempotent. */
export function acquireLocalTerrainLease(id: string): () => void {
  const entry = terrainCache.get(id);
  if (!entry) throw new Error(`Terrain '${id}' is not cached`);
  entry.leases++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.leases--;
    evictIfUnowned(id, entry);
  };
}

/** Expose cache cardinality for lifecycle tests without exposing terrain data. */
export function getLocalTerrainCacheSize(): number {
  return terrainCache.size;
}

/** Test/reset helper. The monotonic ID allocator intentionally is not reset. */
export function clearLocalTerrainCache(): void {
  terrainCache.clear();
  activeTerrainId = null;
}
