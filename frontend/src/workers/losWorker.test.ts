import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTerrainMeshGeometry } from "../components/TerrainViewer";
import { LOSCellState, type RadarConfig } from "../types/api";
import { terrainGradientAt } from "../utils/sensitivity";
import type { LOSWorkerInput, LOSWorkerOutput } from "./losWorker";

const radar: RadarConfig = {
  model_id: "test-radar",
  display_name: "Test radar",
  manufacturer: "Test",
  min_range_m: 0,
  max_range_m: 100,
  h_beam_width_deg: 360,
  v_beam_width_deg: 180,
  elevation_min_deg: -90,
  elevation_max_deg: 90,
  scan_pattern: "SAR360",
  azimuth_range_deg: null,
};

function expectRenderedTriangleCount(grid: number[][], triangleCount: number): void {
  const geometry = buildTerrainMeshGeometry(grid, 1, 0);
  expect(geometry.getIndex()?.count).toBe(triangleCount * 3);
  geometry.dispose();
}

async function runWorker(input: LOSWorkerInput): Promise<LOSWorkerOutput & { error?: string }> {
  vi.resetModules();
  const scope: {
    onmessage: ((event: MessageEvent<LOSWorkerInput>) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  } = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./losWorker");
  if (!scope.onmessage) throw new Error("LOS worker did not register its message handler");
  scope.onmessage({ data: input } as MessageEvent<LOSWorkerInput>);
  return scope.postMessage.mock.calls[0]![0] as LOSWorkerOutput & { error?: string };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LOS worker cell-state contract", () => {
  it("casts rays against the same asymmetric triangle surface as the rendered mesh at a non-zero origin", async () => {
    const result = await runWorker({
      grid: [
        [0, 0, 0, 0],
        [0, 20, 0, 0],
        [0, 0, 0, 0],
      ],
      bounds: { min_x: 100, min_y: 200, max_x: 106, max_y: 204 },
      resolution: 2,
      radar_position: [100, 200, 30],
      radar_config: {
        ...radar,
        max_range_m: 5,
        scan_pattern: "RAR",
        azimuth_range_deg: [60, 70],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.cell_states![1 * 4 + 2]).toBe(4); // The rendered triangle rises above the ray.
    expect(result.shadow_grid[1]![2]).toBe(true);
    expect(result.shadow_zones).toEqual([{ zone_id: 1, cell_count: 1 }]);
    expect(result.visible_area_m2).toBe(0);
  });

  it("uses node-anchored coordinates for flat coverage, sector limits, range, and cell area", async () => {
    const targetRange = Math.hypot(4, 2);
    const targetAzimuth = Math.atan2(4, 2) * (180 / Math.PI);
    const input: LOSWorkerInput = {
      grid: Array.from({ length: 3 }, () => Array(4).fill(0)),
      bounds: { min_x: 100, min_y: 200, max_x: 106, max_y: 204 },
      resolution: 2,
      radar_position: [100, 200, 10],
      radar_config: {
        ...radar,
        max_range_m: targetRange,
        scan_pattern: "RAR",
        azimuth_range_deg: [targetAzimuth, targetAzimuth],
      },
    };
    const visible = await runWorker(input);

    expect(visible.error).toBeUndefined();
    expect(visible.cell_states![1 * 4 + 2]).toBe(5);
    expect(visible.coverage_polygon).toEqual([[104, 202]]);
    expect(visible.visible_area_m2).toBe(4);

    const outsideRange = await runWorker({
      ...input,
      radar_config: { ...input.radar_config, max_range_m: targetRange - 0.01 },
    });
    expect(outsideRange.cell_states![1 * 4 + 2]).toBe(1);
    expect(outsideRange.visible_area_m2).toBe(0);

    const outsideSector = await runWorker({
      ...input,
      radar_config: {
        ...input.radar_config,
        azimuth_range_deg: [targetAzimuth + 0.01, targetAzimuth + 1],
      },
    });
    expect(outsideSector.cell_states![1 * 4 + 2]).toBe(2);
  });

  it("keeps NODATA and rays through missing terrain unknown instead of shadow", async () => {
    const result = await runWorker({
      grid: [
        [0, 0, Number.NaN, 0, 0],
        [0, 0, Number.NaN, 0, 0],
      ],
      bounds: { min_x: 0, min_y: 0, max_x: 4, max_y: 1 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: radar,
    });

    expect(result.error).toBeUndefined();
    expect(result.cell_states).toBeInstanceOf(Uint8Array);
    expect([...result.cell_states!]).toEqual([5, 5, 0, 3, 3, 5, 5, 0, 3, 3]);
    expect(result.shadow_grid).toEqual([
      [false, false, false, false, false],
      [false, false, false, false, false],
    ]);
    expect(result.coverage_pct).toBe(50);
    expect(result.completeness_pct).toBe(50);
    expect(result.visible_area_m2).toBe(4);
    expect(result.shadow_zones).toEqual([]);
    expect(result.grid_rows).toBe(2);
    expect(result.grid_cols).toBe(5);
    expect(result.resolution).toBe(1);
  });

  it("counts contiguous true shadows only and computes horizontal visible area", async () => {
    const result = await runWorker({
      grid: [
        [0, 0, 100, 100, 0],
        [0, 0, 100, 100, 0],
      ],
      bounds: { min_x: 0, min_y: 0, max_x: 8, max_y: 2 },
      resolution: 2,
      radar_position: [0, 0, 10],
      radar_config: radar,
    });

    expect([...result.cell_states!]).toEqual([5, 5, 5, 4, 4, 5, 5, 5, 4, 4]);
    expect(result.shadow_grid).toEqual([
      [false, false, false, true, true],
      [false, false, false, true, true],
    ]);
    expect(result.coverage_pct).toBe(60);
    expect(result.completeness_pct).toBe(100);
    expect(result.visible_area_m2).toBe(24);
    expect(result.shadow_zones).toEqual([{ zone_id: 1, cell_count: 4 }]);
  });

  it("classifies range and angular exclusions without counting them as candidates", async () => {
    const result = await runWorker({
      grid: [[0, 0, 0], [0, 0, 0]],
      bounds: { min_x: 0, min_y: 0, max_x: 2, max_y: 1 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: {
        ...radar,
        max_range_m: 1,
        scan_pattern: "RAR",
        azimuth_range_deg: [-30, 30],
      },
    });

    expect([...result.cell_states!]).toEqual([5, 2, 1, 5, 1, 1]); // VISIBLE/FOV/range, then the second rendered row.
    expect(result.coverage_pct).toBe(100);
    expect(result.completeness_pct).toBe(100);
    expect(result.visible_area_m2).toBe(2);
  });

  it.each([
    ["NaN minimum range", { min_range_m: Number.NaN }],
    ["infinite minimum range", { min_range_m: Number.POSITIVE_INFINITY }],
    ["NaN maximum range", { max_range_m: Number.NaN }],
    ["infinite maximum range", { max_range_m: Number.POSITIVE_INFINITY }],
    ["NaN minimum elevation", { elevation_min_deg: Number.NaN }],
    ["infinite minimum elevation", { elevation_min_deg: Number.POSITIVE_INFINITY }],
    ["NaN maximum elevation", { elevation_max_deg: Number.NaN }],
    ["infinite maximum elevation", { elevation_max_deg: Number.POSITIVE_INFINITY }],
  ])("rejects %s in radar config", async (_label, overrides) => {
    const result = await runWorker({
      grid: [[0]],
      bounds: { min_x: 0, min_y: 0, max_x: 0, max_y: 0 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: { ...radar, ...overrides },
    });

    expect(result.error).toMatch(/range|elevation/i);
  });

  it.each([
    ["negative minimum range", { min_range_m: -1 }],
    ["maximum range below minimum", { min_range_m: 20, max_range_m: 10 }],
    ["minimum elevation below -90°", { elevation_min_deg: -91 }],
    ["maximum elevation above 90°", { elevation_max_deg: 91 }],
    ["minimum elevation above maximum", { elevation_min_deg: 10, elevation_max_deg: 0 }],
  ])("rejects invalid %s in radar config", async (_label, overrides) => {
    const result = await runWorker({
      grid: [[0]],
      bounds: { min_x: 0, min_y: 0, max_x: 0, max_y: 0 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: { ...radar, ...overrides },
    });

    expect(result.error).toMatch(/range|elevation/i);
  });

  it.each([
    ["empty grid", [], 1],
    ["empty row", [[]], 1],
    ["ragged grid", [[0, 1], [0]], 1],
    ["zero resolution", [[0]], 0],
    ["non-finite resolution", [[0]], Number.POSITIVE_INFINITY],
  ])("rejects a %s", async (_label, grid, resolution) => {
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      resolution,
      radar_position: [0, 0, 1],
      radar_config: radar,
    });

    expect(result.error).toMatch(/grid|resolution/i);
  });

  it("detects a narrow rendered ridge that uniform ray samples skip", async () => {
    const clearGrid = Array.from({ length: 2 }, () => Array(6).fill(0));
    const ridgeGrid = [
      Array(6).fill(0),
      [0, 0, 0, 4.2, 0, 0],
    ];
    expectRenderedTriangleCount(clearGrid, 10);
    expectRenderedTriangleCount(ridgeGrid, 10);
    const input: LOSWorkerInput = {
      grid: clearGrid,
      bounds: { min_x: 0, min_y: 0, max_x: 5, max_y: 1 },
      resolution: 1,
      radar_position: [0.2, 1, 10],
      radar_config: radar,
    };

    const clear = await runWorker(input);
    const blocked = await runWorker({ ...input, grid: ridgeGrid });

    expect(clear.cell_states![11]).toBe(LOSCellState.VISIBLE);
    expect(blocked.cell_states![11]).toBe(LOSCellState.SHADOW);
    expect(blocked.shadow_grid[1]![5]).toBe(true);
  });

  it("does not call a sub-cell target visible when its rendered neighborhood has no triangles", async () => {
    const grid = [[0, Number.NaN], [0, 0]];
    expectRenderedTriangleCount(grid, 0);
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      resolution: 1,
      radar_position: [0.75, 0, 10],
      radar_config: radar,
    });

    expect(result.cell_states![0]).toBe(LOSCellState.UNKNOWN_RAY);
    expect(result.shadow_grid[0]![0]).toBe(false);
  });

  it("uses the valid rendered side when the ray follows a boundary beside a hole", async () => {
    const grid = [
      Array(6).fill(0),
      Array(6).fill(0),
      Array(6).fill(Number.NaN),
    ];
    expectRenderedTriangleCount(grid, 10); // Only the strip above the ray is rendered.
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 5, max_y: 2 },
      resolution: 1,
      radar_position: [0.2, 1, 10],
      radar_config: radar,
    });

    expect(result.cell_states![1 * 6 + 5]).toBe(LOSCellState.VISIBLE);
    expect(result.shadow_grid[1]![5]).toBe(false);
  });

  it("keeps a sub-ulp grid-boundary ray on the valid adjacent mesh strip", async () => {
    const grid = [
      Array(6).fill(0),
      Array(6).fill(0),
      Array(6).fill(0),
      Array(6).fill(0),
      Array(6).fill(Number.NaN),
    ];
    const boundaryY = 3 * 0.1;
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 0.5, max_y: 0.4 },
      resolution: 0.1,
      radar_position: [0.02, boundaryY, 10],
      radar_config: radar,
    });

    expect(result.cell_states![3 * 6 + 5]).toBe(LOSCellState.VISIBLE);
  });

  it("keeps a ray through a genuine untriangulated gap unknown", async () => {
    const grid = [
      [0, 0, 0, Number.NaN, 0, 0],
      [0, 0, 0, Number.NaN, 0, 0],
    ];
    expectRenderedTriangleCount(grid, 6); // The gap removes the two adjacent quads.
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 5, max_y: 1 },
      resolution: 1,
      radar_position: [0.2, 1, 10],
      radar_config: radar,
    });

    expect(result.cell_states![1 * 6 + 5]).toBe(LOSCellState.UNKNOWN_RAY);
    expect(result.shadow_grid[1]![5]).toBe(false);
  });

  it("traces a valid target closer than one grid resolution instead of skipping its ray", async () => {
    const grid = [[0, 0], [0, 0]];
    expectRenderedTriangleCount(grid, 2);
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      resolution: 1,
      radar_position: [0.75, 0, 10],
      radar_config: radar,
    });

    expect(result.cell_states![0]).toBe(LOSCellState.VISIBLE);
  });

  it("terminates for a vertical ray through a rendered mesh vertex", async () => {
    const grid = [[0, 0], [0, 0]];
    expectRenderedTriangleCount(grid, 2);
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: radar,
    });

    expect(result.cell_states![0]).toBe(LOSCellState.VISIBLE);
  }, 1_000);

  it("does not extrapolate the neighboring triangle across a diagonal", async () => {
    const result = await runWorker({
      grid: [[0, 0], [0, -1]],
      bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      resolution: 1,
      radar_position: [0.5, 0.49999999995, 0],
      radar_config: radar,
    });

    expect(result.error).toBeUndefined();
    expect(result.cell_states![1]).toBe(LOSCellState.VISIBLE);
    expect(result.shadow_grid[0]![1]).toBe(false);
  });

  it("uses the shared edge height when a ray follows a rendered diagonal", async () => {
    const result = await runWorker({
      grid: [[0, 0], [0, -1]],
      bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      resolution: 1,
      radar_position: [0.75, 0.25, 0],
      radar_config: radar,
    });

    expect(result.error).toBeUndefined();
    expect(result.cell_states![1]).toBe(LOSCellState.VISIBLE);
  });

  it("rejects resolution whose squared cell area underflows", async () => {
    const result = await runWorker({
      grid: [[0]],
      bounds: { min_x: 0, min_y: 0, max_x: 0, max_y: 0 },
      resolution: Number.MIN_VALUE,
      radar_position: [0, 0, 1],
      radar_config: radar,
    });

    expect(result.error).toMatch(/resolution.*area|area.*resolution/i);
  });

  it("rejects finite resolution whose squared cell area overflows", async () => {
    const result = await runWorker({
      grid: [[0]],
      bounds: { min_x: 0, min_y: 0, max_x: 0, max_y: 0 },
      resolution: 1e200,
      radar_position: [0, 0, 1],
      radar_config: radar,
    });

    expect(result.error).toMatch(/resolution.*area|area.*resolution/i);
  });

  it("rejects an excessively long grid axis before simulating LOS", async () => {
    const grid = [Array(16_385).fill(0), Array(16_385).fill(0)];
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 16_384, max_y: 1 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: radar,
    });

    expect(result.error).toMatch(/LOS grid.*dimension|dimension.*LOS grid/i);
    expect(result.cell_states).toBeUndefined();
  });

  it("computes the 467x819 res2 no-data scene that the work estimate used to reject", async () => {
    // Real scene shape: 467x819 @ res 2, origin 92008.875/20288.2734375, radar
    // 92929.5/20721.3/3112.5, range 1200 m. The removed interval estimate scored this
    // geometry at ~650M intervals and rejected it before inspecting the terrain, even
    // though a fully no-data scene traverses no triangles at all.
    const rows = 467;
    const cols = 819;
    const result = await runWorker({
      grid: Array.from({ length: rows }, () => Array(cols).fill(Number.NaN)),
      bounds: {
        min_x: 92_008.875,
        min_y: 20_288.2734375,
        max_x: 92_008.875 + (cols - 1) * 2,
        max_y: 20_288.2734375 + (rows - 1) * 2,
      },
      resolution: 2,
      radar_position: [92_929.5, 20_721.3, 3_112.5],
      radar_config: { ...radar, max_range_m: 1_200 },
    });

    expect(result.error).toBeUndefined();
    expect(result.cell_states).toHaveLength(rows * cols);
    expect(result.cell_states![0]).toBe(LOSCellState.NODATA);
    expect(result.cell_states![rows * cols - 1]).toBe(LOSCellState.NODATA);
  });

  it("traverses real rays for a high-estimate sector-filtered scene without any pre-rejection", async () => {
    // Same scene shape with one finite node inside an exact-azimuth sector: the removed
    // estimate still scored ~650M intervals (it ignores NaN terrain and azimuth filtering)
    // while the actual ray work is a handful of intervals.
    const rows = 467;
    const cols = 819;
    const min_x = 92_008.875;
    const min_y = 20_288.2734375;
    const targetRow = 216;
    const targetCol = 461;
    const cx = min_x + targetCol * 2;
    const cy = min_y + targetRow * 2;
    const targetAzimuth = Math.atan2(cx - 92_929.5, cy - 20_721.3) * (180 / Math.PI);
    const grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(Number.NaN));
    grid[targetRow]![targetCol] = 3_000;
    const result = await runWorker({
      grid,
      bounds: { min_x, min_y, max_x: min_x + (cols - 1) * 2, max_y: min_y + (rows - 1) * 2 },
      resolution: 2,
      radar_position: [92_929.5, 20_721.3, 3_112.5],
      radar_config: {
        ...radar,
        max_range_m: 1_200,
        scan_pattern: "RAR",
        azimuth_range_deg: [targetAzimuth, targetAzimuth],
      },
    });

    expect(result.error).toBeUndefined();
    // The finite node is in-sector, so its ray really runs; NaN terrain along the way
    // leaves the ray unknown rather than visible.
    expect(result.cell_states![targetRow * cols + targetCol]).toBe(LOSCellState.UNKNOWN_RAY);
    expect(result.cell_states![0]).toBe(LOSCellState.NODATA);
  });

  it("aborts a single long ray through the periodic traversal deadline check", async () => {
    // One finite node at the far end of a 2000-node row forces a single ~2000-interval
    // ray that the old 25M estimate let through (~22.6M). The deterministic clock keeps
    // the start read and the first outer-loop read inside the budget, then every later
    // read exceeds it, so only the ~1024-interval traversal check can trip the deadline.
    const cols = 2_000;
    const clockReads = [0, 0];
    vi.stubGlobal("performance", {
      now: () => (clockReads.length > 0 ? clockReads.shift()! : 1e12),
    });
    const targetAzimuth = Math.atan2(cols - 1, 0) * (180 / Math.PI);
    const grid: number[][] = [Array(cols).fill(Number.NaN), Array(cols).fill(Number.NaN)];
    grid[0]![cols - 1] = 0;
    const result = await runWorker({
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: cols - 1, max_y: 1 },
      resolution: 1,
      radar_position: [0, 0, 10],
      radar_config: {
        ...radar,
        max_range_m: 5_000,
        scan_pattern: "RAR",
        azimuth_range_deg: [targetAzimuth, targetAzimuth],
      },
    });

    expect(result.error).toMatch(/excedió el tiempo máximo/i);
    expect(result.error).toMatch(/vuelva a intentarlo/);
    expect(result.cell_states).toBeUndefined();
  });

  it("aborts the outer target loop when the runtime deadline elapses before any ray", async () => {
    // Sector-filtered 467x819 scene (the old estimate rejected it at ~650M before seeing
    // the sector). With the deterministic clock the budget is already spent when the first
    // outer-loop row is checked, so the compute aborts before traversing any triangle.
    const rows = 467;
    const cols = 819;
    let clockCalls = 0;
    vi.stubGlobal("performance", {
      now: () => (clockCalls++ === 0 ? 0 : 125_000),
    });
    const targetAzimuth = Math.atan2(
      92_008.875 + 461 * 2 - 92_929.5,
      20_288.2734375 + 216 * 2 - 20_721.3,
    ) * (180 / Math.PI);
    const result = await runWorker({
      grid: Array.from({ length: rows }, () => Array(cols).fill(0)),
      bounds: {
        min_x: 92_008.875,
        min_y: 20_288.2734375,
        max_x: 92_008.875 + (cols - 1) * 2,
        max_y: 20_288.2734375 + (rows - 1) * 2,
      },
      resolution: 2,
      radar_position: [92_929.5, 20_721.3, 3_112.5],
      radar_config: {
        ...radar,
        max_range_m: 1_200,
        scan_pattern: "RAR",
        azimuth_range_deg: [targetAzimuth, targetAzimuth],
      },
    });

    expect(result.error).toMatch(/excedió el tiempo máximo/i);
    expect(result.error).toMatch(/vuelva a intentarlo/);
    expect(result.cell_states).toBeUndefined();
  });

  it("uses one-sided terrain derivatives at both horizontal border nodes", async () => {
    const grid = [[0, 2, 4], [0, 2, 4]];
    const base: LOSWorkerInput = {
      grid,
      bounds: { min_x: 0, min_y: 0, max_x: 2, max_y: 1 },
      resolution: 1,
      radar_position: [1, 0, 2],
      radar_config: radar,
    };

    const leftEdge = await runWorker(base);
    const rightEdge = await runWorker({
      ...base,
      radar_position: [3, 0, 6],
    });

    expect(leftEdge.cell_states![0]).toBe(LOSCellState.VISIBLE);
    expect(leftEdge.quality_grid![0]![0]).toBeCloseTo(0, 8);
    expect(rightEdge.cell_states![2]).toBe(LOSCellState.VISIBLE);
    expect(rightEdge.quality_grid![0]![2]).toBeCloseTo(0, 8);
  });

  it("uses the finite one-sided derivative beside NODATA without changing its state", async () => {
    const result = await runWorker({
      grid: [
        [Number.NaN, 2, 4],
        [Number.NaN, 2, 4],
      ],
      bounds: { min_x: 0, min_y: 0, max_x: 2, max_y: 1 },
      resolution: 1,
      radar_position: [2, 0, 4],
      radar_config: radar,
    });

    expect(result.cell_states![0]).toBe(LOSCellState.NODATA);
    expect(result.cell_states![1]).toBe(LOSCellState.VISIBLE);
    expect(result.quality_grid![0]![1]).toBeCloseTo(0, 8);
  });

  it("rejects a finite cell area whose full grid area overflows before returning buffers", async () => {
    const result = await runWorker({
      grid: [[0, 0], [0, 0]],
      bounds: { min_x: 0, min_y: 0, max_x: 1e154, max_y: 1e154 },
      resolution: 1e154,
      radar_position: [0, 0, 10],
      radar_config: { ...radar, max_range_m: Number.MAX_VALUE },
    });

    expect(result.error).toMatch(/total.*area|area.*total/i);
    expect(result.cell_states).toBeUndefined();
    expect(result.visible_area_m2).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Geometric quality v2: angular incidence and slope-motion projection
// ─────────────────────────────────────────────────────────────────────────────

async function runWorkerWithTransport(input: LOSWorkerInput): Promise<{
  result: LOSWorkerOutput & { error?: string };
  transfer: readonly unknown[];
}> {
  vi.resetModules();
  const scope: {
    onmessage: ((event: MessageEvent<LOSWorkerInput>) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  } = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("./losWorker");
  if (!scope.onmessage) throw new Error("LOS worker did not register its message handler");
  scope.onmessage({ data: input } as MessageEvent<LOSWorkerInput>);
  const call = scope.postMessage.mock.calls[0]!;
  return {
    result: call[0] as LOSWorkerOutput & { error?: string },
    transfer: (call[1] ?? []) as readonly unknown[],
  };
}

/** Inclined plane z = x on a 3x3 grid at the origin: normal (-1,0,1)/√2, downhill (-1,0,-1)/√2. */
const PLANE_GRID = [
  [0, 1, 2],
  [0, 1, 2],
  [0, 1, 2],
];

function planeInput(
  radar_position: [number, number, number],
  maxRange = 100,
  grid: number[][] = PLANE_GRID,
): LOSWorkerInput {
  return {
    grid,
    bounds: { min_x: 0, min_y: 0, max_x: 2, max_y: 2 },
    resolution: 1,
    radar_position,
    radar_config: { ...radar, max_range_m: maxRange },
  };
}

describe("LOS worker geometric quality v2", () => {
  it("tags new results as geometric-v2 and transfers both flat index buffers", async () => {
    const { result, transfer } = await runWorkerWithTransport(planeInput([0, 1, 5]));

    expect(result.error).toBeUndefined();
    expect(result.quality_model).toBe("geometric-v2");
    expect(result.flat_quality_grid).toBeInstanceOf(Float32Array);
    expect(result.flat_projection_grid).toBeInstanceOf(Float32Array);
    expect(result.flat_projection_grid!.length).toBe(9);
    expect(transfer).toContain(result.flat_quality_grid!.buffer);
    expect(transfer).toContain(result.flat_projection_grid!.buffer);
  });

  it("keeps the incidence score independent of maximum range for still-VISIBLE samples", async () => {
    const wide = await runWorker(planeInput([0, 1, 5], 100));
    const narrow = await runWorker(planeInput([0, 1, 5], 1.5));
    const cell = 1 * 3 + 1;

    expect(wide.cell_states![cell]).toBe(LOSCellState.VISIBLE);
    expect(narrow.cell_states![cell]).toBe(LOSCellState.VISIBLE);
    // Plane z = x, cell (1,1): normal (-1,0,1)/√2 against terrain→radar (-1,0,4)/√17 = 5/√34.
    const expected = 5 / Math.sqrt(34);
    expect(wide.flat_quality_grid![cell]).toBeCloseTo(expected, 6);
    expect(narrow.flat_quality_grid![cell]).toBeCloseTo(expected, 6);
    // No sqrt(1 - distance/maxRange) multiplier: identical scores across ranges.
    expect(narrow.flat_quality_grid![cell]).toBe(wide.flat_quality_grid![cell]);
  });

  it("measures incidence and slope-motion projection as aligned/orthogonal complements on the planar slope", async () => {
    // Terrain→radar along the surface normal (-1,0,1): incidence 1, movement projection 0.
    const normalView = await runWorker(planeInput([-2, 0, 2]));
    // Terrain→radar along the in-slope direction (1,0,1): incidence 0, movement projection 1.
    const downhillView = await runWorker(planeInput([2, 0, 2]));

    expect(normalView.cell_states![0]).toBe(LOSCellState.VISIBLE);
    expect(downhillView.cell_states![0]).toBe(LOSCellState.VISIBLE);
    expect(normalView.flat_quality_grid![0]).toBeCloseTo(1, 6);
    expect(normalView.flat_projection_grid![0]).toBeCloseTo(0, 6);
    expect(downhillView.flat_quality_grid![0]).toBeCloseTo(0, 6);
    expect(downhillView.flat_projection_grid![0]).toBeCloseTo(1, 6);
    // Measured zeros are finite data, never missing indices.
    expect(Number.isNaN(normalView.flat_projection_grid![0]!)).toBe(false);
    expect(Number.isNaN(downhillView.flat_quality_grid![0]!)).toBe(false);
  });

  it("keeps the measured zero of the incidence index at exactly zero", async () => {
    const result = await runWorker(planeInput([3, 1, 3]));

    expect(result.cell_states![4]).toBe(LOSCellState.VISIBLE);
    expect(result.flat_quality_grid![4]).toBe(0);
    expect(result.flat_projection_grid![4]).toBeCloseTo(1, 6);
  });

  it("reports non-visible projection as NaN while keeping the non-visible incidence sentinel", async () => {
    const result = await runWorker(planeInput([0, 1, 5], 1.5));
    const outOfRange = 1 * 3 + 2;

    expect(result.cell_states![outOfRange]).toBe(LOSCellState.OUT_OF_RANGE);
    expect(result.flat_quality_grid![outOfRange]).toBe(-1);
    expect(Number.isNaN(result.flat_projection_grid![outOfRange]!)).toBe(true);
    expect(Number.isNaN(result.flat_projection_grid![1 * 3]!)).toBe(false);
  });

  it("never invents a zero slope where a gradient axis has no finite neighbor", async () => {
    const grid = [
      [0, 1, 2],
      [0, 1, 2],
      [0, Number.NaN, 2],
    ];
    const result = await runWorker(planeInput([0, 1, 5], 100, grid));
    expect(result.error).toBeUndefined();

    let visibleChecked = 0;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const idx = row * 3 + col;
        if (result.cell_states![idx] !== LOSCellState.VISIBLE) continue;
        visibleChecked++;
        const gradient = terrainGradientAt(grid, row, col, 1);
        if (gradient === null) {
          // Strict no-data: the canonical v2 indices are NaN, never a measured zero.
          expect(Number.isNaN(result.flat_quality_grid![idx]!)).toBe(true);
          expect(Number.isNaN(result.flat_projection_grid![idx]!)).toBe(true);
        } else {
          expect(Number.isFinite(result.flat_quality_grid![idx]!)).toBe(true);
          expect(Number.isFinite(result.flat_projection_grid![idx]!)).toBe(true);
        }
      }
    }
    expect(visibleChecked).toBeGreaterThan(0);
  });

  it("characterizes unchanged range/FOV/state codes and counts around the v2 buffers", async () => {
    const result = await runWorker(planeInput([0, 1, 5], 1.5));

    expect(Array.from(result.cell_states!)).toEqual([
      LOSCellState.VISIBLE, LOSCellState.VISIBLE, LOSCellState.OUT_OF_RANGE,
      LOSCellState.VISIBLE, LOSCellState.VISIBLE, LOSCellState.OUT_OF_RANGE,
      LOSCellState.VISIBLE, LOSCellState.VISIBLE, LOSCellState.OUT_OF_RANGE,
    ]);
    expect(result.visible_area_m2).toBe(6);
    expect(result.coverage_pct).toBe(100);
    expect(result.completeness_pct).toBe(100);
  });
});
