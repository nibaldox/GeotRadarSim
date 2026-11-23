/** Moved verbatim from the former tool catalog (WP4); the «Sugerir ubicación» refs use it. */
import { useAnalysisStore } from "../store/analysisStore";

/** Signature of the profile + limits; candidates `C#` expire when it changes. */
export function candidateSignature(): string {
  const s = useAnalysisStore.getState();
  return JSON.stringify([
    s.selectedRadarId,
    s.rangeMinOverride,
    s.rangeMaxOverride,
    s.elMinOverride,
    s.elMaxOverride,
    s.azCenterOverride,
    s.azWidthOverride,
  ]);
}
