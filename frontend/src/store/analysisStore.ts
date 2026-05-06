/**
 * Zustand store for LOS analysis state management.
 *
 * Manages radar list, selected radar, radar position,
 * LOS analysis results, loading state, and errors.
 */

import { create } from "zustand";
import {
  runLOSAnalysis as apiRunLOS,
  listRadars as apiListRadars,
} from "../services/api";
import type { Point3D, RadarConfig, LOSResponse } from "../types/api";

export interface AnalysisState {
  radars: RadarConfig[];
  selectedRadarId: string | null;
  radarPosition: Point3D | null;
  losResult: LOSResponse | null;
  loading: boolean;
  error: string | null;

  loadRadars: () => Promise<void>;
  selectRadar: (modelId: string | null) => void;
  setRadarPosition: (position: Point3D) => void;
  runAnalysis: (terrainId: string) => Promise<void>;
  clearResult: () => void;
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  radars: [],
  selectedRadarId: null,
  radarPosition: null,
  losResult: null,
  loading: false,
  error: null,

  loadRadars: async () => {
    set({ loading: true, error: null });
    try {
      const radars = await apiListRadars();
      set({ radars, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  selectRadar: (modelId) => {
    set({ selectedRadarId: modelId });
  },

  setRadarPosition: (position) => {
    set({ radarPosition: position });
  },

  runAnalysis: async (terrainId) => {
    const { selectedRadarId, radarPosition } = get();
    if (!selectedRadarId || !radarPosition) {
      set({ error: "Radar model and position must be set before analysis" });
      return;
    }

    set({ loading: true, error: null });
    try {
      const losResult = await apiRunLOS({
        terrain_id: terrainId,
        radar_position: radarPosition,
        radar_model_id: selectedRadarId,
      });
      set({ losResult, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  clearResult: () => set({ losResult: null }),
}));
