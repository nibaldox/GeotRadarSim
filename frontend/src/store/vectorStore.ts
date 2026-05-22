import { create } from "zustand";
import { runVectorAnalysis, runSensitivityAnalysis, getLOSJob } from "../services/api";
import type { Point3D, VectorReconstructionResponse } from "../types/api";
import { useAnalysisStore } from "./analysisStore";

export interface VectorState {
  selectedCell: Point3D | null; // API coordinates
  selectedCellLocal: Point3D | null; // Three.js local coordinates
  trueSlideMagnitude: number; // mm
  noiseLevel: number; // mm
  reconstructionResult: VectorReconstructionResponse | null;
  sensitivityGrid: number[][] | null;
  visualizationMode: "QUALITY" | "SENSITIVITY";
  loading: boolean;
  error: string | null;

  selectCell: (point: Point3D, grid: number[][], bounds: any, resolution: number) => Promise<void>;
  updateMagnitude: (magnitude: number, grid: number[][], bounds: any, resolution: number) => Promise<void>;
  updateNoise: (noise: number, grid: number[][], bounds: any, resolution: number) => Promise<void>;
  computeSensitivityMap: (terrainId: string) => Promise<void>;
  setVisualizationMode: (mode: "QUALITY" | "SENSITIVITY") => void;
  reset: () => void;
}

// Internal helper for running the least-squares worker job
async function triggerReconstruction(
  point: Point3D, // Local Three.js coordinates
  grid: number[][],
  bounds: any,
  resolution: number,
  magnitude: number,
  noiseLevel: number,
  set: any
) {
  const deployedRadars = useAnalysisStore.getState().deployedRadars;
  
  if (deployedRadars.length === 0) {
    set({
      error: "Despliega al menos un radar en la red para poder realizar la síntesis vectorial.",
      loading: false,
      reconstructionResult: null
    });
    return;
  }

  // 1. Map row & column to find expected slope failure direction
  const rows = grid.length;
  const cols = grid[0]!.length;
  const r = Math.max(0, Math.min(rows - 1, Math.round(-point.z / resolution)));
  const c = Math.max(0, Math.min(cols - 1, Math.round(point.x / resolution)));

  let gradX = 0;
  let gradY = 0;
  if (c > 0 && c < cols - 1) {
    gradX = (grid[r]![c + 1]! - grid[r]![c - 1]!) / (2 * resolution);
  }
  if (r > 0 && r < rows - 1) {
    gradY = (grid[r + 1]![c]! - grid[r - 1]![c]!) / (2 * resolution);
  }

  // failure expected direction: steepest gravitational descent (API space)
  let ux_f = -gradX;
  let uy_f = -gradY;
  let uz_f = -(gradX * gradX + gradY * gradY);
  
  const fNorm = Math.sqrt(ux_f * ux_f + uy_f * uy_f + uz_f * uz_f);
  if (fNorm > 1e-4) {
    ux_f /= fNorm;
    uy_f /= fNorm;
    uz_f /= fNorm;
  } else {
    ux_f = 0;
    uy_f = 0;
    uz_f = -1.0;
  }

  // True displacement vector [dx, dy, dz] in mm
  const trueVector: [number, number, number] = [
    ux_f * magnitude,
    uy_f * magnitude,
    uz_f * magnitude
  ];

  // 2. Cell georeferenced coordinates (API space)
  const cellPosition: Point3D = {
    x: point.x + bounds.min_x,
    y: bounds.min_y - point.z,
    z: point.y + bounds.min_z
  };

  // 3. Simulate observations for each deployed radar
  const radarPositions = deployedRadars.map(dr => dr.position);
  const radarObservations: number[] = [];

  for (let i = 0; i < deployedRadars.length; i++) {
    const radPos = deployedRadars[i]!.position;
    const dx = cellPosition.x - radPos.x;
    const dy = cellPosition.y - radPos.y;
    const dz = cellPosition.z - radPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
    
    // Line-of-sight unit vector from radar to cell
    const ux_los = dx / dist;
    const uy_los = dy / dist;
    const uz_los = dz / dist;

    // Projected displacement: d_LOS = d_real . u_LOS + noise
    const projected = trueVector[0] * ux_los + trueVector[1] * uy_los + trueVector[2] * uz_los;
    
    // Simulate Gaussian/Random noise
    const simulatedNoise = (Math.random() - 0.5) * 2.0 * noiseLevel;
    
    radarObservations.push(projected + simulatedNoise);
  }

  // Find index of selected/first active radar for 1D single rendering comparisons
  const activeRadarModel = useAnalysisStore.getState().selectedRadarId;
  let selectedRadarIndex = 0;
  if (activeRadarModel) {
    const idx = deployedRadars.findIndex(dr => dr.modelId === activeRadarModel);
    if (idx !== -1) selectedRadarIndex = idx;
  }

  set({ loading: true, error: null });

  try {
    const jobResp = await runVectorAnalysis({
      radarPositions,
      radarObservations,
      cellPosition,
      trueVector,
      selectedRadarIndex
    });

    const poll = async () => {
      try {
        const s = await getLOSJob(jobResp.job_id);
        if (s.status === "COMPLETED" && s.result) {
          set({ reconstructionResult: s.result, loading: false });
        } else if (s.status === "FAILED") {
          set({ error: s.error || "Failed to reconstruct vector", loading: false });
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
      error: err instanceof Error ? err.message : "Failed to run vector reconstruction",
      loading: false
    });
  }
}

export const useVectorStore = create<VectorState>((set, get) => ({
  selectedCell: null,
  selectedCellLocal: null,
  trueSlideMagnitude: 50.0, // 50mm default
  noiseLevel: 1.0, // 1mm noise default
  reconstructionResult: null,
  sensitivityGrid: null,
  visualizationMode: "QUALITY",
  loading: false,
  error: null,

  selectCell: async (point, grid, bounds, resolution) => {
    const { trueSlideMagnitude, noiseLevel } = get();
    
    const cellGeoreferenced: Point3D = {
      x: point.x + bounds.min_x,
      y: bounds.min_y - point.z,
      z: point.y + bounds.min_z
    };

    set({ selectedCell: cellGeoreferenced, selectedCellLocal: point });
    
    await triggerReconstruction(
      point,
      grid,
      bounds,
      resolution,
      trueSlideMagnitude,
      noiseLevel,
      set
    );
  },

  updateMagnitude: async (magnitude, grid, bounds, resolution) => {
    set({ trueSlideMagnitude: magnitude });
    const { selectedCellLocal, noiseLevel } = get();
    if (selectedCellLocal) {
      await triggerReconstruction(
        selectedCellLocal,
        grid,
        bounds,
        resolution,
        magnitude,
        noiseLevel,
        set
      );
    }
  },

  updateNoise: async (noise, grid, bounds, resolution) => {
    set({ noiseLevel: noise });
    const { selectedCellLocal, trueSlideMagnitude } = get();
    if (selectedCellLocal) {
      await triggerReconstruction(
        selectedCellLocal,
        grid,
        bounds,
        resolution,
        trueSlideMagnitude,
        noise,
        set
      );
    }
  },

  computeSensitivityMap: async (terrainId) => {
    const deployedRadars = useAnalysisStore.getState().deployedRadars;
    if (deployedRadars.length === 0) {
      set({ sensitivityGrid: null });
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
            set({ sensitivityGrid: s.result.sensitivityGrid, loading: false });
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
    selectedCell: null,
    selectedCellLocal: null,
    reconstructionResult: null,
    error: null
  })
}));
