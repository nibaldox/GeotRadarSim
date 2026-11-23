/**
 * Specification of the «Sugerir ubicación» run (`suggest_radar_positions`): description,
 * argument schema with its defaults, and result budget. Copied verbatim from the former
 * 18-tool catalog; the panel validates its arguments against this schema.
 */

import type { JsonSchema } from "./validate";

export interface ToolSpecEntry {
  description: string;
  parameters: JsonSchema;
  maxResultBytes: number;
}

export const SUGGEST_RADAR_POSITIONS_SPEC: ToolSpecEntry = {
  description: "Ejecuta el optimizador determinista de la app y corre el cálculo completo de línea de visión de hasta k posiciones elegidas (C1…): las agrega al historial como [A#] y cambia la posición del radar. No hace falta llamar a run_los_analysis después. Las cifras se citan con esos [A#] o su unión; el puntaje grueso solo ordena y no se cita.",
  parameters: {
    "type": "object",
    "properties": {
      "k": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4
      },
      "objective": {
        "type": "string",
        "enum": [
          "VISIBLE_AREA",
          "USEFUL_INCIDENCE",
          "USEFUL_PROJECTION"
        ],
        "default": "USEFUL_INCIDENCE",
        "description": "VISIBLE_AREA = celdas VISIBLE; USEFUL_* = celdas VISIBLE con índice >= umbral medio de la política."
      },
      "keep_analysis_refs": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^A[0-9]{1,3}$",
          "description": "Referencia corta de análisis (A1, A2…) devuelta por otra herramienta."
        },
        "maxItems": 3,
        "uniqueItems": true,
        "default": [],
        "description": "Radares ya ubicados (análisis del historial) que se mantienen fijos."
      },
      "candidate_set": {
        "type": "string",
        "enum": [
          "edges_and_berms",
          "regular_grid"
        ],
        "default": "edges_and_berms"
      },
      "min_separation_m": {
        "type": "number",
        "minimum": 0,
        "maximum": 5000,
        "default": 50
      },
      "height_above_ground_m": {
        "type": "number",
        "minimum": 0,
        "maximum": 50,
        "default": 2
      },
      "time_budget_s": {
        "type": "integer",
        "minimum": 10,
        "maximum": 600,
        "default": 90
      }
    },
    "required": [
      "k"
    ],
    "additionalProperties": false
  },
  maxResultBytes: 2500,
};

export const TOOL_SPECS = {
  suggest_radar_positions: SUGGEST_RADAR_POSITIONS_SPEC,
} as const satisfies Readonly<Record<string, ToolSpecEntry>>;
