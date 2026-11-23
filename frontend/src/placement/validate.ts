/**
 * Hand-written validator for the JSON Schema subset of the W0a catalog
 * (`herramientas.schema.json`); «Sugerir ubicación» validates its arguments with it.
 *
 * It interprets the schema at run time and NEVER generates code: no `eval`,
 * no `new Function`, no dynamic `import()`. This keeps it compatible with the
 * app CSP (`script-src 'self' 'wasm-unsafe-eval'`), unlike Ajv's default mode.
 *
 * Supported keywords: type (string or array), enum, const, minimum, maximum,
 * exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern,
 * properties, required, additionalProperties (boolean or schema), items
 * (single schema), minItems, maxItems, uniqueItems, anyOf, oneOf, plus the
 * annotations description, default, title and $comment. Any other keyword is
 * rejected by `assertSupportedSchema`, so a tool cannot register a schema that
 * this validator would silently ignore.
 */

export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  description?: string;
  default?: unknown;
  title?: string;
  $comment?: string;
}

export interface ValidationIssue {
  /** JSON pointer of the offending value, e.g. `/x_m`. Root is `""`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; issues: ValidationIssue[]; summary: string };

export const MAX_ARGUMENT_CHARS = 16_384;
export const MAX_DEPTH = 32;
export const MAX_ISSUES = 10;

const TYPES: readonly JsonSchemaType[] = ["string", "number", "integer", "boolean", "object", "array", "null"];
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ANNOTATIONS = new Set(["description", "default", "title", "$comment"]);
const KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "oneOf",
  ...ANNOTATIONS,
]);

const patternCache = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    // RegExp construction is data, not code generation; allowed under CSP.
    re = new RegExp(pattern, "u");
    patternCache.set(pattern, re);
  }
  return re;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface SchemaCheckOptions {
  /** Tool parameter roots must be closed objects (`additionalProperties: false`). */
  requireClosedRoot?: boolean;
}

/** Throws when the schema uses anything this validator does not implement. */
export function assertSupportedSchema(schema: JsonSchema, options: SchemaCheckOptions = {}): void {
  if (options.requireClosedRoot) {
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      throw new Error("El esquema raíz de una herramienta debe ser type:object con additionalProperties:false");
    }
  }
  checkSchemaNode(schema, "#", 0);
}

function checkSchemaNode(node: unknown, at: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`${at}: esquema demasiado profundo`);
  if (!isPlainObject(node)) throw new Error(`${at}: el esquema debe ser un objeto`);
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) throw new Error(`${at}: palabra clave no soportada «${key}»`);
  }
  const s = node as JsonSchema;
  if (s.type !== undefined) {
    const list = Array.isArray(s.type) ? s.type : [s.type];
    if (list.length === 0 || list.some((t) => !TYPES.includes(t as JsonSchemaType))) {
      throw new Error(`${at}: type inválido`);
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (s[key] !== undefined && !isFiniteNumber(s[key])) throw new Error(`${at}: ${key} debe ser un número finito`);
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (s[key] !== undefined && !isNonNegativeInteger(s[key])) throw new Error(`${at}: ${key} debe ser entero ≥ 0`);
  }
  if (s.uniqueItems !== undefined && typeof s.uniqueItems !== "boolean") throw new Error(`${at}: uniqueItems`);
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string") throw new Error(`${at}: pattern debe ser texto`);
    try {
      compilePattern(s.pattern);
    } catch {
      throw new Error(`${at}: pattern inválido`);
    }
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) {
    throw new Error(`${at}: enum debe ser una lista no vacía`);
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string")) {
      throw new Error(`${at}: required debe ser una lista de textos`);
    }
  }
  if (s.properties !== undefined) {
    if (!isPlainObject(s.properties)) throw new Error(`${at}: properties debe ser un objeto`);
    for (const [name, child] of Object.entries(s.properties)) {
      if (FORBIDDEN_KEYS.has(name)) throw new Error(`${at}: nombre de propiedad prohibido «${name}»`);
      checkSchemaNode(child, `${at}/properties/${name}`, depth + 1);
    }
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
    checkSchemaNode(s.additionalProperties, `${at}/additionalProperties`, depth + 1);
  }
  if (s.items !== undefined) checkSchemaNode(s.items, `${at}/items`, depth + 1);
  for (const key of ["anyOf", "oneOf"] as const) {
    const list = s[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${at}: ${key} debe ser una lista no vacía`);
    list.forEach((child, i) => checkSchemaNode(child, `${at}/${key}/${i}`, depth + 1));
  }
}

function typeOf(value: unknown): JsonSchemaType | "other" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isFinite(value) ? "number" : "other";
    case "object":
      return isPlainObject(value) ? "object" : "other";
    default:
      return "other";
  }
}

function matchesType(value: unknown, t: JsonSchemaType): boolean {
  const actual = typeOf(value);
  if (t === "integer") return actual === "number" && Number.isInteger(value);
  return actual === t;
}

/** Structural equality for JSON values (enum/const/uniqueItems). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

interface Walk {
  issues: ValidationIssue[];
}

function pushIssue(walk: Walk, path: string, message: string): void {
  if (walk.issues.length < MAX_ISSUES) walk.issues.push({ path, message });
}

function fmt(n: number): string {
  return String(n);
}

function validateNode(schema: JsonSchema, value: unknown, path: string, depth: number, walk: Walk): void {
  if (depth > MAX_DEPTH) {
    pushIssue(walk, path, "anidamiento demasiado profundo");
    return;
  }

  if (schema.type !== undefined) {
    const list = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!list.some((t) => matchesType(value, t))) {
      pushIssue(walk, path, `debe ser ${list.join(" o ")}`);
      return;
    }
  } else if (typeOf(value) === "other") {
    pushIssue(walk, path, "valor no JSON");
    return;
  }

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    pushIssue(walk, path, `debe ser ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => jsonEqual(option, value))) {
    const shown = schema.enum.slice(0, 8).map((o) => JSON.stringify(o)).join(", ");
    pushIssue(walk, path, `debe ser uno de: ${shown}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) pushIssue(walk, path, `debe ser ≥ ${fmt(schema.minimum)}`);
    if (schema.maximum !== undefined && value > schema.maximum) pushIssue(walk, path, `debe ser ≤ ${fmt(schema.maximum)}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      pushIssue(walk, path, `debe ser > ${fmt(schema.exclusiveMinimum)}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      pushIssue(walk, path, `debe ser < ${fmt(schema.exclusiveMaximum)}`);
    }
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      pushIssue(walk, path, `debe tener al menos ${schema.minLength} caracteres`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      pushIssue(walk, path, `debe tener como máximo ${schema.maxLength} caracteres`);
    }
    if (schema.pattern !== undefined && !compilePattern(schema.pattern).test(value)) {
      pushIssue(walk, path, `no cumple el formato ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      pushIssue(walk, path, `debe tener al menos ${schema.minItems} elementos`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      pushIssue(walk, path, `debe tener como máximo ${schema.maxItems} elementos`);
    }
    if (schema.uniqueItems) {
      outer: for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (jsonEqual(value[i], value[j])) {
            pushIssue(walk, path, "los elementos deben ser distintos");
            break outer;
          }
        }
      }
    }
    if (schema.items !== undefined) {
      const items = schema.items;
      value.forEach((item, i) => validateNode(items, item, `${path}/${i}`, depth + 1, walk));
    } else {
      value.forEach((item, i) => validateNode({}, item, `${path}/${i}`, depth + 1, walk));
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) pushIssue(walk, `${path}/${key}`, "falta este campo obligatorio");
    }
    for (const key of Object.keys(obj)) {
      const childPath = `${path}/${key}`;
      if (FORBIDDEN_KEYS.has(key)) {
        pushIssue(walk, childPath, "nombre de campo no permitido");
        continue;
      }
      const child = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
      if (child) {
        validateNode(child, obj[key], childPath, depth + 1, walk);
      } else if (schema.additionalProperties === false) {
        pushIssue(walk, childPath, "campo no permitido");
      } else if (typeof schema.additionalProperties === "object") {
        validateNode(schema.additionalProperties, obj[key], childPath, depth + 1, walk);
      } else {
        validateNode({}, obj[key], childPath, depth + 1, walk);
      }
    }
  }

  if (schema.anyOf !== undefined) {
    const ok = schema.anyOf.some((sub) => countIssues(sub, value, path, depth) === 0);
    if (!ok) pushIssue(walk, path, "no coincide con ninguna de las formas permitidas");
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((sub) => countIssues(sub, value, path, depth) === 0).length;
    if (matches !== 1) pushIssue(walk, path, "debe coincidir con exactamente una forma permitida");
  }
}

function countIssues(schema: JsonSchema, value: unknown, path: string, depth: number): number {
  const walk: Walk = { issues: [] };
  validateNode(schema, value, path, depth + 1, walk);
  return walk.issues.length;
}

function clonePlain(value: unknown): unknown {
  if (Object.is(value, -0)) return 0; // R1 WP5A-10
  if (Array.isArray(value)) return value.map(clonePlain);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clonePlain(v);
    return out;
  }
  return value;
}

export function summarizeIssues(issues: readonly ValidationIssue[]): string {
  const text = issues
    .map((issue) => `${issue.path === "" ? "(raíz)" : issue.path.slice(1)}: ${issue.message}`)
    .join("; ");
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

function fail(issues: ValidationIssue[]): ValidationResult {
  return { ok: false, issues, summary: summarizeIssues(issues) };
}

/**
 * Validates `value` against `schema`. On success returns a deep copy with the
 * top-level `default`s of absent properties applied. The input is not mutated.
 */
export function validateValue(schema: JsonSchema, value: unknown): ValidationResult {
  const walk: Walk = { issues: [] };
  validateNode(schema, value, "", 0, walk);
  if (walk.issues.length > 0) return fail(walk.issues);
  const copy = clonePlain(value);
  if (isPlainObject(copy) && schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (child.default !== undefined && !Object.prototype.hasOwnProperty.call(copy, key)) {
        copy[key] = clonePlain(child.default);
      }
    }
  }
  return { ok: true, value: copy };
}

/** Parses the raw JSON arguments sent by the model and validates them. */
export function parseAndValidateArgs(schema: JsonSchema, raw: string | unknown): ValidationResult {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_ARGUMENT_CHARS) {
      return fail([{ path: "", message: `argumentos demasiado largos (máximo ${MAX_ARGUMENT_CHARS} caracteres)` }]);
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      parsed = {};
    } else {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return fail([{ path: "", message: "los argumentos no son JSON válido" }]);
      }
    }
  }
  if (!isPlainObject(parsed)) return fail([{ path: "", message: "los argumentos deben ser un objeto JSON" }]);
  return validateValue(schema, parsed);
}
