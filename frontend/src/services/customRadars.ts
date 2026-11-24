/**
 * Perfiles de radar personalizados, guardados en `localStorage` del navegador.
 *
 * Se persiste solo la ENTRADA del usuario (nombre y parámetros) junto con su `model_id`
 * generado; nunca un `RadarConfig`. En cada lectura la entrada se revalida y el config se
 * deriva de nuevo, así un registro manipulado no puede inyectar un azimut o un patrón de
 * escaneo incoherentes. `localStorage` es entrada no confiable: JSON corrupto, modo privado
 * o cuota llena nunca lanzan; las entradas inválidas se descartan una por una al leer, pero
 * guardar y borrar mutan el array crudo (añadir uno, quitar un id) sin perder lo que hoy no valida.
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
/** Hard cap on the raw stored array: reads stop here and writes trim to it. */
export const MAX_RAW_CUSTOM_RADAR_RECORDS = 200;
export const CUSTOM_RADAR_NOT_FOUND_ERROR = "No se encontró el perfil personalizado.";
const MAX_TEXT_LENGTH = 40;
const MAX_SLUG_LENGTH = 20;
const CUSTOM_ID_PATTERN = /^custom-[a-z0-9-]{1,40}$/;
// Controles (Cc), formato invisible (Cf: U+200B, U+202E, BOM…) y separadores de línea/párrafo:
// no tienen cabida en una etiqueta de una línea y pueden falsear lo que se ve (U+202E invierte cifras).
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

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

/** NFC + trim: «Café» compuesto y descompuesto quedan iguales antes de validar o comparar. */
const normalizeText = (text: string): string => text.normalize("NFC").trim();

const nameKey = (name: string): string => normalizeText(name).toLocaleLowerCase("es");

/**
 * Valida la entrada según el contrato y devuelve una copia normalizada.
 * `takenNames` son los nombres de todos los demás perfiles (incluidos y personalizados).
 */
export function validateCustomRadarInput(raw: unknown, takenNames: readonly string[] = []): CustomRadarValidation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Datos del perfil no válidos." };
  const input = raw as Record<string, unknown>;

  if (typeof input.name !== "string") return { ok: false, error: "Escribe un nombre para el perfil." };
  const name = normalizeText(input.name);
  if (name.length === 0) return { ok: false, error: "Escribe un nombre para el perfil." };
  if (name.length > MAX_TEXT_LENGTH) return { ok: false, error: `El nombre admite hasta ${MAX_TEXT_LENGTH} caracteres.` };
  if (FORBIDDEN_CHARS.test(name)) return { ok: false, error: "El nombre contiene caracteres no válidos." };
  if (!LETTER_OR_DIGIT.test(name)) return { ok: false, error: "El nombre debe incluir al menos una letra o un número." };
  const key = nameKey(name);
  if (takenNames.some((taken) => nameKey(taken) === key)) {
    return { ok: false, error: "Ya existe un perfil con ese nombre." };
  }

  const rawManufacturer = input.manufacturer ?? "";
  if (typeof rawManufacturer !== "string") return { ok: false, error: "El fabricante no es válido." };
  const manufacturer = normalizeText(rawManufacturer);
  if (manufacturer.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `El fabricante admite hasta ${MAX_TEXT_LENGTH} caracteres.` };
  }
  if (FORBIDDEN_CHARS.test(manufacturer)) return { ok: false, error: "El fabricante contiene caracteres no válidos." };
  if (manufacturer.length > 0 && !LETTER_OR_DIGIT.test(manufacturer)) {
    return { ok: false, error: "El fabricante debe incluir al menos una letra o un número." };
  }

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

type RawRead = { ok: true; items: unknown[] } | { ok: false };

/** Array crudo guardado tal cual (sin validar); `ok: false` si no se pudo leer. Nunca lanza. */
function readRawItems(): RawRead {
  const store = storage();
  if (!store) return { ok: false };
  try {
    const text = store.getItem(CUSTOM_RADARS_STORAGE_KEY);
    if (text == null) return { ok: true, items: [] };
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.warn("Perfiles de radar personalizados con formato desconocido; se ignoran.");
      return { ok: true, items: [] };
    }
    return { ok: true, items: parsed };
  } catch {
    console.warn("Perfiles de radar personalizados ilegibles; se ignoran.");
    return { ok: true, items: [] };
  }
}

const rawModelId = (item: unknown): unknown =>
  item && typeof item === "object" ? (item as Record<string, unknown>).model_id : undefined;

/**
 * Revalida como mucho los primeros `MAX_RAW_CUSTOM_RADAR_RECORDS` elementos y entrega hasta
 * `MAX_CUSTOM_RADARS` válidos. Lo descartado se informa en un único aviso por lectura.
 */
function validRecords(items: readonly unknown[], builtins: readonly RadarConfig[]): StoredCustomRadar[] {
  const takenIds = new Set(builtins.map((radar) => radar.model_id));
  const takenNames = builtins.map((radar) => radar.display_name);
  const records: StoredCustomRadar[] = [];
  const limit = Math.min(items.length, MAX_RAW_CUSTOM_RADAR_RECORDS);
  let discarded = 0;
  let overCap = 0;
  for (let index = 0; index < limit; index++) {
    const item = items[index];
    const modelId = rawModelId(item);
    if (typeof modelId !== "string" || !CUSTOM_ID_PATTERN.test(modelId) || takenIds.has(modelId)) {
      discarded++;
      continue;
    }
    const validation = validateCustomRadarInput(item, takenNames);
    if (!validation.ok) {
      discarded++;
      continue;
    }
    if (records.length >= MAX_CUSTOM_RADARS) {
      overCap++;
      continue;
    }
    takenIds.add(modelId);
    takenNames.push(validation.value.name);
    records.push({ model_id: modelId, ...validation.value });
  }
  const unread = items.length - limit;
  if (discarded > 0 || overCap > 0 || unread > 0) {
    const parts: string[] = [];
    if (discarded > 0) parts.push(`${discarded} no válidos o repetidos`);
    if (overCap > 0) parts.push(`${overCap} por encima del tope de ${MAX_CUSTOM_RADARS}`);
    if (unread > 0) parts.push(`${unread} más allá de los primeros ${MAX_RAW_CUSTOM_RADAR_RECORDS} elementos`);
    console.warn(`Perfiles de radar personalizados ignorados: ${parts.join(", ")}.`);
  }
  return records;
}

/** Lee y revalida los registros guardados; nunca lanza. */
function readStoredRecords(builtins: readonly RadarConfig[]): StoredCustomRadar[] {
  const raw = readRawItems();
  return raw.ok ? validRecords(raw.items, builtins) : [];
}

const serializeRecord = (record: StoredCustomRadar) => ({
  model_id: record.model_id,
  name: record.name,
  manufacturer: record.manufacturer,
  minRangeM: record.minRangeM,
  maxRangeM: record.maxRangeM,
  elMinDeg: record.elMinDeg,
  elMaxDeg: record.elMaxDeg,
  pattern: record.pattern,
  apertureDeg: record.apertureDeg,
});

/**
 * Recorta el array crudo al tope duro quitando desde el final elementos que no sean perfiles
 * vigentes (`keepIds`); un solo aviso si recorta.
 */
function trimRawItems(items: unknown[], limit: number, keepIds: ReadonlySet<string>): unknown[] {
  if (items.length <= limit) return items;
  const trimmed = [...items];
  for (let index = trimmed.length - 1; index >= 0 && trimmed.length > limit; index--) {
    const modelId = rawModelId(trimmed[index]);
    if (typeof modelId === "string" && keepIds.has(modelId)) continue;
    trimmed.splice(index, 1);
  }
  console.warn(`Se recortó la lista de perfiles personalizados a ${limit} elementos.`);
  return trimmed;
}

function writeRawItems(items: readonly unknown[]): string | null {
  const store = storage();
  if (!store) return "Este navegador no permite guardar perfiles.";
  try {
    store.setItem(CUSTOM_RADARS_STORAGE_KEY, JSON.stringify(items));
    return null;
  } catch {
    return "No se pudo guardar en este navegador (almacenamiento lleno o bloqueado).";
  }
}

/** Perfiles personalizados válidos, derivados de nuevo en cada lectura. */
export function loadCustomRadars(builtins: readonly RadarConfig[]): RadarConfig[] {
  return readStoredRecords(builtins).map((record) => deriveCustomRadarConfig(record.model_id, record));
}

/**
 * Valida y guarda un perfil nuevo. Los errores se devuelven como valor. Solo AÑADE al array
 * crudo: los registros que hoy no validan (otra versión, otra pestaña, por encima del tope o en
 * conflicto con un perfil incluido nuevo) se conservan tal cual.
 */
export function saveCustomRadar(input: unknown, builtins: readonly RadarConfig[]): CustomRadarSaveResult {
  const raw = readRawItems();
  if (!raw.ok) return { ok: false, error: "Este navegador no permite guardar perfiles." };
  const records = validRecords(raw.items, builtins);
  if (records.length >= MAX_CUSTOM_RADARS) {
    return { ok: false, error: `Se alcanzó el tope de ${MAX_CUSTOM_RADARS} perfiles personalizados.` };
  }
  const takenNames = [...builtins.map((radar) => radar.display_name), ...records.map((record) => record.name)];
  const validation = validateCustomRadarInput(input, takenNames);
  if (!validation.ok) return validation;
  const rawIds = raw.items.map(rawModelId).filter((id): id is string => typeof id === "string");
  const modelId = generateCustomRadarId(validation.value.name, [
    ...builtins.map((radar) => radar.model_id),
    ...rawIds,
  ]);
  const record: StoredCustomRadar = { model_id: modelId, ...validation.value };
  const keepIds = new Set(records.map((item) => item.model_id));
  const base = trimRawItems(raw.items, MAX_RAW_CUSTOM_RADAR_RECORDS - 1, keepIds);
  const error = writeRawItems([...base, serializeRecord(record)]);
  if (error) return { ok: false, error };
  return { ok: true, radar: deriveCustomRadarConfig(modelId, validation.value) };
}

/** Elimina un perfil personalizado por id: quita del array crudo solo los elementos con ese id. */
export function deleteCustomRadar(modelId: string, builtins: readonly RadarConfig[]): CustomRadarDeleteResult {
  if (!isCustomRadarId(modelId)) return { ok: false, error: "Solo se pueden eliminar perfiles personalizados." };
  const raw = readRawItems();
  if (!raw.ok || !raw.items.some((item) => rawModelId(item) === modelId)) {
    return { ok: false, error: CUSTOM_RADAR_NOT_FOUND_ERROR };
  }
  const remaining = raw.items.filter((item) => rawModelId(item) !== modelId);
  const keepIds = remaining.length > MAX_RAW_CUSTOM_RADAR_RECORDS
    ? new Set(validRecords(remaining, builtins).map((item) => item.model_id))
    : new Set<string>();
  const error = writeRawItems(trimRawItems(remaining, MAX_RAW_CUSTOM_RADAR_RECORDS, keepIds));
  if (error) return { ok: false, error };
  return { ok: true };
}
