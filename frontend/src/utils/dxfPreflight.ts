/**
 * Structural preflight for DXF text, run in the terrain Worker BEFORE `dxf-parser` sees it.
 *
 * `dxf-parser@1.1.2` (the latest release) has loops that stop advancing its scanner on some
 * malformed inputs, so `parseSync` spins forever (audits: plans/rust-wasm/evidence/c2a/audit and
 * evidence/sec-close-opus). Instead of pattern rules, this preflight MIRRORS the parser's control
 * flow: it drives the same state machine over the same code/value groups, without building any
 * object, and rejects the text exactly where the parser would stop advancing. Each function below
 * names the function and lines of `node_modules/dxf-parser/dist/*.js` it mirrors.
 *
 * What is mirrored:
 * - The scanner (`DxfArrayScanner.js`): lines split like `split(/\r\n|\r|\n/g)`, group code =
 *   `parseInt(line)` without a radix, value = trimmed line typed by `parseGroupValue`, the EOF flag
 *   that survives `rewind`, and `next()` throwing past the end, after EOF, or on a bad boolean.
 * - Which groups each loop consumes, ignores (`curr = scanner.next()`), or leaves unconsumed. In
 *   particular a 0/TABLE inside `parseTable` is ignored like any other 0-group, so the parser stays
 *   in the OUTER table (the nested-TABLE hang found by the closing review).
 * - Every `rewind` (ParseHelpers.parsePoint, the 101 embedded-object skip, the 3DFACE and
 *   LWPOLYLINE vertex readers), so the parser's re-reads are reproduced group by group.
 *
 * Outcomes:
 * - The parser would stop advancing (POLYLINE vertex loop, VPORT/LAYER record loops, LWPOLYLINE
 *   re-entry at the same position): REJECT, with the location.
 * - LWPOLYLINE code 90 would make the parser push empty vertices the file does not contain (an
 *   allocation bomb): REJECT once those phantom vertices exceed MAX_DXF_VERTICES, file-wide.
 * - The parser would throw (end of data, group after EOF, bad point, bad boolean, prototype-named
 *   entity, LTYPE pattern without count...): ACCEPT, because the parser then terminates on its own
 *   and the Worker reports its error. Only throws that happen in every build are mirrored; for any
 *   other throw the mirror keeps going, which can only reject more, never less.
 * - Backstop: a step budget linear in the text length turns any loop the mirror did not foresee
 *   into a rejection instead of a hang of the preflight itself.
 *
 * The mirror also applies the S2 limits before `parseSync`, counting the entities and vertices of
 * `dxf.entities` (the last ENTITIES section) the same way as the post-parse check, which stays as
 * a second line of defense.
 */
import { MAX_DXF_VERTICES, validateDxfComplexity } from "./terrainLimits";

/** Entities and vertices the post-parse S2 check will count for this text. */
export interface DxfPreflightSummary {
  entities: number;
  vertices: number;
}

const PREFIX = "DXF rechazado: ";

/** The parser would throw here: it terminates by itself, so there is nothing to reject. */
class ParserStops extends Error {}
const STOP = new ParserStops("dxf-parser would throw here");

function quote(value: string): string {
  const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return `«${shown}»`;
}

function reject(detail: string): never {
  throw new Error(`${PREFIX}${detail}. dxf-parser no puede leer esta estructura sin bloquearse; revisa o vuelve a exportar el archivo.`);
}

interface Group {
  /** `parseInt(codeLine)`, as DxfArrayScanner.next() computes it (may be NaN). */
  code: number;
  /** The code line, trimmed, for messages. */
  codeText: string;
  /** The trimmed value line (DxfArrayScanner.next(): `this._data[ptr].trim()`). */
  raw: string;
  /** 1-based line of the code line. */
  line: number;
}

/** DxfArrayScanner.js parseGroupValue (88-137): codes whose value stays a string. */
function valueIsString(code: number): boolean {
  if (code <= 9) return true;
  if (code >= 10 && code <= 99) return false; // float 10-59, int 60-99
  if (code >= 100 && code <= 109) return true;
  if (code >= 110 && code <= 149) return false;
  if (code >= 160 && code <= 179) return false;
  if (code >= 210 && code <= 239) return false;
  if (code >= 270 && code <= 299) return false; // int 270-289, boolean 290-299
  if (code >= 300 && code <= 369) return true;
  if (code >= 370 && code <= 389) return false;
  if (code >= 390 && code <= 399) return true;
  if (code >= 400 && code <= 409) return false;
  if (code >= 410 && code <= 419) return true;
  if (code >= 420 && code <= 429) return false;
  if (code >= 430 && code <= 439) return true;
  if (code >= 440 && code <= 469) return false; // int 440-459, float 460-469
  if (code >= 470 && code <= 481) return true;
  if (code === 999) return true;
  if (code >= 1000 && code <= 1009) return true;
  if (code >= 1010 && code <= 1071) return false; // float 1010-1059, int 1060-1071
  return true; // every other code (and NaN) falls through and keeps the raw string
}

/** `curr.value === name`: true only for string-typed values. */
const is = (g: Group, name: string): boolean => valueIsString(g.code) && g.raw === name;
/** `groupIs(curr, 0, name)` (DxfParser.js 696-698). */
const is0 = (g: Group, name: string): boolean => g.code === 0 && g.raw === name;
/** `curr.value` of an integer-typed group (codes 60-99): parseInt without a radix, like the scanner. */
const intValue = (g: Group): number => parseInt(g.raw);

/** Keys of `this._entityHandlers` (DxfParser.js registerDefaultEntityHandlers, 25-43). */
const ENTITY_HANDLERS = new Set([
  "3DFACE", "ARC", "ATTDEF", "CIRCLE", "DIMENSION", "ELLIPSE", "INSERT", "LINE",
  "LWPOLYLINE", "MTEXT", "POINT", "POLYLINE", "SOLID", "SPLINE", "TEXT",
]);
/**
 * Codes for which a generic entity parser calls `helpers.parsePoint(scanner)` (entities/*.js).
 * Every other code is an explicit no-op case or `default:` → checkCommonEntityProperties, whose
 * only scanner effect is the 101 embedded-object skip (ParseHelpers.js 73-79).
 */
const POINT_CODES: Record<string, ReadonlySet<number>> = {
  ARC: new Set([10]),
  ATTDEF: new Set([10, 11]),
  CIRCLE: new Set([10]),
  DIMENSION: new Set([10, 11, 12, 13, 14, 15, 16]),
  ELLIPSE: new Set([10, 11]),
  INSERT: new Set([10, 210]),
  LINE: new Set([10, 11, 210]),
  MTEXT: new Set([10, 11]),
  POINT: new Set([10, 210]),
  SOLID: new Set([10, 11, 12, 13, 210]),
  SPLINE: new Set([10, 11, 12, 13, 210]),
  TEXT: new Set([10, 11]),
};
const NO_POINT_CODES: ReadonlySet<number> = new Set();
/** DxfParser.js parseViewPortRecords (372-503): codes read with the local parsePoint. */
const VPORT_POINT_CODES = new Set([10, 11, 12, 13, 14, 15, 16, 17, 110, 111, 112]);
/** entities/lwpolyline.js parseLWPolylineVertices (56-104): codes the vertex reader keeps. */
const LWPOLYLINE_VERTEX_CODES = new Set([20, 30, 40, 41, 42]);
/** `obj[name]` finds an Object.prototype member: `tableDefinitions[name]` or a handler is truthy. */
const isPrototypeKey = (name: string): boolean => name in {};

/** DxfParser.js tableDefinitions (600-619); PROTOTYPE = truthy lookup without a record type. */
type TableKind = "VPORT" | "LTYPE" | "LAYER" | "PROTOTYPE";

export function preflightDxf(text: string): DxfPreflightSummary {
  // ── Lazy line/group reader with a small look-back ring (the parser rewinds at most 2 groups) ──
  const length = text.length;
  let cursor = 0;
  let exhausted = false;
  let lineNumber = 0;
  const readLine = (): string | undefined => {
    if (exhausted) return undefined;
    let end = cursor;
    while (end < length) {
      const ch = text.charCodeAt(end);
      if (ch === 10 || ch === 13) break;
      end++;
    }
    const line = text.slice(cursor, end);
    if (end >= length) exhausted = true;
    else if (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) cursor = end + 2;
    else cursor = end + 1;
    lineNumber++;
    return line;
  };

  const RING = 16;
  const ring: Array<Group | undefined> = new Array(RING);
  let groupsRead = 0;
  let noMoreGroups = false;
  const groupAt = (index: number): Group | undefined => {
    while (!noMoreGroups && groupsRead <= index) {
      const codeLine = readLine();
      const codeLineNumber = lineNumber;
      const valueLine = codeLine === undefined ? undefined : readLine();
      if (codeLine === undefined || valueLine === undefined) {
        noMoreGroups = true; // hasNext() needs both lines (DxfArrayScanner.js 61-71)
        break;
      }
      // Must match DxfArrayScanner.next(): parseInt without a radix (" 0", "0.0", "0x0A" = 10).
      ring[groupsRead % RING] = { code: parseInt(codeLine), codeText: codeLine.trim(), raw: valueLine.trim(), line: codeLineNumber };
      groupsRead++;
    }
    if (index >= groupsRead) return undefined;
    if (groupsRead - index > RING) reject("la estructura obliga a retroceder más grupos de los que el lector admite");
    return ring[index % RING];
  };

  // ── Step budget (backstop): a terminating parse reads each group a bounded number of times ──
  let steps = 0;
  const budget = 16 * (length + 64);
  const step = (): void => {
    if (++steps > budget) reject("dxf-parser no terminaría de leer esta estructura (se agotó el presupuesto de lectura)");
  };

  // ── DxfArrayScanner (DxfArrayScanner.js 12-79) ──
  let ptr = 0; // in groups; the scanner's line pointer is 2 × ptr
  let eof = false;
  let last: Group | undefined;
  const next = (): Group => {
    step();
    if (eof) throw STOP; // "Cannot call 'next' after EOF group has been read"
    const g = groupAt(ptr);
    if (!g) throw STOP; // "Unexpected end of input"
    if (g.code >= 290 && g.code <= 299 && g.raw !== "0" && g.raw !== "1") throw STOP; // parseBoolean
    ptr++;
    if (g.code === 0 && g.raw === "EOF") eof = true;
    last = g;
    return g;
  };
  const rewind = (groups = 1): void => {
    ptr -= groups; // the EOF flag is NOT cleared (DxfArrayScanner.js 54-56)
  };
  const lastRead = (): Group => last!;

  // ── S2 counters (dxf.entities) and the LWPOLYLINE padding budget ──
  let entities = 0;
  let vertices = 0;
  let phantomVertices = 0;

  // ── ParseHelpers.js ──
  /** parsePoint(scanner) (14-36): rewind, re-read X, require Y, optional Z (else rewind). */
  const helperParsePoint = (): void => {
    rewind();
    const code = next().code;
    if (next().code != code + 10) throw STOP;
    if (next().code != code + 20) rewind();
  };
  /** checkCommonEntityProperties, case 101 (73-79): read up to the next 0-group, then rewind. */
  const skipEmbeddedObject = (start: Group): void => {
    let c = start;
    while (c.code != 0) {
      step();
      c = next();
    }
    rewind();
  };

  /** DxfParser.js local parsePoint(curr) (667-685): no initial rewind; the caller's curr is unchanged. */
  const localParsePoint = (from: Group): void => {
    let code = from.code + 10;
    if (next().code != code) throw STOP;
    code += 10;
    if (next().code != code) rewind();
  };

  /**
   * Generic entity loop: entities/{arc,attdef,circle,dimension,ellipse,insert,line,mtext,point,
   * solid,spline,text,vertex}.js parseEntity (lines 7-41) and polyline.js parseSeqEnd (77-88).
   */
  const parseGenericEntity = (pointCodes: ReadonlySet<number>, onPoint?: (code: number) => void): void => {
    let c = next();
    while (!eof) {
      step();
      if (c.code === 0) break;
      if (pointCodes.has(c.code)) {
        helperParsePoint();
        onPoint?.(c.code);
      } else if (c.code === 101) {
        skipEmbeddedObject(c);
      }
      c = next();
    }
  };

  /** entities/polyline.js parseEntity (7-57) + parsePolylineVertices (59-75). Returns VERTEX count. */
  const parsePolyline = (start: Group): number => {
    let c = next();
    while (!eof) {
      step();
      if (c.code === 0) break;
      if (c.code === 210) helperParsePoint();
      else if (c.code === 101) skipEmbeddedObject(c);
      c = next();
    }
    let count = 0;
    while (!eof) {
      step();
      if (c.code === 0 && c.raw === "VERTEX") {
        parseGenericEntity(NO_POINT_CODES); // entities/vertex.js
        c = lastRead();
        count++;
      } else if (c.code === 0 && c.raw === "SEQEND") {
        parseGenericEntity(NO_POINT_CODES); // parseSeqEnd
        break;
      } else {
        // polyline.js 63-73: no branch calls scanner.next(), so the loop never ends.
        reject(`la POLYLINE de la línea ${start.line} no termina con SEQEND: dxf-parser se queda en ${quote(c.raw)} (línea ${c.line}) sin avanzar`);
      }
    }
    return count;
  };

  /** entities/3dface.js parse3dFaceVertices (30-71). Returns the vertices pushed by this call. */
  const parse3dFaceVertices = (start: Group): number => {
    let c = start;
    let started = false;
    let finished = false;
    let pushed = 0;
    for (let i = 0; i <= 4; i++) {
      while (!eof) {
        step();
        if (c.code === 0 || finished) break;
        if (c.code >= 10 && c.code <= 13) {
          if (started) {
            finished = true;
            continue;
          }
          started = true;
        } else if (!((c.code >= 20 && c.code <= 23) || (c.code >= 30 && c.code <= 33))) {
          return pushed; // default: return without rewind
        }
        c = next();
      }
      pushed++;
      started = false;
      finished = false;
    }
    rewind();
    return pushed;
  };

  /** entities/3dface.js parseEntity (7-27). Returns entity.vertices.length. */
  const parse3dFace = (): number => {
    let faceVertices = 0;
    let c = next();
    while (!eof) {
      step();
      if (c.code === 0) break;
      if (c.code === 10) {
        faceVertices = parse3dFaceVertices(c);
        c = lastRead();
      } else if (c.code === 101) {
        skipEmbeddedObject(c);
      }
      c = next();
    }
    return faceVertices;
  };

  /** entities/lwpolyline.js parseLWPolylineVertices (56-104). Returns the vertices pushed. */
  const parseLwVertices = (n: number): number => {
    if (!n || n <= 0) throw STOP; // "n must be greater than 0 verticies"
    let pushed = 0;
    let started = false;
    let finished = false;
    let c = lastRead();
    for (let i = 0; i < n; i++) {
      if (eof || c.code === 0) {
        // Every remaining iteration breaks at once and pushes an empty vertex: count them instead
        // of looping (n comes from the file and can be 2 000 000 000, or Infinity).
        const remaining = n - i;
        phantomVertices += remaining;
        if (phantomVertices > MAX_DXF_VERTICES) {
          reject(`las LWPOLYLINE declaran en el código 90 ${phantomVertices} vértices vacíos más de los que contienen (la última, antes de la línea ${c.line}); el máximo admitido es ${MAX_DXF_VERTICES}`);
        }
        pushed += remaining;
        break;
      }
      while (!eof) {
        step();
        if (c.code === 0 || finished) break;
        if (c.code === 10) {
          if (started) {
            finished = true;
            continue;
          }
          started = true;
        } else if (!LWPOLYLINE_VERTEX_CODES.has(c.code)) {
          rewind();
          if (started) pushed++;
          rewind();
          return pushed;
        }
        c = next();
      }
      pushed++;
      started = false;
      finished = false;
    }
    rewind();
    return pushed;
  };

  /** entities/lwpolyline.js parseEntity (7-53). Returns entity.vertices.length. */
  const parseLwPolyline = (start: Group): number => {
    let n = 0;
    let lwVertices = 0;
    let previousEntry: { ptr: number; n: number } | null = null;
    let c = next();
    while (!eof) {
      step();
      if (c.code === 0) break;
      if (c.code === 90) {
        n = intValue(c);
      } else if (c.code === 10) {
        // Same scanner position and n as the previous call: that call rewound two groups back onto
        // this group 10 (default branch, 87-94), so the parser cycles here forever.
        if (previousEntry && previousEntry.ptr === ptr && Object.is(previousEntry.n, n)) {
          const x = groupAt(ptr - 1)!;
          const after = groupAt(ptr);
          reject(`en la LWPOLYLINE de la línea ${start.line}, el código 10 de la línea ${x.line} va seguido del código ${quote(after?.codeText ?? "")}${after ? ` (línea ${after.line})` : ""} y no de su coordenada Y (código 20)`);
        }
        previousEntry = { ptr, n };
        lwVertices = parseLwVertices(n);
      } else if (c.code === 101) {
        skipEmbeddedObject(c);
      }
      c = next();
    }
    return lwVertices;
  };

  // ── DxfParser.js _parse (85-693): `curr` is shared by every section parser ──
  let curr!: Group;

  /** parseEntities(forBlock) (625-659). Only the ENTITIES section feeds dxf.entities. */
  const parseEntities = (forBlock: boolean): void => {
    const ending = forBlock ? "ENDBLK" : "ENDSEC";
    if (!forBlock) {
      entities = 0; // dxf.entities is replaced by every ENTITIES section
      vertices = 0;
    }
    const count = (entityVertices: number): void => {
      if (forBlock) return;
      entities++;
      vertices += entityVertices;
      validateDxfComplexity(entities, vertices);
    };
    if (!forBlock) curr = next();
    for (;;) {
      step();
      if (curr.code === 0) {
        if (curr.raw === ending) break;
        const name = curr.raw;
        if (ENTITY_HANDLERS.has(name)) {
          if (name === "POLYLINE") count(parsePolyline(curr));
          else if (name === "LWPOLYLINE") count(parseLwPolyline(curr));
          else if (name === "3DFACE") count(parse3dFace());
          else if (name === "LINE") {
            let lineVertices = 0;
            parseGenericEntity(POINT_CODES.LINE!, (code) => { if (code === 10 || code === 11) lineVertices++; });
            count(lineVertices);
          } else {
            parseGenericEntity(POINT_CODES[name]!);
            count(name === "POINT" ? 1 : 0);
          }
          curr = lastRead();
        } else if (isPrototypeKey(name)) {
          throw STOP; // the "handler" is an Object.prototype member: parseEntity is not a function
        } else {
          curr = next();
        }
      } else {
        curr = next();
      }
    }
    if (!forBlock) curr = next();
  };

  /** parseHeader (142-183): every group is consumed until 0/ENDSEC. */
  const parseHeader = (): void => {
    let varValue: "null" | "object" | "primitive" = "null";
    curr = next();
    for (;;) {
      step();
      if (is0(curr, "ENDSEC")) break;
      if (curr.code !== 9) {
        if (curr.code === 10) varValue = "object";
        else if (curr.code === 20 || curr.code === 30) {
          if (varValue === "null") throw STOP; // currVarValue.y on null: TypeError in every build
        } else varValue = "primitive";
      }
      curr = next();
    }
    curr = next();
  };

  /** parseBlock (211-280). */
  const parseBlock = (): void => {
    curr = next();
    while (!is(curr, "EOF")) {
      step();
      switch (curr.code) {
        case 1: case 2: case 3: case 5: case 8: case 67: case 70: case 100: case 330:
          curr = next();
          break;
        case 10:
          localParsePoint(curr);
          curr = next();
          break;
        case 0:
          if (curr.raw !== "ENDBLK") parseEntities(true);
          break;
        default:
          curr = next();
      }
      if (is0(curr, "ENDBLK")) {
        curr = next();
        break;
      }
    }
  };

  /** parseBlocks (187-210). */
  const parseBlocks = (): void => {
    curr = next();
    while (!is(curr, "EOF")) {
      step();
      if (is0(curr, "ENDSEC")) break;
      if (is0(curr, "BLOCK")) parseBlock();
      else curr = next();
    }
  };

  /** parseViewPortRecords (372-503) / parseLayers (553-599): a foreign 0-group is never consumed. */
  const parseStallingRecords = (kind: "VPORT" | "LAYER", tableStart: Group): void => {
    curr = next();
    while (!is0(curr, "ENDTAB")) {
      step();
      if (curr.code === 0) {
        if (curr.raw !== kind) {
          reject(`la tabla ${kind} de la línea ${tableStart.line} contiene ${quote(curr.raw)} en la línea ${curr.line} antes de cerrarse con ENDTAB (dxf-parser no consume ese grupo dentro de la tabla)`);
        }
        curr = next();
      } else if (kind === "VPORT" && VPORT_POINT_CODES.has(curr.code)) {
        localParsePoint(curr);
        curr = next();
      } else {
        curr = next();
      }
    }
  };

  /** parseLineTypes (504-552): always advances; mirrors its TypeErrors on a missing pattern. */
  const parseLineTypeRecords = (): void => {
    let declared = 0;
    let hasPattern = false;
    curr = next();
    while (!is0(curr, "ENDTAB")) {
      step();
      if (curr.code === 73) {
        declared = intValue(curr);
        if (declared > 0) hasPattern = true;
      } else if (curr.code === 49) {
        if (!hasPattern) throw STOP; // ltype.pattern.push on undefined
      } else if (curr.code === 0) {
        if (declared > 0 && !hasPattern) throw STOP; // ltype.pattern.length on undefined
        hasPattern = false; // ltype = {}
      }
      curr = next();
    }
  };

  /**
   * parseTable(group) (312-371). Only a 0-group equal to the table's record type opens the
   * records; every other 0-group, a nested 0/TABLE included, is ignored and the table goes on.
   */
  const parseTable = (kind: TableKind, tableStart: Group): void => {
    curr = next();
    while (!is0(curr, "ENDTAB")) {
      step();
      if (curr.code === 0 && kind !== "PROTOTYPE" && curr.raw === kind) {
        if (kind === "LTYPE") parseLineTypeRecords();
        else parseStallingRecords(kind, tableStart);
      } else {
        curr = next(); // 5, 330, 100, 70, default, and 0-groups that do not open records
      }
    }
    curr = next();
  };

  /** parseTables (285-310): the group after 0/TABLE names the table, whatever its code. */
  const parseTables = (): void => {
    curr = next();
    while (!is(curr, "EOF")) {
      step();
      if (is0(curr, "ENDSEC")) break;
      if (is0(curr, "TABLE")) {
        const tableStart = curr;
        curr = next();
        let kind: TableKind | null = null;
        if (valueIsString(curr.code)) {
          const name = curr.raw;
          if (name === "VPORT" || name === "LTYPE" || name === "LAYER") kind = name;
          else if (isPrototypeKey(name)) kind = "PROTOTYPE";
        }
        if (kind) parseTable(kind, tableStart);
        // Unknown name: curr stays on the name group (DxfParser.js 299-301).
      } else {
        curr = next();
      }
    }
    curr = next();
  };

  /** parseAll (94-137). */
  const parseAll = (): void => {
    curr = next();
    while (!eof) {
      step();
      if (is0(curr, "SECTION")) {
        curr = next();
        if (curr.code !== 2) {
          curr = next();
          continue;
        }
        if (curr.raw === "HEADER") parseHeader();
        else if (curr.raw === "BLOCKS") parseBlocks();
        else if (curr.raw === "ENTITIES") parseEntities(false);
        else if (curr.raw === "TABLES") parseTables();
        // "EOF" and unknown sections: curr stays on the name group.
      } else {
        curr = next();
      }
    }
  };

  try {
    if (!groupAt(0)) throw STOP; // "Empty file" (DxfParser.js 90-91)
    parseAll();
  } catch (error) {
    if (!(error instanceof ParserStops)) throw error;
  }
  return { entities, vertices };
}
