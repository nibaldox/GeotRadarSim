import { describe, expect, it } from "vitest";
import { preflightDxf } from "./dxfPreflight";
import { MAX_DXF_ENTITIES, MAX_DXF_VERTICES } from "./terrainLimits";
import {
  DXF_56_BYTES,
  HANGING_DXF,
  LWPOLYLINE_COUNT_BOMB,
  VALID_DXF,
  dxfText,
} from "./dxfFixtures.testSupport";

function rejectionOf(text: string): { error: unknown; ms: number } {
  const started = performance.now();
  try {
    preflightDxf(text);
  } catch (error) {
    return { error, ms: performance.now() - started };
  }
  return { error: undefined, ms: performance.now() - started };
}

describe("preflightDxf — structures that hang dxf-parser@1.1.2", () => {
  it("rejects the confirmed 56-byte POLYLINE without SEQEND in under 100 ms", () => {
    expect(new TextEncoder().encode(DXF_56_BYTES).byteLength).toBe(56);
    const { error, ms } = rejectionOf(DXF_56_BYTES);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/POLYLINE/);
    expect((error as Error).message).toMatch(/SEQEND/);
    expect((error as Error).message).toMatch(/línea 5/);
    expect(ms).toBeLessThan(100);
  });

  for (const fixture of [...HANGING_DXF, LWPOLYLINE_COUNT_BOMB]) {
    it(`rejects ${fixture.id} in under 100 ms with a Spanish reason`, () => {
      const { error, ms } = rejectionOf(fixture.text);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^DXF rechazado: /);
      expect((error as Error).message).toMatch(fixture.reason!);
      expect(ms).toBeLessThan(100);
    });
  }

  it("rejects the same patterns with CRLF line endings", () => {
    for (const fixture of HANGING_DXF) {
      expect(() => preflightDxf(fixture.text.replace(/\n/g, "\r\n")), fixture.id).toThrow(fixture.reason!);
    }
  });

  it("leaves to the parser the truncated files on which it throws (they end, they do not hang)", () => {
    // The text ends inside a POLYLINE or a LAYER table: scanner.next() throws "Unexpected end of input".
    expect(() => preflightDxf(dxfText([0, "SECTION"], [2, "ENTITIES"], [0, "POLYLINE"], [0, "VERTEX"], [10, 0]))).not.toThrow();
    expect(() => preflightDxf(dxfText([0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, "LAYER"], [0, "LAYER"], [2, "0"]))).not.toThrow();
  });

  it("mirrors parseTable: a nested 0/TABLE is ignored and the outer table keeps its record type", () => {
    const nested = (outer: string, inner: string, records: string[]) => dxfText(
      [0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, outer], [0, "TABLE"], [2, inner],
      ...records.map((record) => [0, record] as const), [0, "ENDTAB"], [0, "ENDSEC"], [0, "EOF"]);
    // Records of the OUTER type only: the parser reads them and closes the table.
    expect(() => preflightDxf(nested("VPORT", "LAYER", ["VPORT", "VPORT"]))).not.toThrow();
    expect(() => preflightDxf(nested("LAYER", "VPORT", ["LAYER"]))).not.toThrow();
    // A record of the nested type after the outer one starts its records: the parser stalls there.
    expect(() => preflightDxf(nested("VPORT", "LTYPE", ["VPORT", "LTYPE"]))).toThrow(/tabla VPORT.*«LTYPE»/);
    expect(() => preflightDxf(nested("VPORT", "VPORT", ["VPORT", "LAYER"]))).toThrow(/tabla VPORT.*«LAYER»/);
  });

  it("reads codes exactly like the scanner (parseInt), so padded or hexadecimal codes cannot slip through", () => {
    // " 0" and "0.0" are code 0 for parseInt; "0x0A" is code 10.
    expect(() => preflightDxf(DXF_56_BYTES.replace("0\nENDSEC", " 0\nENDSEC"))).toThrow(/SEQEND/);
    expect(() => preflightDxf(DXF_56_BYTES.replace("0\nENDSEC", "0.0\nENDSEC"))).toThrow(/SEQEND/);
    const hexTen = dxfText([0, "SECTION"], [2, "ENTITIES"], [0, "LWPOLYLINE"], [90, 1], ["0x0A", 0], [8, "L"], [0, "ENDSEC"], [0, "EOF"]);
    expect(() => preflightDxf(hexTen)).toThrow(/LWPOLYLINE.*código 10/);
  });

  it("stops at the first 0/EOF group, as the parser does", () => {
    expect(() => preflightDxf(dxfText([0, "EOF"], [0, "POLYLINE"], [0, "ENDSEC"]))).not.toThrow();
  });
});

describe("preflightDxf — well-formed DXF", () => {
  for (const fixture of VALID_DXF) {
    it(`accepts ${fixture.id}`, () => {
      expect(() => preflightDxf(fixture.text)).not.toThrow();
    });
  }

  it("accepts empty text and leaves the empty-file error to the parser", () => {
    expect(preflightDxf("")).toEqual({ entities: 0, vertices: 0 });
  });

  it("counts ENTITIES-section entities and vertices like the post-parse S2 check", () => {
    const valid = VALID_DXF.find((fixture) => fixture.id === "terrain-all-sections")!;
    // POINT ×2 (2 vertices), LINE (2), LWPOLYLINE (3 declared), POLYLINE (2 VERTEX); the block is not counted.
    expect(preflightDxf(valid.text)).toEqual({ entities: 5, vertices: 9 });
  });
});

describe("preflightDxf — S2 limits applied before parseSync", () => {
  it("accepts exactly MAX_DXF_ENTITIES entities and rejects one more", () => {
    const points = (count: number): string =>
      `0\nSECTION\n2\nENTITIES\n${"0\nPOINT\n".repeat(count)}0\nENDSEC\n0\nEOF\n`;
    expect(preflightDxf(points(MAX_DXF_ENTITIES)).entities).toBe(MAX_DXF_ENTITIES);
    expect(() => preflightDxf(points(MAX_DXF_ENTITIES + 1))).toThrow(/entidades/);
  });

  it("does not count entities that live in BLOCKS", () => {
    const blockPoints = `0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nB\n${"0\nPOINT\n".repeat(MAX_DXF_ENTITIES + 1)}0\nENDBLK\n0\nENDSEC\n0\nEOF\n`;
    expect(preflightDxf(blockPoints).entities).toBe(0);
  });

  it("accepts exactly MAX_DXF_VERTICES vertices and rejects one more", () => {
    const polyline = (count: number): string =>
      `0\nSECTION\n2\nENTITIES\n0\nPOLYLINE\n${"0\nVERTEX\n".repeat(count)}0\nSEQEND\n0\nENDSEC\n0\nEOF\n`;
    expect(preflightDxf(polyline(MAX_DXF_VERTICES)).vertices).toBe(MAX_DXF_VERTICES);
    expect(() => preflightDxf(polyline(MAX_DXF_VERTICES + 1))).toThrow(/vértices/);
  }, 20_000);

  it("bounds the vertices that LWPOLYLINE code 90 makes the parser allocate without matching code 10 groups", () => {
    const declared = (count: number, tens: number): string =>
      dxfText([0, "SECTION"], [2, "BLOCKS"], [0, "BLOCK"], [2, "B"], [0, "LWPOLYLINE"], [90, count],
        ...Array.from({ length: tens }, () => [10, 0] as const), [0, "ENDBLK"], [0, "ENDSEC"], [0, "EOF"]);
    // A slightly wrong count (typical exporter slop) still passes; a padding bomb does not. Without
    // any group 10 the vertex reader never runs, so the count alone allocates nothing.
    expect(() => preflightDxf(declared(5, 3))).not.toThrow();
    expect(() => preflightDxf(declared(MAX_DXF_VERTICES + 1, 0))).not.toThrow();
    expect(() => preflightDxf(declared(MAX_DXF_VERTICES + 1, 1))).not.toThrow();
    expect(() => preflightDxf(declared(MAX_DXF_VERTICES + 2, 1))).toThrow(/código 90/);
  });
});
