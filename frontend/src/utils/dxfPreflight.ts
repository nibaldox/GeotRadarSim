/**
 * Structural preflight for DXF text, run in the terrain Worker BEFORE `dxf-parser` sees it.
 *
 * `dxf-parser@1.1.2` (the latest release) has loops that stop advancing its scanner on some
 * malformed inputs, so `parseSync` spins forever (audit: plans/rust-wasm/evidence/c2a/audit):
 *
 * 1. `entities/polyline.js` `parsePolylineVertices`: after a POLYLINE (or one of its VERTEX),
 *    any 0-group other than VERTEX, SEQEND or EOF is never consumed (56 bytes are enough).
 * 2. `DxfParser.js` `parseViewPortRecords` / `parseLayers`: once a VPORT or LAYER table has
 *    started its records, any 0-group other than that record type or ENDTAB (EOF included) is
 *    never consumed.
 * 3. `entities/lwpolyline.js`: in a LWPOLYLINE, a group 10 directly followed by a group outside
 *    {0, 10, 20, 30, 40, 41, 42} makes the vertex reader rewind two groups and re-enter forever.
 * 4. `entities/lwpolyline.js`: the vertex loop runs code-90 times even without vertices, so one
 *    entity declaring 2 000 000 000 vertices exhausts memory.
 *
 * This preflight reads the code/value pairs exactly like the scanner (same line splitting,
 * `parseInt` codes, trimmed values, stop at the first 0/EOF) in one O(n) pass without
 * allocating the line array, and rejects those structures. The rules are global, so they are a
 * superset of what the parser can reach: they only reject files that break the DXF reference
 * (a POLYLINE always ends in SEQEND, a VPORT/LAYER table holds only its records before ENDTAB,
 * an LWPOLYLINE X coordinate is followed by its Y).
 *
 * It also applies the S2 limits early, counting the ENTITIES-section entities and vertices the
 * same way as the post-parse check in the Worker (which stays as a second line of defense).
 */
import { MAX_DXF_VERTICES, validateDxfComplexity } from "./terrainLimits";

/** Entities and vertices the post-parse S2 check will count for this text. */
export interface DxfPreflightSummary {
  entities: number;
  vertices: number;
}

/** Entity types with a handler in dxf-parser@1.1.2; only these end up in `dxf.entities`. */
const PARSED_ENTITY_TYPES = new Set([
  "3DFACE", "ARC", "ATTDEF", "CIRCLE", "DIMENSION", "ELLIPSE", "INSERT", "LINE",
  "LWPOLYLINE", "MTEXT", "POINT", "POLYLINE", "SOLID", "SPLINE", "TEXT",
]);

/** Group codes the LWPOLYLINE vertex reader accepts right after a group 10. */
const LWPOLYLINE_AFTER_X = new Set([0, 10, 20, 30, 40, 41, 42]);

const PREFIX = "DXF rechazado: ";

function quote(value: string): string {
  const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return `«${shown}»`;
}

function reject(detail: string): never {
  throw new Error(`${PREFIX}${detail}. dxf-parser no puede leer esta estructura sin bloquearse; revisa o vuelve a exportar el archivo.`);
}

export function preflightDxf(text: string): DxfPreflightSummary {
  const length = text.length;
  let cursor = 0;
  let exhausted = false;
  let lineNumber = 0;

  // Same lines as `text.split(/\r\n|\r|\n/g)`, read lazily.
  const readLine = (): string | undefined => {
    if (exhausted) return undefined;
    let end = cursor;
    while (end < length) {
      const ch = text.charCodeAt(end);
      if (ch === 10 || ch === 13) break;
      end++;
    }
    const line = text.slice(cursor, end);
    if (end >= length) {
      exhausted = true;
    } else if (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) {
      cursor = end + 2;
    } else {
      cursor = end + 1;
    }
    lineNumber++;
    return line;
  };

  let section: string | null = null;
  let expectSectionName = false;

  let polylineLine = 0; // > 0 while a POLYLINE waits for SEQEND
  let tableNamePending = false;
  let recordTable: "VPORT" | "LAYER" | null = null;
  let recordTableLine = 0;
  let recordsStarted = false;

  let entityType: string | null = null;
  let entityLine = 0;
  let lwDeclared = 0;
  let lwTens = 0;
  let lwSkipRest = false; // after group 101 the parser skips to the next 0-group
  let lwPrevWasX = false;
  let lwPhantomVertices = 0;

  let entities = 0;
  let vertices = 0;

  const countVertices = (count: number): void => {
    if (section !== "ENTITIES" || count <= 0) return;
    vertices += count;
    validateDxfComplexity(entities, vertices);
  };

  const closeEntity = (): void => {
    if (entityType !== "LWPOLYLINE") return;
    // The parser pushes code-90 vertices even when the entity has fewer X groups: bound that
    // padding file-wide (BLOCKS included) before it can become an allocation bomb.
    lwPhantomVertices += Math.max(0, lwDeclared - lwTens);
    if (lwPhantomVertices > MAX_DXF_VERTICES) {
      reject(`las LWPOLYLINE declaran en el código 90 ${lwPhantomVertices} vértices más de los que contienen (la última, en la línea ${entityLine}); el máximo admitido es ${MAX_DXF_VERTICES}`);
    }
    countVertices(lwDeclared);
  };

  for (;;) {
    const codeLine = readLine();
    if (codeLine === undefined) break;
    const groupLine = lineNumber;
    const valueLine = readLine();
    if (valueLine === undefined) break; // the scanner ignores a dangling last line too
    // Must match DxfArrayScanner: parseInt without a radix, so " 0", "0.0" and "0x0A" (10) all count.
    const code = parseInt(codeLine);

    if (entityType === "LWPOLYLINE" && !lwSkipRest && lwPrevWasX && !LWPOLYLINE_AFTER_X.has(code)) {
      reject(`en la LWPOLYLINE de la línea ${entityLine}, el código 10 de la línea ${groupLine - 2} va seguido del código ${quote(codeLine.trim())} (línea ${groupLine}) y no de su coordenada Y (código 20)`);
    }

    // The group right after 0/TABLE names the table, whatever its code (as parseTables reads it).
    let namesTable = false;
    if (tableNamePending) {
      tableNamePending = false;
      namesTable = true;
      const name = valueLine.trim();
      if (name === "VPORT" || name === "LAYER") {
        recordTable = name;
        recordTableLine = groupLine;
        recordsStarted = false;
      }
    }

    if (expectSectionName) {
      expectSectionName = false;
      if (code === 2) section = valueLine.trim();
    }

    if (code !== 0) {
      if (entityType === "LWPOLYLINE" && !lwSkipRest) {
        if (code === 90) {
          // The scanner reads code 90 with parseInt as well.
          const declared = parseInt(valueLine.trim());
          if (Number.isFinite(declared) && declared > lwDeclared) lwDeclared = declared;
        } else if (code === 10) {
          lwTens++;
        } else if (code === 101) {
          lwSkipRest = true;
        }
        lwPrevWasX = code === 10;
      } else if (entityType === "LINE" && (code === 10 || code === 11)) {
        countVertices(1);
      } else if (entityType === "3DFACE" && code >= 10 && code <= 13) {
        countVertices(1);
      }
      continue;
    }

    const value = valueLine.trim();

    if (recordTable !== null && !namesTable) {
      if (value === "ENDTAB") {
        recordTable = null;
      } else if (value === recordTable) {
        recordsStarted = true;
      } else if (recordsStarted || value === "ENDSEC" || value === "EOF") {
        reject(`la tabla ${recordTable} de la línea ${recordTableLine} contiene ${quote(value)} en la línea ${groupLine} antes de cerrarse con ENDTAB`);
      }
    }

    if (polylineLine > 0) {
      if (value === "VERTEX") {
        closeEntity();
        entityType = "VERTEX";
        countVertices(1);
        continue;
      }
      if (value === "SEQEND") {
        closeEntity();
        polylineLine = 0;
        entityType = "SEQEND";
        continue;
      }
      reject(`la POLYLINE de la línea ${polylineLine} no termina con SEQEND antes de ${quote(value)} en la línea ${groupLine}`);
    }

    closeEntity();
    if (value === "EOF") break;

    entityType = value;
    entityLine = groupLine;
    lwDeclared = 0;
    lwTens = 0;
    lwSkipRest = false;
    lwPrevWasX = false;

    if (value === "SECTION") expectSectionName = true;
    else if (value === "ENDSEC") section = null;
    else if (value === "TABLE") tableNamePending = true;
    else if (value === "POLYLINE") polylineLine = groupLine;

    if (section === "ENTITIES" && PARSED_ENTITY_TYPES.has(value)) {
      entities++;
      validateDxfComplexity(entities, vertices);
      if (value === "POINT") countVertices(1);
    }
  }

  closeEntity();
  if (polylineLine > 0) {
    reject(`la POLYLINE de la línea ${polylineLine} no termina con SEQEND antes del fin del archivo`);
  }
  if (recordTable !== null && recordsStarted) {
    reject(`la tabla ${recordTable} de la línea ${recordTableLine} no se cierra con ENDTAB antes del fin del archivo`);
  }
  return { entities, vertices };
}
