import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { renderReportCover3d } from "./reportCover3d";
import { buildReportModel, captureReportInputs, isCurrentReportState, reportStateSignature } from "./reportModel";
import { generateManagementReportPdf } from "./reportPdf";
import { ReportError } from "./types";
import type { ReportCoverImage } from "./types";

export async function prepareManagementReport(opts: { title?: string }): Promise<{ blob: Blob; filename: string }> {
  const inputs = captureReportInputs();
  const signature = reportStateSignature(inputs);
  const model = buildReportModel(inputs, { title: opts.title });
  let cover: ReportCoverImage | null = null;
  try {
    cover = await renderReportCover3d(model);
  } catch {
    console.warn("No se pudo generar la portada 3D; se usará el mapa 2D.");
  }
  const analysis = useAnalysisStore.getState();
  const terrain = useTerrainStore.getState();
  if (analysis.loading || analysis.multiLoading || terrain.loading ||
      !isCurrentReportState({ analysis, terrain }, inputs.snapshot, inputs.result) ||
      signature !== reportStateSignature()) {
    throw new ReportError("STALE", "El análisis cambió durante la generación. Vuelve a calcular la cobertura y genera el informe otra vez.");
  }
  const blob = generateManagementReportPdf(model, { cover });
  const date = new Date(model.createdAtIso);
  const pad = (value: number) => String(value).padStart(2, "0");
  const filename = `informe-reunion-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.pdf`;
  return { blob, filename };
}
