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
| 🎯 **Configurable limits** | Choose a bundled software profile and override range, elevation, and azimuth constraints |
| 🔴 **Multiple analyses** | Select compatible history entries to combine their cell-level geometric visibility |
| 🧮 **Geometric sensitivity** | Project the terrain's maximum-slope direction onto one or more individually visible LOS directions |
| 📊 **Grid metrics** | Show candidate-cell coverage, completeness, visible grid area, shadow components, and sensitivity |
| 📄 **PDF / CSV export** | Export the active compatible analysis, including per-cell LOS states in CSV |
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
2. In **Geometric Sensitivity 3D / Sensibilidad Geométrica 3D**, choose **Sensitivity (3D) / Sensibilidad (3D)** and calculate the map. **Quality LOS (1D) / Calidad LOS (1D)** shows the geometric score; when several analyses are selected, the merged overlay takes the maximum individual score at each visible cell.
3. At each finite terrain cell where both gradient axes can be computed from central or available one-sided neighbors, only selected analyses with an individual LOS state of `VISIBLE` contribute. `observer_count` is this per-cell contributor count; one contributor scores `|dot|`, while multiple contributors use `sqrt(sum(dot_i²) / observer_count)` (RMS). The result is a dimensionless geometric projection, not SNR, RF sensitivity, or a physical 3D radar model.
4. A `VISIBLE` LOS mask alone is not enough: if either terrain-gradient axis is unavailable, that observation does not contribute. Cells with `observer_count = 0` are no-data/transparent (`NaN`); a finite value of zero with `observer_count > 0` is a measured result.

The UI's **1D** and **3D** labels describe the geometric score and its multi-viewpoint aggregation/visualization. They do not indicate separate physical radar modes.

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

The **Quality LOS (1D) / Calidad LOS (1D)** display is also geometric: its scalar combines line-of-sight orientation relative to the local terrain normal with a taper based on distance to the configured maximum range. With multiple analyses selected, the merged overlay uses the maximum individual score among analyses classified as `VISIBLE` at each cell. It is not SNR, received power, a propagation model, or validated radar quality.

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
- LOS also enforces a conservative estimated traversal-work limit of **5,000,000 intervals**; an analysis can be rejected even when its grid is under the grid-size cap.
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
