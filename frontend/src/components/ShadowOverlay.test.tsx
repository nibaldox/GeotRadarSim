import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LOSCellState, type AnalysisSnapshot, type LOSResponse, type SensitivityMapResponse } from "../types/api";
import * as THREE from "three";
import {
  ShadowOverlay,
  classifyOverlayCellState,
  createObserverCountTexture,
  sensitivityMapMatchesSnapshot,
  sensitivityValueForCell,
} from "./ShadowOverlay";
import { useAnalysisStore } from "../store/analysisStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";

describe("ShadowOverlay cell-state classification", () => {
  it("classifies merged LOS states without ever treating NODATA as shadow", () => {
    expect([0, 1, 2, 3, 4, 5].map(classifyOverlayCellState)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "shadow",
      "visible",
    ]);
  });
});

const snapshot: AnalysisSnapshot = {
  terrainKey: { terrain_id: "terrain-overlay", epoch: 2 },
  analysisId: null,
  sourceAnalysisIds: ["analysis-a", "analysis-b"],
  generation: 5,
  radars: [],
};

const sensitivityMap: SensitivityMapResponse = {
  terrainKey: snapshot.terrainKey,
  sourceAnalysisIds: ["analysis-a", "analysis-b"],
  grid_rows: 1,
  grid_cols: 3,
  resolution: 2,
  flat_sensitivity_grid: new Float32Array([Number.NaN, 0, 0.75]),
  observer_count: new Uint16Array([0, 1, 2]),
};

describe("ShadowOverlay per-cell sensitivity mask", () => {
  it("uploads observer counts in a float texture compatible with the sampler2D shader", () => {
    const counts = new Uint16Array([0, 1, 2, 65_535]);
    const texture = createObserverCountTexture(counts, 2, 2);
    try {
      // RedFormat + UnsignedShortType has no sized internal format in Three.js
      // and fails gl.texStorage2D. RedFormat + FloatType maps to WebGL2 R32F.
      expect(texture.format).toBe(THREE.RedFormat);
      expect(texture.type).toBe(THREE.FloatType);
      expect(texture.image.width).toBe(2);
      expect(texture.image.height).toBe(2);
      expect(texture.image.data).toBeInstanceOf(Float32Array);
      expect(Array.from(texture.image.data as Float32Array)).toEqual([0, 1, 2, 65_535]);
      expect(Array.from(counts)).toEqual([0, 1, 2, 65_535]);
      expect(texture.minFilter).toBe(THREE.NearestFilter);
      expect(texture.magFilter).toBe(THREE.NearestFilter);
      expect(texture.generateMipmaps).toBe(false);
      expect(texture.version).toBeGreaterThan(0);
    } finally {
      texture.dispose();
    }
  });

  it("discards cells with zero observers and preserves a measured zero", () => {
    expect(sensitivityValueForCell(sensitivityMap, 0)).toBeNull();
    expect(sensitivityValueForCell(sensitivityMap, 1)).toBe(0);
    expect(sensitivityValueForCell(sensitivityMap, 2)).toBe(0.75);
  });

  it("requires map provenance to match selected analysis IDs and terrain epoch", () => {
    expect(sensitivityMapMatchesSnapshot(sensitivityMap, snapshot, 1, 3, 2)).toBe(true);
    expect(sensitivityMapMatchesSnapshot(sensitivityMap, { ...snapshot, terrainKey: { terrain_id: "terrain-overlay", epoch: 1 } }, 1, 3, 2)).toBe(false);
    expect(sensitivityMapMatchesSnapshot(sensitivityMap, { ...snapshot, sourceAnalysisIds: ["analysis-a"] }, 1, 3, 2)).toBe(false);
  });

  it("returns no value for invalid or unavailable map samples", () => {
    expect(sensitivityValueForCell(sensitivityMap, -1)).toBeNull();
    expect(sensitivityValueForCell(sensitivityMap, 3)).toBeNull();
    expect(sensitivityValueForCell({ ...sensitivityMap, flat_sensitivity_grid: new Float32Array([Number.NaN, Number.NaN, 0.75]) }, 1)).toBeNull();
  });

  it("uses the individual VISIBLE state code, not the merged-state code", () => {
    expect(LOSCellState.VISIBLE).toBe(5);
    expect(sensitivityValueForCell(sensitivityMap, 1)).toBe(0);
  });
});

// ─── Real material shader harness ─────────────────────────────────────────────
// jsdom provides no WebGL, so instead of keeping a parallel JS copy of the
// paint rules (which could drift from the GPU) these tests render the real
// ShadowOverlay and capture the fragment shader plus uniform values bound to
// its material element, then execute that exact GLSL per cell through a
// minimal evaluator for the GLSL subset the overlay uses. The texture inputs
// are the very THREE.DataTexture uploads the component built from the LOS
// response, so the assertions cover the real CPU→shader seam.

type ShaderTexture = {
  image: { data: ArrayLike<number>; width: number; height: number };
  minFilter?: number;
  magFilter?: number;
};

interface ShaderUniforms {
  qualityTexture: ShaderTexture | null;
  cellStateTexture: ShaderTexture | null;
  observerCountTexture: ShaderTexture | null;
  opacity: number;
  mapMode: number;
  mediumMin: number;
  highMin: number;
}

interface CapturedMaterial {
  fragmentShader: string;
  uniforms: ShaderUniforms;
}

declare global {
  interface HTMLElement {
    /** R3F binds shader uniforms as element properties; jsdom renders the
     * intrinsic as a plain element, so tests provide this material stand-in. */
    uniforms?: Record<string, { value: unknown }>;
    __uniforms?: Record<string, { value: unknown }>;
  }
}

Object.defineProperty(HTMLElement.prototype, "uniforms", {
  configurable: true,
  get(this: HTMLElement) {
    if (!this.__uniforms) {
      this.__uniforms = new Proxy({}, {
        get: (target, prop: string | symbol) => {
          const slots = target as Record<string, { value: unknown }>;
          const key = String(prop);
          if (!(key in slots)) slots[key] = { value: undefined };
          return slots[key];
        },
      });
    }
    return this.__uniforms;
  },
  set(this: HTMLElement, value: Record<string, { value: unknown }>) {
    this.__uniforms = value;
  },
});

class DiscardSignal extends Error {}

function sampleTexture(texture: ShaderTexture, uv: number[]): number[] {
  const { data, width, height } = texture.image;
  const col = Math.min(width - 1, Math.max(0, Math.floor((uv[0] ?? 0) * width)));
  const row = Math.min(height - 1, Math.max(0, Math.floor((uv[1] ?? 0) * height)));
  const raw = data[row * width + col] ?? 0;
  // WebGL normalizes unsigned-byte uploads to [0,1]; float uploads read as-is.
  return [data instanceof Uint8Array ? raw / 255 : raw];
}

const vec = (...parts: Array<number | number[]>): number[] => {
  const first = parts[0];
  if (parts.length === 1 && typeof first === "number") return [first, first, first];
  return parts.flatMap((part) => (Array.isArray(part) ? part : [part]));
};

const mix = (a: number | number[], b: number | number[], t: number): number | number[] =>
  Array.isArray(a) && Array.isArray(b)
    ? a.map((value, index) => value + ((b[index] ?? value) - value) * t)
    : (a as number) + ((b as number) - (a as number)) * t;

/** Executes the captured fragment shader for one sample point. Returns the
 * drawn RGBA color, or null when the shader ran `discard` (transparent). */
function runFragmentShader(source: string, uniforms: ShaderUniforms, vUv: [number, number]): number[] | null {
  const main = /void\s+main\s*\(\s*\)\s*\{([\s\S]*)\}/.exec(source);
  if (!main || !main[1]) throw new Error("fragment shader has no main() body");
  const body = main[1]
    .replace(/texture2D\s*\(\s*(\w+)\s*,\s*vUv\s*\)/g, "sampleTexture($1, vUv)")
    .replace(/\.r\b/g, "[0]")
    .replace(/\bvec[234]\s*\(/g, "vec(")
    .replace(/^(\s*)(?:float|vec[234])\s+(\w+)\s*=/gm, "$1let $2 =")
    .replace(/^(\s*)(?:float|vec[234])\s+(\w+)\s*;?\s*$/gm, "$1let $2;")
    .replace(/\bdiscard\s*;/g, "throw new DiscardSignal();")
    .replace(/\bgl_FragColor\b/g, "glFragColor")
    .replace(/\breturn\s*;/g, "return glFragColor;");
  const compiled = new Function(
    "uniforms", "vUv", "sampleTexture", "vec", "mix", "floor", "DiscardSignal",
    `const { qualityTexture, cellStateTexture, observerCountTexture, opacity, mapMode, mediumMin, highMin } = uniforms;
     let glFragColor = null;
     ${body}
     return glFragColor;`,
  ) as unknown as (
    uniforms: ShaderUniforms,
    vUv: [number, number],
    sample: typeof sampleTexture,
    vecCtor: typeof vec,
    mixFn: typeof mix,
    floorFn: (x: number) => number,
    discardType: typeof DiscardSignal,
  ) => number[] | null;
  try {
    return compiled(uniforms, vUv, sampleTexture, vec, mix, Math.floor, DiscardSignal);
  } catch (error) {
    if (error instanceof DiscardSignal) return null;
    throw error;
  }
}

const OVERLAY_GRID = [[0, 0, 0, 0], [0, 0, 0, 0]];
const OVERLAY_ROWS = 2;
const OVERLAY_COLS = 4;
const OVERLAY_RESOLUTION = 2;

interface OverlayFixture {
  mode: "QUALITY" | "SENSITIVITY";
  cellStates: number[];
  /** Flat worker quality per cell (-1 marks non-visible, like real output). */
  quality?: number[];
  observerCounts?: number[];
  sensitivity?: number[];
  /** Score-model tag of the LOS result; undefined renders a legacy result. */
  qualityModel?: string | undefined;
  policy?: { mediumMin: number; highMin: number };
}

function renderOverlayMaterial(fixture: OverlayFixture): CapturedMaterial | null {
  const cellCount = OVERLAY_ROWS * OVERLAY_COLS;
  const losResult: LOSResponse = {
    shadow_grid: Array.from({ length: OVERLAY_ROWS }, () => Array<boolean>(OVERLAY_COLS).fill(false)),
    cell_states: Uint8Array.from(fixture.cellStates),
    grid_rows: OVERLAY_ROWS,
    grid_cols: OVERLAY_COLS,
    resolution: OVERLAY_RESOLUTION,
    coverage_polygon: [],
    coverage_pct: 100,
    completeness_pct: 100,
    visible_area_m2: 1,
    shadow_zones: [],
    flat_quality_grid: Float32Array.from(fixture.quality ?? Array<number>(cellCount).fill(-1)),
    ...(fixture.qualityModel === undefined
      ? {}
      : { quality_model: fixture.qualityModel as "geometric-v2" }),
    flat_projection_grid: new Float32Array(cellCount),
  };
  const activeSnapshot: AnalysisSnapshot | null = fixture.mode === "SENSITIVITY" ? snapshot : null;
  const map: SensitivityMapResponse | null = fixture.mode === "SENSITIVITY"
    ? {
        ...sensitivityMap,
        grid_rows: OVERLAY_ROWS,
        grid_cols: OVERLAY_COLS,
        resolution: OVERLAY_RESOLUTION,
        flat_sensitivity_grid: Float32Array.from(fixture.sensitivity ?? Array<number>(cellCount).fill(0)),
        observer_count: Uint16Array.from(fixture.observerCounts ?? Array<number>(cellCount).fill(0)),
      }
    : null;
  useAnalysisStore.setState({ losResult, activeSnapshot });
  useVectorStore.setState({ visualizationMode: fixture.mode, sensitivityMap: map });
  useQualityPolicyStore.setState({ policy: fixture.policy ?? { ...DEFAULT_QUALITY_POLICY } });

  const { container, unmount } = render(<ShadowOverlay grid={OVERLAY_GRID} resolution={OVERLAY_RESOLUTION} />);
  const element = container.querySelector("shadermaterial") as HTMLElement | null;
  if (!element) {
    unmount();
    return null;
  }
  const readUniform = (name: string): ShaderTexture | null =>
    (element.uniforms?.[name]?.value as ShaderTexture | undefined) ?? null;
  const captured: CapturedMaterial = {
    fragmentShader: element.getAttribute("fragmentshader") ?? "",
    uniforms: {
      qualityTexture: readUniform("qualityTexture"),
      cellStateTexture: readUniform("cellStateTexture"),
      observerCountTexture: readUniform("observerCountTexture"),
      // The material's `opacity` uniform default from the component's uniforms prop.
      opacity: 0.6,
      mapMode: (element.uniforms?.mapMode?.value as number | undefined) ?? Number.NaN,
      // GPU samplers/uniforms are float32: round like WebGL uploads to keep
      // exact-threshold boundaries faithful to the real shader.
      mediumMin: Math.fround((element.uniforms?.mediumMin?.value as number | undefined) ?? Number.NaN),
      highMin: Math.fround((element.uniforms?.highMin?.value as number | undefined) ?? Number.NaN),
    },
  };
  unmount();
  return captured;
}

/** Samples the shader at the exact center of row-major terrain cell `index`. */
function sampleCell(source: string, uniforms: ShaderUniforms, index: number): number[] | null {
  const row = Math.floor(index / OVERLAY_COLS);
  const col = index % OVERLAY_COLS;
  return runFragmentShader(source, uniforms, [(col + 0.5) / OVERLAY_COLS, (row + 0.5) / OVERLAY_ROWS]);
}

function expectColor(color: number[] | null, expected: number[]): void {
  expect(color).not.toBeNull();
  expect(color).toHaveLength(expected.length);
  expected.forEach((channel, index) => {
    expect(color![index]).toBeCloseTo(channel, 6);
  });
}

describe("ShadowOverlay LOS quality rendering (real material shader)", () => {
  it("paints only VISIBLE cells; SHADOW and every unobserved state leave the base terrain", () => {
    const { fragmentShader, uniforms } = renderOverlayMaterial({
      mode: "QUALITY",
      qualityModel: "geometric-v2",
      cellStates: [0, 1, 2, 3, 4, 5, 5, 5],
      quality: [-1, -1, -1, -1, -1, 0, 0.5, 1],
    })!;

    expect(sampleCell(fragmentShader, uniforms, 0), "NODATA (state 0) must stay transparent").toBeNull();
    expect(sampleCell(fragmentShader, uniforms, 1), "OUT_OF_RANGE (state 1) must stay transparent").toBeNull();
    expect(sampleCell(fragmentShader, uniforms, 2), "OUTSIDE_FOV (state 2) must stay transparent").toBeNull();
    expect(sampleCell(fragmentShader, uniforms, 3), "UNKNOWN_RAY (state 3) must stay transparent").toBeNull();
    expect(sampleCell(fragmentShader, uniforms, 4), "SHADOW (state 4) must stay transparent like the other unobserved states").toBeNull();
  });

  it("keeps a VISIBLE cell with a measured quality of exactly zero painted red", () => {
    const { fragmentShader, uniforms } = renderOverlayMaterial({
      mode: "QUALITY",
      qualityModel: "geometric-v2",
      cellStates: [0, 0, 0, 0, 0, 5, 0, 0],
      quality: [-1, -1, -1, -1, -1, 0, -1, -1],
    })!;

    // Low band of the VISIBLE index: a measured 0.0 is data, not absence.
    expectColor(sampleCell(fragmentShader, uniforms, 5), [0.9, 0.1, 0.1, 0.6]);
  });

  it("shades the three configured categories red, yellow and green with strict policy boundaries", () => {
    const { fragmentShader, uniforms } = renderOverlayMaterial({
      mode: "QUALITY",
      qualityModel: "geometric-v2",
      cellStates: [5, 5, 5, 5, 5, 5, 5, 5],
      quality: [0, 0.2999, 0.3, 0.6999, 0.7, 1, 0.5, 0.5],
    })!;
    expect(uniforms.mediumMin).toBe(Math.fround(DEFAULT_QUALITY_POLICY.mediumMin));
    expect(uniforms.highMin).toBe(Math.fround(DEFAULT_QUALITY_POLICY.highMin));

    expectColor(sampleCell(fragmentShader, uniforms, 0), [0.9, 0.1, 0.1, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 1), [0.9, 0.1, 0.1, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 2), [1, 0.8, 0, 0.6]);   // exactly mediumMin → medium
    expectColor(sampleCell(fragmentShader, uniforms, 3), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 4), [0, 0.9, 0.2, 0.6]); // exactly highMin → high
    expectColor(sampleCell(fragmentShader, uniforms, 5), [0, 0.9, 0.2, 0.6]);
  });

  it("follows the editable policy in both color layers without recomputing LOS", () => {
    const policy = { mediumMin: 0.25, highMin: 0.75 };
    const quality = renderOverlayMaterial({
      mode: "QUALITY",
      qualityModel: "geometric-v2",
      cellStates: [5, 5, 5, 5, 0, 0, 0, 0],
      quality: [0.24, 0.25, 0.74, 0.75, -1, -1, -1, -1],
      policy,
    })!;
    expect(quality.uniforms.mediumMin).toBe(0.25);
    expect(quality.uniforms.highMin).toBe(0.75);
    expectColor(sampleCell(quality.fragmentShader, quality.uniforms, 0), [0.9, 0.1, 0.1, 0.6]);
    expectColor(sampleCell(quality.fragmentShader, quality.uniforms, 1), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(quality.fragmentShader, quality.uniforms, 2), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(quality.fragmentShader, quality.uniforms, 3), [0, 0.9, 0.2, 0.6]);

    const movement = renderOverlayMaterial({
      mode: "SENSITIVITY",
      cellStates: [5, 5, 5, 5, 5, 5, 5, 5],
      observerCounts: [1, 1, 1, 1, 1, 1, 1, 1],
      sensitivity: [0.24, 0.25, 0.74, 0.75, 0, 1, 0.5, 0.5],
      policy,
    })!;
    expect(movement.uniforms.mediumMin).toBe(0.25);
    expect(movement.uniforms.highMin).toBe(0.75);
    expectColor(sampleCell(movement.fragmentShader, movement.uniforms, 0), [0.9, 0.1, 0.1, 0.6]);
    expectColor(sampleCell(movement.fragmentShader, movement.uniforms, 1), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(movement.fragmentShader, movement.uniforms, 2), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(movement.fragmentShader, movement.uniforms, 3), [0, 0.9, 0.2, 0.6]);
  });

  it("uploads quality values with nearest filtering so excluded texels cannot bleed into visible cells", () => {
    for (const mode of ["QUALITY", "SENSITIVITY"] as const) {
      const captured = renderOverlayMaterial({
        mode,
        qualityModel: "geometric-v2",
        cellStates: [5, 5, 5, 5, 5, 5, 5, 5],
        quality: [1, -1, -1, -1, -1, -1, -1, -1],
        observerCounts: [1, 0, 0, 0, 0, 0, 0, 0],
        sensitivity: [1, 0, 0, 0, 0, 0, 0, 0],
      })!;
      expect(captured.uniforms.qualityTexture!.minFilter, `${mode} minFilter`).toBe(THREE.NearestFilter);
      expect(captured.uniforms.qualityTexture!.magFilter, `${mode} magFilter`).toBe(THREE.NearestFilter);
    }
  });

  it("discards invalid or missing indices as transparent while keeping measured zeros painted", () => {
    const { fragmentShader, uniforms } = renderOverlayMaterial({
      mode: "QUALITY",
      qualityModel: "geometric-v2",
      // VISIBLE cells with sentinel -1 (invalid) and NaN (missing index) must not be painted.
      cellStates: [5, 5, 5, 5, 0, 0, 0, 0],
      quality: [-1, Number.NaN, 0, 0.5, -1, -1, -1, -1],
    })!;

    expect(sampleCell(fragmentShader, uniforms, 0), "invalid sentinel must stay transparent").toBeNull();
    expect(sampleCell(fragmentShader, uniforms, 1), "missing index must stay transparent").toBeNull();
    expectColor(sampleCell(fragmentShader, uniforms, 2), [0.9, 0.1, 0.1, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 3), [1, 0.8, 0, 0.6]);
  });

  it("refuses to draw legacy unversioned quality under the v2 incidence legend", () => {
    const legacy = renderOverlayMaterial({
      mode: "QUALITY",
      qualityModel: undefined,
      cellStates: [5, 5, 5, 5, 5, 5, 5, 5],
      quality: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    expect(legacy).toBeNull();

    // The projection layer is version-independent: its own worker provenance gates it.
    const movement = renderOverlayMaterial({
      mode: "SENSITIVITY",
      qualityModel: undefined,
      cellStates: [5, 5, 5, 5, 5, 5, 5, 5],
      observerCounts: [1, 1, 1, 1, 1, 1, 1, 1],
      sensitivity: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    expect(movement).not.toBeNull();
  });

  it("keeps the 3D movement-projection mode keyed on observer counts, not merged states", () => {
    const { fragmentShader, uniforms } = renderOverlayMaterial({
      mode: "SENSITIVITY",
      cellStates: [5, 5, 5, 5, 4, 4, 0, 2],
      observerCounts: [0, 1, 2, 3, 2, 1, 1, 1],
      sensitivity: [0.75, 0, 1, 0.5, 0.5, 0.5, 0.5, 0.5],
    })!;

    // No contributors means no measurement, not a zero value.
    expect(sampleCell(fragmentShader, uniforms, 0), "zero observers must stay transparent").toBeNull();
    // A measured zero with a contributor stays painted (low band).
    expectColor(sampleCell(fragmentShader, uniforms, 1), [0.9, 0.1, 0.1, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 2), [0, 0.9, 0.2, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 3), [1, 0.8, 0, 0.6]);
    // The merged LOS state is not a visibility proxy here: SHADOW/NODATA/
    // OUTSIDE_FOV cells with contributors still show their projection.
    expectColor(sampleCell(fragmentShader, uniforms, 4), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 5), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 6), [1, 0.8, 0, 0.6]);
    expectColor(sampleCell(fragmentShader, uniforms, 7), [1, 0.8, 0, 0.6]);
  });
});
