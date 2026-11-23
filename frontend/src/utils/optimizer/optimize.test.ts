import { describe, expect, it } from "vitest";
import { mergeResults } from "../../store/analysisStore";
import { LOSCellState } from "../../types/api";
import { DEFAULT_QUALITY_POLICY, computeQualitySummary } from "../qualityMetrics";
import { objectiveQualityMetric, objectiveValueFromSummary } from "./objective";
import { optimizeCoarse } from "./optimize";
import type { CoarseOptimizationInput } from "./optimize";
import { asLOSResponse } from "./optimizer.testSupport";
import type { LosCellOutput, LosRequest, LosScorer, OptimizerGrid } from "./types";

/** Stepped pit (1 m nodes, 60 × 80) with a NODATA notch; z drops 5 m at each face node. */
function pit(): OptimizerGrid {
  const rows = 60;
  const cols = 80;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    const level = c < 20 ? 30 : c < 22 ? 30 - 5 * (c - 19) : c < 40 ? 20 : c < 42 ? 20 - 5 * (c - 39) : 10;
    return r < 3 && c > 60 ? Number.NaN : level;
  }));
  return { grid, bounds: { min_x: 100, min_y: 200 }, resolution: 1 };
}

/**
 * Fake LOS: VISIBLE inside a disk of radius 18 m around the radar (on the grid it is
 * handed), quality falling with distance, projection depending on the column parity.
 */
function fakeLos(calls: LosRequest[]): LosScorer {
  return (request) => {
    calls.push(request);
    const { grid, bounds, resolution } = request.grid;
    const rows = grid.length;
    const cols = grid[0]!.length;
    const size = rows * cols;
    const cell_states = new Uint8Array(size);
    const flat_quality_grid = new Float32Array(size).fill(-1);
    const flat_projection_grid = new Float32Array(size).fill(Number.NaN);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (!Number.isFinite(grid[r]![c]!)) {
          cell_states[idx] = LOSCellState.NODATA;
          continue;
        }
        const dx = bounds.min_x + c * resolution - request.position.x;
        const dy = bounds.min_y + r * resolution - request.position.y;
        const d = Math.hypot(dx, dy);
        if (d > 18) {
          cell_states[idx] = LOSCellState.OUT_OF_RANGE;
          continue;
        }
        cell_states[idx] = LOSCellState.VISIBLE;
        flat_quality_grid[idx] = Math.max(0, 1 - d / 18);
        flat_projection_grid[idx] = c % 2 === 0 ? 0.6 : 0.2;
      }
    }
    return { cell_states, flat_quality_grid, flat_projection_grid };
  };
}

function baseInput(calls: LosRequest[], extra: Partial<CoarseOptimizationInput> = {}): CoarseOptimizationInput {
  return {
    source: pit(),
    k: 3,
    policy: DEFAULT_QUALITY_POLICY,
    los: fakeLos(calls),
    minSeparationM: 15,
    maxCoarseNodes: 1500,
    ...extra,
  };
}

describe("optimizeCoarse (pure pipeline with an injected LOS)", () => {
  it("defaults to USEFUL_INCIDENCE, coarsens the grid and scores every candidate on it", () => {
    const calls: LosRequest[] = [];
    const result = optimizeCoarse(baseInput(calls));
    expect(result.status).toBe("OK");
    expect(result.objective).toBe("USEFUL_INCIDENCE");
    // 60 × 80 = 4800 > 1500 at f = 1; f = 2 gives 30 × 40 = 1200 ≤ 1500.
    expect(result.coarse).toEqual({ factor: 2, rows: 30, cols: 40, resolution: 2 });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(result.candidates.length);
    calls.forEach((call, index) => {
      expect(call.subject).toEqual({ kind: "candidate", index });
      expect(call.grid.grid.length).toBe(30);
      expect(call.grid.grid[0]!.length).toBe(40);
      expect(call.grid.resolution).toBe(2);
      const candidate = result.candidates[index]!;
      expect(call.position).toEqual({ x: candidate.x, y: candidate.y, z: candidate.groundZ + 2 });
    });
    expect(result.greedy!.selected.length).toBeGreaterThan(0);
    expect(result.greedy!.guarantee).toBe("heuristic");
  });

  it("reports coarse union values identical to mergeResults + computeQualitySummary on the coarse grid", () => {
    for (const objective of ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"] as const) {
      const calls: LosRequest[] = [];
      const fixed = [{ x: 105, y: 250, z: 32 }];
      const result = optimizeCoarse(baseInput(calls, { objective, fixed }));
      expect(result.status).toBe("OK");
      const greedy = result.greedy!;
      // App union order (history newest first): chosen candidates in reverse selection order, then the fixed radar.
      const outputs: LosCellOutput[] = [];
      const scorer = fakeLos([]);
      const fixedCall = calls.find((call) => call.subject.kind === "fixed")!;
      expect(greedy.unionOrder).toEqual([
        ...[...greedy.selected].reverse().map((index) => ({ kind: "candidate", index })),
        { kind: "fixed", index: 0 },
      ]);
      for (const member of greedy.unionOrder) {
        outputs.push(scorer(member.kind === "fixed"
          ? fixedCall
          : calls.find((call) => call.subject.kind === "candidate" && call.subject.index === member.index)!));
      }
      const coarseGrid = fixedCall.grid.grid.map((row) => [...row]);
      const key = { terrain_id: "t", epoch: 3 };
      const merged = mergeResults(outputs.map((output) => asLOSResponse(output, 30, 40, 2)));
      const summary = computeQualitySummary({
        metric: objectiveQualityMetric(objective),
        policy: DEFAULT_QUALITY_POLICY,
        losResult: merged,
        terrainGrid: coarseGrid,
        terrainResolution: 2,
        terrainKey: key,
        snapshot: { terrainKey: key, analysisId: null, sourceAnalysisIds: [], generation: 1, radars: [] },
      })!;
      expect(greedy.value).toBe(objectiveValueFromSummary(summary, objective, DEFAULT_QUALITY_POLICY));
      expect(result.fixedValues).toHaveLength(1);
      expect(greedy.baseValue).toBe(result.fixedValues[0]);
      if (objective === "USEFUL_PROJECTION") expect(greedy.guarantee).toBe("none");
    }
  });

  it("raises a buried coarse radar with the injected coarse-surface sampler", () => {
    const calls: LosRequest[] = [];
    const result = optimizeCoarse(baseInput(calls, {
      heightAboveGroundM: 2,
      sampleCoarseSurface: (_grid, x) => (x < 130 ? 1000 : null),
    }));
    result.candidates.forEach((candidate, index) => {
      const position = result.coarsePositions[index]!;
      if (candidate.x < 130) expect(position).toEqual({ z: 1002, adjusted: true });
      else expect(position).toEqual({ z: candidate.groundZ + 2, adjusted: false });
      expect(calls[index]!.position.z).toBe(position.z);
    });
    expect(result.coarsePositions.some((position) => position.adjusted)).toBe(true);
  });

  it("is deterministic: two runs give the same JSON", () => {
    const first = optimizeCoarse(baseInput([]));
    const second = optimizeCoarse(baseInput([]));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(() => JSON.parse(JSON.stringify(first))).not.toThrow();
  });

  it("checks cancellation between LOS evaluations and reports progress", () => {
    const calls: LosRequest[] = [];
    const progress: Array<{ phase: string; done: number; total: number }> = [];
    const result = optimizeCoarse(baseInput(calls, {
      isCancelled: () => calls.length >= 3,
      onProgress: (event) => progress.push({ phase: event.phase, done: event.done, total: event.total }),
    }));
    expect(result.status).toBe("CANCELLED");
    expect(result.greedy).toBeNull();
    expect(calls).toHaveLength(3);
    expect(progress.map((event) => event.done)).toEqual([1, 2, 3]);
    expect(progress.every((event) => event.phase === "coarse_los")).toBe(true);
  });

  it("returns NO_CANDIDATES on a terrain without eligible nodes", () => {
    const tiny = { grid: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bounds: { min_x: 0, min_y: 0 }, resolution: 1 };
    const result = optimizeCoarse({ ...baseInput([]), source: tiny });
    expect(result.status).toBe("NO_CANDIDATES");
    expect(result.greedy).toBeNull();
  });

  it("rejects a LOS output that does not match the coarse grid", () => {
    const bad: LosScorer = () => ({
      cell_states: new Uint8Array(3),
      flat_quality_grid: new Float32Array(3),
      flat_projection_grid: new Float32Array(3),
    });
    expect(() => optimizeCoarse({ ...baseInput([]), los: bad })).toThrow(RangeError);
  });
});
