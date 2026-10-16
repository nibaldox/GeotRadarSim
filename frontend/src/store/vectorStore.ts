import { create } from "zustand";
import { cancelSensitivityAnalysis, releaseSensitivityJob, runSensitivityAnalysis, getLOSJob } from "../services/api";
import { useAnalysisStore } from "./analysisStore";
import type { HistoryEntry } from "./analysisStore";
import type { AnalysisSnapshot, SensitivityMapRequest, SensitivityMapResponse, SensitivityObservation } from "../types/api";
import { LOSCellState } from "../types/api";

export interface VectorState {
  sensitivityMap: SensitivityMapResponse | null;
  visualizationMode: "QUALITY" | "SENSITIVITY";
  loading: boolean;
  error: string | null;

  computeSensitivityMap: (terrainId: string) => Promise<void>;
  setVisualizationMode: (mode: "QUALITY" | "SENSITIVITY") => void;
  reset: () => void;
}

interface SensitivityContext {
  terrainKey: AnalysisSnapshot["terrainKey"] | null;
  transitioning: boolean;
  selectedEntries: HistoryEntry[];
}

const sameTerrainKey = (
  left: AnalysisSnapshot["terrainKey"] | null,
  right: AnalysisSnapshot["terrainKey"] | null,
): boolean => left === right || (!!left && !!right && left.terrain_id === right.terrain_id && left.epoch === right.epoch);

function sensitivityContext(state: ReturnType<typeof useAnalysisStore.getState>): SensitivityContext {
  return {
    terrainKey: state.terrainKey ? { ...state.terrainKey } : null,
    transitioning: state.terrainTransitioning,
    selectedEntries: state.history.filter((entry) => entry.selected),
  };
}

function sameContext(left: SensitivityContext, right: SensitivityContext): boolean {
  if (left.transitioning !== right.transitioning || !sameTerrainKey(left.terrainKey, right.terrainKey) ||
      left.selectedEntries.length !== right.selectedEntries.length) return false;
  return left.selectedEntries.every((entry, index) => entry === right.selectedEntries[index]);
}

function buildObservations(
  entries: HistoryEntry[],
  terrainKey: AnalysisSnapshot["terrainKey"],
): SensitivityObservation[] {
  const ids = new Set<string>();
  let expectedRows: number | null = null;
  let expectedCols: number | null = null;
  let expectedResolution: number | null = null;

  return entries.map((entry) => {
    const snapshot = entry.snapshot;
    if (!snapshot || !snapshot.analysisId || snapshot.sourceAnalysisIds.length !== 1 ||
        snapshot.sourceAnalysisIds[0] !== snapshot.analysisId || snapshot.radars.length !== 1 ||
        !sameTerrainKey(snapshot.terrainKey, terrainKey)) {
      throw new RangeError("Selected history entry requires current immutable analysis provenance and radar snapshot");
    }
    if (ids.has(snapshot.analysisId)) throw new RangeError("Selected analysis IDs must be unique");
    ids.add(snapshot.analysisId);
    const radar = snapshot.radars[0]!;
    if (!radar.radarId || radar.radarModelId !== entry.radarId ||
        radar.position.x !== entry.position.x || radar.position.y !== entry.position.y || radar.position.z !== entry.position.z) {
      throw new RangeError("Selected history radar does not match its analysis snapshot");
    }

    const { grid_rows: rows, grid_cols: cols, resolution, cell_states } = entry.result;
    if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(cols) || cols <= 0 ||
        !Number.isFinite(resolution) || resolution <= 0 || !(cell_states instanceof Uint8Array) ||
        cell_states.length !== rows * cols) {
      throw new RangeError("Selected LOS result has invalid grid dimensions or cell-state length");
    }
    if (expectedRows === null) {
      expectedRows = rows;
      expectedCols = cols;
      expectedResolution = resolution;
    } else if (rows !== expectedRows || cols !== expectedCols || resolution !== expectedResolution) {
      throw new RangeError("Selected LOS results do not share the same grid dimensions and resolution");
    }
    return {
      analysisId: snapshot.analysisId,
      snapshot,
      grid_rows: rows,
      grid_cols: cols,
      resolution,
      cell_states,
    };
  });
}

function validateSensitivityResult(
  value: unknown,
  request: SensitivityMapRequest,
): SensitivityMapResponse {
  const result = value as SensitivityMapResponse | null;
  const firstObservation = request.observations[0];
  const ids = request.observations.map((observation) => observation.analysisId);
  if (!result || !firstObservation || !sameTerrainKey(result.terrainKey, request.terrainKey) ||
      result.grid_rows !== firstObservation.grid_rows || result.grid_cols !== firstObservation.grid_cols ||
      result.resolution !== firstObservation.resolution ||
      !Array.isArray(result.sourceAnalysisIds) || result.sourceAnalysisIds.length !== ids.length ||
      result.sourceAnalysisIds.some((id, index) => id !== ids[index]) ||
      !(result.flat_sensitivity_grid instanceof Float32Array) ||
      !(result.observer_count instanceof Uint16Array) ||
      result.flat_sensitivity_grid.length !== firstObservation.grid_rows * firstObservation.grid_cols ||
      result.observer_count.length !== firstObservation.grid_rows * firstObservation.grid_cols) {
    throw new RangeError("Sensitivity result provenance or grid dimensions do not match the selected analyses");
  }

  for (let index = 0; index < result.observer_count.length; index++) {
    // All observations share one validated terrain key/grid, so gradient availability is cell-wide:
    // either every VISIBLE mask contributes at this cell or none can.
    const visibleMaskCount = request.observations.reduce(
      (count, observation) => count + Number(observation.cell_states[index] === LOSCellState.VISIBLE),
      0,
    );
    const count = result.observer_count[index]!;
    const sensitivity = result.flat_sensitivity_grid[index]!;
    if (!Number.isInteger(count) || count < 0 || count > visibleMaskCount ||
        (count !== 0 && count !== visibleMaskCount) ||
        (count === 0 ? !Number.isNaN(sensitivity) : !Number.isFinite(sensitivity) || sensitivity < 0 || sensitivity > 1.00001)) {
      throw new RangeError("Sensitivity observer count or value is inconsistent with individual LOS cell states");
    }
  }
  return result;
}

export const useVectorStore = create<VectorState>((set) => {
  let requestToken = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let activeJobId: string | null = null;

  const cancelActiveWork = () => {
    requestToken++;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (activeJobId) {
      cancelSensitivityAnalysis(activeJobId);
      releaseSensitivityJob(activeJobId);
    }
    activeJobId = null;
  };

  const discardJob = (jobId: string) => {
    cancelSensitivityAnalysis(jobId);
    releaseSensitivityJob(jobId);
    if (activeJobId === jobId) activeJobId = null;
  };

  const clearMap = () => {
    cancelActiveWork();
    set({ sensitivityMap: null, loading: false, error: null });
  };

  let lastAnalysisContext = sensitivityContext(useAnalysisStore.getState());
  useAnalysisStore.subscribe((state) => {
    const next = sensitivityContext(state);
    if (sameContext(lastAnalysisContext, next)) return;
    lastAnalysisContext = next;
    clearMap();
  });

  const isCurrentRequest = (
    token: number,
    expectedKey: AnalysisSnapshot["terrainKey"],
    selectedEntries: HistoryEntry[],
  ): boolean => {
    if (requestToken !== token) return false;
    const current = useAnalysisStore.getState();
    if (current.terrainTransitioning || !sameTerrainKey(current.terrainKey, expectedKey)) return false;
    const selected = current.history.filter((entry) => entry.selected);
    return selected.length === selectedEntries.length && selected.every((entry, index) => entry === selectedEntries[index]);
  };

  return {
    sensitivityMap: null,
    visualizationMode: "QUALITY",
    loading: false,
    error: null,

    computeSensitivityMap: async (terrainId) => {
      cancelActiveWork();
      const token = requestToken;
      set({ sensitivityMap: null, loading: false, error: null });
      const analysisState = useAnalysisStore.getState();
      const selectedEntries = analysisState.history.filter((entry) => entry.selected);
      const terrainKey = analysisState.terrainKey;

      if (selectedEntries.length === 0) return;
      if (!terrainKey || analysisState.terrainTransitioning || terrainKey.terrain_id !== terrainId) {
        set({ error: "Selected analyses do not match the active terrain", loading: false });
        return;
      }

      let observations: SensitivityObservation[];
      try {
        observations = buildObservations(selectedEntries, terrainKey);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Invalid selected analysis provenance", loading: false });
        return;
      }
      const request: SensitivityMapRequest = { terrainKey: { ...terrainKey }, observations };
      set({ loading: true, error: null });

      const requestIsCurrent = () => isCurrentRequest(token, request.terrainKey, selectedEntries);
      try {
        const job = await runSensitivityAnalysis(request);
        if (!requestIsCurrent()) {
          discardJob(job.job_id);
          return;
        }
        activeJobId = job.job_id;

        const poll = async () => {
          pollTimer = null;
          if (!requestIsCurrent()) {
            discardJob(job.job_id);
            return;
          }
          let status: Awaited<ReturnType<typeof getLOSJob>>;
          try {
            status = await getLOSJob(job.job_id);
          } catch (error) {
            if (!requestIsCurrent()) {
              discardJob(job.job_id);
              return;
            }
            set({ error: error instanceof Error ? error.message : "Error polling sensitivity job", loading: false });
            discardJob(job.job_id);
            return;
          }

          if (!requestIsCurrent()) {
            discardJob(job.job_id);
            return;
          }
          if (status.status === "PENDING") {
            if (activeJobId === job.job_id) {
              pollTimer = setTimeout(() => void poll(), 250);
            }
            return;
          }

          try {
            if (status.status === "COMPLETED") {
              if (!status.result) throw new Error("Sensitivity job completed without a result");
              const sensitivityMap = validateSensitivityResult(status.result, request);
              set({ sensitivityMap, visualizationMode: "SENSITIVITY", loading: false, error: null });
            } else {
              set({ error: status.error || "Failed to calculate geometric sensitivity map", loading: false });
            }
          } catch (error) {
            set({ error: error instanceof Error ? error.message : "Invalid sensitivity map result", loading: false });
          } finally {
            if (activeJobId === job.job_id) activeJobId = null;
            releaseSensitivityJob(job.job_id);
          }
        };

        pollTimer = setTimeout(() => void poll(), 250);
      } catch (error) {
        if (!requestIsCurrent()) return;
        set({ error: error instanceof Error ? error.message : "Failed to compute geometric sensitivity map", loading: false });
      }
    },

    setVisualizationMode: (mode) => set({ visualizationMode: mode }),

    reset: () => {
      cancelActiveWork();
      set({ sensitivityMap: null, error: null, visualizationMode: "QUALITY", loading: false });
    },
  };
});
