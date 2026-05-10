/**
 * Zustand store for LOS analysis state management.
 *
 * Manages radar list, selected radar, radar position,
 * LOS analysis results, loading state, and errors.
 *
 * Supports multi-radar mode: multiple deployed radars with unified coverage.
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

// ─── Multi-Radar types ───────────────────────────────────────────────────────

export const RADAR_COLORS = [
  "#ff4444", "#44aaff", "#44ff88", "#ffaa00",
  "#cc44ff", "#ff88cc", "#00ffcc", "#ffff44",
];

export interface DeployedRadar {
  id: string;
  modelId: string;
  position: Point3D;
  color: string;
  // Per-radar overrides
  rangeMin?: number;
  rangeMax?: number;
  elMin?: number;
  elMax?: number;
  azCenter?: number;
  azWidth?: number;
  // Result from its own analysis
  result?: LOSResponse;
}

// ─── Store interface ─────────────────────────────────────────────────────────

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

  // Multi-radar
  deployedRadars: DeployedRadar[];
  unifiedLos: LOSResponse | null;
  multiLoading: boolean;

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

  // Multi-radar actions
  deployCurrentRadar: () => void;
  removeDeployedRadar: (id: string) => void;
  clearDeployedRadars: () => void;
  runMultiAnalysis: (terrainId: string) => Promise<void>;
}

// ─── Helper: merge multiple LOSResponse results into one ────────────────────

function mergeResults(results: LOSResponse[]): LOSResponse {
  if (results.length === 0) throw new Error("No results to merge");
  if (results.length === 1) return results[0]!;

  const rows = results[0]!.shadow_grid.length;
  const cols = results[0]!.shadow_grid[0]?.length ?? 0;

  // shadow = true only if ALL radars say shadow (= no radar can see it)
  const shadow_grid: boolean[][] = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (__, c) =>
      results.every((res) => res.shadow_grid[r]?.[c] ?? true)
    )
  );

  // quality = max across all radars for visible cells
  const quality_grid: number[][] = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (__, c) => {
      if (shadow_grid[r]![c]) return 0;
      return Math.max(...results.map((res) => res.quality_grid?.[r]?.[c] ?? 0));
    })
  );

  const visibleCount = shadow_grid.flat().filter((v) => !v).length;
  const total = rows * cols;
  const coverage_pct = total > 0 ? (visibleCount / total) * 100 : 0;

  // Coverage polygon = union of all polygons (simplified: concatenate)
  const coverage_polygon = results.flatMap((r) => r.coverage_polygon).slice(0, 500);

  // Visible area: sum from all results, then clamp to per-cell
  const visible_area_m2 = results.reduce((acc, r) => acc + r.visible_area_m2, 0) * (visibleCount / Math.max(1, results.reduce((s, r) => s + r.visible_area_m2, 0) || 1));

  // Shadow zones: collect all from individual results  
  const shadow_zones = results.flatMap((r, idx) =>
    r.shadow_zones.map((z) => ({ zone_id: z.zone_id + idx * 1000, cell_count: z.cell_count }))
  );

  return {
    shadow_grid,
    quality_grid,
    coverage_pct: Number(coverage_pct.toFixed(2)),
    visible_area_m2: Number(visible_area_m2.toFixed(2)),
    coverage_polygon,
    shadow_zones,
  };
}

// ─── Store ───────────────────────────────────────────────────────────────────

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
  deployedRadars: [],
  unifiedLos: null,
  multiLoading: false,

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
      azWidthOverride: null,
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
      const {
        rangeMinOverride, rangeMaxOverride,
        elMinOverride, elMaxOverride,
        azCenterOverride, azWidthOverride,
      } = get();
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

  // ─── Multi-Radar ────────────────────────────────────────────────────────

  deployCurrentRadar: () => {
    const {
      selectedRadarId, radarPosition, deployedRadars,
      rangeMinOverride, rangeMaxOverride,
      elMinOverride, elMaxOverride,
      azCenterOverride, azWidthOverride,
    } = get();

    if (!selectedRadarId || !radarPosition) {
      set({ error: "Select a radar model and place it on the terrain first." });
      return;
    }

    const colorIndex = deployedRadars.length % RADAR_COLORS.length;
    const color = RADAR_COLORS[colorIndex]!;

    const newRadar: DeployedRadar = {
      id: `radar-${Date.now()}`,
      modelId: selectedRadarId,
      position: { ...radarPosition },
      color,
      rangeMin: rangeMinOverride ?? undefined,
      rangeMax: rangeMaxOverride ?? undefined,
      elMin: elMinOverride ?? undefined,
      elMax: elMaxOverride ?? undefined,
      azCenter: azCenterOverride ?? undefined,
      azWidth: azWidthOverride ?? undefined,
    };

    set({ deployedRadars: [...deployedRadars, newRadar], error: null });
  },

  removeDeployedRadar: (id) => {
    set((s) => ({
      deployedRadars: s.deployedRadars.filter((r) => r.id !== id),
      unifiedLos: null,
    }));
  },

  clearDeployedRadars: () => {
    set({ deployedRadars: [], unifiedLos: null });
  },

  runMultiAnalysis: async (terrainId) => {
    const { deployedRadars } = get();
    if (deployedRadars.length === 0) {
      set({ error: "Deploy at least one radar first." });
      return;
    }

    set({ multiLoading: true, error: null });

    try {
      // Run all radars in parallel
      const jobPromises = deployedRadars.map((dr) =>
        apiRunLOS({
          terrain_id: terrainId,
          radar_position: dr.position,
          radar_model_id: dr.modelId,
          range_min_m: dr.rangeMin,
          range_max_m: dr.rangeMax,
          el_min_deg: dr.elMin,
          el_max_deg: dr.elMax,
          az_center_deg: dr.azCenter,
          az_width_deg: dr.azWidth,
        })
      );

      const jobs = await Promise.all(jobPromises);

      // Poll all jobs until they complete
      const pollJob = (jobId: string): Promise<LOSResponse> =>
        new Promise((resolve, reject) => {
          const check = async () => {
            try {
              const s = await getLOSJob(jobId);
              if (s.status === "COMPLETED" && s.result) resolve(s.result);
              else if (s.status === "FAILED") reject(new Error(s.error ?? "Analysis failed"));
              else setTimeout(check, 1000);
            } catch (e) {
              reject(e);
            }
          };
          setTimeout(check, 1000);
        });

      const results = await Promise.all(jobs.map((j) => pollJob(j.job_id)));

      // Store individual results on each deployed radar
      const updatedRadars = deployedRadars.map((dr, i) => ({
        ...dr,
        result: results[i],
      }));

      const unified = mergeResults(results);

      set({
        deployedRadars: updatedRadars,
        unifiedLos: unified,
        losResult: unified, // also update single-result so overlay works
        multiLoading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Multi-analysis failed",
        multiLoading: false,
      });
    }
  },
}));
