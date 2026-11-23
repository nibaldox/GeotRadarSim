import { describe, expect, it } from "vitest";
import { generateSyntheticTerrain } from "../../services/terrainEngine";
import {
  CANDIDATE_DEFAULTS,
  classifyCandidateNodes,
  generateCandidates,
  slopeDegreesGrid,
  thinNodes,
} from "./candidates";
import { flatTerrain } from "./optimizer.testSupport";
import type { OptimizerGrid } from "./types";

/**
 * Stepped pit profile along x (1 m nodes, 5 m drop per face node):
 * plateau z=30 (c0–9) · face · bench z=20 (c11–18) · face · bench z=10 (c20–27) · face · floor z=0 (c29–50).
 * Central differences make the bench edge nodes steep (atan 2.5 ≈ 68°), so the flat
 * nodes next to faces are exactly: plateau c0–8, bench c12–17, bench c21–26, floor c30–39 (≤ 10 m from c29).
 */
function steppedPit(rows = 20): OptimizerGrid {
  const profile: number[] = [];
  for (let c = 0; c <= 50; c++) {
    if (c <= 9) profile.push(30);
    else if (c === 10) profile.push(25);
    else if (c <= 18) profile.push(20);
    else if (c === 19) profile.push(15);
    else if (c <= 27) profile.push(10);
    else if (c === 28) profile.push(5);
    else profile.push(0);
  }
  return { grid: Array.from({ length: rows }, () => [...profile]), bounds: { min_x: 500, min_y: 7000 }, resolution: 1 };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function nodes(rows: readonly number[], cols: readonly number[], width: number): number[] {
  return rows.flatMap((r) => cols.map((c) => r * width + c)).sort((a, b) => a - b);
}

describe("slopeDegreesGrid", () => {
  it("uses terrainGradientAt: θ = atan(‖∇z‖) in degrees, NaN where the gradient is unknown", () => {
    const grid = [
      [0, 1, 2],
      [0, 1, 2],
      [Number.NaN, 1, 2],
    ];
    const slope = slopeDegreesGrid(grid, 1);
    expect(slope[1 * 3 + 1]).toBeCloseTo(45, 12);
    expect(Number.isNaN(slope[2 * 3 + 0]!)).toBe(true);
  });
});

describe("classifyCandidateNodes (P1)", () => {
  it("marks berms exactly at the bench nodes of a stepped pit, with the crest at the top level", () => {
    const pit = steppedPit();
    const width = 51;
    const classification = classifyCandidateNodes(pit);
    const interiorRows = range(2, 17);
    const benchCols = [...range(2, 8), ...range(12, 17), ...range(21, 26), ...range(30, 39)];
    const bermOrCrest = [...classification.berm, ...classification.crest].sort((a, b) => a - b);
    expect(bermOrCrest).toEqual(nodes(interiorRows, benchCols, width));
    // P80 of the elevations is 25 m: only the z = 30 plateau qualifies as crest.
    expect(classification.crestElevation).toBe(25);
    expect(classification.crest).toEqual(nodes(interiorRows, range(2, 8), width));
    expect(classification.perimeter).toEqual([]);
  });

  it("respects the face radius: floor nodes farther than 10 m from the last face are not berms", () => {
    const classification = classifyCandidateNodes(steppedPit());
    const cols = new Set([...classification.berm, ...classification.crest].map((idx) => idx % 51));
    expect(cols.has(39)).toBe(true); // exactly 10 m from the face node c29
    expect(cols.has(40)).toBe(false);
  });

  it("keeps every candidate ≥ m nodes from NODATA and from the grid border", () => {
    const rows = 24;
    const cols = 30;
    const hole = [];
    for (let r = 10; r <= 12; r++) for (let c = 14; c <= 16; c++) hole.push(r * cols + c);
    const grid = flatTerrain(rows, cols, 5, hole);
    const m = CANDIDATE_DEFAULTS.marginNodes;
    const classification = classifyCandidateNodes({ grid, bounds: { min_x: 0, min_y: 0 }, resolution: 2 });
    const all = [...classification.berm, ...classification.crest, ...classification.perimeter, ...classification.regular];
    expect(all.length).toBeGreaterThan(0);
    for (const idx of all) {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      expect(r >= m && r <= rows - 1 - m && c >= m && c <= cols - 1 - m).toBe(true);
      const chebyshevToHole = Math.max(
        r < 10 ? 10 - r : r > 12 ? r - 12 : 0,
        c < 14 ? 14 - c : c > 16 ? c - 16 : 0,
      );
      expect(chebyshevToHole).toBeGreaterThanOrEqual(m);
    }
    // The flat band at Chebyshev distance m..m+3 from the NODATA limit is the perimeter (an edge).
    const expectedPerimeter: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = Math.max(r < 10 ? 10 - r : r > 12 ? r - 12 : 0, c < 14 ? 14 - c : c > 16 ? c - 16 : 0);
        const inside = r >= m && r <= rows - 1 - m && c >= m && c <= cols - 1 - m;
        if (inside && d >= m && d <= m + CANDIDATE_DEFAULTS.perimeterBandNodes) expectedPerimeter.push(r * cols + c);
      }
    }
    expect(classification.perimeter).toEqual(expectedPerimeter);
  });

  it("requires the four incident quads to be renderable even with a smaller margin", () => {
    const grid = flatTerrain(9, 9, 0, [4 * 9 + 5]);
    const classification = classifyCandidateNodes(
      { grid, bounds: { min_x: 0, min_y: 0 }, resolution: 1 },
      { marginNodes: 0 },
    );
    const all = new Set([...classification.perimeter, ...classification.regular]);
    expect(all.has(4 * 9 + 4)).toBe(false); // shares a quad with the NaN node
    expect(all.has(4 * 9 + 3)).toBe(true);
    expect(all.has(0)).toBe(false); // border node: some incident quads fall outside the grid
  });
});

describe("thinNodes", () => {
  it("keeps the node nearest to each box centre, ties to the lower row-major index", () => {
    // 1 m grid, 10 m boxes: box (0,0) centre at local (5,5).
    const cols = 30;
    const tied = [4 * cols + 4, 4 * cols + 6, 6 * cols + 4, 6 * cols + 6]; // all at distance √2 from (5,5)
    const result = thinNodes([...tied].reverse(), cols, 1, 10, 160);
    expect(result).toEqual({ nodes: [4 * cols + 4], boxSideM: 10, passes: 1 });
    const nearer = thinNodes([4 * cols + 4, 5 * cols + 5, 12 * cols + 12], cols, 1, 10, 160);
    expect(nearer.nodes).toEqual([5 * cols + 5, 12 * cols + 12]);
  });

  it("grows the box side by 1.25 until at most N_max nodes remain", () => {
    const cols = 100;
    const all = range(0, 100 * 100 - 1);
    const result = thinNodes(all, cols, 1, 1, 160);
    expect(result.nodes.length).toBeLessThanOrEqual(160);
    let side = 1;
    while ((Math.floor(99 / side) + 1) ** 2 > 160) side *= 1.25;
    expect(result.boxSideM).toBe(side);
  });
});

describe("generateCandidates (P1)", () => {
  it("places candidates 2 m above the exact node elevation, in row-major order with stable indices", () => {
    const pit = steppedPit();
    const result = generateCandidates(pit, { minSeparationM: 6, heightAboveGroundM: 2 });
    expect(result.candidateSetUsed).toBe("edges_and_berms");
    expect(result.fallbackReason).toBeNull();
    expect(result.candidates.length).toBeGreaterThan(0);
    result.candidates.forEach((candidate, index) => {
      expect(candidate.index).toBe(index);
      expect(candidate.groundZ).toBe(pit.grid[candidate.row]![candidate.col]);
      expect(candidate.z).toBe(candidate.groundZ + 2);
      expect(candidate.x).toBe(500 + candidate.col * 1);
      expect(candidate.y).toBe(7000 + candidate.row * 1);
      expect(["BERM", "CREST", "PERIMETER"]).toContain(candidate.kind);
      if (index > 0) {
        const previous = result.candidates[index - 1]!;
        expect(previous.row * 51 + previous.col).toBeLessThan(candidate.row * 51 + candidate.col);
      }
    });
    expect(result.candidates.length).toBeLessThanOrEqual(CANDIDATE_DEFAULTS.maxCandidates);
  });

  it("falls back to regular_grid on the app's smooth synthetic bowl and says why", () => {
    const bowl = generateSyntheticTerrain(200, 200, 30, 1.0);
    const source = { grid: bowl.grid, bounds: bowl.metadata.bounds, resolution: bowl.metadata.resolution };
    const result = generateCandidates(source, { minSeparationM: 50 });
    expect(result.rawCounts.berm + result.rawCounts.crest + result.rawCounts.perimeter).toBe(0);
    expect(result.candidateSetRequested).toBe("edges_and_berms");
    expect(result.candidateSetUsed).toBe("regular_grid");
    expect(result.fallbackReason).toMatch(/bermas|bordes/);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.kind).toBe("REGULAR");
      expect(candidate.slopeDeg).toBeLessThanOrEqual(CANDIDATE_DEFAULTS.regularMaxSlopeDeg);
    }
  });

  it("honours an explicit regular_grid request without a fallback reason", () => {
    const result = generateCandidates(steppedPit(), { candidateSet: "regular_grid", minSeparationM: 10 });
    expect(result.candidateSetUsed).toBe("regular_grid");
    expect(result.fallbackReason).toBeNull();
    expect(result.candidates.every((candidate) => candidate.kind === "REGULAR")).toBe(true);
  });

  it("is deterministic and never mutates the DEM", () => {
    const pit = steppedPit();
    const before = JSON.stringify(pit.grid);
    const first = generateCandidates(pit, { minSeparationM: 5 });
    const second = generateCandidates(pit, { minSeparationM: 5 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(pit.grid)).toBe(before);
  });

  it("validates its options", () => {
    const pit = steppedPit();
    expect(() => generateCandidates(pit, { minSeparationM: -1 })).toThrow(RangeError);
    expect(() => generateCandidates(pit, { heightAboveGroundM: Number.NaN })).toThrow(RangeError);
    expect(() => generateCandidates({ ...pit, resolution: 0 })).toThrow(RangeError);
  });
});
