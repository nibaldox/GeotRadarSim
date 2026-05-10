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
  getLOSJob,
} from "../services/api";
import type { Point3D, RadarConfig, LOSResponse } from "../types/api";

export interface HistoryEntry {
  position: Point3D;
  coveragePct: number;
  timestamp: string;
  result: LOSResponse;
  radarId: string;
}

export interface AnalysisState {
  radars: RadarConfig[];
  selectedRadarId: string | null;
  radarPosition: Point3D | null;
  losResult: LOSResponse | null;
  loading: boolean;
  error: string | null;
  rangeMinOverride: number | null;
  rangeMaxOverride: number | null;
  elMinOverride: number | null;
  elMaxOverride: number | null;
  azCenterOverride: number | null;
  azWidthOverride: number | null;
  history: HistoryEntry[];

  loadRadars: () => Promise<void>;
  selectRadar: (modelId: string | null) => void;
  setRadarPosition: (position: Point3D) => void;
  setRangeOverrides: (min: number | null, max: number | null) => void;
  setElevationOverrides: (min: number | null, max: number | null) => void;
  setAzimuthOverrides: (center: number | null, width: number | null) => void;
  runAnalysis: (terrainId: string) => Promise<void>;
  clearResult: () => void;
  clearHistory: () => void;
  restoreHistoryEntry: (index: number) => void;
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  radars: [],
  selectedRadarId: null,
  radarPosition: null,
  losResult: null,
  loading: false,
  error: null,
  rangeMinOverride: null,
  rangeMaxOverride: null,
  elMinOverride: null,
  elMaxOverride: null,
  azCenterOverride: null,
  azWidthOverride: null,
  history: [],

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
    set({ 
      selectedRadarId: modelId, 
      rangeMinOverride: null, 
      rangeMaxOverride: null,
      elMinOverride: null,
      elMaxOverride: null,
      azCenterOverride: null,
      azWidthOverride: null
    });
  },

  setRadarPosition: (position) => {
    set({ radarPosition: position });
  },

  setRangeOverrides: (min, max) => {
    set({ rangeMinOverride: min, rangeMaxOverride: max });
  },
 
  setElevationOverrides: (min, max) => {
    set({ elMinOverride: min, elMaxOverride: max });
  },
 
  setAzimuthOverrides: (center, width) => {
    set({ azCenterOverride: center, azWidthOverride: width });
  },

  runAnalysis: async (terrainId) => {
    const { selectedRadarId, radarPosition } = get();
    if (!selectedRadarId || !radarPosition) {
      set({ error: "Radar model and position must be set before analysis" });
      return;
    }

    set({ loading: true, error: null });
    try {
      const { rangeMinOverride, rangeMaxOverride, elMinOverride, elMaxOverride, azCenterOverride, azWidthOverride } = get();
      const jobResp = await apiRunLOS({
        terrain_id: terrainId,
        radar_position: radarPosition,
        radar_model_id: selectedRadarId,
        range_min_m: rangeMinOverride ?? undefined,
        range_max_m: rangeMaxOverride ?? undefined,
        el_min_deg: elMinOverride ?? undefined,
        el_max_deg: elMaxOverride ?? undefined,
        az_center_deg: azCenterOverride ?? undefined,
        az_width_deg: azWidthOverride ?? undefined,
      });
      
      const poll = async () => {
        try {
          const statusResp = await getLOSJob(jobResp.job_id);
          if (statusResp.status === "COMPLETED" && statusResp.result) {
            set({ losResult: statusResp.result, loading: false });
            
            // Add to history
            const entry: HistoryEntry = {
              position: radarPosition,
              coveragePct: statusResp.result.coverage_pct,
              timestamp: new Date().toLocaleTimeString(),
              result: statusResp.result,
              radarId: selectedRadarId,
            };
            set((s) => ({ history: [entry, ...s.history].slice(0, 10) }));
          } else if (statusResp.status === "FAILED") {
            set({ error: statusResp.error || "Analysis failed", loading: false });
          } else {
            // PENDING
            setTimeout(poll, 1000);
          }
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : "Error checking job status",
            loading: false,
          });
        }
      };
      
      setTimeout(poll, 1000);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Unknown error",
        loading: false,
      });
    }
  },

  clearResult: () => set({ losResult: null }),
  clearHistory: () => set({ history: [] }),

  restoreHistoryEntry: (index) => {
    const entry = get().history[index];
    if (!entry) return;
    set({
      losResult: entry.result,
      radarPosition: entry.position,
      selectedRadarId: entry.radarId,
    });
  },
}));
