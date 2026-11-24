/**
 * Perfiles de radar personalizados, guardados en `localStorage` del navegador.
 *
 * Se persiste solo la ENTRADA del usuario (nombre y parámetros) junto con su `model_id`
 * generado; nunca un `RadarConfig`. En cada lectura la entrada se revalida y el config se
 * deriva de nuevo, así un registro manipulado no puede inyectar un azimut o un patrón de
 * escaneo incoherentes. `localStorage` es entrada no confiable: JSON corrupto, modo privado
 * o cuota llena nunca lanzan; las entradas inválidas se descartan una por una.
 *
 * Este módulo no conoce el catálogo incluido: quien lo llama pasa los perfiles incluidos
 * para comprobar la unicidad de nombre e id.
 */

import type { RadarConfig } from "../types/api";

export const CUSTOM_RADARS_STORAGE_KEY = "geotradar-custom-radars-v1";
export const MAX_CUSTOM_RADARS = 20;
export const CUSTOM_RADAR_DEFAULT_MANUFACTURER = "Perfil local";
export const CUSTOM_RADAR_V_BEAM_DEG = 30;
export const MAX_CUSTOM_RANGE_M = 100_000;
const MAX_TEXT_LENGTH = 40;
const MAX_SLUG_LENGTH = 20;
const CUSTOM_ID_PATTERN = /^custom-[a-z0-9-]{1,40}$/;
// Caracteres de control (incluye saltos de línea): no tienen cabida en una etiqueta de una línea.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export type CustomRadarPattern = "SAR360" | "RAR";

export interface CustomRadarInput {
  name: string;
  manufacturer: string;
  minRangeM: number;
  maxRangeM: number;
  elMinDeg: number;
  elMaxDeg: number;
  pattern: CustomRadarPattern;
  /** 1–359 solo cuando `pattern === "RAR"`; ignorado en `SAR360`. */
  apertureDeg: number;
}

/** Registro persistido: la entrada normalizada más su id generado. */
interface StoredCustomRadar extends CustomRadarInput {
  model_id: string;
}

export type CustomRadarValidation =
  | { ok: true; value: CustomRadarInput }
  | { ok: false; error: string };

export type CustomRadarSaveResult =
  | { ok: true; radar: RadarConfig }
  | { ok: false; error: string };

export type CustomRadarDeleteResult = { ok: true } | { ok: false; error: string };

export function isCustomRadarId(modelId: string): boolean {
  return CUSTOM_ID_PATTERN.test(modelId);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nameKey = (name: string): string => name.trim().toLocaleLowerCase("es");

/**
 * Valida la entrada según el contrato y devuelve una copia normalizada.
 * `takenNames` son los nombres de todos los demás perfiles (incluidos y personalizados).
 */
export function validateCustomRadarInput(raw: unknown, takenNames: readonly string[] = []): CustomRadarValidation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Datos del perfil no válidos." };
  const input = raw as Record<string, unknown>;

  if (typeof input.name !== "string") return { ok: false, error: "Escribe un nombre para el perfil." };
  const name = input.name.trim();
  if (name.length === 0) return { ok: false, error: "Escribe un nombre para el perfil." };
  if (name.length > MAX_TEXT_LENGTH) return { ok: false, error: `El nombre admite hasta ${MAX_TEXT_LENGTH} caracteres.` };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: "El nombre contiene caracteres no válidos." };
  const key = nameKey(name);
  if (takenNames.some((taken) => nameKey(taken) === key)) {
    return { ok: false, error: "Ya existe un perfil con ese nombre." };
  }

  const rawManufacturer = input.manufacturer ?? "";
  if (typeof rawManufacturer !== "string") return { ok: false, error: "El fabricante no es válido." };
  const manufacturer = rawManufacturer.trim();
  if (manufacturer.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `El fabricante admite hasta ${MAX_TEXT_LENGTH} caracteres.` };
  }
  if (CONTROL_CHARS.test(manufacturer)) return { ok: false, error: "El fabricante contiene caracteres no válidos." };

  const { minRangeM, maxRangeM, elMinDeg, elMaxDeg, pattern, apertureDeg } = input;
  if (!isFiniteNumber(minRangeM) || minRangeM < 0) {
    return { ok: false, error: "El rango mínimo debe ser un número mayor o igual a 0." };
  }
  if (!isFiniteNumber(maxRangeM) || maxRangeM <= minRangeM) {
    return { ok: false, error: "El rango máximo debe ser mayor que el mínimo." };
  }
  if (maxRangeM > MAX_CUSTOM_RANGE_M) {
    return { ok: false, error: `El rango máximo no puede superar ${MAX_CUSTOM_RANGE_M} m.` };
  }
  if (!isFiniteNumber(elMinDeg) || elMinDeg < -90 || elMinDeg > 90) {
    return { ok: false, error: "La elevación mínima debe estar entre −90° y 90°." };
  }
  if (!isFiniteNumber(elMaxDeg) || elMaxDeg <= elMinDeg || elMaxDeg > 90) {
    return { ok: false, error: "La elevación máxima debe ser mayor que la mínima y no superar 90°." };
  }
  if (pattern !== "SAR360" && pattern !== "RAR") {
    return { ok: false, error: "Elige la cobertura: 360° o sector." };
  }
  let aperture = 360;
  if (pattern === "RAR") {
    if (!isFiniteNumber(apertureDeg) || apertureDeg < 1 || apertureDeg > 359) {
      return { ok: false, error: "La apertura del sector debe estar entre 1° y 359°." };
    }
    aperture = apertureDeg;
  }

  return {
    ok: true,
    value: { name, manufacturer, minRangeM, maxRangeM, elMinDeg, elMaxDeg, pattern, apertureDeg: aperture },
  };
}

/** Deriva el `RadarConfig` de una entrada ya validada. */
export function deriveCustomRadarConfig(modelId: string, input: CustomRadarInput): RadarConfig {
  const sector = input.pattern === "RAR";
  const aperture = sector ? input.apertureDeg : 360;
  return {
    model_id: modelId,
    display_name: input.name,
    manufacturer: input.manufacturer || CUSTOM_RADAR_DEFAULT_MANUFACTURER,
    min_range_m: input.minRangeM,
    max_range_m: input.maxRangeM,
    h_beam_width_deg: aperture,
    v_beam_width_deg: CUSTOM_RADAR_V_BEAM_DEG,
    elevation_min_deg: input.elMinDeg,
    elevation_max_deg: input.elMaxDeg,
    scan_pattern: sector ? "RAR" : "SAR360",
    azimuth_range_deg: sector ? [-aperture / 2, aperture / 2] : null,
  };
}

/** Slug a-z0-9- (≤20) del nombre, con tildes transliteradas. */
export function slugifyRadarName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "radar";
}

const randomSuffix = (): string => {
  const value = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return value.slice(0, 6);
};

/** Genera un id `custom-<slug>-<sufijo>` que no colisiona con `takenIds`. */
export function generateCustomRadarId(name: string, takenIds: readonly string[]): string {
  const slug = slugifyRadarName(name);
  const taken = new Set(takenIds);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = `custom-${slug}-${randomSuffix()}`;
    if (CUSTOM_ID_PATTERN.test(candidate) && !taken.has(candidate)) return candidate;
  }
  // Imposible en la práctica (≤20 perfiles frente a 36^6 sufijos); se ensancha el sufijo.
  let counter = 0;
  for (;;) {
    const candidate = `custom-${slug}-${Date.now().toString(36)}${counter.toString(36)}`;
    if (!taken.has(candidate)) return candidate;
    counter++;
  }
}

const storage = (): Storage | null => {
  try {
    if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.getItem === "function") {
      return localStorage;
    }
  } catch {
    // El acceso a localStorage puede lanzar (p. ej. cookies bloqueadas).
  }
  return null;
};

/** Lee y revalida los registros guardados; nunca lanza. */
function readStoredRecords(builtins: readonly RadarConfig[]): StoredCustomRadar[] {
  const store = storage();
  if (!store) return [];
  let parsed: unknown;
  try {
    const text = store.getItem(CUSTOM_RADARS_STORAGE_KEY);
    if (text == null) return [];
    parsed = JSON.parse(text);
  } catch {
    console.warn("Perfiles de radar personalizados ilegibles; se ignoran.");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("Perfiles de radar personalizados con formato desconocido; se ignoran.");
    return [];
  }

  const takenIds = new Set(builtins.map((radar) => radar.model_id));
  const takenNames = builtins.map((radar) => radar.display_name);
  const records: StoredCustomRadar[] = [];
  for (const item of parsed) {
    if (records.length >= MAX_CUSTOM_RADARS) {
      console.warn(`Se ignoran perfiles personalizados por encima del tope de ${MAX_CUSTOM_RADARS}.`);
      break;
    }
    const modelId = item && typeof item === "object" ? (item as Record<string, unknown>).model_id : undefined;
    if (typeof modelId !== "string" || !CUSTOM_ID_PATTERN.test(modelId) || takenIds.has(modelId)) {
      console.warn("Se descarta un perfil personalizado con id no válido o repetido.");
      continue;
    }
    const validation = validateCustomRadarInput(item, takenNames);
    if (!validation.ok) {
      console.warn(`Se descarta un perfil personalizado no válido: ${validation.error}`);
      continue;
    }
    takenIds.add(modelId);
    takenNames.push(validation.value.name);
    records.push({ model_id: modelId, ...validation.value });
  }
  return records;
}

function writeStoredRecords(records: readonly StoredCustomRadar[]): string | null {
  const store = storage();
  if (!store) return "Este navegador no permite guardar perfiles.";
  try {
    const payload = records.map((record) => ({
      model_id: record.model_id,
      name: record.name,
      manufacturer: record.manufacturer,
      minRangeM: record.minRangeM,
      maxRangeM: record.maxRangeM,
      elMinDeg: record.elMinDeg,
      elMaxDeg: record.elMaxDeg,
      pattern: record.pattern,
      apertureDeg: record.apertureDeg,
    }));
    store.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify(payload));
    return null;
  } catch {
    return "No se pudo guardar en este navegador (almacenamiento lleno o bloqueado).";
  }
}

/** Perfiles personalizados válidos, derivados de nuevo en cada lectura. */
export function loadCustomRadars(builtins: readonly RadarConfig[]): RadarConfig[] {
  return readStoredRecords(builtins).map((record) => deriveCustomRadarConfig(record.model_id, record));
}

/** Valida y guarda un perfil nuevo. Los errores se devuelven como valor. */
export function saveCustomRadar(input: unknown, builtins: readonly RadarConfig[]): CustomRadarSaveResult {
  const records = readStoredRecords(builtins);
  if (records.length >= MAX_CUSTOM_RADARS) {
    return { ok: false, error: `Se alcanzó el tope de ${MAX_CUSTOM_RADARS} perfiles personalizados.` };
  }
  const takenNames = [...builtins.map((radar) => radar.display_name), ...records.map((record) => record.name)];
  const validation = validateCustomRadarInput(input, takenNames);
  if (!validation.ok) return validation;
  const modelId = generateCustomRadarId(validation.value.name, [
    ...builtins.map((radar) => radar.model_id),
    ...records.map((record) => record.model_id),
  ]);
  const record: StoredCustomRadar = { model_id: modelId, ...validation.value };
  const error = writeStoredRecords([...records, record]);
  if (error) return { ok: false, error };
  return { ok: true, radar: deriveCustomRadarConfig(modelId, validation.value) };
}

/** Elimina un perfil personalizado por id. */
export function deleteCustomRadar(modelId: string, builtins: readonly RadarConfig[]): CustomRadarDeleteResult {
  if (!isCustomRadarId(modelId)) return { ok: false, error: "Solo se pueden eliminar perfiles personalizados." };
  const records = readStoredRecords(builtins);
  if (!records.some((record) => record.model_id === modelId)) {
    return { ok: false, error: "No se encontró el perfil personalizado." };
  }
  const error = writeStoredRecords(records.filter((record) => record.model_id !== modelId));
  if (error) return { ok: false, error };
  return { ok: true };
}
