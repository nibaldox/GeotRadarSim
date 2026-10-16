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
  previewTerrainBounds as apiPreviewTerrainBounds,
  type TerrainBoundsPreview,
} from "../services/api";
import type {
  DTMMetadata,
  TerrainGridResponse,
  SyntheticTerrainRequest,
} from "../types/api";
import { useAnalysisStore } from "./analysisStore";
import type { TerrainKey } from "./analysisStore";

/** Per-file upload preview state: file metadata + parsed bounds, waiting for the user to confirm a resolution. */
export interface UploadPreview {
  file: File;
  filename: string;
  source: 'STL' | 'DXF';
  pointCount: number;
  bbox: {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
  };
  span: { x: number; y: number; z: number };
}

export interface TerrainState {
  metadata: DTMMetadata | null;
  grid: number[][] | null;
  terrainKey: TerrainKey | null;
  terrainEpoch: number;
  loading: boolean;
  error: string | null;
  preferredResolution: number;

  /** Pending upload preview while the worker parses bounds; null when no preview is active. */
  uploadPreview: UploadPreview | null;
  uploadPreviewLoading: boolean;
  uploadPreviewError: string | null;

  generateSynthetic: (params: SyntheticTerrainRequest) => Promise<void>;
  loadGrid: (terrainId: string) => Promise<void>;
  uploadDXF: (file: File) => Promise<void>;
  uploadSTL: (file: File) => Promise<void>;
  setPreferredResolution: (res: number) => void;
  clearError: () => void;

  /**
   * Begin a bounds preview for a chosen file. Surfaces the file's X/Y/Z envelope and
   * the suggested resolution before committing to a full DTM build.
   */
  startUploadPreview: (file: File) => Promise<void>;
  cancelUploadPreview: () => void;
  /** Commit the pending preview by uploading with the chosen resolution. */
  confirmUploadPreview: (resolution: number) => Promise<void>;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : "Unknown error";

export const useTerrainStore = create<TerrainState>((set, get) => {
  let latestRequestId = 0;
  let latestPreviewRequest = 0;

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
    uploadPreview: null,
    uploadPreviewLoading: false,
    uploadPreviewError: null,

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

    startUploadPreview: async (file) => {
      const requestId = ++latestPreviewRequest;
      set({
        uploadPreview: { file, filename: file.name } as UploadPreview,
        uploadPreviewLoading: true,
        uploadPreviewError: null,
      });
      try {
        const bounds: TerrainBoundsPreview = await apiPreviewTerrainBounds(file);
        if (requestId !== latestPreviewRequest) return;
        set({
          uploadPreview: {
            file,
            filename: file.name,
            source: bounds.source,
            pointCount: bounds.pointCount,
            bbox: bounds.bbox,
            span: bounds.span,
          },
          uploadPreviewLoading: false,
        });
      } catch (err) {
        if (requestId !== latestPreviewRequest) return;
        // Keep the file around so the user can retry without re-picking; only show the error.
        set({
          uploadPreviewError: errorMessage(err),
          uploadPreviewLoading: false,
        });
      }
    },

    cancelUploadPreview: () => {
      ++latestPreviewRequest;
      set({
        uploadPreview: null,
        uploadPreviewLoading: false,
        uploadPreviewError: null,
      });
    },

    confirmUploadPreview: async (resolution) => {
      const preview = get().uploadPreview;
      if (!preview || !preview.source) {
        // Bounds not yet parsed (or parse failed); ignore the click.
        return;
      }
      const file = preview.file;
      const isStl = preview.source === 'STL';
      // Bump the request fence so any in-flight startUploadPreview becomes a no-op.
      ++latestPreviewRequest;
      // Clear the preview up front so the dialog closes immediately; the upload itself
      // raises `loading` via beginTransition().
      set({
        uploadPreview: null,
        uploadPreviewLoading: false,
        uploadPreviewError: null,
      });
      await uploadAndActivate(() =>
        isStl
          ? apiUploadSTL(file, resolution)
          : apiUploadDXF(file, resolution),
      );
    },
  };
});
