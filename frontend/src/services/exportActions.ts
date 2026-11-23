import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { exportPDF, exportCSV } from "./api";
import { buildQualityExportContext, metricForVisualizationMode } from "../utils/qualityReport";
import type { QualityExportContext } from "../utils/qualityReport";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

export type ExportFormat = "pdf" | "csv" | "png";
export type ExportErrorCode = "INVALID_FORMAT" | "NOT_AVAILABLE" | "SUPERSEDED" | "CANVAS_NOT_FOUND" | "IMAGE_EMPTY" | "EXPORT_FAILED";
export class ExportError extends Error {
  constructor(public readonly code: ExportErrorCode, public readonly cause?: unknown) {
    super(code);
    this.name = "ExportError";
  }
}
/** The original pair is retained so callers can recheck it immediately before download. */
export interface ExportProvenance { snapshot: AnalysisSnapshot; result: LOSResponse }
export interface PreparedExport { blob: Blob; filename: string; provenance: ExportProvenance }

export const sameTerrainKey = (
  left: Readonly<{ terrain_id: string; epoch: number }> | null,
  right: Readonly<{ terrain_id: string; epoch: number }> | null,
): boolean => !!left && !!right && left.terrain_id === right.terrain_id && left.epoch === right.epoch;

function cloneAnalysisSnapshot(snapshot: AnalysisSnapshot): AnalysisSnapshot {
  return {
    terrainKey: { ...snapshot.terrainKey }, analysisId: snapshot.analysisId,
    sourceAnalysisIds: [...snapshot.sourceAnalysisIds], generation: snapshot.generation,
    radars: snapshot.radars.map((radar) => ({
      radarId: radar.radarId, radarModelId: radar.radarModelId,
      position: { ...radar.position }, overrides: { ...radar.overrides },
    })),
  };
}

export function isCurrentExport(snapshot: AnalysisSnapshot, result: LOSResponse): boolean {
  const analysis = useAnalysisStore.getState();
  const terrain = useTerrainStore.getState();
  return analysis.activeSnapshot === snapshot && analysis.losResult === result &&
    !analysis.terrainTransitioning && sameTerrainKey(snapshot.terrainKey, analysis.terrainKey) &&
    sameTerrainKey(snapshot.terrainKey, terrain.terrainKey) &&
    terrain.metadata?.terrain_id === snapshot.terrainKey.terrain_id;
}

export function captureQualityContext(snapshot: AnalysisSnapshot, result: LOSResponse): QualityExportContext | null {
  const terrain = useTerrainStore.getState();
  return buildQualityExportContext({
    snapshot, losResult: result,
    metric: metricForVisualizationMode(useVectorStore.getState().visualizationMode),
    policy: useQualityPolicyStore.getState().policy,
    terrainGrid: terrain.grid, terrainMetadata: terrain.metadata, terrainKey: terrain.terrainKey,
  });
}

/** Prepare only; the caller must confirm and recheck provenance before downloading. */
export async function prepareExport(format: ExportFormat): Promise<PreparedExport> {
  if (format !== "pdf" && format !== "csv" && format !== "png") throw new ExportError("INVALID_FORMAT");
  const { activeSnapshot: snapshot, losResult: result } = useAnalysisStore.getState();
  if (!snapshot || !result || !isCurrentExport(snapshot, result)) throw new ExportError("NOT_AVAILABLE");
  const provenance = { snapshot, result };
  const terrainId = snapshot.terrainKey.terrain_id;
  try {
    let blob: Blob | null;
    let filename: string;
    if (format === "png") {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new ExportError("CANVAS_NOT_FOUND");
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      filename = `terrain-snapshot-${terrainId}.png`;
    } else {
      const qualityContext = captureQualityContext(snapshot, result);
      const exportableSnapshot = cloneAnalysisSnapshot(snapshot);
      blob = format === "pdf"
        ? await exportPDF(exportableSnapshot, result, qualityContext ?? undefined)
        : await exportCSV(exportableSnapshot, result, qualityContext ?? undefined);
      filename = format === "pdf" ? `coverage-report-${terrainId}.pdf` : `coverage-data-${terrainId}.csv`;
    }
    if (!isCurrentExport(snapshot, result)) throw new ExportError("SUPERSEDED");
    if (!blob) throw new ExportError("IMAGE_EMPTY");
    return { blob, filename, provenance };
  } catch (error) {
    if (!isCurrentExport(snapshot, result)) throw new ExportError("SUPERSEDED", error);
    if (error instanceof ExportError) throw error;
    throw new ExportError("EXPORT_FAILED", error);
  }
}
