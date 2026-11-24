/**
 * Perfiles de radar personalizados: validación del contrato, derivación del RadarConfig,
 * persistencia robusta en localStorage y unicidad del id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RadarConfig } from "../types/api";
import {
  CUSTOM_RADARS_STORAGE_KEY,
  MAX_CUSTOM_RADARS,
  deleteCustomRadar,
  deriveCustomRadarConfig,
  generateCustomRadarId,
  isCustomRadarId,
  loadCustomRadars,
  saveCustomRadar,
  slugifyRadarName,
  validateCustomRadarInput,
} from "./customRadars";
import type { CustomRadarInput } from "./customRadars";

const builtins: RadarConfig[] = [
  {
    model_id: "ibis-arcsar360",
    display_name: "IBIS-ArcSAR360",
    manufacturer: "IDS GeoRadar",
    min_range_m: 50,
    max_range_m: 2500,
    h_beam_width_deg: 360,
    v_beam_width_deg: 40,
    elevation_min_deg: -60,
    elevation_max_deg: 60,
    scan_pattern: "SAR360",
    azimuth_range_deg: null,
  },
];

const valid: CustomRadarInput = {
  name: "Radar Norte",
  manufacturer: "Acme",
  minRangeM: 30,
  maxRangeM: 3000,
  elMinDeg: -20,
  elMaxDeg: 25,
  pattern: "RAR",
  apertureDeg: 90,
};

// jsdom's Storage turns own-property writes into items, so spy on the prototype when it exists.
const storageTarget = (): Storage =>
  typeof Storage !== "undefined" && localStorage instanceof Storage ? Storage.prototype : localStorage;

const stored = (): unknown => JSON.parse(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

describe("validateCustomRadarInput", () => {
  it("acepta una entrada válida y normaliza nombre y fabricante", () => {
    const result = validateCustomRadarInput({ ...valid, name: "  Radar Norte  ", manufacturer: " Acme " });
    expect(result).toEqual({ ok: true, value: { ...valid } });
  });

  it.each<[string, Partial<Record<keyof CustomRadarInput, unknown>>, RegExp]>([
    ["nombre vacío", { name: "   " }, /nombre/],
    ["nombre de 41 caracteres", { name: "x".repeat(41) }, /40 caracteres/],
    ["nombre no texto", { name: 7 }, /nombre/],
    ["nombre con salto de línea", { name: "Radar\nNorte" }, /caracteres no válidos/],
    ["fabricante de 41 caracteres", { manufacturer: "y".repeat(41) }, /40 caracteres/],
    ["rango mínimo negativo", { minRangeM: -1 }, /rango mínimo/],
    ["rango mínimo NaN", { minRangeM: Number.NaN }, /rango mínimo/],
    ["rango mínimo en texto", { minRangeM: "10" }, /rango mínimo/],
    ["rango máximo igual al mínimo", { minRangeM: 100, maxRangeM: 100 }, /rango máximo/],
    ["rango máximo menor", { minRangeM: 100, maxRangeM: 50 }, /rango máximo/],
    ["rango máximo infinito", { maxRangeM: Number.POSITIVE_INFINITY }, /rango máximo/],
    ["rango máximo sobre 100 km", { maxRangeM: 100_001 }, /100000/],
    ["elevación mínima bajo −90", { elMinDeg: -91 }, /elevación mínima/],
    ["elevación máxima sobre 90", { elMaxDeg: 91 }, /elevación máxima/],
    ["elevación desordenada", { elMinDeg: 10, elMaxDeg: 10 }, /elevación máxima/],
    ["patrón desconocido", { pattern: "MIMO" }, /cobertura/],
    ["apertura 0", { apertureDeg: 0 }, /1° y 359°/],
    ["apertura 360 en sector", { apertureDeg: 360 }, /1° y 359°/],
    ["apertura no numérica", { apertureDeg: "90" }, /1° y 359°/],
  ])("rechaza %s", (_label, patch, message) => {
    const result = validateCustomRadarInput({ ...valid, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it("admite los bordes del contrato", () => {
    expect(validateCustomRadarInput({ ...valid, name: "x".repeat(40), minRangeM: 0, maxRangeM: 100_000, elMinDeg: -90, elMaxDeg: 90, apertureDeg: 1 }).ok).toBe(true);
    expect(validateCustomRadarInput({ ...valid, apertureDeg: 359 }).ok).toBe(true);
    expect(validateCustomRadarInput({ ...valid, manufacturer: "" }).ok).toBe(true);
  });

  it("ignora la apertura en 360°", () => {
    const result = validateCustomRadarInput({ ...valid, pattern: "SAR360", apertureDeg: Number.NaN });
    expect(result).toEqual({ ok: true, value: { ...valid, pattern: "SAR360", apertureDeg: 360 } });
  });

  it("rechaza un nombre duplicado sin distinguir mayúsculas", () => {
    const result = validateCustomRadarInput({ ...valid, name: "ibis-arcsar360" }, ["IBIS-ArcSAR360"]);
    expect(result).toEqual({ ok: false, error: "Ya existe un perfil con ese nombre." });
  });
});

describe("deriveCustomRadarConfig", () => {
  it("sector → RAR con [−a/2, +a/2] y haz igual a la apertura", () => {
    expect(deriveCustomRadarConfig("custom-radar-norte-abc123", valid)).toEqual({
      model_id: "custom-radar-norte-abc123",
      display_name: "Radar Norte",
      manufacturer: "Acme",
      min_range_m: 30,
      max_range_m: 3000,
      h_beam_width_deg: 90,
      v_beam_width_deg: 30,
      elevation_min_deg: -20,
      elevation_max_deg: 25,
      scan_pattern: "RAR",
      azimuth_range_deg: [-45, 45],
    });
  });

  it("360° → SAR360 con azimuth_range_deg null y fabricante por defecto", () => {
    const config = deriveCustomRadarConfig("custom-x-1", { ...valid, manufacturer: "", pattern: "SAR360", apertureDeg: 90 });
    expect(config.scan_pattern).toBe("SAR360");
    expect(config.azimuth_range_deg).toBeNull();
    expect(config.h_beam_width_deg).toBe(360);
    expect(config.manufacturer).toBe("Perfil local");
  });
});

describe("model_id", () => {
  it("translitera el nombre a un slug a-z0-9- de hasta 20 caracteres", () => {
    expect(slugifyRadarName("Ñandú Élite — Sur 2")).toBe("nandu-elite-sur-2");
    expect(slugifyRadarName("<script>alert(1)</script>")).toBe("script-alert-1-scrip");
    expect(slugifyRadarName("abcdefghij klmnopqrst uvw").length).toBeLessThanOrEqual(20);
    expect(slugifyRadarName("!!!")).toBe("radar");
  });

  it("cumple el patrón custom- y no colisiona con ids tomados", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(0.5);
    const first = generateCustomRadarId("Radar", []);
    const second = generateCustomRadarId("Radar", [first]);
    expect(first).toMatch(/^custom-[a-z0-9-]{1,40}$/);
    expect(second).toMatch(/^custom-[a-z0-9-]{1,40}$/);
    expect(second).not.toBe(first);
    expect(randomSpy).toHaveBeenCalledTimes(3);
    expect(isCustomRadarId(first)).toBe(true);
    expect(isCustomRadarId("ibis-arcsar360")).toBe(false);
  });

  it("genera ids únicos al guardar perfiles de nombres parecidos", () => {
    const ids = ["Radar A", "Radar-A ", "radar a!"].map((name, index) => {
      const result = saveCustomRadar({ ...valid, name: `${name}${index}` }, builtins);
      expect(result.ok).toBe(true);
      return result.ok ? result.radar.model_id : "";
    });
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(id).toMatch(/^custom-[a-z0-9-]{1,40}$/));
  });
});

describe("persistencia", () => {
  it("round-trip: guarda la entrada (no el config) y la vuelve a derivar al leer", () => {
    const saved = saveCustomRadar(valid, builtins);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const raw = stored() as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(1);
    expect(Object.keys(raw[0]!).sort()).toEqual(
      ["apertureDeg", "elMaxDeg", "elMinDeg", "manufacturer", "maxRangeM", "minRangeM", "model_id", "name", "pattern"],
    );
    expect(raw[0]).not.toHaveProperty("scan_pattern");
    expect(raw[0]).not.toHaveProperty("azimuth_range_deg");
    expect(loadCustomRadars(builtins)).toEqual([saved.radar]);
  });

  it("sin datos o con JSON corrupto arranca vacío sin lanzar", () => {
    expect(loadCustomRadars(builtins)).toEqual([]);
    localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, "{no es json");
    expect(() => loadCustomRadars(builtins)).not.toThrow();
    expect(loadCustomRadars(builtins)).toEqual([]);
    localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify({ model_id: "custom-a-1" }));
    expect(loadCustomRadars(builtins)).toEqual([]);
  });

  it("si getItem lanza (modo privado) devuelve vacío", () => {
    expect(saveCustomRadar(valid, builtins).ok).toBe(true);
    expect(loadCustomRadars(builtins)).toHaveLength(1);
    vi.spyOn(storageTarget(), "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    expect(() => loadCustomRadars(builtins)).not.toThrow();
    expect(loadCustomRadars(builtins)).toEqual([]);
  });

  it("cuota agotada: devuelve el error y no deja nada guardado", () => {
    vi.spyOn(storageTarget(), "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const result = saveCustomRadar(valid, builtins);
    expect(result).toEqual({ ok: false, error: "No se pudo guardar en este navegador (almacenamiento lleno o bloqueado)." });
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toBeNull();
  });

  it("descarta entradas inválidas una por una sin perder las válidas", () => {
    localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify([
      { model_id: "custom-bueno-1", ...valid },
      { model_id: "custom-malo-1", ...valid, name: "Malo", maxRangeM: -5 },
      null,
      "texto",
      { model_id: "ibis-arcsar360", ...valid, name: "Suplanta id" },
      { model_id: "custom-ibis-1", ...valid, name: "IBIS-ArcSAR360" },
      { model_id: "custom-bueno-1", ...valid, name: "Id repetido" },
      { model_id: "custom-duplicado-1", ...valid, name: "RADAR NORTE" },
      { model_id: "custom-<b>x</b>", ...valid, name: "Id con HTML" },
      { model_id: "custom-otro-1", ...valid, name: "Otro", pattern: "SAR360" },
    ]));
    const radars = loadCustomRadars(builtins);
    expect(radars.map((radar) => radar.model_id)).toEqual(["custom-bueno-1", "custom-otro-1"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("una entrada manipulada no puede alterar el config derivado", () => {
    localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify([{
      model_id: "custom-trampa-1",
      ...valid,
      pattern: "SAR360",
      apertureDeg: 45,
      scan_pattern: "RAR",
      azimuth_range_deg: [10, 20],
      h_beam_width_deg: 5,
      v_beam_width_deg: 99,
      display_name: "Otro nombre",
    }, {
      model_id: "custom-sector-1",
      ...valid,
      name: "Sector",
      apertureDeg: 120,
      azimuth_range_deg: [0, 360],
    }]));
    const [full, sector] = loadCustomRadars(builtins);
    expect(full).toMatchObject({ scan_pattern: "SAR360", azimuth_range_deg: null, h_beam_width_deg: 360, v_beam_width_deg: 30, display_name: "Radar Norte" });
    expect(sector).toMatchObject({ scan_pattern: "RAR", azimuth_range_deg: [-60, 60], h_beam_width_deg: 120 });
  });

  it(`aplica el tope de ${MAX_CUSTOM_RADARS} perfiles`, () => {
    for (let index = 0; index < MAX_CUSTOM_RADARS; index++) {
      expect(saveCustomRadar({ ...valid, name: `Radar ${index}` }, builtins).ok).toBe(true);
    }
    const before = localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY);
    expect(saveCustomRadar({ ...valid, name: "Uno más" }, builtins)).toEqual({ ok: false, error: `Se alcanzó el tope de ${MAX_CUSTOM_RADARS} perfiles personalizados.` });
    expect(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY)).toBe(before);
    // Una lista manipulada más larga que el tope solo entrega los primeros 20.
    const records = Array.from({ length: MAX_CUSTOM_RADARS + 5 }, (_, index) => ({ model_id: `custom-r-${index}`, ...valid, name: `R ${index}` }));
    localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify(records));
    expect(loadCustomRadars(builtins)).toHaveLength(MAX_CUSTOM_RADARS);
  });

  it("rechaza al guardar un nombre que ya usa un perfil incluido o personalizado", () => {
    expect(saveCustomRadar({ ...valid, name: "ibis-ARCSAR360" }, builtins)).toEqual({ ok: false, error: "Ya existe un perfil con ese nombre." });
    expect(saveCustomRadar(valid, builtins).ok).toBe(true);
    expect(saveCustomRadar({ ...valid, name: "radar norte" }, builtins)).toEqual({ ok: false, error: "Ya existe un perfil con ese nombre." });
  });

  it("elimina por id y no toca perfiles incluidos ni ids desconocidos", () => {
    const first = saveCustomRadar(valid, builtins);
    const second = saveCustomRadar({ ...valid, name: "Segundo" }, builtins);
    if (!first.ok || !second.ok) throw new Error("setup");
    expect(deleteCustomRadar("ibis-arcsar360", builtins)).toEqual({ ok: false, error: "Solo se pueden eliminar perfiles personalizados." });
    expect(deleteCustomRadar("custom-no-existe-1", builtins)).toEqual({ ok: false, error: "No se encontró el perfil personalizado." });
    expect(deleteCustomRadar(first.radar.model_id, builtins)).toEqual({ ok: true });
    expect(loadCustomRadars(builtins).map((radar) => radar.model_id)).toEqual([second.radar.model_id]);
  });
});
