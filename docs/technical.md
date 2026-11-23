# GeotRadarSim — technical reference

> [Leer en español](tecnico.md) · [Back to the README](../README.md)

This page keeps the detailed semantics of the geometric model, the metrics and the exports. The interface is in
Spanish; labels are quoted exactly as they appear, with an English translation in parentheses.

GeotRadarSim is a geometric terrain-analysis aid, not a validated radar or radio-frequency (RF) simulator. It does
**not** calculate or measure SNR, received signal power, detection probability or field performance.

## Contents

- [Workflows](#workflows)
- [Cell states](#cell-states)
- [LOS metrics](#los-metrics)
- [Geometric quality layers (geometric-v2)](#geometric-quality-layers-geometric-v2)
- [Area to monitor and placement suggestion](#area-to-monitor-and-placement-suggestion)
- [Exports](#exports)
- [Bundled radar profiles](#bundled-radar-profiles)
- [Terrain input and gridding](#terrain-input-and-gridding)
- [Architecture](#architecture)
- [Limits](#limits)

## Workflows

### One radar position

1. In **Terreno** (Terrain), load a DXF or STL file with **Cargar STL / DXF** (Load STL / DXF), or load the example
   pit with **Terreno sintético** (Synthetic terrain).
2. In **Radar**, choose a **Modelo de radar** (radar model). **Parámetros** (Parameters) lets you override range,
   elevation, azimuth and aperture.
3. Place the radar: use the viewer tool **Agregar radar** (Add radar) and click the terrain, or type **E / N / Cota**
   (Easting / Northing / Elevation) and press **Aplicar** (Apply). A click places the radar 2 m above the sampled
   surface; typed coordinates are used as given. The LOS analysis then runs automatically.
4. Read the result in the figures bar above the viewer and in **Resultados** (Results).

### Several positions (geometric union)

1. Create separate analyses by changing the position and/or the configured limits. Each one becomes a line in
   **Historial** (History).
2. Tick the entries to include. Their cell-level LOS states are combined on the same terrain grid: for finite
   terrain samples, the merged cell is `VISIBLE` when at least one selected individual analysis reports `VISIBLE`.
3. The merged metrics are recomputed from the merged states. This is a geometric union, not a combination of radar
   signals.

### 3D sensitivity layer

1. Select one or more compatible individual analyses in **Historial**.
2. In **Sensibilidad 3D** (3D sensitivity), choose the **Modo de capa del terreno** (terrain layer mode) —
   **Incidencia superficial** (surface incidence) or **Proyección del movimiento** (movement projection) — and press
   **Calcular mapa de sensibilidad** (compute sensitivity map).
3. At each finite terrain cell where both gradient axes can be computed from central or available one-sided
   neighbours, only selected analyses whose **individual** LOS state is `VISIBLE` contribute. `observer_count` is the
   per-cell contributor count; one contributor scores `|dot|`, several contributors use
   `sqrt(sum(dot_i²) / observer_count)` (RMS). The result is a dimensionless geometric projection, not SNR, RF
   sensitivity or a physical 3D radar model.
4. A `VISIBLE` LOS state alone is not enough: if either terrain-gradient axis is unavailable, that observation does
   not contribute. Cells with `observer_count = 0` are no data and transparent (`NaN`); a finite zero with
   `observer_count > 0` is a measured result.

The layer modes describe two geometric indices and how several positions are aggregated on the 3D terrain. They are
not separate physical radar modes.

## Cell states

LOS is evaluated on the regular terrain grid. The ray traversal visits grid-line and grid-diagonal crossings and
checks the triangles that form the sampled surface; it does not trace the original STL facets. Horizontal range is
measured in the map plane; elevation and azimuth limits are geometric constraints.

| Cell state | Meaning |
|---|---|
| `NODATA` | The target grid sample has no finite elevation |
| `OUT_OF_RANGE` | The target is outside the configured horizontal minimum/maximum range |
| `OUTSIDE_FOV` | The target is outside the configured elevation or azimuth limits |
| `UNKNOWN_RAY` | The ray crosses part of the grid where a valid terrain triangle is unavailable |
| `SHADOW` | A valid terrain triangle obstructs the straight geometric ray |
| `VISIBLE` | The target is within the configured limits and no traversed terrain triangle obstructs the ray |

These are geometric classifications of the gridded surface. They do not represent measured radar detection or signal
quality.

## LOS metrics

The LOS metrics use candidate samples in the states `VISIBLE`, `SHADOW` or `UNKNOWN_RAY`:

- **Coverage (%)** = `VISIBLE / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`. The app shows it as **Visibilidad
  (candidatos)** (visibility, candidates) and **Visibilidad** in the figures bar.
- **Completeness (%)** = `(VISIBLE + SHADOW) / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100` (**Completitud**).
- `NODATA`, `OUT_OF_RANGE` and `OUTSIDE_FOV` samples are excluded from both denominators. With no candidate samples,
  coverage and completeness are `null` (shown as no data), not 0 %.
- **Visible area** = `VISIBLE` sample count × grid resolution². It is a planimetric grid estimate, not a measured 3D
  slope area.
- **Shadow zones** are connected components of `SHADOW` samples with four-neighbour connectivity.

## Geometric quality layers (geometric-v2)

The quality layers are geometric indices painted only on `VISIBLE` cells. They are not SNR, received power, a
propagation model or validated radar quality.

- **Incidencia superficial** (surface incidence) — for `VISIBLE` cells, the 0–1 alignment of the terrain surface
  normal with the LOS direction from terrain to radar. Distance is **not** a multiplier: the configured maximum range
  only decides which cells are eligible and cannot change the score of a cell that stays `VISIBLE`.
- **Proyección del movimiento** (movement projection) — the projection of the LOS on the terrain's maximum-slope
  direction (the normalised downhill tangent, with a downward-vertical fallback on flat terrain): one contributor
  scores `|dot|`, several use the RMS above. A measured zero has at least one contributor; no contributor means no
  data, not zero. It is a scalar projection under an assumed maximum-slope motion, not a volumetric reconstruction or
  a 3-axis displacement inversion.
- **Useful coverage vs. visible distribution** — useful cells are `VISIBLE` cells whose selected index is measured
  (finite, 0–1) and classified medium or high. **Cobertura útil** (useful coverage) is that count over the common
  target **Topografía válida completa** (full valid topography: every finite terrain-grid node, independent of the
  radar footprint). The target area is nominal planar area (`cells × resolution²`), not inclined 3D area. The
  low / medium / high / no-index distribution and the medium + high share are computed over `VISIBLE` cells only.
  **Área útil** (useful area) is the useful cell count × resolution². The summary is computed per metric and bound to
  the result's terrain epoch and analysis provenance; when the result is legacy/unversioned or comes from another
  terrain or epoch, the index is reported as not available and a rerun is requested. Missing data is never reported
  as zero.
- **Provisional configurable bands** — the band policy defaults to `media ≥ 0.3`, `alta ≥ 0.7` and is edited in
  **Ajustes → Bandas de calidad** (Settings → Quality bands). Editing the thresholds reclassifies existing scores
  without rerunning LOS. Invalid thresholds (`0 ≤ media mínima < alta mínima ≤ 1`, distinct at Float32 precision) are
  rejected visibly instead of being reordered. Classification runs in Float32 — values and thresholds are compared
  after rounding to Float32, so the counts always agree with the colours painted by the GPU — with half-open
  intervals: low `[0, media)`, medium `[media, alta)`, high `[alta, 1]`. These are geometric-index ranges, not
  equipment-certified detection thresholds.
- **Transparency and measured zero** — `NODATA`, `OUT_OF_RANGE`, `OUTSIDE_FOV`, `UNKNOWN_RAY` and `SHADOW` are
  unobserved and not painted: the base terrain shows through. A missing index (for example a `VISIBLE` cell without
  a computable gradient) is transparent too. A measured `0.0` is data and stays coloured in the low band.
  Transparency alone does not identify its cause; it does not mean shadow.
- **Colours** — incidence uses a continuous gradient anchored to the band cut-offs (low red, medium orange, high
  green); movement projection uses a fixed continuous violet–blue–cyan–green gradient. Both are painted on observed
  cells only. Radar markers in the 3D view are plain core-and-post icons.
- **Merged analyses** — with several analyses selected, merged incidence takes the maximum individual finite
  incidence at each merged `VISIBLE` cell and merged movement projection is the RMS across contributing analyses;
  missing values are excluded instead of counted as zeros.

## Area to monitor and placement suggestion

- **Área a monitorear** (area to monitor) — a viewer tool. Click the terrain to add vertices and close the polygon by
  clicking the first vertex or double-clicking; drag vertices to edit it, and remove it with **Borrar área** (clear
  area). **Resultados → Cobertura del área** (area coverage) and the figures bar then report how much of the area is
  visible and usefully covered.
- **Sugerir ubicación** (suggest location) — a deterministic calculation: the same inputs give the same result. It
  generates candidates on berms, the crest and the perimeter; when an area is defined it also considers open ground
  outside the area and within range. Candidates are evaluated with a coarse line-of-sight pass, radars are chosen
  greedily and every proposal is checked with the full calculation; verified results stay in **Historial**.
  - Options: **Radares** (1–4), **Objetivo** (objective: **Cobertura útil (incidencia)**, **Área visible** or
    **Cobertura útil (proyección del movimiento)**), **Usar el área a monitorear** (use the area to monitor),
    **Conservar los radares seleccionados en el historial** (keep the selected radars) and **Separación mínima (m)**
    (minimum separation).
  - For the visibility and incidence objectives, the greedy selection guarantees at least 63 % of the optimum
    (`1 − 1/e`); there is no such guarantee for projection. The default time budget is 90 seconds and the calculation
    can be stopped with **Detener**. A result is discarded if the terrain, the band policy or the area changes.

## Exports

The footer of the sidebar holds the exports. All of them use the active compatible analysis.

- **Informe para reunión** (meeting report) — a PDF with a 3D cover, a radar table with coordinates, a map for each
  radar and a consolidated map that separates areas seen by only one radar from areas seen by two or more. With two
  or more radars it adds a consolidated quality map (red, yellow and green bands for incidence, the same colours as
  the per-radar maps): each area takes the best incidence among the radars that see it, or the root mean square of
  their projections, exactly as the app combines them, so its useful area equals the union's. An
  optional **Título del informe** (report title) is printed on the cover. Its figures match the interface.
- **PDF técnico** (technical PDF) and **CSV** — carry the same classification policy and provenance as the on-screen
  summary: thresholds marked provisional (no certified accuracy), the Float32 classification precision, the metric,
  the quality model `geometric-v2`, the terrain id/epoch and the analysis ids.
  - For geometric-v2 results the CSV per-cell columns are `row,col,state,incidence,projection,shadowed` (legacy
    results keep `row,col,state,quality,shadowed`). `incidence` / `projection` are written only for `VISIBLE` cells
    with a measured index, as Float32 round-trip tokens (the shortest decimal that parses back to the same Float32; a
    measured zero is `0`, and the field is blank for not-visible or no-index cells) instead of a 4-decimal rounding
    that could move a value across a threshold.
  - The quality report is added only from a context captured at the export click that still matches the exported
    snapshot and result; every number is re-derived from the exported result, and a context that does not match is
    rejected. Legacy or unversioned results export without a quality report rather than inventing one.
- **PNG** — a capture of the current 3D view.

## Bundled radar profiles

The app contains hard-coded **local software profiles**. The model names are labels; the values are application
defaults, **not manufacturer specifications or validated operating limits**. Override them in **Parámetros** to match
a separately verified scenario.

| Local profile label | Default range | Elevation interval | Default azimuth sector |
|---|---:|---:|---:|
| GroundProbe SSR-FX | 50–2500 m | −60° to +60° | −75° to +75° (150° total) |
| IBIS-ArcSAR360 | 50–2500 m | −60° to +60° | 360° |
| Reutech MSR | 50–2500 m | −60° to +60° | −75° to +75° (150° total) |

The tool does not fetch or validate manufacturer specifications. A configured maximum range is only a geometric
cut-off, not a claim that an instrument can detect a target at that distance.

## Terrain input and gridding

| Format | Extension | Input handling |
|---|---|---|
| DXF | `.dxf` | Reads point, line, 3D face, polyline and lightweight-polyline vertices |
| STL | `.stl` | Reads ASCII and binary triangular facets |

- Input points become a regular elevation grid by local inverse-distance weighting (IDW within 3 × resolution, with
  the nearest point in the 3 × 3 neighbouring bins as fallback, and no data when no point is near). LOS then checks
  triangles of that grid; it is not a Delaunay triangulation of the imported points nor a ray test against the
  original STL facets.
- STL files with more than 500,000 facets are sampled before gridding.
- The import resolution is set with **Resolución de importación** (import resolution), 0.5–5 m.
- Grid nodes are spaced from each X/Y minimum by the resolution. If the span divided by the resolution is an integer
  within floating-point tolerance, the endpoint is included; otherwise the grid stops at
  `min + floor(span / resolution) × resolution` without a partial interval. Metadata `max_x` / `max_y` report the
  last sampled node (for example, a 200 m span at 3 m resolution ends at 198 m). A 200 m span therefore produces 101
  nodes at 2 m, 401 at 0.5 m and 67 at 3 m. Each axis needs at least two nodes; spans shorter than one resolution are
  rejected. The grid-size caps (see [Limits](#limits)) are checked before the grid is allocated.
- DXF elevation: `POINT` uses its parsed position; for `LWPOLYLINE`, a finite vertex Z takes precedence and a missing
  vertex Z falls back to the entity's finite elevation. Missing or non-finite required coordinates are rejected, not
  coerced to zero.
- Missing or invalid grid areas lead to `UNKNOWN_RAY` or `NODATA`, never to visible terrain.

### Example terrain

**Terreno sintético** loads a synthetic open pit of about 1.4 × 1.1 km (680 × 536 nodes at 2 m) with benches,
berms, a ramp, phases, a waste dump and about 301 m of relief. It was generated from scratch with a fixed seed and
contains no real survey data. It loads at 2 m, or is rebuilt at the chosen import resolution when that is coarser.
Provenance and the regeneration command are in
[`frontend/public/samples/README.md`](../frontend/public/samples/README.md).

## Architecture

```text
Browser (static site, no analysis backend)
├── React + Three.js viewer and compact sidebar
├── Terrain Worker      DXF/STL → regular IDW elevation grid
├── LOS Worker          ray traversal over grid triangles + quality indices
├── Sensitivity Worker  movement projection from selected visible analyses
├── Optimizer Worker    «Sugerir ubicación»: candidates, coarse LOS, greedy selection
└── Local state and client-side PDF / CSV / PNG exports
```

- The LOS, sensitivity and optimizer calculations use the Rust core (`rust/radar-core`) compiled to WebAssembly
  (`rust/radar-wasm`). A TypeScript implementation of LOS and sensitivity remains available and can be selected with
  the URL parameter `?engine=ts`.
- Workers start from a `blob:` bootstrap so they inherit the page's Content Security Policy. The production build sets
  `default-src 'self'` and `connect-src 'self'`: the app cannot connect to external origins, and terrain and results
  stay on the user's device.

## Limits

- Grid size: at most **16,384 nodes per axis** and **1,000,000 cells in total**; both apply.
- Each LOS calculation has a **120-second** deadline (plus a 125-second worker watchdog); an analysis can be rejected
  for time even when the grid is under the size cap.
- STL input above 500,000 facets is sampled. IDW resampling and the grid resolution affect the surface and the LOS
  classification.
- LOS is a straight geometric ray over the sampled grid. It does not model RF propagation, attenuation, SNR,
  detection probability, radar resolution or field performance.
- Coordinates use the terrain's own frame; the app does not store a datum or zone.
- Browser memory and WebGL limits depend on the device. No runtime benchmark is claimed.
- DXF entities with missing or zero elevation can produce a flat or unsuitable surface.
