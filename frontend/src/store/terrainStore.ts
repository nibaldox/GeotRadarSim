/**
 * Zustand store for terrain state management.
 *
 * Metadata and grid are committed together only after a terrain request and
 * its grid load both succeed. Request IDs fence off out-of-order responses.
 */

import { create } from "zustand";
import {
  generateSynthetic as apiGenerateSynthetic,
  getTerrainGrid as apiGetTerrainGrid,
  uploadDXF as apiUploadDXF,
  uploadSTL as apiUploadSTL,
  activateTerrain as apiActivateTerrain,
  releaseTerrain as apiReleaseTerrain,
} from "../services/api";
import type {
  DTMMetadata,
  TerrainGridResponse,
  SyntheticTerrainRequest,
} from "../types/api";
import { useAnalysisStore } from "./analysisStore";
import type { TerrainKey } from "./analysisStore";

export interface TerrainState {
  metadata: DTMMetadata | null;
  grid: number[][] | null;
  terrainKey: TerrainKey | null;
  terrainEpoch: number;
  loading: boolean;
  error: string | null;
  preferredResolution: number;

  generateSynthetic: (params: SyntheticTerrainRequest) => Promise<void>;
  loadGrid: (terrainId: string) => Promise<void>;
  uploadDXF: (file: File) => Promise<void>;
  uploadSTL: (file: File) => Promise<void>;
  setPreferredResolution: (res: number) => void;
  clearError: () => void;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : "Unknown error";

export const useTerrainStore = create<TerrainState>((set, get) => {
  let latestRequestId = 0;

  const beginTransition = () => {
    const requestId = ++latestRequestId;
    const previousKey = get().terrainKey;
    useAnalysisStore.getState().beginTerrainTransition();
    set({ loading: true, error: null });
    return { requestId, previousKey };
  };

  const restorePreviousTerrain = (requestId: number, previousKey: TerrainKey | null, err: unknown) => {
    if (requestId !== latestRequestId) return;
    useAnalysisStore.getState().restoreTerrainAfterFailure(previousKey);
    set({ error: errorMessage(err), loading: false });
  };

  const activateGrid = (
    requestId: number,
    expectedTerrainId: string,
    response: TerrainGridResponse,
  ) => {
    if (requestId !== latestRequestId) return;
    if (
      !response ||
      !response.metadata ||
      response.terrain_id !== expectedTerrainId ||
      response.metadata.terrain_id !== expectedTerrainId
    ) {
      throw new Error("Terrain grid does not match the requested terrain");
    }

    const epoch = get().terrainEpoch + 1;
    const terrainKey: TerrainKey = { terrain_id: expectedTerrainId, epoch };
    apiActivateTerrain(expectedTerrainId);
    useAnalysisStore.getState().activateTerrain(terrainKey);
    set({
      metadata: response.metadata,
      grid: response.grid,
      terrainKey,
      terrainEpoch: epoch,
      loading: false,
      error: null,
    });
  };

  const loadGridForTransition = async (
    requestId: number,
    previousKey: TerrainKey | null,
    metadata: DTMMetadata,
  ) => {
    try {
      const response = await apiGetTerrainGrid(metadata.terrain_id);
      if (requestId !== latestRequestId) {
        apiReleaseTerrain(metadata.terrain_id);
        return;
      }
      activateGrid(requestId, metadata.terrain_id, response);
    } catch (err) {
      apiReleaseTerrain(metadata.terrain_id);
      restorePreviousTerrain(requestId, previousKey, err);
    }
  };

  const uploadAndActivate = async (
    upload: () => Promise<DTMMetadata>,
  ): Promise<void> => {
    const { requestId, previousKey } = beginTransition();
    try {
      const metadata = await upload();
      if (requestId !== latestRequestId) {
        apiReleaseTerrain(metadata.terrain_id);
        return;
      }
      await loadGridForTransition(requestId, previousKey, metadata);
    } catch (err) {
      restorePreviousTerrain(requestId, previousKey, err);
    }
  };

  return {
    metadata: null,
    grid: null,
    terrainKey: null,
    terrainEpoch: 0,
    loading: false,
    error: null,
    preferredResolution: 1.0,

    generateSynthetic: async (params) => {
      const { preferredResolution } = get();
      await uploadAndActivate(() => apiGenerateSynthetic({ ...params, resolution: preferredResolution }));
    },

    loadGrid: async (terrainId) => {
      const { requestId, previousKey } = beginTransition();
      try {
        const response = await apiGetTerrainGrid(terrainId);
        if (requestId !== latestRequestId) {
          apiReleaseTerrain(terrainId);
          return;
        }
        activateGrid(requestId, terrainId, response);
      } catch (err) {
        apiReleaseTerrain(terrainId);
        restorePreviousTerrain(requestId, previousKey, err);
      }
    },

    uploadDXF: async (file) => {
      const { preferredResolution } = get();
      await uploadAndActivate(() => apiUploadDXF(file, preferredResolution));
    },

    uploadSTL: async (file) => {
      const { preferredResolution } = get();
      await uploadAndActivate(() => apiUploadSTL(file, preferredResolution));
    },

    clearError: () => set({ error: null }),
    setPreferredResolution: (res) => set({ preferredResolution: res }),
  };
});
