/**
 * Seeded regression cases for the optimizer without an AOI (WP14).
 *
 * `regressionDigests()` runs the public optimizer API on fixed-seed instances and returns
 * one digest per case. The expected digests in `regression.fixture.ts` were produced by
 * this module on the WP7 base (4207380), before any WP14 change, so the regression test
 * proves that a run without `aoi` gives byte-identical JSON to that base.
 */

import { LOSCellState } from "../../types/api";
import { DEFAULT_QUALITY_POLICY } from "../qualityMetrics";
import type { QualityPolicy } from "../qualityMetrics";
import { greedySelect } from "./greedy";
import { evaluateUnion, scoreLosOutput } from "./objective";
import { optimizeCoarse } from "./optimize";
import { randomInt, seededRandom } from "./optimizer.testSupport";
import type { LosCellOutput, LosScorer, OptimizerGrid, OptimizerObjective } from "./types";

const OBJECTIVES: readonly OptimizerObjective[] = ["VISIBLE_AREA", "USEFUL_INCIDENCE", "USEFUL_PROJECTION"];

/** FNV-1a over UTF-16 code units, two seeds, plus the length: collisions are irrelevant here. */
export function digestString(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 + 2) >>> 0;
  }
  return `${text.length}:${a.toString(16)}:${b.toString(16)}`;
}

/** JSON with typed arrays as plain arrays and non-finite numbers spelled out. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Uint8Array || entry instanceof Uint32Array || entry instanceof Float32Array ||
        entry instanceof Float64Array) {
      return Array.from(entry as ArrayLike<number>, (n) => (Number.isFinite(n) ? n : String(n)));
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) return String(entry);
    return entry;
  });
}

/** Stepped terrain with benches, an optional NODATA notch and seeded noise. */
export function regressionTerrain(seed: number): OptimizerGrid {
  const random = seededRandom(seed);
  const rows = randomInt(random, 24, 44);
  const cols = randomInt(random, 24, 52);
  const benches = randomInt(random, 2, 4);
  const bench = Math.floor(cols / benches);
  const notch = random() < 0.5;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    if (notch && r < 3 && c > cols - 8) return Number.NaN;
    const level = Math.min(benches - 1, Math.floor(c / bench));
    const inFace = c % bench < 2 && c >= bench;
    return 40 - 6 * level - (inFace ? 3 * (c % bench) : 0) + Math.round(random() * 4) / 100;
  }));
  return { grid, bounds: { min_x: 1000 + randomInt(random, -50, 50), min_y: -200 + randomInt(random, -50, 50) }, resolution: 1 };
}

/** Deterministic fake LOS: a disk of the given radius, quality and projection from a cell hash. */
export function regressionLos(radius: number, salt: number): LosScorer {
  return (request) => {
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
        if (d > radius) {
          cell_states[idx] = LOSCellState.OUT_OF_RANGE;
          continue;
        }
        const h = (Math.imul(idx + 1, 2654435761) ^ Math.imul(Math.round(request.position.x * 7 + request.position.y * 13) + salt, 40503)) >>> 0;
        if (h % 7 === 0) {
          cell_states[idx] = LOSCellState.SHADOW;
          continue;
        }
        cell_states[idx] = LOSCellState.VISIBLE;
        flat_quality_grid[idx] = (h % 1000) / 999;
        flat_projection_grid[idx] = h % 11 === 0 ? Number.NaN : ((h >>> 10) % 1000) / 999;
      }
    }
    return { cell_states, flat_quality_grid, flat_projection_grid };
  };
}

function randomOutput(random: () => number, size: number): LosCellOutput {
  const cell_states = new Uint8Array(size);
  const flat_quality_grid = new Float32Array(size).fill(-1);
  const flat_projection_grid = new Float32Array(size).fill(Number.NaN);
  for (let idx = 0; idx < size; idx++) {
    const roll = random();
    if (roll < 0.45) {
      cell_states[idx] = LOSCellState.VISIBLE;
      flat_quality_grid[idx] = random() < 0.1 ? Number.NaN : random();
      flat_projection_grid[idx] = random() < 0.1 ? Number.NaN : random();
    } else if (roll < 0.6) cell_states[idx] = LOSCellState.SHADOW;
    else if (roll < 0.7) cell_states[idx] = LOSCellState.OUTSIDE_FOV;
    else if (roll < 0.8) cell_states[idx] = LOSCellState.UNKNOWN_RAY;
    else cell_states[idx] = LOSCellState.OUT_OF_RANGE;
  }
  return { cell_states, flat_quality_grid, flat_projection_grid };
}

export interface RegressionDigest {
  readonly name: string;
  readonly digest: string;
}

/** Every regression case, in a fixed order. */
export function regressionDigests(): RegressionDigest[] {
  const out: RegressionDigest[] = [];
  const policies: QualityPolicy[] = [DEFAULT_QUALITY_POLICY, { mediumMin: 0.45, highMin: 0.8 }];

  // 1. optimizeCoarse end to end.
  for (let seed = 1; seed <= 36; seed++) {
    const random = seededRandom(1000 + seed);
    const objective = OBJECTIVES[seed % 3]!;
    const source = regressionTerrain(seed);
    const fixedCount = randomInt(random, 0, 2);
    const fixed = Array.from({ length: fixedCount }, () => ({
      x: source.bounds.min_x + randomInt(random, 2, 20), y: source.bounds.min_y + randomInt(random, 2, 20), z: 45,
    }));
    const result = optimizeCoarse({
      source,
      k: randomInt(random, 1, 3),
      objective,
      policy: policies[seed % 2]!,
      los: regressionLos(randomInt(random, 8, 20), seed),
      candidateSet: seed % 5 === 0 ? "regular_grid" : "edges_and_berms",
      minSeparationM: randomInt(random, 0, 8),
      fixed,
      maxCoarseNodes: randomInt(random, 300, 1200),
      shortlistPerStep: randomInt(random, 1, 4),
      candidateParams: { maxCandidates: randomInt(random, 6, 40), faceMinSlopeDeg: 30 },
    });
    out.push({ name: `optimizeCoarse#${seed}`, digest: digestString(stableJson(result)) });
  }

  // 2. greedySelect and evaluateUnion over random scores.
  for (let seed = 1; seed <= 60; seed++) {
    const random = seededRandom(5000 + seed);
    const objective = OBJECTIVES[seed % 3]!;
    const policy = policies[seed % 2]!;
    const size = randomInt(random, 20, 90);
    const n = randomInt(random, 1, 9);
    const candidates = Array.from({ length: n }, () => ({
      score: scoreLosOutput(randomOutput(random, size), objective, policy),
      x: randomInt(random, 0, 30),
      y: randomInt(random, 0, 30),
    }));
    const fixed = Array.from({ length: randomInt(random, 0, 2) }, () => ({
      score: scoreLosOutput(randomOutput(random, size), objective, policy),
      x: randomInt(random, 0, 30),
      y: randomInt(random, 0, 30),
    }));
    const greedy = greedySelect(candidates, {
      k: randomInt(random, 1, 4),
      objective,
      policy,
      minSeparationM: randomInt(random, 0, 6),
      fixed,
      shortlistPerStep: randomInt(random, 1, 3),
    });
    const union = evaluateUnion(candidates.map((c) => c.score), objective, policy);
    out.push({ name: `greedy#${seed}`, digest: digestString(stableJson({ greedy, union, scores: candidates.map((c) => c.score) })) });
  }
  return out;
}
