# 📡 GeotRadarSim — Geometric LOS Terrain Viewer for Slope Monitoring

**A browser-based tool for inspecting geometric line of sight (LOS) over user-supplied terrain.** It classifies terrain-grid samples using a radar/viewpoint position and configurable range, azimuth, and elevation limits.

> [Leer en Español 🇪🇸](README.es.md)

> This is a geometric terrain-analysis aid, not a validated radar or radio-frequency (RF) simulator. It does **not** calculate or measure SNR, received signal power, detection probability, or field performance.

🌐 **Live app:** [https://nibaldox.github.io/GeotRadarSim/](https://nibaldox.github.io/GeotRadarSim/)

---

## The Problem

When considering slope-monitoring radar positions, it can be useful to inspect which terrain samples are geometrically unobstructed from each proposed position and which are outside configured range or angular limits. GeotRadarSim helps visualize those relationships on a terrain grid.

It can help answer geometric questions:

- Which sampled slopes are inside the configured horizontal range and field of view?
- Which valid terrain triangles obstruct a straight line from the viewpoint?
- How does the geometric union change when analyses from multiple positions are selected?

It cannot answer whether a real radar will receive an adequate signal at a given distance. Use manufacturer data, site validation, and appropriate RF analysis for operational decisions.

---

## Features

| Feature | Description |
|---|---|
| 🗺️ **Terrain input** | Load DXF point/line/polyline data or an STL surface and convert it to a regular elevation grid |
| 🏗️ **Synthetic terrain** | Generate a simple bowl-shaped example surface for testing the interface and geometry |
| 📡 **Geometric LOS** | Classify grid samples as visible, shadowed, outside configured limits, no-data, or unknown-ray |
| ✅ **Geometric quality layers (v2)** | Paint the surface-incidence index or the slope-motion projection on observed cells only, under shared configurable provisional bands |
| 🎯 **Configurable limits** | Choose a bundled software profile and override range, elevation, and azimuth constraints |
| 🔴 **Multiple analyses** | Select compatible history entries to combine their cell-level geometric visibility |
| 🧮 **Geometric sensitivity** | Project the terrain's maximum-slope direction onto one or more individually visible LOS directions (one contributor: \|dot\|; several: RMS) |
| 📊 **Grid metrics** | Show candidate-cell coverage, completeness, visible grid area, shadow components, useful coverage over the full valid topography, and the visible-cell quality distribution |
| 📄 **PDF / CSV export** | Export the active compatible analysis, including per-cell LOS states and index columns in CSV and a useful-coverage report with policy and provenance |
| 🖼️ **PNG snapshot** | Capture the current 3D view |
| 🌐 **Client-side processing** | Terrain and LOS calculations run in browser workers; there is no analysis backend |

---

## Quick Start

### Online

Open [the hosted app](https://nibaldox.github.io/GeotRadarSim/).

### Run locally

```bash
git clone https://github.com/nibaldox/GeotRadarSim.git
cd GeotRadarSim/frontend
npm install
npm run dev
```

Open [http://localhost:5173/GeotRadarSim/](http://localhost:5173/GeotRadarSim/) in your browser.

---

## How to Use

### Single-viewpoint LOS analysis

1. **Load terrain** — upload a DXF or STL file, or generate the synthetic example.
2. **Choose a profile and limits** — select one of the bundled local profiles; optionally override its range, elevation, or azimuth values.
3. **Place the viewpoint** — click the terrain or enter coordinates. A click places it 2 m above the sampled surface; the LOS analysis runs automatically.
4. **Inspect the result** — read the per-cell states and candidate-cell metrics described below.

### Combine multiple analyses

1. Create separate analyses by changing the viewpoint and/or configured limits.
2. In **History**, select the entries to include. Their cell-level LOS states are combined on the same terrain grid; for finite terrain samples, the merged cell is `VISIBLE` when at least one selected individual analysis reports `VISIBLE` there.
3. The displayed merged metrics are recomputed from the merged states. This is a geometric union, not a combination of radar signals.

### Geometric sensitivity

1. Select one or more compatible individual analyses in **History**.
2. In **Sensibilidad Geométrica 3D / Geometric Sensitivity 3D**, choose the terrain-layer mode — **Incidencia superficial / Surface incidence** or **Proyección del movimiento / Movement projection** — and click **🗺️ Calcular Mapa de Sensibilidad 3D**. With several analyses selected, the merged incidence layer takes the maximum individual finite incidence value at each visible cell, and the merged movement projection uses the RMS across the contributing analyses.
3. At each finite terrain cell where both gradient axes can be computed from central or available one-sided neighbors, only selected analyses with an individual LOS state of `VISIBLE` contribute. `observer_count` is this per-cell contributor count; one contributor scores `|dot|`, while multiple contributors use `sqrt(sum(dot_i²) / observer_count)` (RMS). The result is a dimensionless geometric projection, not SNR, RF sensitivity, or a physical 3D radar model.
4. A `VISIBLE` LOS mask alone is not enough: if either terrain-gradient axis is unavailable, that observation does not contribute. Cells with `observer_count = 0` are no-data/transparent (`NaN`); a finite value of zero with `observer_count > 0` is a measured result.

The layer-mode labels describe two geometric indices and their multi-viewpoint aggregation/visualization on the 3D terrain. They do not indicate separate physical radar modes.

---

## Geometric Model and Result Semantics

LOS is evaluated on the regular terrain grid. The ray traversal visits grid-line and grid-diagonal crossings and checks the triangles that form the sampled surface. It does not trace the original STL mesh facets directly. Horizontal range is measured in the map plane; elevation and azimuth limits are geometric constraints.

| Cell state | Meaning |
|---|---|
| `NODATA` | The target grid sample has no finite elevation |
| `OUT_OF_RANGE` | The target is outside the configured horizontal minimum/maximum range |
| `OUTSIDE_FOV` | The target is outside the configured elevation or azimuth limits |
| `UNKNOWN_RAY` | The ray crosses a portion of the grid where a valid terrain triangle is unavailable |
| `SHADOW` | A valid terrain triangle obstructs the straight geometric ray |
| `VISIBLE` | The target is within configured limits and no traversed terrain triangle obstructs the ray |

These are geometric classifications of the gridded input surface. They do not represent measured radar detection or signal quality.

The LOS metrics use candidate samples in states `VISIBLE`, `SHADOW`, or `UNKNOWN_RAY`:

- **Coverage (%)** = `VISIBLE / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- **Completeness (%)** = `(VISIBLE + SHADOW) / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- `NODATA`, `OUT_OF_RANGE`, and `OUTSIDE_FOV` samples are excluded from both denominators. If there are no candidate samples, coverage and completeness are `null` (shown as no data), not 0%.
- **Visible area** is `VISIBLE sample count × grid resolution²`; it is a planimetric grid estimate, not a measured 3D slope-surface area.
- **Shadow zones** are connected components of `SHADOW` grid samples using four-neighbor connectivity.

### Geometric quality layers (geometric-v2)

The quality layers are geometric indices painted only on `VISIBLE` cells. They are not SNR, received power, a propagation model, or validated radar quality.

- **Surface incidence (Incidencia superficial)** — for `VISIBLE` cells, the 0–1 alignment of the terrain surface normal with the LOS direction from terrain to radar. Distance is **not** a multiplier: the configured maximum range only gates which cells are eligible for LOS and cannot change the score of a cell that stays `VISIBLE`.
- **Movement projection (Proyección del movimiento)** — the slope-motion projection of the LOS against the terrain's maximum-slope direction (the normalized downhill tangent, with a downward-vertical fallback on flat terrain): one contributor scores `|dot|`, several contributors use `sqrt(sum(dot_i²) / observer_count)` (RMS). A measured zero has at least one contributor; no contributors means no data, not zero. The 3D layer paints a scalar projection on the terrain surface under the assumed maximum-slope motion; it is not a volumetric reconstruction nor a full 3-axis displacement inversion.
- **Useful coverage vs visible distribution** — useful cells are `VISIBLE` cells whose selected index is measured (finite, 0–1) and classified medium or high. **Useful coverage** is that count over the shared target **Topografía válida completa** ("full valid topography": every finite terrain-grid node, independent of the radar footprint), and the reported target area is nominal planar area (`cells × resolution²`), not inclined 3D surface area. The low/medium/high/no-index **distribution** and the medium+high share are computed over `VISIBLE` cells only. The summary is computed per selected metric and is bound to the result's terrain epoch and analysis provenance; when the result is legacy/unversioned or from another terrain or epoch, the index is reported as not available and a rerun is requested — missing data is never reported as zero.
- **Provisional configurable bands** — the shared band policy defaults to `media ≥ 0.3`, `alta ≥ 0.7`, copied from the legacy legend and editable in the **Bandas de calidad** panel. Editing the thresholds reclassifies existing scores without rerunning LOS; invalid thresholds (`0 ≤ media mínima < alta mínima ≤ 1`, distinct at Float32 precision) are rejected visibly instead of being silently reordered. Classification runs in Float32 — values and thresholds are compared after rounding to Float32, so the summary counts always agree with the colors painted by the GPU — with strict half-open intervals: low `[0, media)`, medium `[media, alta)`, high `[alta, 1]`. These are geometric-index ranges, not equipment-certified detection thresholds.
- **Transparency and measured zero** — `NODATA`, `OUT_OF_RANGE`, `OUTSIDE_FOV`, `UNKNOWN_RAY` and `SHADOW` are unobserved states and are not painted: they leave the base terrain unchanged. A missing or unavailable index (for example a `VISIBLE` cell without a computable gradient) is transparent too. A measured `0.0` is data and stays colored in the low band. Transparency alone does not identify its cause; for example, it does not identify shadow. The radar/viewpoint markers in the 3D view are plain core-and-post icons without halo rings or billboards.
- **Merged analyses** — when several analyses are selected, the merged incidence layer takes the maximum individual finite incidence value at each merged `VISIBLE` cell and the merged movement projection is the RMS across the contributing analyses; missing values are excluded instead of being counted as zeros.
- **Exports** — the PDF report and the CSV file carry the same classification policy and provenance as the on-screen summary: thresholds marked provisional (no certified accuracy), the Float32 classification precision, the metric identity, the quality model `geometric-v2`, the terrain id/epoch and the analysis ids. For geometric-v2 results the CSV per-cell columns are `row,col,state,incidence,projection,shadowed` (legacy results keep `row,col,state,quality,shadowed`); `incidence`/`projection` are written only for `VISIBLE` cells with a measured index, as Float32 round-trip tokens (the shortest decimal that parses back to the same Float32, with a measured zero printed as `0` and blank for not-visible or no-index cells) instead of a 4-decimal rounding that could move a value across a threshold. The quality report is only added from a context captured at the export click that still matches the exported snapshot and result — every reported number is re-derived from the result being exported, and a context that does not match is rejected instead of being reported. Legacy or unversioned results export without a quality report rather than inventing one.

---

## Bundled Radar Profiles

The app contains hard-coded **local software profiles**. The model names are labels; the values below are application defaults, **not manufacturer specifications or independently validated operating limits**. Override them to match a separately verified scenario.

| Local profile label | Default range | Elevation interval | Default azimuth sector |
|---|---:|---:|---:|
| GroundProbe SSR-FX | 50–2500 m | −60° to +60° | −75° to +75° (150° total) |
| IBIS-ArcSAR360 | 50–2500 m | −60° to +60° | 360° |
| Reutech MSR | 50–2500 m | −60° to +60° | −75° to +75° (150° total) |

The tool does not fetch or validate manufacturer radar specifications. A configured maximum range is only a geometric cutoff; it is not a claim that a real instrument can detect a target at that distance.

---

## Supported File Formats and Terrain Processing

| Format | Extension | Input handling |
|---|---|---|
| DXF | `.dxf` | Reads point, line, 3D face, polyline, and lightweight-polyline vertices/coordinates |
| STL | `.stl` | Reads ASCII and binary triangular facets |

Input coordinates are converted to a regular elevation grid using local inverse-distance-weighted (IDW) interpolation and a spatial bin index. LOS traversal then checks triangles of that generated grid; it is not a Delaunay triangulation of the imported points or a direct ray test against the original STL facets. For STL files with more than 500,000 facets, the importer samples facets to limit the amount of input used for gridding. Missing or invalid grid areas can result in `UNKNOWN_RAY` or `NODATA` rather than being treated as visible terrain.

Grid nodes are spaced from each X/Y minimum by the selected resolution. If the span divided by resolution is an integer within floating-point tolerance, the endpoint is included; otherwise the grid stops at `min + floor(span / resolution) × resolution`, without adding a partial interval. Metadata `max_x`/`max_y` report the last sampled node, not an unsampled remainder (for example, a 200 m span at 3 m resolution ends at 198 m). Synthetic 200 m spans therefore produce 101 nodes at 2 m, 401 at 0.5 m, and 67 at 3 m. Each axis must have at least two nodes; spans shorter than one resolution are rejected. The 16,384-node-per-axis and 1,000,000-cell caps are checked before grid allocation.

> DXF elevation handling: `POINT` uses its parsed `position`; for `LWPOLYLINE`, a finite vertex Z takes precedence and a missing vertex Z falls back to the entity's finite elevation. Missing or non-finite required coordinates/elevations are rejected rather than coerced to zero.

---

## Technical Architecture

```text
Browser application
├── React + Three.js terrain viewer
├── Terrain Web Worker: DXF/STL input → regular IDW elevation grid
├── LOS Web Worker: configured geometric ray traversal over grid triangles
├── Sensitivity Web Worker: geometric projections from selected visible analyses
└── Local state and client-side PDF/CSV exports
```

Workers keep terrain, LOS, and sensitivity calculations in the browser. No RF propagation or signal-to-noise calculation is performed.

---

## Limitations

- Grid dimensions are limited to **16,384 nodes per axis** and **1,000,000 row × column entries total**. Both constraints apply.
- Each LOS compute runs under a monotonic runtime deadline of **120 seconds** (plus a 125-second worker watchdog); an analysis can be rejected when it exceeds the deadline even when its grid is under the grid-size cap.
- STL input above 500,000 facets is sampled before gridding. IDW resampling and grid resolution affect the resulting surface and LOS classifications.
- LOS is a straight geometric ray test over the sampled grid. It does not model RF propagation, attenuation, SNR, detection probability, radar resolution, or field performance.
- Local profile values are not validated manufacturer specifications. Choose and verify operational radar limits independently.
- Browser memory and WebGL/GPU limits depend on the device. No universal runtime or performance benchmark is claimed.
- DXF entities with missing/zero elevation may create a flat or unsuitable surface.

---

## Roadmap

- [ ] Contour labels and 2D plan view
- [ ] Radar beam-cone visualization
- [ ] Multi-analysis comparison table
- [ ] Import/export radar-network configuration (JSON)
- [ ] Custom local-profile editor
- [ ] Mobile-responsive layout

---

## Contributing

Contributions are welcome. Accuracy of the geometric contract, explicit no-data handling, and reproducible behavior matter more than unsupported physical or performance claims.

```bash
cd frontend
npm test
npm run build
```

---

## License

MIT — Free to use, modify, and distribute.

---

## About

GeotRadarSim is a browser-based tool for exploring terrain geometry and configured LOS scenarios. It can support early geometric review, but does not replace survey-quality input checks, manufacturer data, RF analysis, or field validation.

Issues and suggestions → [GitHub Issues](https://github.com/nibaldox/GeotRadarSim/issues)
