import { create } from "zustand";
import { runSensitivityAnalysis, getLOSJob } from "../services/api";
import { useAnalysisStore } from "./analysisStore";

export interface VectorState {
  sensitivityGrid: number[][] | null;
  flat_sensitivity_grid: Float32Array | null;
  visualizationMode: "QUALITY" | "SENSITIVITY";
  loading: boolean;
  error: string | null;

  computeSensitivityMap: (terrainId: string) => Promise<void>;
  setVisualizationMode: (mode: "QUALITY" | "SENSITIVITY") => void;
  reset: () => void;
}

export const useVectorStore = create<VectorState>((set) => ({
  sensitivityGrid: null,
  flat_sensitivity_grid: null,
  visualizationMode: "QUALITY",
  loading: false,
  error: null,

  computeSensitivityMap: async (terrainId) => {
    const selectedHistory = useAnalysisStore.getState().history.filter(h => h.selected);
    const deployedRadars = selectedHistory.map(h => ({
      position: h.position,
      modelId: h.radarId
    }));

    if (deployedRadars.length === 0) {
      set({ sensitivityGrid: null, flat_sensitivity_grid: null });
      return;
    }

    set({ loading: true, error: null });
    
    try {
      const radarPositions = deployedRadars.map(dr => dr.position);
      const jobResp = await runSensitivityAnalysis({
        terrainId,
        radarPositions
      });

      const poll = async () => {
        try {
          const s = await getLOSJob(jobResp.job_id);
          if (s.status === "COMPLETED" && s.result) {
            set({
              sensitivityGrid: s.result.sensitivityGrid,
              flat_sensitivity_grid: s.result.flat_sensitivity_grid || null,
              loading: false
            });
          } else if (s.status === "FAILED") {
            set({ error: s.error || "Failed to calculate sensitivity map", loading: false });
          } else {
            setTimeout(poll, 250);
          }
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : "Error polling job status",
            loading: false
          });
        }
      };

      setTimeout(poll, 250);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to compute sensitivity map",
        loading: false
      });
    }
  },

  setVisualizationMode: (mode) => set({ visualizationMode: mode }),

  reset: () => set({
    sensitivityGrid: null,
    flat_sensitivity_grid: null,
    error: null,
    visualizationMode: "QUALITY"
  })
}));
