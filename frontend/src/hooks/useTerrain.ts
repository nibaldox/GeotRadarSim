/**
 * useTerrain hook — convenience wrapper around the terrain Zustand store.
 *
 * Exposes terrain state and actions for use in React components.
 */

import { useTerrainStore } from "../store/terrainStore";

export function useTerrain() {
  const metadata = useTerrainStore((s) => s.metadata);
  const grid = useTerrainStore((s) => s.grid);
  const loading = useTerrainStore((s) => s.loading);
  const error = useTerrainStore((s) => s.error);
  const generateSynthetic = useTerrainStore((s) => s.generateSynthetic);
  const loadGrid = useTerrainStore((s) => s.loadGrid);
  const uploadDXF = useTerrainStore((s) => s.uploadDXF);
  const clearError = useTerrainStore((s) => s.clearError);

  return {
    metadata,
    grid,
    loading,
    error,
    generateSynthetic,
    loadGrid,
    uploadDXF,
    clearError,
  };
}
