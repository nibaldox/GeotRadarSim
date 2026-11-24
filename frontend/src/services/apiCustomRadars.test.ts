/**
 * Resolución de perfiles personalizados en la API local: catálogo incluidos → personalizados,
 * `getRadar` y `runLOSAnalysis` con un id `custom-…`, y el error de siempre para ids inexistentes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelLOSAnalysis,
  generateSynthetic,
  getBuiltinRadars,
  getRadar,
  getRadarCatalog,
  listRadars,
  releaseTerrain,
  resolveRadar,
  runLOSAnalysis,
} from "./api";
import { clearLocalTerrainCache } from "./localDataStore";
import { CUSTOM_RADARS_STORAGE_KEY, deleteCustomRadar, saveCustomRadar } from "./customRadars";
import type { RadarConfig } from "../types/api";

class CapturingWorker {
  static instances: CapturingWorker[] = [];
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: ErrorEvent) => unknown) | null = null;
  postedMessages: unknown[] = [];
  constructor() { CapturingWorker.instances.push(this); }
  postMessage(message: unknown): void { this.postedMessages.push(message); }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
}

vi.stubGlobal("Worker", CapturingWorker);

const BUILTIN_IDS = ["groundprobe-ssr-fx", "ibis-arcsar360", "reutech-msr", "chcnav-ps-2000"];

const saveOrThrow = (input: Parameters<typeof saveCustomRadar>[0]): RadarConfig => {
  const result = saveCustomRadar(input, getBuiltinRadars());
  if (!result.ok) throw new Error(result.error);
  return result.radar;
};

const sector = {
  name: "Sector Sur",
  manufacturer: "",
  minRangeM: 20,
  maxRangeM: 1800,
  elMinDeg: -45,
  elMaxDeg: 40,
  pattern: "RAR" as const,
  apertureDeg: 100,
};

beforeEach(() => {
  CapturingWorker.instances = [];
  clearLocalTerrainCache();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

describe("catálogo con perfiles personalizados", () => {
  it("listRadars mantiene los incluidos primero, en su orden, y agrega los personalizados al final", async () => {
    const first = saveOrThrow(sector);
    const second = saveOrThrow({ ...sector, name: "Vigía 360", pattern: "SAR360" });
    const list = await listRadars();
    expect(list.map((radar) => radar.model_id)).toEqual([...BUILTIN_IDS, first.model_id, second.model_id]);
    expect(list[4]).toEqual(first);
    expect(getRadarCatalog()).toEqual(list);
    expect(getBuiltinRadars().map((radar) => radar.model_id)).toEqual(BUILTIN_IDS);
  });

  it("sin personalizados el catálogo es exactamente el incluido", async () => {
    expect((await listRadars()).map((radar) => radar.model_id)).toEqual(BUILTIN_IDS);
  });

  it("resolveRadar y getRadar encuentran un id custom-… y olvidan uno eliminado", async () => {
    const radar = saveOrThrow(sector);
    expect(resolveRadar(radar.model_id)).toEqual(radar);
    await expect(getRadar(radar.model_id)).resolves.toEqual(radar);
    expect(resolveRadar("ibis-arcsar360")?.display_name).toBe("IBIS-ArcSAR360");

    expect(deleteCustomRadar(radar.model_id, []).ok).toBe(true);
    expect(resolveRadar(radar.model_id)).toBeUndefined();
    await expect(getRadar(radar.model_id)).rejects.toThrow("No se encontró el radar.");
  });
});

describe("runLOSAnalysis con un perfil personalizado", () => {
  it("envía al Worker el radar_config derivado del perfil", async () => {
    const radar = saveOrThrow(sector);
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
    const job = await runLOSAnalysis({
      terrain_id: terrain.terrain_id,
      radar_position: { x: 10, y: 10, z: 5 },
      radar_model_id: radar.model_id,
    });
    expect(job.status).toBe("PENDING");
    const posted = CapturingWorker.instances[CapturingWorker.instances.length - 1]!.postedMessages[0] as { radar_config: RadarConfig };
    expect(posted.radar_config).toEqual({
      model_id: radar.model_id,
      display_name: "Sector Sur",
      manufacturer: "Perfil local",
      min_range_m: 20,
      max_range_m: 1800,
      h_beam_width_deg: 100,
      v_beam_width_deg: 30,
      elevation_min_deg: -45,
      elevation_max_deg: 40,
      scan_pattern: "RAR",
      azimuth_range_deg: [-50, 50],
    });
    cancelLOSAnalysis(job.job_id);
    releaseTerrain(terrain.terrain_id);
  });

  it("un id inexistente o eliminado sigue lanzando «No se encontró el modelo de radar»", async () => {
    const radar = saveOrThrow(sector);
    deleteCustomRadar(radar.model_id, []);
    const terrain = await generateSynthetic({ size_x: 20, size_y: 20, depth: 1, resolution: 1 });
    for (const id of [radar.model_id, "custom-nunca-existio-1"]) {
      await expect(runLOSAnalysis({
        terrain_id: terrain.terrain_id,
        radar_position: { x: 10, y: 10, z: 5 },
        radar_model_id: id,
      })).rejects.toThrow("No se encontró el modelo de radar.");
    }
    expect(CapturingWorker.instances).toHaveLength(0);
    releaseTerrain(terrain.terrain_id);
  });
});
