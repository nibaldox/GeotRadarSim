/**
 * Seeded grammar of DXF group sequences for the differential test of `preflightDxf` against the
 * real `dxf-parser@1.1.2` (src/utils/dxfDifferential.test.ts and plans/rust-wasm/evidence/c3).
 *
 * It builds documents from the structures the parser's state machine reacts to (sections, tables
 * with VPORT/LAYER/LTYPE records and nested TABLEs, blocks, POLYLINE/VERTEX/SEQEND, LWPOLYLINE with
 * 90/10/20/42, LINE, POINT, 3DFACE, EOF and stray codes) and then mutates them by inserting,
 * deleting, duplicating and swapping groups drawn from the same vocabulary. Depth and length are
 * bounded; the same seed always yields the same text.
 */

/** mulberry32: small, fast, deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type G = [string, string];

/** Groups the mutations draw from: every code/value the parser's control flow compares. */
export const DXF_VOCABULARY: readonly G[] = [
  ["0", "SECTION"], ["2", "HEADER"], ["2", "TABLES"], ["2", "BLOCKS"], ["2", "ENTITIES"], ["0", "ENDSEC"],
  ["0", "TABLE"], ["0", "ENDTAB"], ["2", "VPORT"], ["2", "LAYER"], ["2", "LTYPE"],
  ["0", "VPORT"], ["0", "LAYER"], ["0", "LTYPE"], ["73", "1"], ["49", "0.5"], ["62", "7"],
  ["0", "BLOCK"], ["0", "ENDBLK"], ["0", "POLYLINE"], ["0", "VERTEX"], ["0", "SEQEND"], ["66", "1"],
  ["0", "LWPOLYLINE"], ["90", "2"], ["10", "1"], ["20", "2"], ["30", "3"], ["42", "0.5"], ["11", "1"], ["21", "1"],
  ["0", "LINE"], ["0", "POINT"], ["0", "3DFACE"], ["0", "CIRCLE"], ["0", "HATCH"], ["0", "EOF"],
  ["8", "L"], ["5", "AB"], ["70", "1"], ["9", "$ACADVER"], ["1", "AC1015"], ["999", "c"], ["101", "Embedded Object"],
  ["1000", "x"], ["40", "1"], ["210", "0"], ["220", "0"], ["230", "1"],
];

export function generateDxfCase(seed: number): string {
  const rnd = seededRandom(seed);
  const chance = (p: number): boolean => rnd() < p;
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const num = (): string => String(int(-50, 50));
  const out: G[] = [];
  const push = (code: string | number, value: string | number): void => { out.push([String(code), String(value)]); };
  const point = (base = 10, z = true): void => {
    push(base, num());
    if (chance(0.95)) push(base + 10, num());
    if (z && chance(0.7)) push(base + 20, num());
  };
  const noise = (): void => {
    if (chance(0.15)) out.push(pick(DXF_VOCABULARY));
  };

  const entity = (depth: number): void => {
    const kind = pick(["POINT", "POINT", "LINE", "POLYLINE", "LWPOLYLINE", "LWPOLYLINE", "3DFACE", "CIRCLE", "HATCH", "VERTEX"]);
    push(0, kind);
    if (chance(0.5)) push(8, "TOPO");
    switch (kind) {
      case "POINT": point(); break;
      case "LINE": point(10); point(11); break;
      case "CIRCLE": point(); push(40, 2); break;
      case "3DFACE": for (let k = 0; k < int(0, 5); k++) point(10 + Math.min(k, 3)); break;
      case "POLYLINE": {
        push(66, 1);
        if (chance(0.3)) push(70, pick([0, 8, 64]));
        const vertices = int(0, 4);
        for (let k = 0; k < vertices; k++) {
          push(0, "VERTEX");
          point();
          if (chance(0.1)) push(101, "Embedded Object");
          noise();
        }
        if (chance(0.8)) push(0, "SEQEND");
        break;
      }
      case "LWPOLYLINE": {
        const vertices = int(0, 5);
        const declared = chance(0.85) ? vertices : pick([0, 1, 3, 1000, 2_000_000_000, -1]);
        if (chance(0.9)) push(90, declared);
        if (chance(0.3)) push(38, num());
        for (let k = 0; k < vertices; k++) {
          push(10, num());
          if (chance(0.1)) out.push(pick(DXF_VOCABULARY)); // a foreign group right after X
          if (chance(0.9)) push(20, num());
          if (chance(0.2)) push(42, "0.5");
          if (chance(0.15)) push(30, num());
        }
        break;
      }
      default:
        if (depth < 2 && chance(0.3)) entity(depth + 1);
    }
    noise();
  };

  const table = (depth: number): void => {
    const kind = pick(["VPORT", "LAYER", "LTYPE", "VPORT", "LAYER", "STYLE"]);
    push(0, "TABLE");
    push(chance(0.9) ? 2 : 0, kind);
    if (chance(0.5)) push(70, int(0, 3));
    if (depth < 2 && chance(0.3)) {
      if (chance(0.5)) table(depth + 1); // a complete nested TABLE
      else { push(0, "TABLE"); push(chance(0.8) ? 2 : 0, pick(["VPORT", "LAYER", "LTYPE"])); } // header only
    }
    const records = int(0, 3);
    for (let k = 0; k < records; k++) {
      push(0, chance(0.7) ? kind : pick(["VPORT", "LAYER", "LTYPE", "ENDSEC", "EOF", "TABLE"]));
      push(2, pick(["0", "*ACTIVE", "TOPO", "CONTINUOUS"]));
      if (kind === "VPORT" && chance(0.5)) point(10, false);
      if (kind === "LAYER" && chance(0.5)) push(62, 7);
      if (kind === "LTYPE" && chance(0.5)) { push(73, int(0, 2)); if (chance(0.5)) push(49, "0.5"); }
      noise();
    }
    if (chance(0.85)) push(0, "ENDTAB");
  };

  const section = (): void => {
    const name = pick(["HEADER", "TABLES", "BLOCKS", "ENTITIES", "ENTITIES", "OBJECTS"]);
    push(0, "SECTION");
    push(chance(0.95) ? 2 : 8, name);
    switch (name) {
      case "HEADER":
        for (let k = 0; k < int(0, 3); k++) { push(9, "$INSBASE"); if (chance(0.6)) point(); else push(1, "AC1015"); }
        break;
      case "TABLES":
        for (let k = 0; k < int(0, 3); k++) table(0);
        break;
      case "BLOCKS":
        for (let k = 0; k < int(0, 2); k++) {
          push(0, "BLOCK");
          push(2, "B");
          if (chance(0.6)) point(10);
          for (let e = 0; e < int(0, 3); e++) entity(0);
          if (chance(0.85)) push(0, "ENDBLK");
        }
        break;
      default:
        for (let k = 0; k < int(0, 5); k++) entity(0);
    }
    if (chance(0.85)) push(0, "ENDSEC");
  };

  for (let k = 0; k < int(1, 3); k++) section();
  if (chance(0.85)) push(0, "EOF");

  // Mutations bounded in number; the result stays under ~200 groups.
  const mutations = chance(0.6) ? int(1, 3) : 0;
  for (let m = 0; m < mutations; m++) {
    const at = int(0, out.length);
    const op = int(0, 3);
    if (op === 0) out.splice(at, 0, pick(DXF_VOCABULARY));
    else if (op === 1 && out.length > 1) out.splice(Math.min(at, out.length - 1), 1);
    else if (op === 2 && out.length > 0) { const i = Math.min(at, out.length - 1); out.splice(i, 0, out[i]!); }
    else if (op === 3 && out.length > 1) { const i = Math.min(at, out.length - 2); [out[i], out[i + 1]] = [out[i + 1]!, out[i]!]; }
  }
  return out.slice(0, 200).map(([code, value]) => `${code}\n${value}\n`).join("");
}
