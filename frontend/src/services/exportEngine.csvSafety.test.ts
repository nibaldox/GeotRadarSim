import { describe, expect, it } from "vitest";
import { generateCSVBlob, generatePDFBlob } from "./exportEngine";
import { LOSCellState } from "../types/api";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

const snapshot: AnalysisSnapshot = {
  terrainKey: { terrain_id: 'terrain,"x"\nnext', epoch: 1 }, analysisId: 'job',
  sourceAnalysisIds: ['=HYPERLINK("https://example.com")'], generation: 1,
  radars: [{ radarId: '+radar', radarModelId: '@model', position: { x: -12.5, y: 0, z: 1 },
    overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } }],
};
const result = { grid_rows: 1, grid_cols: 2, resolution: 1, cell_states: new Uint8Array([LOSCellState.VISIBLE, LOSCellState.SHADOW]), quality_grid: [[-0.5, 0]], coverage_pct: 20, completeness_pct: 100, visible_area_m2: 1, shadow_zones: [] } as unknown as LOSResponse;

// RFC 4180 state machine: embedded commas, quotes and line breaks are data.
function parseCsv(s: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === '"') { if (cell || closed) throw Error('unexpected quote'); quoted = true; }
    else if (c === ',' || c === '\n' || c === '\r') { row.push(cell); cell = ''; closed = false; if (c !== ',') { rows.push(row); row = []; if (c === '\r' && s[i + 1] === '\n') i++; } }
    else { if (closed) throw Error('unexpected character'); cell += c; }
  }
  if (quoted) throw Error('unterminated quote');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  return rows;
}

describe('CSV safety', () => {
  it('escapes text and neutralizes formulas while preserving numeric negatives', async () => {
    const text = await generateCSVBlob(snapshot, result).text();
    const rows = parseCsv(text);
    const value = (key: string) => rows.find(row => row[0] === `# ${key}`)?.[1];
    expect(value('Terrain ID')).toBe('terrain,"x"\nnext');
    expect(value('Analysis ID')).toBe('\'=HYPERLINK("https://example.com")');
    expect(value('Radar ID')).toBe("'+radar");
    expect(value('Radar Model')).toBe("'@model");
    expect(value('Radar Position X')).toBe('-12.500');
    expect(text).toContain('0,0,VISIBLE,-0.5000,0');
    const start = rows.findIndex(row => row[0] === 'row' && row[1] === 'col');
    expect(start).toBeGreaterThan(0);
    for (const row of rows.slice(start)) expect(row).toHaveLength(5);
  });
  it.each(['-cmd', '\tcmd', '\rcmd'])('quotes dangerous text %s', async (value) => {
    const text = await generateCSVBlob({ ...snapshot, terrainKey: { ...snapshot.terrainKey, terrain_id: value } }, result).text();
    expect(text).toContain(`# Terrain ID,"'${value}"`);
  });
  it('limits long multiline PDF metadata to one presentable line', async () => {
    const text = await generatePDFBlob({ ...snapshot, terrainKey: { ...snapshot.terrainKey, terrain_id: 'a'.repeat(200) + '\nsecond' } }, result).text();
    expect(text).not.toContain('a'.repeat(200));
    expect(text).not.toContain('second');
  });
});
