/**
 * Synthetic DXF fixtures shared by the preflight, Worker-order and real-parser tests.
 *
 * Every `HANGING_DXF` entry was confirmed to keep `dxf-parser@1.1.2` looping forever (audit in
 * plans/rust-wasm/evidence/c2a/audit). `VALID_DXF` entries parse normally and must keep doing so.
 */

type Group = readonly [code: number | string, value: number | string];

/** Serialize code/value pairs as DXF text (one line each, `\n` separated). */
export function dxfText(...groups: Group[]): string {
  return groups.map(([code, value]) => `${code}\n${value}\n`).join("");
}

const section = (name: string): Group[] => [[0, "SECTION"], [2, name]];
const endOfFile: Group[] = [[0, "ENDSEC"], [0, "EOF"]];

export interface DxfFixture {
  id: string;
  text: string;
  /** Pattern the preflight error must match (hanging fixtures only). */
  reason?: RegExp;
}

/** The 56-byte file confirmed by the coordinator: POLYLINE without SEQEND. */
export const DXF_56_BYTES = "0\nSECTION\n2\nENTITIES\n0\nPOLYLINE\n8\n0\n66\n1\n0\nENDSEC\n0\nEOF\n";

export const HANGING_DXF: readonly DxfFixture[] = [
  { id: "polyline-56b", text: DXF_56_BYTES, reason: /POLYLINE.*SEQEND/ },
  {
    id: "polyline-vertex-then-endsec",
    text: dxfText(...section("ENTITIES"), [0, "POLYLINE"], [66, 1], [0, "VERTEX"], [10, 1], [20, 2], [30, 3], ...endOfFile),
    reason: /POLYLINE.*SEQEND/,
  },
  {
    id: "polyline-then-point",
    text: dxfText(...section("ENTITIES"), [0, "POLYLINE"], [66, 1], [0, "POINT"], [10, 1], [20, 2], [30, 3], [0, "SEQEND"], ...endOfFile),
    reason: /POLYLINE.*SEQEND/,
  },
  {
    id: "polyline-in-block-endblk",
    text: dxfText(...section("BLOCKS"), [0, "BLOCK"], [2, "B"], [0, "POLYLINE"], [66, 1], [0, "ENDBLK"], ...endOfFile),
    reason: /POLYLINE.*SEQEND/,
  },
  {
    id: "vport-record-then-other",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "VPORT"], [0, "VPORT"], [2, "*ACTIVE"], [0, "LAYER"], [0, "ENDTAB"], ...endOfFile),
    reason: /tabla VPORT.*ENDTAB/,
  },
  {
    id: "vport-record-then-eof",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "VPORT"], [0, "VPORT"], [2, "*ACTIVE"], [0, "EOF"]),
    reason: /tabla VPORT.*ENDTAB/,
  },
  {
    id: "layer-record-then-endsec",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "LAYER"], [0, "LAYER"], [2, "0"], ...endOfFile),
    reason: /tabla LAYER.*ENDTAB/,
  },
  // A nested 0/TABLE is ignored inside parseTable, so the parser stays in the OUTER table and
  // stalls on the other table's record (closing review, evidence/sec-close-opus).
  {
    id: "vport-nested-table-layer",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "VPORT"], [0, "TABLE"], [2, "LAYER"], [0, "VPORT"], [0, "LAYER"], [0, "ENDTAB"], ...endOfFile),
    reason: /tabla VPORT.*ENDTAB/,
  },
  {
    id: "layer-nested-table-vport",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "LAYER"], [0, "TABLE"], [2, "VPORT"], [0, "LAYER"], [0, "VPORT"], [0, "ENDTAB"], ...endOfFile),
    reason: /tabla LAYER.*ENDTAB/,
  },
  {
    id: "vport-nested-table-layer-full",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "VPORT"], [70, 1], [0, "TABLE"], [2, "LAYER"], [70, 1], [0, "VPORT"], [2, "*ACTIVE"], [0, "LAYER"], [2, "0"], [62, 7], [0, "ENDTAB"], [0, "ENDSEC"],
      ...section("ENTITIES"), [0, "POINT"], [10, 0], [20, 0], [30, 0], ...endOfFile),
    reason: /tabla VPORT.*ENDTAB/,
  },
  {
    id: "nested-table-name-code0",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "VPORT"], [0, "TABLE"], [0, "LAYER"], [0, "VPORT"], [0, "LAYER"], [0, "ENDTAB"], ...endOfFile),
    reason: /tabla VPORT.*ENDTAB/,
  },
  {
    id: "lwpolyline-10-then-8",
    text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 1], [10, 0], [8, "L"], ...endOfFile),
    reason: /LWPOLYLINE.*código 10/,
  },
  {
    id: "lwpolyline-10-then-21",
    text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 2], [10, 0], [20, 0], [10, 1], [21, 0], ...endOfFile),
    reason: /LWPOLYLINE.*código 10/,
  },
  {
    id: "lwpolyline-10-then-nan-code",
    text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 1], [10, 0], ["x", "y"], ...endOfFile),
    reason: /LWPOLYLINE.*código 10/,
  },
];

/** Not an endless loop but an allocation bomb: one vertex declared as two billion (OOM in 0.7 s). */
export const LWPOLYLINE_COUNT_BOMB: DxfFixture = {
  id: "lwpolyline-count-2e9",
  text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 2_000_000_000], [10, 0], [20, 0], ...endOfFile),
  reason: /código 90/,
};

/** A small, well-formed terrain with every entity the Worker reads, plus tables and blocks. */
export const VALID_TERRAIN_DXF = dxfText(
  ...section("HEADER"), [9, "$ACADVER"], [1, "AC1015"], [0, "ENDSEC"],
  ...section("TABLES"),
  [0, "TABLE"], [2, "VPORT"], [70, 1], [0, "VPORT"], [2, "*ACTIVE"], [10, 0], [20, 0], [0, "ENDTAB"],
  [0, "TABLE"], [2, "LTYPE"], [70, 1], [0, "LTYPE"], [2, "CONTINUOUS"], [73, 0], [0, "ENDTAB"],
  [0, "TABLE"], [2, "LAYER"], [70, 2], [0, "LAYER"], [2, "0"], [62, 7], [0, "LAYER"], [2, "TOPO"], [62, 3], [0, "ENDTAB"],
  [0, "ENDSEC"],
  ...section("BLOCKS"),
  [0, "BLOCK"], [2, "MARK"], [10, 0], [20, 0], [30, 0],
  [0, "POLYLINE"], [66, 1], [0, "VERTEX"], [10, 0], [20, 0], [30, 0], [0, "SEQEND"],
  [0, "ENDBLK"],
  [0, "ENDSEC"],
  ...section("ENTITIES"),
  [0, "POINT"], [8, "TOPO"], [10, 0], [20, 0], [30, 1],
  [0, "POINT"], [8, "TOPO"], [10, 10], [20, 10], [30, 2],
  [0, "LINE"], [10, 0], [20, 10], [30, 3], [11, 10], [21, 0], [31, 4],
  [0, "LWPOLYLINE"], [90, 3], [70, 0], [38, 5], [10, 2], [20, 2], [10, 4], [20, 2], [30, 6], [10, 4], [20, 4],
  [0, "POLYLINE"], [66, 1], [70, 8], [0, "VERTEX"], [10, 6], [20, 6], [30, 7], [0, "VERTEX"], [10, 8], [20, 8], [30, 8], [0, "SEQEND"], [8, "TOPO"],
  [0, "ENDSEC"],
  [0, "EOF"],
);

export const VALID_DXF: readonly DxfFixture[] = [
  { id: "terrain-all-sections", text: VALID_TERRAIN_DXF },
  { id: "terrain-crlf", text: VALID_TERRAIN_DXF.replace(/\n/g, "\r\n") },
  { id: "terrain-without-final-newline", text: VALID_TERRAIN_DXF.replace(/\n$/, "") },
  { id: "garbage-after-eof", text: `${VALID_TERRAIN_DXF}0\nPOLYLINE\n0\nENDSEC\n` },
  {
    id: "lwpolyline-embedded-object",
    text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 1], [10, 0], [20, 0], [101, "Embedded Object"], [10, 1], [1000, "x"], ...endOfFile),
  },
  {
    id: "lwpolyline-vertex-width-and-bulge",
    text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 2], [10, 0], [40, 0], [41, 0], [42, 0], [20, 0], [10, 1], [30, 2], [20, 1], ...endOfFile),
  },
  {
    id: "lwpolyline-10-then-0",
    text: dxfText(...section("ENTITIES"), [0, "LWPOLYLINE"], [90, 1], [10, 0], ...endOfFile),
  },
  {
    id: "polyline-seqend-attributes",
    text: dxfText(...section("ENTITIES"), [0, "POLYLINE"], [0, "VERTEX"], [10, 0], [20, 0], [30, 0], [0, "SEQEND"], [5, "AB"], [8, "0"], ...endOfFile),
  },
  {
    id: "table-other-kinds",
    text: dxfText(...section("TABLES"), [0, "TABLE"], [2, "STYLE"], [0, "STYLE"], [2, "S"], [0, "ENDTAB"], ...endOfFile),
  },
  {
    id: "vertex-outside-polyline",
    text: dxfText(...section("ENTITIES"), [0, "VERTEX"], [10, 0], [20, 0], [30, 0], [0, "POINT"], [10, 0], [20, 0], [30, 0], ...endOfFile),
  },
];
