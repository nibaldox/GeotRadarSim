/**
 * Zustand store for terrain state management.
 *
 * Manages terrain metadata, grid data, loading state, and errors.
 * Actions delegate to the API client.
 */

import { create } from "zustand";
import {
  generateSynthetic as apiGenerateSynthetic,
  getTerrainGrid as apiGetTerrainGrid,
  uploadDXF as apiUploadDXF,
  uploadSTL as apiUploadSTL,
} from "../services/api";
import type {
  DTMMetadata,
  TerrainGridResponse,
  SyntheticTerrainRequest,
} from "../types/api";

export interface TerrainState {
  metadata: DTMMetadata | null;
  grid: number[][] | null;
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

export const useTerrainStore = create<TerrainState>((set, get) => ({
  metadata: null,
  grid: null,
  loading: false,
  error: null,
  preferredResolution: 1.0,

  generateSynthetic: async (params) => {
    set({ loading: true, error: null });
    try {
      const { preferredResolution } = get();
      const metadata = await apiGenerateSynthetic({ ...params, resolution: preferredResolution });
      set({ metadata, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  loadGrid: async (terrainId) => {
    set({ loading: true, error: null });
    try {
      const response: TerrainGridResponse = await apiGetTerrainGrid(terrainId);
      set({ grid: response.grid, metadata: response.metadata, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  uploadDXF: async (file) => {
    set({ loading: true, error: null });
    try {
      const { preferredResolution } = get();
      const metadata = await apiUploadDXF(file, preferredResolution);
      set({ metadata, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  uploadSTL: async (file) => {
    set({ loading: true, error: null });
    try {
      const { preferredResolution } = get();
      const metadata = await apiUploadSTL(file, preferredResolution);
      set({ metadata, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  clearError: () => set({ error: null }),
  setPreferredResolution: (res) => set({ preferredResolution: res }),
}));
