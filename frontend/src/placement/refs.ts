/**
 * Opaque short references of the «Sugerir ubicación» runtime instead of internal IDs (DESIGN §1,
 * herramientas.md «Referencias opacas y cortas»).
 *
 * - `T<epoch>`: the terrain, from the WP1 activation epoch.
 * - `A#`: an analysis of the history (internal `snapshot.analysisId`).
 * - `C#`: a candidate of the optimizer (registered by WP8).
 *
 * Every ref is bound to the terrain key (terrain_id + epoch) that was active
 * when it was minted. Counters never go back within a session, so a ref name
 * is never reused: once the epoch changes, the old refs stay stale forever and
 * `isStale` can answer by name alone. The terrain_id and the
 * `dtm-`/`stl-`/`los-job-` IDs never leave this module.
 */

import type { TerrainKey } from "../store/analysisStore";

export const MAX_REF_NUMBER = 999;

export type RefResolution<T> =
  | { status: "ok"; value: T }
  | { status: "stale" }
  | { status: "unknown" };

interface Bound<T> {
  key: TerrainKey;
  value: T;
}

export interface CandidateRecord {
  /** Local coordinates (metres from the terrain's minimum corner). */
  x_m: number;
  y_m: number;
  height_above_ground_m: number;
  /** Profile + limits the optimizer used; a different current signature makes the candidate stale. */
  signature: string;
}

const sameKey = (a: TerrainKey | null, b: TerrainKey | null): boolean =>
  !!a && !!b && a.terrain_id === b.terrain_id && a.epoch === b.epoch;

const REF_RE = /^([ACT])([0-9]{1,3})$/u;

export interface PlacementRefMapOptions {
  /** Active terrain key (WP1), or null without terrain / during a transition. */
  currentKey: () => TerrainKey | null;
  /** Current profile + limits signature, used to expire `C#`. */
  candidateSignature?: () => string;
  /** False when the analysis left the history (cap of 10, or deleted by the user): its `A#` is stale (R4 WP4A-3). */
  isLiveAnalysis?: (key: TerrainKey, analysisId: string) => boolean;
}

export class PlacementRefMap {
  private readonly analyses = new Map<string, Bound<string>>();
  private readonly analysisIndex = new Map<string, string>();
  private readonly candidates = new Map<string, Bound<CandidateRecord>>();
  private readonly counters = { A: 0, C: 0 };

  constructor(private readonly options: PlacementRefMapOptions) {}

  /** True when `n` more refs of `kind` can still be minted in this session (R4 WP4A-12). */
  canMint(kind: "A" | "C", n = 1): boolean {
    return this.counters[kind] + n <= MAX_REF_NUMBER;
  }

  private mint(kind: "A" | "C"): string | null {
    if (this.counters[kind] >= MAX_REF_NUMBER) return null;
    this.counters[kind] += 1;
    return `${kind}${this.counters[kind]}`;
  }

  /** Stable `A#` for an analysis of `key`; null only when the session ran out of refs. */
  analysisRef(key: TerrainKey, analysisId: string): string | null {
    const index = `${key.epoch}\u0000${key.terrain_id}\u0000${analysisId}`;
    const existing = this.analysisIndex.get(index);
    if (existing) return existing;
    const ref = this.mint("A");
    if (!ref) return null;
    this.analysisIndex.set(index, ref);
    this.analyses.set(ref, { key: { terrain_id: key.terrain_id, epoch: key.epoch }, value: analysisId });
    return ref;
  }

  private resolve<T>(map: Map<string, Bound<T>>, ref: string): RefResolution<T> {
    const bound = map.get(ref);
    if (!bound) return { status: "unknown" };
    if (!sameKey(bound.key, this.options.currentKey())) return { status: "stale" };
    return { status: "ok", value: bound.value };
  }

  resolveAnalysis(ref: string): RefResolution<string> {
    const resolved = this.resolve(this.analyses, ref);
    if (resolved.status !== "ok") return resolved;
    const bound = this.analyses.get(ref)!;
    if (this.options.isLiveAnalysis && !this.options.isLiveAnalysis(bound.key, resolved.value)) return { status: "stale" };
    return resolved;
  }

  registerCandidate(key: TerrainKey, record: CandidateRecord): string | null {
    const ref = this.mint("C");
    if (ref) this.candidates.set(ref, { key: { ...key }, value: { ...record } });
    return ref;
  }

  resolveCandidate(ref: string): RefResolution<CandidateRecord> {
    const resolved = this.resolve(this.candidates, ref);
    if (resolved.status !== "ok") return resolved;
    const signature = this.options.candidateSignature?.();
    if (signature !== undefined && signature !== resolved.value.signature) return { status: "stale" };
    return resolved;
  }

  /** True when the ref exists but belongs to another epoch (or expired); unknown refs are not stale. */
  isStale(ref: string): boolean {
    const match = REF_RE.exec(ref);
    if (!match) return false;
    const kind = match[1] as "A" | "C" | "T";
    if (kind === "T") {
      const current = this.options.currentKey();
      return current === null || `T${current.epoch}` !== ref;
    }
    if (kind === "A") return this.resolveAnalysis(ref).status === "stale";
    return this.resolveCandidate(ref).status === "stale";
  }
}
