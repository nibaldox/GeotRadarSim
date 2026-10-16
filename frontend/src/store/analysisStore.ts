/**
 * Zustand store for LOS analysis state management.
 *
 * Owns result/history provenance and fences asynchronous analyses whenever
 * their terrain, radar selection, position, or deployed network changes.
 */

import { create } from "zustand";
import * as apiModule from "../services/api";
import {
  runLOSAnalysis as apiRunLOS,
  listRadars as apiListRadars,
  getLOSJob,
} from "../services/api";
import type {
  AnalysisRadarOverrides,
  AnalysisRadarSnapshot,
  AnalysisSnapshot,
  Point3D,
  RadarConfig,
  LOSResponse,
} from "../types/api";
import { LOSCellState } from "../types/api";

export interface TerrainKey {
  terrain_id: string;
  epoch: number;
}

export interface HistoryEntry {
  position: Point3D;
  coveragePct: number | null;
  timestamp: string;
  result: LOSResponse;
  radarId: string;
  selected?: boolean;
  /** Optional only for legacy/test-created entries; new results always set both. */
  terrain_id?: string;
  terrain_epoch?: number;
  /** Immutable provenance for newly produced history items. */
  snapshot?: AnalysisSnapshot;
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

type RadarOverrides = AnalysisRadarOverrides;

interface SingleAnalysisSnapshot {
  terrainKey: TerrainKey;
  radarId: string;
  position: Point3D;
  overrides: RadarOverrides;
}

// ─── Store interface ─────────────────────────────────────────────────────────

export interface AnalysisState {
  radars: RadarConfig[];
  selectedRadarId: string | null;
  radarPosition: Point3D | null;
  losResult: LOSResponse | null;
  /** Provenance paired atomically with losResult; absent for legacy results. */
  activeSnapshot: AnalysisSnapshot | null;
  loading: boolean;
  error: string | null;
  rangeMinOverride: number | null;
  rangeMaxOverride: number | null;
  elMinOverride: number | null;
  elMaxOverride: number | null;
  azCenterOverride: number | null;
  azWidthOverride: number | null;
  history: HistoryEntry[];
  terrainKey: TerrainKey | null;
  terrainTransitioning: boolean;

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
  /** Cancel any in-flight single or multi LOS analysis (never the radar catalog load). */
  cancelAnalysis: () => void;
  clearResult: () => void;
  clearHistory: () => void;
  restoreHistoryEntry: (index: number) => void;
  toggleHistoryEntrySelection: (index: number) => void;
  removeHistoryEntry: (index: number) => void;
  beginTerrainTransition: () => void;
  activateTerrain: (terrainKey: TerrainKey) => void;
  restoreTerrainAfterFailure: (terrainKey: TerrainKey | null) => void;

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

  const first = results[0]!;
  const { grid_rows: rows, grid_cols: cols, resolution } = first;
  if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(cols) || cols <= 0 || !Number.isFinite(resolution) || resolution <= 0) {
    throw new Error("LOS results must provide valid grid dimensions and resolution");
  }
  const size = rows * cols;
  for (const result of results) {
    if (result.grid_rows !== rows || result.grid_cols !== cols || result.resolution !== resolution) {
      throw new Error("Cannot merge LOS results with different grid dimensions or resolution");
    }
    if (!(result.cell_states instanceof Uint8Array) || result.cell_states.length !== size) {
      throw new Error("LOS cell-state dimensions do not match the declared grid");
    }
  }

  const cell_states = new Uint8Array(size);
  const flat_quality_grid = new Float32Array(size);
  flat_quality_grid.fill(-1);
  const shadow_grid: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const quality_grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  let visibleCount = 0;
  let shadowCount = 0;
  let unknownRayCount = 0;

  for (let idx = 0; idx < size; idx++) {
    const states = results.map((result) => result.cell_states[idx]!);
    let mergedState: number;
    if (states.includes(LOSCellState.NODATA)) mergedState = LOSCellState.NODATA;
    else if (states.includes(LOSCellState.VISIBLE)) mergedState = LOSCellState.VISIBLE;
    else if (states.includes(LOSCellState.UNKNOWN_RAY)) mergedState = LOSCellState.UNKNOWN_RAY;
    else if (states.includes(LOSCellState.SHADOW)) mergedState = LOSCellState.SHADOW;
    else if (states.includes(LOSCellState.OUTSIDE_FOV)) mergedState = LOSCellState.OUTSIDE_FOV;
    else mergedState = LOSCellState.OUT_OF_RANGE;

    cell_states[idx] = mergedState;
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    if (mergedState === LOSCellState.VISIBLE) {
      visibleCount++;
      let bestQuality = 0;
      for (const result of results) {
        if (result.cell_states[idx] !== LOSCellState.VISIBLE) continue;
        const flatQuality = result.flat_quality_grid?.[idx];
        const gridQuality = result.quality_grid?.[row]?.[col];
        const quality = flatQuality !== undefined && Number.isFinite(flatQuality) && flatQuality >= 0
          ? flatQuality
          : gridQuality !== undefined && Number.isFinite(gridQuality) && gridQuality >= 0
            ? gridQuality
            : 0;
        bestQuality = Math.max(bestQuality, quality);
      }
      quality_grid[row]![col] = bestQuality;
      flat_quality_grid[idx] = bestQuality;
    } else if (mergedState === LOSCellState.SHADOW) {
      shadowCount++;
      shadow_grid[row]![col] = true;
    } else if (mergedState === LOSCellState.UNKNOWN_RAY) {
      unknownRayCount++;
    }
  }

  const coverage_polygon = results
    .flatMap((result) => result.coverage_polygon)
    .filter(([x, y], index, points) => points.findIndex(([otherX, otherY]) => otherX === x && otherY === y) === index)
    .slice(0, 500);

  const shadow_zones: Array<{ zone_id: number; cell_count: number }> = [];
  const visited = new Uint8Array(size);
  let zoneId = 0;
  for (let idx = 0; idx < size; idx++) {
    if (cell_states[idx] !== LOSCellState.SHADOW || visited[idx]) continue;
    zoneId++;
    const queue = [idx];
    visited[idx] = 1;
    let cellCount = 0;
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      const row = Math.floor(current / cols);
      const col = current % cols;
      cellCount++;
      const neighbors: Array<[number, number]> = [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
      for (const [nextRow, nextCol] of neighbors) {
        if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols) continue;
        const nextIndex = nextRow * cols + nextCol;
        if (!visited[nextIndex] && cell_states[nextIndex] === LOSCellState.SHADOW) {
          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }
    }
    shadow_zones.push({ zone_id: zoneId, cell_count: cellCount });
  }

  const candidateCount = visibleCount + shadowCount + unknownRayCount;
  return {
    shadow_grid,
    cell_states,
    grid_rows: rows,
    grid_cols: cols,
    resolution,
    quality_grid,
    flat_quality_grid,
    coverage_pct: candidateCount > 0 ? Number(((visibleCount / candidateCount) * 100).toFixed(2)) : null,
    completeness_pct: candidateCount > 0
      ? Number((((visibleCount + shadowCount) / candidateCount) * 100).toFixed(2))
      : null,
    visible_area_m2: visibleCount * resolution * resolution,
    coverage_polygon,
    shadow_zones,
  };
}

const samePoint = (left: Point3D | null, right: Point3D): boolean =>
  left !== null && left.x === right.x && left.y === right.y && left.z === right.z;

const sameTerrainKey = (left: TerrainKey | null, right: TerrainKey): boolean =>
  left !== null && left.terrain_id === right.terrain_id && left.epoch === right.epoch;

const clearDeployedResults = (radars: DeployedRadar[]): DeployedRadar[] =>
  radars.map((radar) => {
    const clean = { ...radar, position: { ...radar.position } };
    delete clean.result;
    return clean;
  });

const createAnalysisSnapshot = (
  terrainKey: TerrainKey,
  radars: readonly AnalysisRadarSnapshot[],
  sourceAnalysisIds: readonly string[],
  generation: number,
): AnalysisSnapshot => {
  const sourceIds = Object.freeze([...new Set(sourceAnalysisIds)]);
  const immutableRadars = Object.freeze(radars.map((radar) => Object.freeze({
    radarId: radar.radarId,
    radarModelId: radar.radarModelId,
    position: Object.freeze({ ...radar.position }),
    overrides: Object.freeze({ ...radar.overrides }),
  })));
  return Object.freeze({
    terrainKey: Object.freeze({ ...terrainKey }),
    analysisId: sourceIds.length === 1 ? sourceIds[0]! : null,
    sourceAnalysisIds: sourceIds,
    generation,
    radars: immutableRadars,
  });
};

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAnalysisStore = create<AnalysisState>((set, get) => {
  let requestGeneration = 0;
  let radarListGeneration = 0;
  let preTransitionTerrainKey: TerrainKey | null = null;
  let preTransitionRadarPosition: Point3D | null = null;
  const trackedLOSJobs = new Map<number, Set<string>>();

  const trackLOSJob = (requestId: number, jobId: string): void => {
    const jobs = trackedLOSJobs.get(requestId) ?? new Set<string>();
    jobs.add(jobId);
    trackedLOSJobs.set(requestId, jobs);
  };

  const callLOSJobControl = (operation: "cancelLOSAnalysis" | "releaseLOSJob", jobId: string): void => {
    const exports = apiModule as unknown as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(exports, operation)) return;
    const control = exports[operation];
    if (typeof control === "function") control(jobId);
  };

  const settleLOSJob = (requestId: number, jobId: string, cancel: boolean): void => {
    callLOSJobControl(cancel ? "cancelLOSAnalysis" : "releaseLOSJob", jobId);
    const jobs = trackedLOSJobs.get(requestId);
    jobs?.delete(jobId);
    if (jobs?.size === 0) trackedLOSJobs.delete(requestId);
  };

  const cancelRequestLOSJobs = (requestId: number): void => {
    for (const jobId of [...(trackedLOSJobs.get(requestId) ?? [])]) {
      settleLOSJob(requestId, jobId, true);
    }
  };

  const releaseRequestLOSJobs = (requestId: number): void => {
    for (const jobId of [...(trackedLOSJobs.get(requestId) ?? [])]) {
      settleLOSJob(requestId, jobId, false);
    }
  };

  const advanceRequestGeneration = (): number => {
    requestGeneration += 1;
    for (const requestId of [...trackedLOSJobs.keys()]) cancelRequestLOSJobs(requestId);
    return requestGeneration;
  };

  const overridesFor = (state: AnalysisState): RadarOverrides => ({
    rangeMin: state.rangeMinOverride,
    rangeMax: state.rangeMaxOverride,
    elMin: state.elMinOverride,
    elMax: state.elMaxOverride,
    azCenter: state.azCenterOverride,
    azWidth: state.azWidthOverride,
  });

  const sameOverrides = (left: RadarOverrides, right: RadarOverrides): boolean =>
    left.rangeMin === right.rangeMin && left.rangeMax === right.rangeMax &&
    left.elMin === right.elMin && left.elMax === right.elMax &&
    left.azCenter === right.azCenter && left.azWidth === right.azWidth;

  const currentTerrainMatches = (state: AnalysisState, key: TerrainKey): boolean => {
    if (state.terrainTransitioning) return false;
    if (state.terrainKey) return sameTerrainKey(state.terrainKey, key);
    // Direct store callers without an activated terrain key retain the legacy epoch-0 path.
    return key.epoch === 0;
  };

  const entryMatchesTerrain = (entry: HistoryEntry, state: AnalysisState): boolean => {
    if (state.terrainTransitioning) return false;
    if (state.terrainKey) {
      return entry.terrain_id === state.terrainKey.terrain_id && entry.terrain_epoch === state.terrainKey.epoch;
    }
    return entry.terrain_epoch === 0;
  };

  const entryMatchesKey = (entry: HistoryEntry, key: TerrainKey): boolean =>
    entry.terrain_id === key.terrain_id && entry.terrain_epoch === key.epoch;

  const invalidateCurrentResults = (state: AnalysisState): Partial<AnalysisState> => ({
    losResult: null,
    activeSnapshot: null,
    loading: false,
    error: null,
    history: state.history.map((entry) => ({ ...entry, selected: false })),
    deployedRadars: clearDeployedResults(state.deployedRadars),
    unifiedLos: null,
    multiLoading: false,
  });

  const snapshotIsCurrent = (state: AnalysisState, snapshot: SingleAnalysisSnapshot): boolean =>
    currentTerrainMatches(state, snapshot.terrainKey) &&
    state.selectedRadarId === snapshot.radarId &&
    samePoint(state.radarPosition, snapshot.position) &&
    sameOverrides(overridesFor(state), snapshot.overrides);

  const isCurrentSingleRequest = (requestId: number, snapshot: SingleAnalysisSnapshot): boolean =>
    requestId === requestGeneration && snapshotIsCurrent(get(), snapshot);

  const deployedSnapshotMatches = (state: AnalysisState, expected: DeployedRadar[]): boolean => {
    if (state.deployedRadars.length !== expected.length) return false;
    return expected.every((radar, index) => {
      const current = state.deployedRadars[index];
      return !!current && current.id === radar.id && current.modelId === radar.modelId &&
        samePoint(current.position, radar.position) && current.rangeMin === radar.rangeMin &&
        current.rangeMax === radar.rangeMax && current.elMin === radar.elMin &&
        current.elMax === radar.elMax && current.azCenter === radar.azCenter &&
        current.azWidth === radar.azWidth;
    });
  };

  const isCurrentMultiRequest = (
    requestId: number,
    terrainKey: TerrainKey,
    deployedSnapshot: DeployedRadar[],
  ): boolean => {
    const state = get();
    return requestId === requestGeneration && currentTerrainMatches(state, terrainKey) &&
      deployedSnapshotMatches(state, deployedSnapshot);
  };

  const invalidateForConfigurationChange = (): Partial<AnalysisState> => {
    advanceRequestGeneration();
    return invalidateCurrentResults(get());
  };

  const recomputeSelectedHistory = (history: HistoryEntry[], state: AnalysisState): LOSResponse | null => {
    const selected = history.filter((entry) => entry.selected && entryMatchesTerrain(entry, state));
    if (selected.length === 0) return null;
    if (selected.length === 1) return selected[0]!.result;
    const [first, ...rest] = selected;
    if (rest.some((entry) => !entryMatchesKey(entry, {
      terrain_id: first!.terrain_id ?? "",
      epoch: first!.terrain_epoch ?? -1,
    }))) {
      return first!.result;
    }
    return mergeResults(selected.map((entry) => entry.result));
  };

  const snapshotForSelectedHistory = (
    history: HistoryEntry[],
    state: AnalysisState,
    generation: number,
  ): AnalysisSnapshot | null => {
    const selected = history.filter((entry) => entry.selected && entryMatchesTerrain(entry, state));
    if (selected.length === 0 || selected.some((entry) => !entry.snapshot)) return null;
    if (selected.length === 1) return selected[0]!.snapshot!;
    const snapshots = selected.map((entry) => entry.snapshot!);
    const sourceIds = snapshots.flatMap((snapshot) => snapshot.sourceAnalysisIds);
    const radars = snapshots.flatMap((snapshot) => snapshot.radars);
    return createAnalysisSnapshot(snapshots[0]!.terrainKey, radars, sourceIds, generation);
  };

  return {
    radars: [],
    selectedRadarId: null,
    radarPosition: null,
    losResult: null,
    activeSnapshot: null,
    loading: false,
    error: null,
    rangeMinOverride: null,
    rangeMaxOverride: null,
    elMinOverride: null,
    elMaxOverride: null,
    azCenterOverride: null,
    azWidthOverride: null,
    history: [],
    terrainKey: null,
    terrainTransitioning: false,
    deployedRadars: [],
    unifiedLos: null,
    multiLoading: false,

    loadRadars: async () => {
      const requestId = ++radarListGeneration;
      set({ loading: true, error: null });
      try {
        const radars = await apiListRadars();
        if (requestId !== radarListGeneration) return;
        set({ radars, loading: false });
      } catch (err) {
        if (requestId !== radarListGeneration) return;
        set({ error: err instanceof Error ? err.message : "Unknown error", loading: false });
      }
    },

    selectRadar: (modelId) => {
      const state = get();
      const changed = state.selectedRadarId !== modelId || state.rangeMinOverride !== null ||
        state.rangeMaxOverride !== null || state.elMinOverride !== null || state.elMaxOverride !== null ||
        state.azCenterOverride !== null || state.azWidthOverride !== null;
      if (!changed) return;
      set({
        ...invalidateForConfigurationChange(),
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
      const state = get();
      if (state.terrainTransitioning || samePoint(state.radarPosition, position)) return;
      set({ ...invalidateForConfigurationChange(), radarPosition: { ...position } });
    },

    setRangeOverrides: (min, max) => {
      const state = get();
      if (state.rangeMinOverride === min && state.rangeMaxOverride === max) return;
      set({ ...invalidateForConfigurationChange(), rangeMinOverride: min, rangeMaxOverride: max });
    },

    setElevationOverrides: (min, max) => {
      const state = get();
      if (state.elMinOverride === min && state.elMaxOverride === max) return;
      set({ ...invalidateForConfigurationChange(), elMinOverride: min, elMaxOverride: max });
    },

    setAzimuthOverrides: (center, width) => {
      const state = get();
      if (state.azCenterOverride === center && state.azWidthOverride === width) return;
      set({ ...invalidateForConfigurationChange(), azCenterOverride: center, azWidthOverride: width });
    },

    runAnalysis: async (terrainId) => {
      const initialState = get();
      if (initialState.terrainTransitioning) return;
      const { selectedRadarId, radarPosition } = initialState;
      if (!selectedRadarId || !radarPosition) {
        set({ error: "Radar model and position must be set before analysis", loading: false });
        return;
      }

      const terrainKey = initialState.terrainKey ?? { terrain_id: terrainId, epoch: 0 };
      if (terrainKey.terrain_id !== terrainId) return;
      const snapshot: SingleAnalysisSnapshot = {
        terrainKey: { ...terrainKey },
        radarId: selectedRadarId,
        position: { ...radarPosition },
        overrides: overridesFor(initialState),
      };
      const requestId = advanceRequestGeneration();
      set({
        loading: true,
        multiLoading: false,
        error: null,
        losResult: null,
        activeSnapshot: null,
        unifiedLos: null,
        deployedRadars: clearDeployedResults(get().deployedRadars),
        history: get().history.map((entry) => ({ ...entry, selected: false })),
      });

      try {
        const jobResp = await apiRunLOS({
          terrain_id: snapshot.terrainKey.terrain_id,
          radar_position: { ...snapshot.position },
          radar_model_id: snapshot.radarId,
          range_min_m: snapshot.overrides.rangeMin ?? undefined,
          range_max_m: snapshot.overrides.rangeMax ?? undefined,
          el_min_deg: snapshot.overrides.elMin ?? undefined,
          el_max_deg: snapshot.overrides.elMax ?? undefined,
          az_center_deg: snapshot.overrides.azCenter ?? undefined,
          az_width_deg: snapshot.overrides.azWidth ?? undefined,
        });
        trackLOSJob(requestId, jobResp.job_id);
        if (!isCurrentSingleRequest(requestId, snapshot)) {
          settleLOSJob(requestId, jobResp.job_id, true);
          return;
        }

        const poll = async () => {
          if (!isCurrentSingleRequest(requestId, snapshot)) {
            cancelRequestLOSJobs(requestId);
            return;
          }
          try {
            const statusResp = await getLOSJob(jobResp.job_id);
            if (!isCurrentSingleRequest(requestId, snapshot)) {
              cancelRequestLOSJobs(requestId);
              return;
            }
            if (statusResp.status === "COMPLETED" && statusResp.result) {
              const analysisSnapshot = createAnalysisSnapshot(
                snapshot.terrainKey,
                [{
                  radarId: snapshot.radarId,
                  radarModelId: snapshot.radarId,
                  position: snapshot.position,
                  overrides: snapshot.overrides,
                }],
                [jobResp.job_id],
                requestId,
              );
              const entry: HistoryEntry = {
                position: { ...snapshot.position },
                coveragePct: statusResp.result.coverage_pct,
                timestamp: new Date().toLocaleTimeString(),
                result: statusResp.result,
                radarId: snapshot.radarId,
                selected: true,
                terrain_id: snapshot.terrainKey.terrain_id,
                terrain_epoch: snapshot.terrainKey.epoch,
                snapshot: analysisSnapshot,
              };
              let published = false;
              set((state) => {
                if (requestId !== requestGeneration || !snapshotIsCurrent(state, snapshot)) return {};
                const currentHistory = state.history
                  .filter((historyEntry) => entryMatchesKey(historyEntry, snapshot.terrainKey))
                  .map((historyEntry) => ({ ...historyEntry, selected: false }));
                published = true;
                return {
                  losResult: statusResp.result,
                  activeSnapshot: analysisSnapshot,
                  loading: false,
                  error: null,
                  history: [entry, ...currentHistory].slice(0, 10),
                };
              });
              settleLOSJob(requestId, jobResp.job_id, !published);
            } else if (statusResp.status === "FAILED") {
              if (!isCurrentSingleRequest(requestId, snapshot)) {
                cancelRequestLOSJobs(requestId);
                return;
              }
              set({ error: statusResp.error || "Analysis failed", loading: false, losResult: null });
              settleLOSJob(requestId, jobResp.job_id, false);
            } else {
              setTimeout(poll, 1000);
            }
          } catch (err) {
            if (!isCurrentSingleRequest(requestId, snapshot)) {
              cancelRequestLOSJobs(requestId);
              return;
            }
            set({
              error: err instanceof Error ? err.message : "Error checking job status",
              loading: false,
            });
            cancelRequestLOSJobs(requestId);
          }
        };

        if (isCurrentSingleRequest(requestId, snapshot)) setTimeout(poll, 1000);
        else cancelRequestLOSJobs(requestId);
      } catch (err) {
        if (!isCurrentSingleRequest(requestId, snapshot)) return;
        set({
          error: err instanceof Error ? err.message : "Unknown error",
          loading: false,
        });
      }
    },

    cancelAnalysis: () => {
      const state = get();
      // Only a running single/multi analysis may be cancelled: finished results
      // are preserved and the shared loadRadars catalog fetch is left alone
      // (the UI hides the control while the radar catalog is loading).
      if (!state.loading && !state.multiLoading) return;
      // advanceRequestGeneration fences every pending single/multi poll and
      // terminates all tracked LOS jobs via cancelLOSAnalysis; jobs created
      // afterwards settle stale and get cancelled on arrival.
      set({ ...invalidateForConfigurationChange() });
    },

    clearResult: () => {
      advanceRequestGeneration();
      set({ losResult: null, activeSnapshot: null, loading: false });
    },

    clearHistory: () => {
      advanceRequestGeneration();
      set({ history: [], losResult: null, activeSnapshot: null, loading: false, error: null });
    },

    restoreHistoryEntry: (index) => {
      const state = get();
      const entry = state.history[index];
      if (!entry || !entryMatchesTerrain(entry, state)) return;
      advanceRequestGeneration();
      const history = state.history.map((candidate, idx) => ({
        ...candidate,
        selected: idx === index && entryMatchesTerrain(candidate, state),
      }));
      const radarSnapshot = entry.snapshot?.radars[0];
      set({
        history,
        losResult: entry.result,
        activeSnapshot: entry.snapshot ?? null,
        radarPosition: radarSnapshot ? { ...radarSnapshot.position } : { ...entry.position },
        selectedRadarId: radarSnapshot?.radarModelId ?? entry.radarId,
        ...(radarSnapshot ? {
          rangeMinOverride: radarSnapshot.overrides.rangeMin,
          rangeMaxOverride: radarSnapshot.overrides.rangeMax,
          elMinOverride: radarSnapshot.overrides.elMin,
          elMaxOverride: radarSnapshot.overrides.elMax,
          azCenterOverride: radarSnapshot.overrides.azCenter,
          azWidthOverride: radarSnapshot.overrides.azWidth,
        } : {}),
        loading: false,
        multiLoading: false,
        error: null,
        unifiedLos: null,
      });
    },

    toggleHistoryEntrySelection: (index) => {
      const state = get();
      const entry = state.history[index];
      if (!entry || !entryMatchesTerrain(entry, state)) return;
      advanceRequestGeneration();
      const history = state.history.map((candidate, idx) => {
        if (!entryMatchesTerrain(candidate, state)) return { ...candidate, selected: false };
        if (idx === index) return { ...candidate, selected: !candidate.selected };
        return candidate;
      });
      const losResult = recomputeSelectedHistory(history, state);
      const activeSnapshot = snapshotForSelectedHistory(history, state, requestGeneration);
      set({ history, losResult, activeSnapshot, loading: false, multiLoading: false, error: null, unifiedLos: null });
    },

    removeHistoryEntry: (index) => {
      const state = get();
      advanceRequestGeneration();
      const history = state.history.filter((_, idx) => idx !== index);
      const losResult = recomputeSelectedHistory(history, state);
      const activeSnapshot = snapshotForSelectedHistory(history, state, requestGeneration);
      set({ history, losResult, activeSnapshot, loading: false, multiLoading: false, error: null });
    },

    beginTerrainTransition: () => {
      advanceRequestGeneration();
      const state = get();
      if (!state.terrainTransitioning) {
        preTransitionTerrainKey = state.terrainKey ? { ...state.terrainKey } : null;
        preTransitionRadarPosition = state.radarPosition ? { ...state.radarPosition } : null;
      }
      set({
        ...invalidateCurrentResults(state),
        terrainKey: null,
        terrainTransitioning: true,
        radarPosition: null,
        history: [],
        deployedRadars: [],
        unifiedLos: null,
      });
    },

    activateTerrain: (terrainKey) => {
      advanceRequestGeneration();
      const state = get();
      const changed = !sameTerrainKey(state.terrainKey, terrainKey);
      preTransitionTerrainKey = null;
      preTransitionRadarPosition = null;
      set({
        ...(changed ? invalidateCurrentResults(state) : {}),
        terrainKey: { ...terrainKey },
        terrainTransitioning: false,
        ...(changed ? { history: [], deployedRadars: [], unifiedLos: null, radarPosition: null } : {}),
      });
    },

    restoreTerrainAfterFailure: (terrainKey) => {
      advanceRequestGeneration();
      // A failed import leaves A active, so restore its position only with A's exact key.
      const restorePosition = terrainKey && sameTerrainKey(preTransitionTerrainKey, terrainKey)
        ? preTransitionRadarPosition
        : null;
      preTransitionTerrainKey = null;
      preTransitionRadarPosition = null;
      set({
        terrainKey: terrainKey ? { ...terrainKey } : null,
        terrainTransitioning: false,
        radarPosition: restorePosition ? { ...restorePosition } : null,
      });
    },

    deployCurrentRadar: () => {
      const state = get();
      const {
        selectedRadarId, radarPosition, deployedRadars,
        rangeMinOverride, rangeMaxOverride,
        elMinOverride, elMaxOverride,
        azCenterOverride, azWidthOverride,
      } = state;

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
      set({
        ...invalidateForConfigurationChange(),
        deployedRadars: [...clearDeployedResults(deployedRadars), newRadar],
        error: null,
      });
    },

    removeDeployedRadar: (id) => {
      const state = get();
      const invalidated = invalidateForConfigurationChange();
      set({
        ...invalidated,
        deployedRadars: clearDeployedResults(state.deployedRadars.filter((radar) => radar.id !== id)),
        unifiedLos: null,
        losResult: null,
      });
    },

    clearDeployedRadars: () => {
      set({
        ...invalidateForConfigurationChange(),
        deployedRadars: [],
        unifiedLos: null,
        losResult: null,
      });
    },

    runMultiAnalysis: async (terrainId) => {
      const state = get();
      if (state.terrainTransitioning) return;
      const terrainKey = state.terrainKey ?? { terrain_id: terrainId, epoch: 0 };
      if (terrainKey.terrain_id !== terrainId) return;
      if (state.deployedRadars.length === 0) {
        set({ error: "Deploy at least one radar first.", multiLoading: false });
        return;
      }

      const deployedSnapshot = clearDeployedResults(state.deployedRadars);
      const requestId = advanceRequestGeneration();
      set({
        multiLoading: true,
        loading: false,
        error: null,
        losResult: null,
        activeSnapshot: null,
        unifiedLos: null,
        history: state.history.map((entry) => ({ ...entry, selected: false })),
        deployedRadars: deployedSnapshot,
      });

      const snapshotIsCurrent = () => isCurrentMultiRequest(requestId, terrainKey, deployedSnapshot);
      try {
        const jobs = await Promise.all(deployedSnapshot.map(async (radar) => {
          const job = await apiRunLOS({
            terrain_id: terrainKey.terrain_id,
            radar_position: { ...radar.position },
            radar_model_id: radar.modelId,
            range_min_m: radar.rangeMin,
            range_max_m: radar.rangeMax,
            el_min_deg: radar.elMin,
            el_max_deg: radar.elMax,
            az_center_deg: radar.azCenter,
            az_width_deg: radar.azWidth,
          });
          trackLOSJob(requestId, job.job_id);
          if (!snapshotIsCurrent()) settleLOSJob(requestId, job.job_id, true);
          return job;
        }));
        if (!snapshotIsCurrent()) {
          cancelRequestLOSJobs(requestId);
          return;
        }

        const pollJob = (jobId: string): Promise<LOSResponse | null> =>
          new Promise((resolve, reject) => {
            const check = async () => {
              if (!snapshotIsCurrent()) {
                cancelRequestLOSJobs(requestId);
                resolve(null);
                return;
              }
              try {
                const response = await getLOSJob(jobId);
                if (!snapshotIsCurrent()) {
                  cancelRequestLOSJobs(requestId);
                  resolve(null);
                  return;
                }
                if (response.status === "COMPLETED" && response.result) resolve(response.result);
                else if (response.status === "FAILED") reject(new Error(response.error ?? "Analysis failed"));
                else setTimeout(check, 1000);
              } catch (err) {
                if (!snapshotIsCurrent()) {
                  cancelRequestLOSJobs(requestId);
                  resolve(null);
                } else reject(err);
              }
            };
            setTimeout(check, 1000);
          });

        const results = await Promise.all(jobs.map((job) => pollJob(job.job_id)));
        if (!snapshotIsCurrent() || results.some((result) => result === null)) {
          cancelRequestLOSJobs(requestId);
          return;
        }
        const completedResults = results as LOSResponse[];
        const unified = mergeResults(completedResults);
        if (!snapshotIsCurrent()) {
          cancelRequestLOSJobs(requestId);
          return;
        }

        const updatedRadars = deployedSnapshot.map((radar, index) => ({
          ...radar,
          result: completedResults[index],
        }));
        const analysisSnapshot = createAnalysisSnapshot(
          terrainKey,
          deployedSnapshot.map((radar) => ({
            radarId: radar.id,
            radarModelId: radar.modelId,
            position: radar.position,
            overrides: {
              rangeMin: radar.rangeMin ?? null,
              rangeMax: radar.rangeMax ?? null,
              elMin: radar.elMin ?? null,
              elMax: radar.elMax ?? null,
              azCenter: radar.azCenter ?? null,
              azWidth: radar.azWidth ?? null,
            },
          })),
          jobs.map((job) => job.job_id),
          requestId,
        );
        let published = false;
        set((current) => {
          if (!snapshotIsCurrent() || !deployedSnapshotMatches(current, deployedSnapshot)) return {};
          published = true;
          return {
            deployedRadars: updatedRadars,
            unifiedLos: unified,
            losResult: unified,
            activeSnapshot: analysisSnapshot,
            multiLoading: false,
            error: null,
          };
        });
        if (published) releaseRequestLOSJobs(requestId);
        else cancelRequestLOSJobs(requestId);
      } catch (err) {
        if (!snapshotIsCurrent()) {
          cancelRequestLOSJobs(requestId);
          return;
        }
        set({
          error: err instanceof Error ? err.message : "Multi-analysis failed",
          multiLoading: false,
        });
        cancelRequestLOSJobs(requestId);
      }
    },
  };
});
