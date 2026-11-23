import { describe, expect, it } from "vitest";
import {
  assertSupportedSchema,
  parseAndValidateArgs,
  validateValue,
  type JsonSchema,
} from "./validate";

// Copies of three catalog schemas from W0a `herramientas.schema.json` (98ad400).
const PLACE_RADAR: JsonSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["local_xy", "candidate"] },
    x_m: { type: "number", minimum: 0, maximum: 200000, description: "Solo local_xy." },
    y_m: { type: "number", minimum: 0, maximum: 200000 },
    height_above_ground_m: { type: "number", minimum: 0, maximum: 50, default: 2 },
    candidate_id: { type: "string", pattern: "^C[0-9]{1,3}$" },
  },
  required: ["mode"],
  additionalProperties: false,
};

const GET_COVERAGE_METRICS: JsonSchema = {
  type: "object",
  properties: {
    analysis_ref: {
      anyOf: [
        { type: "string", pattern: "^A[0-9]{1,3}$" },
        { type: "string", enum: ["active"] },
      ],
      default: "active",
    },
    metric: { type: "string", enum: ["INCIDENCE", "PROJECTION"] },
  },
  required: [],
  additionalProperties: false,
};

const COMPARE: JsonSchema = {
  type: "object",
  properties: {
    analysis_refs: {
      type: "array",
      items: { type: "string", pattern: "^A[0-9]{1,3}$" },
      minItems: 2,
      maxItems: 10,
      uniqueItems: true,
    },
    k: { type: "integer", minimum: 1, maximum: 5 },
  },
  required: ["analysis_refs"],
  additionalProperties: false,
};

describe("assertSupportedSchema", () => {
  it("accepts the catalog subset", () => {
    expect(() => assertSupportedSchema(PLACE_RADAR)).not.toThrow();
    expect(() => assertSupportedSchema(GET_COVERAGE_METRICS)).not.toThrow();
    expect(() => assertSupportedSchema(COMPARE)).not.toThrow();
  });

  it("rejects unknown keywords so no tool silently skips validation", () => {
    expect(() =>
      assertSupportedSchema({ type: "object", properties: { a: { type: "string", format: "email" } } } as unknown as JsonSchema),
    ).toThrow(/format/);
    expect(() => assertSupportedSchema({ type: "object", $ref: "#/x" } as unknown as JsonSchema)).toThrow(/\$ref/);
    expect(() => assertSupportedSchema({ type: "object", patternProperties: {} } as unknown as JsonSchema)).toThrow();
  });

  it("rejects invalid keyword values", () => {
    expect(() => assertSupportedSchema({ type: "strin" } as unknown as JsonSchema)).toThrow(/type/);
    expect(() => assertSupportedSchema({ type: "string", pattern: "(" })).toThrow(/pattern/);
    expect(() => assertSupportedSchema({ type: "number", minimum: Number.NaN })).toThrow(/minimum/);
    expect(() => assertSupportedSchema({ type: "object", required: ["a", 1] } as unknown as JsonSchema)).toThrow();
  });

  it("requires additionalProperties:false on tool parameter roots when asked", () => {
    expect(() =>
      assertSupportedSchema({ type: "object", properties: {} }, { requireClosedRoot: true }),
    ).toThrow(/additionalProperties/);
  });
});

describe("validateValue", () => {
  it("accepts a valid call and applies top-level defaults to a copy", () => {
    const input = { mode: "local_xy", x_m: 412, y_m: 655.5 };
    const res = validateValue(PLACE_RADAR, input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ mode: "local_xy", x_m: 412, y_m: 655.5, height_above_ground_m: 2 });
      expect(res.value).not.toBe(input);
    }
    expect(input).not.toHaveProperty("height_above_ground_m");
  });

  it("rejects extra properties, wrong types and out-of-range values", () => {
    const extra = validateValue(PLACE_RADAR, { mode: "local_xy", z: 1 });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.issues[0]?.path).toBe("/z");

    const wrongType = validateValue(PLACE_RADAR, { mode: "local_xy", x_m: "412" });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.issues[0]?.message).toMatch(/number/);

    const tooHigh = validateValue(PLACE_RADAR, { mode: "local_xy", height_above_ground_m: 50.0001 });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.issues[0]?.path).toBe("/height_above_ground_m");

    const negative = validateValue(PLACE_RADAR, { mode: "local_xy", x_m: -0.1 });
    expect(negative.ok).toBe(false);
  });

  it("rejects missing required, bad enum and bad pattern", () => {
    expect(validateValue(PLACE_RADAR, {}).ok).toBe(false);
    expect(validateValue(PLACE_RADAR, { mode: "gps" }).ok).toBe(false);
    expect(validateValue(PLACE_RADAR, { mode: "candidate", candidate_id: "C1234" }).ok).toBe(false);
    expect(validateValue(PLACE_RADAR, { mode: "candidate", candidate_id: "xC1" }).ok).toBe(false);
    expect(validateValue(PLACE_RADAR, { mode: "candidate", candidate_id: "C12" }).ok).toBe(true);
  });

  it("supports anyOf, integers, arrays, minItems/maxItems and uniqueItems", () => {
    expect(validateValue(GET_COVERAGE_METRICS, { analysis_ref: "A2" }).ok).toBe(true);
    expect(validateValue(GET_COVERAGE_METRICS, { analysis_ref: "active" }).ok).toBe(true);
    expect(validateValue(GET_COVERAGE_METRICS, { analysis_ref: "B2" }).ok).toBe(false);
    const def = validateValue(GET_COVERAGE_METRICS, {});
    expect(def.ok && def.value).toEqual({ analysis_ref: "active" });

    expect(validateValue(COMPARE, { analysis_refs: ["A1", "A2"], k: 2 }).ok).toBe(true);
    expect(validateValue(COMPARE, { analysis_refs: ["A1", "A2"], k: 2.5 }).ok).toBe(false);
    expect(validateValue(COMPARE, { analysis_refs: ["A1"] }).ok).toBe(false);
    expect(validateValue(COMPARE, { analysis_refs: ["A1", "A1"] }).ok).toBe(false);
    expect(
      validateValue(COMPARE, { analysis_refs: Array.from({ length: 11 }, (_, i) => `A${i + 1}`) }).ok,
    ).toBe(false);
    expect(validateValue(COMPARE, { analysis_refs: "A1,A2" }).ok).toBe(false);
  });

  it("type arrays include null and integer matches whole numbers only", () => {
    const schema: JsonSchema = { type: ["integer", "null"] };
    expect(validateValue(schema, null).ok).toBe(true);
    expect(validateValue(schema, 3).ok).toBe(true);
    expect(validateValue(schema, 3.1).ok).toBe(false);
    expect(validateValue({ type: "number" }, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateValue({ type: "number" }, Number.NaN).ok).toBe(false);
  });

  it("counts string length in code points and supports const/oneOf/exclusive bounds", () => {
    expect(validateValue({ type: "string", maxLength: 2 }, "🛰🛰").ok).toBe(true);
    expect(validateValue({ type: "string", minLength: 3 }, "🛰🛰").ok).toBe(false);
    expect(validateValue({ const: "x" }, "x").ok).toBe(true);
    expect(validateValue({ const: "x" }, "y").ok).toBe(false);
    const one: JsonSchema = { oneOf: [{ type: "integer" }, { type: "number", minimum: 0 }] };
    expect(validateValue(one, -1).ok).toBe(true); // only integer matches
    expect(validateValue(one, 1).ok).toBe(false); // both match
    expect(validateValue({ type: "number", exclusiveMinimum: 0 }, 0).ok).toBe(false);
    expect(validateValue({ type: "number", exclusiveMaximum: 1 }, 0.99).ok).toBe(true);
  });

  it("never accepts prototype-polluting keys, even when extra properties are allowed", () => {
    const parsed = JSON.parse('{"mode":"local_xy","__proto__":{"polluted":true}}');
    const res = validateValue({ type: "object", properties: { mode: { type: "string" } } }, parsed);
    expect(res.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(validateValue({ type: "object" }, { constructor: 1 }).ok).toBe(false);
  });

  it("bounds nesting depth", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i += 1) deep = [deep];
    const res = validateValue({ type: "array" }, deep);
    expect(res.ok).toBe(false);
  });

  it("caps the number of reported issues", () => {
    const schema: JsonSchema = { type: "object", additionalProperties: false, properties: {} };
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const res = validateValue(schema, many);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeLessThanOrEqual(10);
  });
});

describe("parseAndValidateArgs", () => {
  it("parses raw JSON text from the model", () => {
    const res = parseAndValidateArgs(PLACE_RADAR, '{"mode":"local_xy","x_m":1,"y_m":2}');
    expect(res.ok).toBe(true);
  });

  it("treats empty text as an empty object (models send '' for no-arg tools)", () => {
    const res = parseAndValidateArgs(GET_COVERAGE_METRICS, "");
    expect(res.ok).toBe(true);
  });

  it("reports malformed JSON, non-object roots and oversized payloads", () => {
    const bad = parseAndValidateArgs(PLACE_RADAR, "{mode: local}");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.message).toMatch(/JSON/);
    expect(parseAndValidateArgs(PLACE_RADAR, "[1]").ok).toBe(false);
    expect(parseAndValidateArgs(PLACE_RADAR, `{"mode":"${"x".repeat(20000)}"}`).ok).toBe(false);
  });

  it("formats issues as one short Spanish line for the model", () => {
    const res = parseAndValidateArgs(PLACE_RADAR, '{"mode":"local_xy","x_m":-5}');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.summary).toContain("x_m");
      expect(res.summary.length).toBeLessThanOrEqual(300);
    }
  });
});
