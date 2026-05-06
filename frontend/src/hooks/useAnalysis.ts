/**
 * useAnalysis hook — convenience wrapper around the analysis Zustand store.
 *
 * Exposes radar selection, LOS analysis state and actions for React components.
 */

import { useAnalysisStore } from "../store/analysisStore";

export function useAnalysis() {
  const radars = useAnalysisStore((s) => s.radars);
  const selectedRadarId = useAnalysisStore((s) => s.selectedRadarId);
  const radarPosition = useAnalysisStore((s) => s.radarPosition);
  const losResult = useAnalysisStore((s) => s.losResult);
  const loading = useAnalysisStore((s) => s.loading);
  const error = useAnalysisStore((s) => s.error);
  const loadRadars = useAnalysisStore((s) => s.loadRadars);
  const selectRadar = useAnalysisStore((s) => s.selectRadar);
  const setRadarPosition = useAnalysisStore((s) => s.setRadarPosition);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);
  const clearResult = useAnalysisStore((s) => s.clearResult);

  return {
    radars,
    selectedRadarId,
    radarPosition,
    losResult,
    loading,
    error,
    loadRadars,
    selectRadar,
    setRadarPosition,
    runAnalysis,
    clearResult,
  };
}
