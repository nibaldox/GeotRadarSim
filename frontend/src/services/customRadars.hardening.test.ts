/**
 * Endurecimiento de perfiles personalizados (revisión adversarial, lente B):
 * B-1 texto Unicode, B-2 mutación del array crudo con tope duro, B-4 recorrido acotado y un aviso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RadarConfig } from "../types/api";
import {
  CUSTOM_RADARS_STORAGE_KEY,
  MAX_RAW_CUSTOM_RADAR_RECORDS,
  deleteCustomRadar,
  loadCustomRadars,
  saveCustomRadar,
  validateCustomRadarInput,
} from "./customRadars";
import type { CustomRadarInput } from "./customRadars";

const builtin = (model_id: string, display_name: string): RadarConfig => ({
  model_id,
  display_name,
  manufacturer: "Fabricante",
  min_range_m: 50,
  max_range_m: 2500,
  h_beam_width_deg: 360,
  v_beam_width_deg: 40,
  elevation_min_deg: -60,
  elevation_max_deg: 60,
  scan_pattern: "SAR360",
  azimuth_range_deg: null,
});

const builtins = [builtin("ibis-arcsar360", "IBIS-ArcSAR360")];

const valid: CustomRadarInput = {
  name: "Radar Norte",
  manufacturer: "Acme",
  minRangeM: 30,
  maxRangeM: 3000,
  elMinDeg: -20,
  elMaxDeg: 25,
  pattern: "SAR360",
  apertureDeg: 360,
};

const raw = (): Array<Record<string, unknown>> => JSON.parse(localStorage.getItem(CUSTOM_RADARS_STORAGE_KEY) ?? "[]");
const setRaw = (value: unknown) => localStorage.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify(value));
const record = (index: number, extra: Record<string, unknown> = {}) => ({ model_id: `custom-r-${index}`, ...valid, name: `R ${index}`, ...extra });
const warnSpy = () => vi.mocked(console.warn);

beforeEach(() => {
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(CUSTOM_RADARS_STORAGE_KEY);
});

describe("B-1 — texto Unicode en nombre y fabricante", () => {
  it.each([
    ["U+202E (override de dirección)", "Radar \u202E0005"],
    ["U+200B (espacio de ancho cero)", "Radar\u200BNorte"],
    ["BOM interior U+FEFF", "Ra\uFEFFdar"],
    ["U+2028 (separador de línea)", "Radar\u2028Norte"],
    ["U+2029 (separador de párrafo)", "Radar\u2029Norte"],
    ["C1 U+0085", "Radar\u0085Norte"],
  ])("rechaza en el nombre %s", (_label, name) => {
    const result = validateCustomRadarInput({ ...valid, name });
    expect(result).toEqual({ ok: false, error: "El nombre contiene caracteres no válidos." });
  });

  it.each([
    ["U+202E", "Acme\u202E"],
    ["U+200B", "Ac\u200Bme"],
    ["BOM interior", "Ac\uFEFFme"],
  ])("rechaza en el fabricante %s", (_label, manufacturer) => {
    const result = validateCustomRadarInput({ ...valid, manufacturer });
    expect(result).toEqual({ ok: false, error: "El fabricante contiene caracteres no válidos." });
  });

  it("exige al menos una letra o un dígito en el nombre y en un fabricante no vacío", () => {
    expect(validateCustomRadarInput({ ...valid, name: "--- · ---" })).toEqual({ ok: false, error: "El nombre debe incluir al menos una letra o un número." });
    expect(validateCustomRadarInput({ ...valid, manufacturer: "***" })).toEqual({ ok: false, error: "El fabricante debe incluir al menos una letra o un número." });
    expect(validateCustomRadarInput({ ...valid, manufacturer: "" }).ok).toBe(true);
    expect(validateCustomRadarInput({ ...valid, name: "Ñandú 7" }).ok).toBe(true);
  });

  it("normaliza a NFC: «Café» compuesto y descompuesto son el mismo nombre", () => {
    const composed = "Caf\u00e9";
    const decomposed = "Cafe\u0301";
    expect(composed).not.toBe(decomposed);

    const first = saveCustomRadar({ ...valid, name: decomposed, manufacturer: `Fábrica ${decomposed}` }, builtins);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.radar.display_name).toBe(composed);
    expect(first.radar.manufacturer).toBe(`Fábrica ${composed}`);
    expect(raw()[0]!.name).toBe(composed);

    expect(saveCustomRadar({ ...valid, name: composed }, builtins)).toEqual({ ok: false, error: "Ya existe un perfil con ese nombre." });
    expect(validateCustomRadarInput({ ...valid, name: decomposed }, [composed])).toEqual({ ok: false, error: "Ya existe un perfil con ese nombre." });
  });

  it("descarta al leer un registro guardado con U+202E", () => {
    setRaw([record(1, { name: "Radar \u202E0005" }), record(2)]);
    expect(loadCustomRadars(builtins).map((radar) => radar.model_id)).toEqual(["custom-r-2"]);
  });
});

describe("B-2 — guardar y borrar mutan el array crudo", () => {
  it("22 registros guardados: borrar 1 deja 21", () => {
    setRaw(Array.from({ length: 22 }, (_, index) => record(index)));
    expect(loadCustomRadars(builtins)).toHaveLength(20);
    expect(deleteCustomRadar("custom-r-0", builtins)).toEqual({ ok: true });
    const after = raw();
    expect(after).toHaveLength(21);
    expect(after.map((item) => item.model_id)).not.toContain("custom-r-0");
    expect(loadCustomRadars(builtins).map((radar) => radar.model_id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `custom-r-${index + 1}`),
    );
  });

  it("un registro desconocido (otra versión) sobrevive a un alta tal cual", () => {
    const future = { model_id: "custom-futuro-1", name: "Futuro", schema: 2, pattern: "MIMO", lobes: [1, 2] };
    setRaw([future, record(1)]);
    const saved = saveCustomRadar({ ...valid, name: "Nuevo" }, builtins);
    expect(saved.ok).toBe(true);
    const after = raw();
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual(future);
    expect(after[1]!.model_id).toBe("custom-r-1");
    expect(after[2]!.name).toBe("Nuevo");
  });

  it("no borra un personalizado cuyo nombre choca con un perfil incluido nuevo", () => {
    setRaw([{ ...record(1), name: "Nuevo Incluido" }, record(2)]);
    const newerBuiltins = [...builtins, builtin("nuevo-incluido", "Nuevo Incluido")];
    expect(loadCustomRadars(newerBuiltins).map((radar) => radar.model_id)).toEqual(["custom-r-2"]);

    expect(saveCustomRadar({ ...valid, name: "Otro" }, newerBuiltins).ok).toBe(true);
    expect(raw().map((item) => item.model_id)).toContain("custom-r-1");
    expect(deleteCustomRadar("custom-r-2", newerBuiltins)).toEqual({ ok: true });
    expect(raw().map((item) => item.model_id)).toContain("custom-r-1");
    // Con el catálogo anterior el perfil vuelve a aparecer intacto.
    expect(loadCustomRadars(builtins).map((radar) => radar.display_name)).toContain("Nuevo Incluido");
  });

  it("borrar quita todas las copias del id afectado y nada más", () => {
    setRaw([record(1), "texto", record(2), { ...record(1), name: "Copia" }]);
    expect(deleteCustomRadar("custom-r-1", builtins)).toEqual({ ok: true });
    expect(raw()).toEqual(["texto", record(2)]);
  });

  it(`tope duro de ${200} elementos crudos, con un solo aviso al recortar`, () => {
    expect(MAX_RAW_CUSTOM_RADAR_RECORDS).toBe(200);
    setRaw([record(1), ...Array.from({ length: 249 }, (_, index) => ({ junk: index }))]);
    const saved = saveCustomRadar({ ...valid, name: "Nuevo" }, builtins);
    expect(saved.ok).toBe(true);
    const after = raw();
    expect(after).toHaveLength(200);
    expect(after[0]!.model_id).toBe("custom-r-1");
    expect(after[after.length - 1]!.name).toBe("Nuevo");
    const trimWarnings = warnSpy().mock.calls.filter(([message]) => /recort/i.test(String(message)));
    expect(trimWarnings).toHaveLength(1);
    expect(loadCustomRadars(builtins).map((radar) => radar.display_name)).toEqual(["R 1", "Nuevo"]);
  });
});

describe("B-4 — lectura acotada y un solo aviso agregado", () => {
  it("varias entradas inválidas producen un único aviso por lectura", () => {
    setRaw([record(1, { maxRangeM: -1 }), null, "x", { model_id: "ibis-arcsar360" }, record(2), record(3, { pattern: "?" })]);
    expect(loadCustomRadars(builtins).map((radar) => radar.model_id)).toEqual(["custom-r-2"]);
    expect(warnSpy()).toHaveBeenCalledTimes(1);
  });

  it("solo recorre los primeros 200 elementos", () => {
    setRaw([...Array.from({ length: 250 }, (_, index) => ({ junk: index })), record(1)]);
    expect(loadCustomRadars(builtins)).toEqual([]);
    expect(warnSpy()).toHaveBeenCalledTimes(1);
  });

  it("un array enorme no genera más de un aviso ni tarda de más", () => {
    setRaw(Array.from({ length: 100_000 }, (_, index) => ({ model_id: `custom-x-${index}`, name: "" })));
    const started = performance.now();
    expect(loadCustomRadars(builtins)).toEqual([]);
    const elapsed = performance.now() - started;
    expect(warnSpy().mock.calls.length).toBeLessThanOrEqual(1);
    expect(elapsed).toBeLessThan(1000);
  });
});
