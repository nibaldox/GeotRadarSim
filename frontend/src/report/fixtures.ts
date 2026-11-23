import { LOSCellState } from "../types/api";
import { RADAR_COLORS } from "../store/analysisStore";
import type { ReportCoverageMetrics, ReportModel, ReportRadar } from "./types";

const ROWS = 30;
const COLS = 40;
const RES = 5;
const SIZE = ROWS * COLS;
const CELL_AREA = RES * RES;

/** Grilla sintética con pendiente, loma y un hueco; no contiene datos reales. */
function makeFixture(radarCount: 1 | 3): ReportModel {
  const elevations = new Float32Array(SIZE);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const hill = 18 * Math.exp(-((col - 21) ** 2 + (row - 15) ** 2) / 60);
      elevations[row * COLS + col] = 100 + col * 0.5 + row * 0.25 + hill;
    }
  }
  // Hueco en la esquina noroeste de la grilla, compartido por todos los radares.
  elevations[(ROWS - 1) * COLS] = NaN;
  const validElevations = [...elevations].filter(Number.isFinite);
  const positions = [{ col: 6, row: 7 }, { col: 20, row: 7 }, { col: 33, row: 7 }];

  // El área rectangular está delimitada por nodos, en coordenadas del terreno.
  const aoi = { vertices: [{ x: 50, y: 30 }, { x: 145, y: 30 }, { x: 145, y: 110 }, { x: 50, y: 110 }], areaM2: 95 * 80 };
  const inAoi = (index: number) => {
    const x = (index % COLS) * RES;
    const y = Math.floor(index / COLS) * RES;
    return x >= 50 && x <= 145 && y >= 30 && y <= 110;
  };
  const metrics = (states: Uint8Array, quality: Float32Array): ReportCoverageMetrics => {
    let visible = 0, shadow = 0, useful = 0, aoiTotal = 0, aoiVisible = 0, aoiUseful = 0;
    const bands = { low: 0, medium: 0, high: 0, noIndex: 0 };
    for (let i = 0; i < SIZE; i++) {
      if (Number.isFinite(elevations[i]) && inAoi(i)) aoiTotal++;
      if (states[i] === LOSCellState.SHADOW) shadow++;
      if (states[i] !== LOSCellState.VISIBLE) continue;
      visible++;
      const q = quality[i]!;
      if (!Number.isFinite(q)) bands.noIndex++;
      else if (q < 0.3) bands.low++;
      else if (q < 0.7) { bands.medium++; useful++; }
      else { bands.high++; useful++; }
      if (inAoi(i)) { aoiVisible++; if (Number.isFinite(q) && q >= 0.3) aoiUseful++; }
    }
    const pct = (n: number, d: number) => d ? 100 * n / d : 0;
    return {
      visiblePct: pct(visible, visible + shadow), visibleAreaM2: visible * CELL_AREA,
      usefulPct: pct(useful, SIZE - 1), usefulAreaM2: useful * CELL_AREA,
      bandsPct: { low: pct(bands.low, visible), medium: pct(bands.medium, visible), high: pct(bands.high, visible), noIndex: pct(bands.noIndex, visible) },
      aoi: { areaM2: aoi.areaM2, visiblePct: pct(aoiVisible, aoiTotal), usefulPct: pct(aoiUseful, aoiTotal) },
    };
  };
  const radars: ReportRadar[] = positions.slice(0, radarCount).map(({ col: radarCol, row: radarRow }, index) => {
    const cellStates = new Uint8Array(SIZE);
    const qualityValues = new Float32Array(SIZE).fill(NaN);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        // Tres franjas de visibilidad que se solapan; la franja superior es sombra.
        if (!Number.isFinite(elevations[i])) cellStates[i] = LOSCellState.NODATA;
        else if (Math.abs(col - radarCol) > (index === 1 ? 13 : 9)) cellStates[i] = LOSCellState.OUT_OF_RANGE;
        else if (row >= 25) cellStates[i] = LOSCellState.SHADOW;
        else {
          cellStates[i] = LOSCellState.VISIBLE;
          // Baja, media, alta y celdas visibles sin índice.
          if (i % 19 !== 0) qualityValues[i] = [0.15, 0.5, 0.85][(col + row + index) % 3]!;
        }
      }
    }
    const groundZ = elevations[radarRow * COLS + radarCol]!;
    return {
      index, label: `Radar ${index + 1}`, radarId: `radar-${index + 1}`, modelId: "synthetic-model",
      modelName: "Modelo sintético", color: RADAR_COLORS[index]!,
      position: { x: radarCol * RES, y: radarRow * RES, z: groundZ + 5 }, groundZ,
      heightAboveGround: 5, rangeM: 150, azimuthDeg: null, apertureDeg: null,
      analysisId: `analysis-${index + 1}`, cellStates, qualityValues,
      metrics: metrics(cellStates, qualityValues), exclusiveAreaM2: radarCount === 1 ? null : 0,
    };
  });

  let union: ReportModel["union"] = null;
  if (radarCount === 3) {
    const cellStates = new Uint8Array(SIZE);
    const visibleCount = new Uint8Array(SIZE);
    const qualityValues = new Float32Array(SIZE).fill(NaN);
    let overlapAreaM2 = 0;
    for (let i = 0; i < SIZE; i++) {
      const seen = radars.filter((radar) => radar.cellStates[i] === LOSCellState.VISIBLE);
      visibleCount[i] = seen.length;
      if (!Number.isFinite(elevations[i])) cellStates[i] = LOSCellState.NODATA;
      else if (seen.length) {
        cellStates[i] = LOSCellState.VISIBLE;
        const values = seen.map((radar) => radar.qualityValues![i]!).filter(Number.isFinite);
        if (values.length) qualityValues[i] = Math.max(...values);
        if (seen.length === 1) seen[0]!.exclusiveAreaM2! += CELL_AREA;
        else overlapAreaM2 += CELL_AREA;
      } else if (radars.some((radar) => radar.cellStates[i] === LOSCellState.SHADOW)) cellStates[i] = LOSCellState.SHADOW;
      else cellStates[i] = LOSCellState.OUT_OF_RANGE;
    }
    union = { cellStates, visibleCount, qualityValues, metrics: metrics(cellStates, qualityValues), overlapAreaM2 };
  }

  return {
    version: 1, createdAtIso: "2026-01-01T00:00:00.000Z", title: "Informe de cobertura de radares",
    terrain: { terrainId: "synthetic-terrain", epoch: 1, rows: ROWS, cols: COLS, resolution: RES,
      bounds: { min_x: 0, max_x: (COLS - 1) * RES, min_y: 0, max_y: (ROWS - 1) * RES,
        min_z: Math.min(...validElevations), max_z: Math.max(...validElevations) }, elevations },
    policy: { mediumMin: 0.3, highMin: 0.7 }, metric: "INCIDENCE", qualityModel: "geometric-v2",
    radars, union, aoi, provenance: { generation: 1, sourceAnalysisIds: radars.map((radar) => radar.analysisId) },
  };
}

export function reportFixture3(): ReportModel { return makeFixture(3); }
export function reportFixture1(): ReportModel { return makeFixture(1); }
