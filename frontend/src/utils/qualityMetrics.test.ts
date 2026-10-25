import { describe, expect, it } from "vitest";
import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";
import {
  DEFAULT_QUALITY_POLICY,
  QUALITY_MODEL_V2,
  classifyQualityValue,
  computeCommonTarget,
  computeQualitySummary,
  formatBandRange,
  isValidQualityPolicy,
  metricLabel,
} from "./qualityMetrics";

const activeTerrainKey = { terrain_id: "terrain-a", epoch: 1 };
const activeSnapshot: AnalysisSnapshot = {
  terrainKey: activeTerrainKey,
  analysisId: "job-1",
  sourceAnalysisIds: ["job-1"],
  generation: 1,
  radars: [],
};

describe("quality policy validation and classification", () => {
  it("accepts the provisional default bands and rejects invalid thresholds without reordering", () => {
    expect(DEFAULT_QUALITY_POLICY).toEqual({ mediumMin: 0.3, highMin: 0.7 });
    expect(isValidQualityPolicy(DEFAULT_QUALITY_POLICY)).toBe(true);
    expect(isValidQualityPolicy({ mediumMin: 0, highMin: 1 })).toBe(true);
    expect(isValidQualityPolicy({ mediumMin: 0.7, highMin: 0.3 })).toBe(false);
    expect(isValidQualityPolicy({ mediumMin: 0.5, highMin: 0.5 })).toBe(false);
    expect(isValidQualityPolicy({ mediumMin: -0.1, highMin: 0.5 })).toBe(false);
    expect(isValidQualityPolicy({ mediumMin: 0.5, highMin: 1.2 })).toBe(false);
    expect(isValidQualityPolicy({ mediumMin: Number.NaN, highMin: 0.7 })).toBe(false);
    expect(isValidQualityPolicy({ mediumMin: 0.3, highMin: Number.POSITIVE_INFINITY })).toBe(false);
    // Thresholds collapsing into one Float32 cannot define bands; rejected explicitly.
    expect(isValidQualityPolicy({ mediumMin: 0.7, highMin: 0.700000001 })).toBe(false);
  });

  it("classifies with strict boundaries and keeps missing values out of the bands", () => {
    const policy = { mediumMin: 0.3, highMin: 0.7 };
    expect(classifyQualityValue(0, policy)).toBe("low");
    expect(classifyQualityValue(0.2999, policy)).toBe("low");
    expect(classifyQualityValue(0.3, policy)).toBe("medium");
    expect(classifyQualityValue(0.6999, policy)).toBe("medium");
    expect(classifyQualityValue(0.7, policy)).toBe("high");
    expect(classifyQualityValue(1, policy)).toBe("high");
    expect(classifyQualityValue(Number.NaN, policy)).toBeNull();
    expect(classifyQualityValue(-1, policy)).toBeNull();
    expect(classifyQualityValue(Number.POSITIVE_INFINITY, policy)).toBeNull();
  });

  it("formats band ranges and metric labels shared by legend, cards and export", () => {
    expect(formatBandRange("low", DEFAULT_QUALITY_POLICY)).toBe("[0, 0.3)");
    expect(formatBandRange("medium", DEFAULT_QUALITY_POLICY)).toBe("[0.3, 0.7)");
    expect(formatBandRange("high", DEFAULT_QUALITY_POLICY)).toBe("[0.7, 1]");
    // Typed user precision survives; intervals are half-open and unambiguous.
    expect(formatBandRange("low", { mediumMin: 0.705, highMin: 0.9 })).toBe("[0, 0.705)");
    expect(formatBandRange("medium", { mediumMin: 0.705, highMin: 0.9 })).toBe("[0.705, 0.9)");
    expect(formatBandRange("high", { mediumMin: 0.705, highMin: 0.9 })).toBe("[0.9, 1]");
    expect(metricLabel("INCIDENCE")).toBe("Incidencia superficial");
    expect(metricLabel("PROJECTION")).toBe("Proyección del movimiento");
  });
});

describe("common target — topografía válida completa", () => {
  it("counts every finite raster node on a rectangular grid and reports its nominal planar area", () => {
    const grid = [
      [0, 1, Number.NaN],
      [2, 3, 4],
    ];
    const target = computeCommonTarget(grid, 5);
    expect(target.label).toBe("Topografía válida completa");
    expect(target.cellCount).toBe(5);
    expect(target.nominalAreaM2).toBe(5 * 25);
  });

  it("depends only on the finite terrain nodes, never on radar range/FOV footprints", () => {
    const grid = [
      [0, 1, 2],
      [3, Number.NaN, 5],
    ];
    const statesA = [
      LOSCellState.VISIBLE, LOSCellState.VISIBLE, LOSCellState.OUT_OF_RANGE,
      LOSCellState.VISIBLE, LOSCellState.NODATA, LOSCellState.OUTSIDE_FOV,
    ];
    const statesB = [
      LOSCellState.VISIBLE, LOSCellState.UNKNOWN_RAY, LOSCellState.VISIBLE,
      LOSCellState.OUT_OF_RANGE, LOSCellState.NODATA, LOSCellState.VISIBLE,
    ];
    const first = computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: v2Result({ states: statesA, rows: 2, cols: 3, incidence: [0.9, 0.9, -1, 0.9, -1, -1] }),
      terrainGrid: grid,
      terrainResolution: 1,
      terrainKey: activeTerrainKey,
      snapshot: activeSnapshot,
    });
    const second = computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: v2Result({ states: statesB, rows: 2, cols: 3, incidence: [0.9, -1, 0.9, -1, -1, 0.9] }),
      terrainGrid: grid,
      terrainResolution: 1,
      terrainKey: activeTerrainKey,
      snapshot: activeSnapshot,
    });
    expect(first!.target).toEqual(second!.target);
    expect(first!.target.cellCount).toBe(5);
    expect(first!.usefulCoveragePct).toBeCloseTo((3 / 5) * 100, 10);
    expect(second!.usefulCoveragePct).toBeCloseTo((3 / 5) * 100, 10);
  });

  it("reports no target as null target-referenced metrics", () => {
    const grid = [[Number.NaN, Number.NaN]];
    const summary = computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: v2Result({ states: [LOSCellState.NODATA, LOSCellState.NODATA], rows: 1, cols: 2, incidence: [-1, -1] }),
      terrainGrid: grid,
      terrainResolution: 1,
      terrainKey: activeTerrainKey,
      snapshot: activeSnapshot,
    });
    expect(summary).not.toBeNull();
    expect(summary!.target.cellCount).toBe(0);
    expect(summary!.usefulCoveragePct).toBeNull();
    expect(summary!.usefulAreaM2).toBeNull();
    expect(summary!.mediumHighAmongVisiblePct).toBeNull();
    expect(summary!.distribution).toBeNull();
  });
});

describe("quality summary — useful coverage and distribution", () => {
  const terrainGrid = [
    [0, 1, 2],
    [3, 4, 5],
  ];
  const baseInput = {
    metric: "INCIDENCE" as const,
    policy: { mediumMin: 0.3, highMin: 0.7 },
    terrainGrid,
    terrainResolution: 2,
    terrainKey: activeTerrainKey,
    snapshot: activeSnapshot,
  };

  it("computes useful coverage over the common target and media+alta over all visible cells", () => {
    const summary = computeQualitySummary({
      ...baseInput,
      losResult: v2Result({
        states: [5, 5, 5, 5, 4, 3],
        rows: 2,
        cols: 3,
        resolution: 2,
        // Values on each side of the thresholds; NaN is a missing index, not a zero.
        incidence: [0.29, 0.31, 0.71, Number.NaN, -1, -1],
      }),
    })!;

    expect(summary.qualityModel).toBe(QUALITY_MODEL_V2);
    expect(summary.target.cellCount).toBe(6);
    expect(summary.visibleCount).toBe(4);
    expect(summary.usefulCount).toBe(2);
    expect(summary.usefulCoveragePct).toBeCloseTo((2 / 6) * 100, 10);
    expect(summary.usefulAreaM2).toBe(2 * 4);
    expect(summary.mediumHighAmongVisiblePct).toBeCloseTo((2 / 4) * 100, 10);
    expect(summary.distribution).toEqual({
      lowCount: 1, mediumCount: 1, highCount: 1, noIndexCount: 1,
      lowPct: 25, mediumPct: 25, highPct: 25, noIndexPct: 25,
    });
  });

  it("classifies exact threshold values as medium and high under binary-exact bands", () => {
    const summary = computeQualitySummary({
      ...baseInput,
      policy: { mediumMin: 0.25, highMin: 0.75 },
      losResult: v2Result({
        states: [5, 5, 4, 4, 4, 4],
        rows: 2,
        cols: 3,
        resolution: 2,
        incidence: [0.25, 0.75, -1, -1, -1, -1],
      }),
    })!;
    expect(summary.distribution).toEqual({
      lowCount: 0, mediumCount: 1, highCount: 1, noIndexCount: 0,
      lowPct: 0, mediumPct: 50, highPct: 50, noIndexPct: 0,
    });
    expect(summary.usefulCount).toBe(2);
  });

  it("reclassifies existing scores when thresholds change without rerunning LOS", () => {
    const result = v2Result({
      states: [5, 5, 5, 4, 4, 4],
      rows: 2,
      cols: 3,
      resolution: 2,
      incidence: [0.25, 0.5, 0.75, -1, -1, -1],
    });
    const loose = computeQualitySummary({
      ...baseInput,
      policy: { mediumMin: 0.3, highMin: 0.7 },
      losResult: result,
    })!;
    const strict = computeQualitySummary({
      ...baseInput,
      policy: { mediumMin: 0.6, highMin: 0.8 },
      losResult: result,
    })!;

    expect(loose.usefulCount).toBe(2);
    expect(strict.usefulCount).toBe(1);
    expect(loose.distribution).toEqual({
      lowCount: 1, mediumCount: 1, highCount: 1, noIndexCount: 0,
      lowPct: (1 / 3) * 100, mediumPct: (1 / 3) * 100, highPct: (1 / 3) * 100, noIndexPct: 0,
    });
    expect(strict.distribution).toEqual({
      lowCount: 2, mediumCount: 1, highCount: 0, noIndexCount: 0,
      lowPct: (2 / 3) * 100, mediumPct: (1 / 3) * 100, highPct: 0, noIndexPct: 0,
    });
  });

  it("reports measured-none as zero useful coverage when the target is nonempty but nothing is visible", () => {
    const summary = computeQualitySummary({
      ...baseInput,
      losResult: v2Result({
        states: [4, 4, 4, 4, 4, 4],
        rows: 2,
        cols: 3,
        resolution: 2,
        incidence: [-1, -1, -1, -1, -1, -1],
      }),
    })!;
    expect(summary.usefulCount).toBe(0);
    expect(summary.usefulCoveragePct).toBe(0);
    expect(summary.usefulAreaM2).toBe(0);
    expect(summary.mediumHighAmongVisiblePct).toBeNull();
    expect(summary.distribution).toBeNull();
  });

  it("keeps missing indices in their own visible bucket instead of renormalizing valid data", () => {
    const summary = computeQualitySummary({
      ...baseInput,
      losResult: v2Result({
        states: [5, 5, 5, 5, 4, 4],
        rows: 2,
        cols: 3,
        resolution: 2,
        incidence: [0.5, 0.5, Number.NaN, Number.NaN, -1, -1],
      }),
    })!;
    expect(summary.distribution).toEqual({
      lowCount: 0, mediumCount: 2, highCount: 0, noIndexCount: 2,
      lowPct: 0, mediumPct: 50, highPct: 0, noIndexPct: 50,
    });
    expect(summary.usefulCount).toBe(2);
  });

  it("never treats a measured zero as missing data", () => {
    const summary = computeQualitySummary({
      ...baseInput,
      losResult: v2Result({
        states: [5, 4, 4, 4, 4, 4],
        rows: 2,
        cols: 3,
        resolution: 2,
        incidence: [0, -1, -1, -1, -1, -1],
      }),
    })!;
    expect(summary.distribution!.lowCount).toBe(1);
    expect(summary.distribution!.noIndexCount).toBe(0);
  });

  it("selects the projection grid for the movement metric and marks unavailable projection", () => {
    const result = v2Result({
      states: [5, 5, 5, 4, 4, 4],
      rows: 2,
      cols: 3,
      resolution: 2,
      incidence: [0.9, 0.9, 0.9, -1, -1, -1],
      projection: [0.1, 0.8, Number.NaN, -1, -1, -1],
    });
    const byProjection = computeQualitySummary({ ...baseInput, metric: "PROJECTION", losResult: result })!;
    expect(byProjection.usefulCount).toBe(1);
    expect(byProjection.distribution).toEqual({
      lowCount: 1, mediumCount: 0, highCount: 1, noIndexCount: 1,
      lowPct: (1 / 3) * 100, mediumPct: 0, highPct: (1 / 3) * 100, noIndexPct: (1 / 3) * 100,
    });

    const withoutProjection = { ...result };
    delete withoutProjection.flat_projection_grid;
    expect(computeQualitySummary({ ...baseInput, metric: "PROJECTION", losResult: withoutProjection })).toBeNull();
  });
});

describe("quality summary — availability guards", () => {
  const terrainGrid = [[0, 1], [2, 3]];
  const legacyResult = {
    shadow_grid: [[false, false], [false, true]],
    cell_states: Uint8Array.from([5, 5, 5, 4]),
    grid_rows: 2,
    grid_cols: 2,
    resolution: 1,
    quality_grid: [[0.9, 0.9], [0.9, 0]],
    flat_quality_grid: Float32Array.from([0.9, 0.9, 0.9, -1]),
    coverage_polygon: [],
    coverage_pct: 75,
    completeness_pct: 100,
    visible_area_m2: 3,
    shadow_zones: [{ zone_id: 1, cell_count: 1 }],
  } as unknown as LOSResponse;

  it("treats historical unversioned results as unavailable, never as current v2 quality", () => {
    const summary = computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: legacyResult,
      terrainGrid,
      terrainResolution: 1,
    });
    expect(summary).toBeNull();
  });

  it("rejects a wrong score-model version tag", () => {
    const wrong = { ...legacyResult, quality_model: "geometric-v1" } as unknown as LOSResponse;
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: wrong,
      terrainGrid,
      terrainResolution: 1,
    })).toBeNull();
  });

  it("rejects mismatched terrain epoch, dimensions and resolution", () => {
    const result = v2Result({
      states: [5, 5, 5, 4],
      rows: 2,
      cols: 2,
      resolution: 1,
      incidence: [0.5, 0.5, 0.5, -1],
    });
    const snapshot: AnalysisSnapshot = {
      terrainKey: { terrain_id: "terrain-a", epoch: 1 },
      analysisId: "job-1",
      sourceAnalysisIds: ["job-1"],
      generation: 1,
      radars: [],
    };
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: result,
      terrainGrid,
      terrainResolution: 1,
      terrainKey: { terrain_id: "terrain-a", epoch: 1 },
      snapshot,
    })).not.toBeNull();

    // Different epoch of the same terrain id.
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: result,
      terrainGrid,
      terrainResolution: 1,
      terrainKey: { terrain_id: "terrain-a", epoch: 2 },
      snapshot,
    })).toBeNull();

    // Different dimensions.
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: result,
      terrainGrid: [[0, 1, 2], [3, 4, 5]],
      terrainResolution: 1,
    })).toBeNull();

    // Different resolution.
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: DEFAULT_QUALITY_POLICY,
      losResult: result,
      terrainGrid,
      terrainResolution: 2,
    })).toBeNull();
  });

  it("rejects invalid policies instead of silently reordering thresholds", () => {
    const result = v2Result({
      states: [5, 5, 5, 4],
      rows: 2,
      cols: 2,
      resolution: 1,
      incidence: [0.5, 0.5, 0.5, -1],
    });
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: { mediumMin: 0.9, highMin: 0.1 },
      losResult: result,
      terrainGrid,
      terrainResolution: 1,
    })).toBeNull();
  });
});

interface V2ResultParams {
  states: number[];
  rows: number;
  cols: number;
  resolution?: number;
  incidence?: Array<number | null>;
  projection?: Array<number | null>;
  qualityModel?: string | undefined;
}

function v2Result(params: V2ResultParams): LOSResponse {
  const size = params.states.length;
  const resolution = params.resolution ?? 1;
  const flat_quality_grid = new Float32Array(size);
  flat_quality_grid.fill(-1);
  const flat_projection_grid = new Float32Array(size);
  flat_projection_grid.fill(Number.NaN);
  const quality_grid: number[][] = Array.from({ length: params.rows }, () => Array<number>(params.cols).fill(0));
  for (let idx = 0; idx < size; idx++) {
    const incidence = params.incidence?.[idx];
    if (incidence !== undefined && incidence !== null) flat_quality_grid[idx] = incidence;
    const projection = params.projection?.[idx];
    if (projection !== undefined && projection !== null) flat_projection_grid[idx] = projection;
    quality_grid[Math.floor(idx / params.cols)]![idx % params.cols] = flat_quality_grid[idx]!;
  }
  return {
    shadow_grid: Array.from({ length: params.rows }, () => Array<boolean>(params.cols).fill(false)),
    cell_states: Uint8Array.from(params.states),
    grid_rows: params.rows,
    grid_cols: params.cols,
    resolution,
    quality_grid,
    flat_quality_grid,
    quality_model: (params.qualityModel ?? QUALITY_MODEL_V2) as "geometric-v2",
    flat_projection_grid,
    coverage_polygon: [],
    coverage_pct: 50,
    completeness_pct: 100,
    visible_area_m2: params.states.filter((state) => state === LOSCellState.VISIBLE).length * resolution * resolution,
    shadow_zones: [],
  };
}

describe("quality summary — canonical Float32 band precision", () => {
  function nextFloat32(value: number, direction: 1 | -1): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    view.setUint32(0, view.getUint32(0) + direction);
    return view.getFloat32(0);
  }

  it("classifies in the canonical Float32 space shared with the GPU bands", () => {
    const policy = { mediumMin: 0.3, highMin: 0.7 };
    // Canonical grid values are Float32: f32(0.7) sits exactly on the high cutoff.
    expect(classifyQualityValue(Math.fround(0.7), policy)).toBe("high");
    expect(classifyQualityValue(nextFloat32(Math.fround(0.7), -1), policy)).toBe("medium");
    expect(classifyQualityValue(Math.fround(0.7), policy)).toBe("high");
    expect(classifyQualityValue(nextFloat32(Math.fround(0.7), 1), policy)).toBe("high");

    const midPolicy = { mediumMin: 0.35, highMin: 0.7 };
    expect(classifyQualityValue(nextFloat32(Math.fround(0.35), -1), midPolicy)).toBe("low");
    expect(classifyQualityValue(Math.fround(0.35), midPolicy)).toBe("medium");
    expect(classifyQualityValue(nextFloat32(Math.fround(0.35), 1), midPolicy)).toBe("medium");

    // Measured zero stays a measured low; NaN and out-of-range stay out of the bands.
    expect(classifyQualityValue(0, policy)).toBe("low");
    expect(classifyQualityValue(Number.NaN, policy)).toBeNull();
    expect(classifyQualityValue(1.0001, policy)).toBeNull();
  });

  it("counts the useful numerator from the classified band, never a second double comparison", () => {
    const summary = computeQualitySummary({
      metric: "INCIDENCE",
      policy: { mediumMin: 0.35, highMin: 0.7 },
      losResult: v2Result({
        states: [5, 5, 4, 4, 4, 4],
        rows: 2,
        cols: 3,
        resolution: 2,
        incidence: [Math.fround(0.35), Math.fround(0.7), -1, -1, -1, -1],
      }),
      terrainGrid: [[0, 1, 2], [3, 4, 5]],
      terrainResolution: 2,
      terrainKey: activeTerrainKey,
      snapshot: activeSnapshot,
    })!;
    // Both values equal their cutoff in Float32: medium and high, both useful.
    expect(summary.distribution).toEqual({
      lowCount: 0, mediumCount: 1, highCount: 1, noIndexCount: 0,
      lowPct: 0, mediumPct: 50, highPct: 50, noIndexPct: 0,
    });
    expect(summary.usefulCount).toBe(2);
    expect(summary.mediumHighAmongVisiblePct).toBe(100);
  });

  it("rejects thresholds that collapse in Float32 instead of reordering them", () => {
    expect(computeQualitySummary({
      metric: "INCIDENCE",
      policy: { mediumMin: 0.7, highMin: 0.700000001 },
      losResult: v2Result({ states: [5, 4, 4, 4], rows: 2, cols: 2, resolution: 1, incidence: [0.5, -1, -1, -1] }),
      terrainGrid: [[0, 1], [2, 3]],
      terrainResolution: 1,
      terrainKey: activeTerrainKey,
      snapshot: activeSnapshot,
    })).toBeNull();
  });
});

describe("quality summary — provenance and grid coherence", () => {
  const validInput = {
    metric: "INCIDENCE" as const,
    policy: DEFAULT_QUALITY_POLICY,
    losResult: v2Result({ states: [5, 5, 5, 4], rows: 2, cols: 2, resolution: 1, incidence: [0.5, 0.5, 0.5, -1] }),
    terrainGrid: [[0, 1], [2, 3]],
    terrainResolution: 1,
    terrainKey: activeTerrainKey,
    snapshot: activeSnapshot,
  };

  it("requires the active terrain key and the snapshot key to be present, valid and exactly equal", () => {
    expect(computeQualitySummary(validInput)).not.toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainKey: null })).toBeNull();
    expect(computeQualitySummary({ ...validInput, snapshot: null })).toBeNull();
    expect(computeQualitySummary({
      ...validInput,
      snapshot: { ...activeSnapshot, terrainKey: undefined as never },
    })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainKey: { terrain_id: "terrain-a", epoch: 2 } })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainKey: { terrain_id: "terrain-b", epoch: 1 } })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainKey: { terrain_id: "", epoch: 1 } })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainKey: { terrain_id: "terrain-a", epoch: Number.NaN } })).toBeNull();
  });

  it("rejects ragged grids and dimension, resolution or area mismatches with valid provenance", () => {
    expect(computeQualitySummary({ ...validInput, terrainGrid: [[0, 1], [2]] })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainGrid: [[0, 1, 2], [3, 4, 5]] })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainResolution: 2 })).toBeNull();
    expect(computeQualitySummary({
      ...validInput,
      losResult: v2Result({ states: [5, 5, 5, 4], rows: 2, cols: 2, resolution: 0, incidence: [0.5, 0.5, 0.5, -1] }),
      terrainResolution: 0,
    })).toBeNull();
    expect(computeQualitySummary({ ...validInput, terrainResolution: Number.NaN })).toBeNull();
  });

  it("rejects results whose cell states disagree with the terrain data", () => {
    // VISIBLE over a missing terrain node would report coverage beyond the target.
    expect(computeQualitySummary({
      ...validInput,
      terrainGrid: [[0, 1], [Number.NaN, 3]],
      losResult: v2Result({ states: [5, 5, 5, 5], rows: 2, cols: 2, resolution: 1, incidence: [0.5, 0.5, 0.5, 0.5] }),
    })).toBeNull();
    // NODATA over a finite terrain node shrinks the shared target below the data.
    expect(computeQualitySummary({
      ...validInput,
      losResult: v2Result({ states: [5, 5, 5, 0], rows: 2, cols: 2, resolution: 1, incidence: [0.5, 0.5, 0.5, -1] }),
    })).toBeNull();
    // Unknown cell-state codes cannot be summarized.
    expect(computeQualitySummary({
      ...validInput,
      losResult: v2Result({ states: [5, 5, 5, 7], rows: 2, cols: 2, resolution: 1, incidence: [0.5, 0.5, 0.5, -1] }),
    })).toBeNull();
  });
});
