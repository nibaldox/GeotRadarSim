/**
 * Shared editable quality-band policy for cards, summary, both color layers,
 * legends and export metadata. Invalid changes are rejected; archived raw
 * analyses are never mutated by policy edits.
 */

import { create } from "zustand";
import { DEFAULT_QUALITY_POLICY, isValidQualityPolicy } from "../utils/qualityMetrics";
import type { QualityPolicy } from "../utils/qualityMetrics";

export interface QualityPolicyState {
  policy: QualityPolicy;
  /** Validated update; returns false and keeps the previous policy when invalid. */
  setPolicy: (next: { mediumMin: number; highMin: number }) => boolean;
  resetPolicy: () => void;
}

export const useQualityPolicyStore = create<QualityPolicyState>((set) => ({
  policy: { ...DEFAULT_QUALITY_POLICY },
  setPolicy: (next) => {
    if (!isValidQualityPolicy(next)) return false;
    set({ policy: { mediumMin: next.mediumMin, highMin: next.highMin } });
    return true;
  },
  resetPolicy: () => set({ policy: { ...DEFAULT_QUALITY_POLICY } }),
}));
