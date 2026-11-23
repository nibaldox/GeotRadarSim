/**
 * Test helpers (adopted from the R14 probes): the app's real TS LOS engine, i.e. the handler of
 * `workers/losWorker.ts` with a stubbed `self` and engine "ts". The Worker file is only imported,
 * never modified. Test files that use it mock `wasm/loader` (the TS engine does not need it).
 */
import { vi } from "vitest";
import type { RadarConfig } from "../../types/api";
import { normalizeAzimuthRange } from "../../services/api";
import type { LOSWorkerInput, LOSWorkerOutput } from "../../workers/losWorker";
import type { LosCellOutput, LosScorer, OptimizerGrid } from "./types";

type Handler = (event: MessageEvent) => void | Promise<void>;
let handler: Handler | null = null;

export async function loadLosHandler(): Promise<void> {
  if (handler) return;
  vi.resetModules();
  const scope: { onmessage: Handler | null; postMessage: () => void } = { onmessage: null, postMessage: () => undefined };
  vi.stubGlobal("self", scope);
  await import("../../workers/losWorker");
  vi.unstubAllGlobals();
  if (!scope.onmessage) throw new Error("LOS worker did not register its handler");
  handler = scope.onmessage;
}

/** Synchronous TS engine run (engine "ts" posts synchronously). */
export function runLos(input: LOSWorkerInput): LOSWorkerOutput {
  if (!handler) throw new Error("call loadLosHandler first");
  const posted: unknown[] = [];
  vi.stubGlobal("self", { onmessage: null, postMessage: (m: unknown) => posted.push(m) });
  try {
    void handler({ data: { ...input, engine: "ts" } } as MessageEvent);
  } finally {
    vi.unstubAllGlobals();
  }
  const out = posted[0] as LOSWorkerOutput;
  if (!out || out.error) throw new Error(`LOS failed: ${out?.error}`);
  return out;
}

/** Catalog-like RAR radar (groundprobe-ssr-fx numbers), optionally with open elevation. */
export function rarRadar(overrides: Partial<RadarConfig> = {}): RadarConfig {
  return {
    model_id: "groundprobe-ssr-fx",
    display_name: "probe",
    manufacturer: "probe",
    min_range_m: 50,
    max_range_m: 2500,
    h_beam_width_deg: 150,
    v_beam_width_deg: 30,
    elevation_min_deg: -60,
    elevation_max_deg: 60,
    scan_pattern: "RAR",
    azimuth_range_deg: [-75, 75],
    ...overrides,
  };
}

/** Apply an az_center override exactly like services/api.ts runLOSAnalysis (L413-418). */
export function withAzimuthOverride(radar: RadarConfig, center: number | undefined, width?: number): RadarConfig {
  if (center === undefined && width === undefined) return radar;
  return {
    ...radar,
    azimuth_range_deg: normalizeAzimuthRange(center ?? 0, width ?? radar.h_beam_width_deg),
    scan_pattern: "RAR",
  };
}

export function gridInput(g: OptimizerGrid, radar: RadarConfig, pos: { x: number; y: number; z: number }): LOSWorkerInput {
  const rows = g.grid.length;
  const cols = g.grid[0]!.length;
  return {
    grid: g.grid as number[][],
    bounds: {
      min_x: g.bounds.min_x,
      min_y: g.bounds.min_y,
      max_x: g.bounds.min_x + (cols - 1) * g.resolution,
      max_y: g.bounds.min_y + (rows - 1) * g.resolution,
    },
    resolution: g.resolution,
    radar_position: [pos.x, pos.y, pos.z],
    radar_config: radar,
  };
}

/** LosScorer over the real TS engine, applying azimuthCenterDeg like the app would. */
export function realScorer(radar: RadarConfig, log?: unknown[]): LosScorer {
  return (request) => {
    const cfg = withAzimuthOverride(radar, request.azimuthCenterDeg);
    const out = runLos(gridInput(request.grid, cfg, request.position));
    log?.push({ subject: request.subject, az: request.azimuthCenterDeg });
    const result: LosCellOutput = {
      cell_states: out.cell_states,
      flat_quality_grid: out.flat_quality_grid!,
      flat_projection_grid: out.flat_projection_grid!,
    };
    return result;
  };
}
