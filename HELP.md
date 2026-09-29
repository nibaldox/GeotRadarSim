# 📡 GeotRadarSim — Getting Started Guide

This guide explains the browser app's terrain, geometric LOS, and sensitivity workflows. The outputs are geometric estimates on a gridded terrain surface, not measured radar performance.

---

## What this tool does

GeotRadarSim evaluates whether terrain-grid samples are geometrically within configured range/elevation/azimuth limits and unobstructed by the triangulated grid surface. It does **not** calculate SNR, received power, detection probability, RF propagation, or field performance. Do not interpret a color or percentage as a validated radar measurement.

---

## Step 1 — Load terrain

Choose one of the following:

### Generate the synthetic example

Click **Generate Synthetic Terrain**. The app creates a simple bowl-shaped example (200 × 200 m, 30 m depth). It is illustrative geometry, not a survey or a realistic mine model.

### Upload DXF or STL

1. Click **Upload DXF / STL**.
2. Select a `.dxf` or `.stl` file.
3. The browser worker converts its coordinates to a regular elevation grid.

DXF point, line, 3D-face, polyline, and lightweight-polyline coordinates are read as terrain samples. STL input may be ASCII or binary; STL facet vertices are used to generate the grid, not ray-traced as the original mesh. The gridding method is local inverse-distance weighting (IDW), not Delaunay triangulation. STL files over 500,000 facets are sampled before gridding.

### Grid resolution

The **Grid Resolution** slider ranges from 0.5 m to 5 m (initial value 1 m) and sets the terrain-grid spacing used for synthetic and uploaded terrain. Smaller spacing creates more grid samples; the app's grid and LOS-work limits still apply.

Grid nodes are spaced from each X/Y minimum by the selected resolution. A span divisible by the resolution (within floating-point tolerance) includes its endpoint; a non-divisible span is truncated at the last node not beyond the requested/input maximum. Metadata maxima report that real last node—for example, 200 m at 3 m resolution gives 67 nodes ending at 198 m. Each axis requires at least two nodes, so an extent shorter than one resolution is rejected rather than producing a degenerate surface.

> DXF elevation: `POINT` uses its parsed `position`; `LWPOLYLINE` uses a finite vertex Z when present and otherwise falls back to the entity's finite elevation. Missing or non-finite required coordinates/elevations are rejected rather than converted to zero.

---

## Step 2 — Configure the viewpoint limits

Choose one of the bundled profile labels in **Radar Model**, then optionally set minimum/maximum range, minimum/maximum elevation, azimuth center, and scan aperture. Distances are in metres and angular limits are in degrees. The azimuth convention is 0° north, 90° east, 180° south, and 270° west.

The selected model names use hard-coded local software defaults; they are **not validated manufacturer specifications**. The current defaults for all profiles have a 50–2500 m range and −60° to +60° elevation. GroundProbe SSR-FX and Reutech MSR use a −75° to +75° azimuth sector; IBIS-ArcSAR360 uses 360°. These are application values only. Override them only with values appropriate to the scenario you are evaluating.

If either azimuth center or aperture is entered, an omitted center defaults to 0° and an omitted aperture uses that profile's configured horizontal width. The configured horizontal range is a geometric cutoff, not a statement about the actual instrument's detection range.

---

## Step 3 — Place the viewpoint and run LOS

Click a point on the rendered terrain. The app places the viewpoint 2 m above the sampled surface and starts a LOS analysis. You can also enter X/Y/Z coordinates in the position controls and apply them.

The straight ray is checked against triangles of the generated terrain grid. The imported STL faces are not tested directly.

---

## Step 4 — Read LOS states and metrics

Each finite terrain target is checked against the configured horizontal range and elevation/azimuth limits. The resulting cell states are:

| State | Meaning |
|---|---|
| `NODATA` | The target terrain sample has no finite elevation |
| `OUT_OF_RANGE` | The target is outside the configured horizontal range |
| `OUTSIDE_FOV` | The target is outside the configured elevation or azimuth limits |
| `UNKNOWN_RAY` | A portion of the ray crosses the grid without a valid terrain triangle |
| `SHADOW` | A valid terrain triangle obstructs the geometric ray |
| `VISIBLE` | The target is within the configured limits and no traversed terrain triangle obstructs the ray |

The displayed percentages use only candidate states `VISIBLE`, `SHADOW`, and `UNKNOWN_RAY`:

- **Coverage** = `VISIBLE / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- **Completeness** = `(VISIBLE + SHADOW) / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- `NODATA`, `OUT_OF_RANGE`, and `OUTSIDE_FOV` are not included. If there are no candidate samples, both percentages are `null`/no data, not 0%.
- **Visible area** is the visible sample count multiplied by grid resolution squared. It is a planimetric grid estimate, not an exact 3D slope area.

The **Quality LOS (1D) / Calidad LOS (1D)** score is geometric: it combines LOS orientation relative to the local terrain normal with a distance taper to the configured maximum range. When several analyses are selected, the merged overlay uses the maximum individual score among those classified as `VISIBLE` at each cell. It is not SNR, received signal power, or validated signal quality.

---

## Step 5 — Combine multiple analyses (optional)

1. Run separate analyses from different positions and/or with different configured limits.
2. In **History**, select the entries to include. Their states are combined on the same terrain grid; for finite terrain samples, a cell is `VISIBLE` if at least one selected individual analysis marks it `VISIBLE`.
3. The merged coverage overlay and metrics update from the selected per-cell results. This is a geometric union; it does not add or combine radar signals.

---

## Step 6 — Geometric sensitivity (optional)

1. Select one or more individual analysis entries in **History**.
2. In **Sensibilidad Geométrica 3D**, select **Sensibilidad (3D)** and click **🗺️ Calcular Mapa de Sensibilidad 3D**.
3. The calculation uses a selected analysis at a cell only when that analysis's own LOS state is `VISIBLE` there. One visible viewpoint produces `|dot|`, the absolute projection of the LOS direction onto the terrain's maximum-slope direction. Multiple visible viewpoints produce `sqrt(sum(dot_i²) / observer_count)` (RMS).
4. Cells without an eligible visible viewpoint/finite terrain gradient are no-data and transparent. A valid computed zero remains a value, not no-data.

The **1D/3D** labels refer to the geometric projection and one-/multi-viewpoint presentation. This index is dimensionless and is not an SNR value, a pseudoinverse/eigenvalue calculation, or a physical RF sensitivity model.

---

## Exports

| Button | Output |
|---|---|
| **PDF Report** | Summary metrics and shadow-zone information for the active compatible analysis |
| **CSV Data** | Per-cell `row,col,state,quality,shadowed` values plus analysis metadata |
| **Image (PNG)** | Screenshot of the current 3D canvas |

The export controls are enabled when a compatible active analysis is available. A CSV quality value is a geometric display score, not a signal measurement.

---

## History and navigation

- Toggle a history entry to include or exclude it from the merged geometric overlay and sensitivity selection.
- Use the **X** on an entry to remove it, or **Clear All** to clear the history.
- Rotate the terrain with left-click and drag, zoom with the scroll wheel, and pan with right-click and drag.
- Use the compass gizmo to reset the view.

---

## Limits and troubleshooting

- The terrain grid is limited to **16,384 nodes per axis** and **1,000,000 row × column entries total**.
- LOS also rejects work estimates above **5,000,000 traversal intervals**. A small-looking grid can still exceed this work limit depending on configured range and geometry.
- Browser memory and WebGL/GPU capabilities vary by device.
- If a target is all no-data, check the input elevations and grid coverage. `NODATA` is not the same as terrain shadow.
- If coverage is `0%`, candidate cells exist but none are classified `VISIBLE`. If coverage displays no data, there were no `VISIBLE`, `SHADOW`, or `UNKNOWN_RAY` candidate samples (for example, all cells may be out of range/FOV or have no terrain data).
- A missing terrain segment along a ray becomes `UNKNOWN_RAY`, not a confirmed shadow or visibility result.
- If azimuth appears unexpected, check both azimuth center and aperture and remember that the app's local defaults are not manufacturer-validated settings.
- If PDF/CSV buttons are disabled, run a valid analysis on the currently loaded terrain first.

---

## Example workflow: compare two positions

1. Generate the synthetic terrain for an interface check, or upload a terrain grid appropriate to your scenario.
2. Select a bundled profile label, then set range and angular limits to the geometric scenario you want to inspect.
3. Place the first viewpoint and note its candidate-cell coverage and completeness.
4. Place a second viewpoint and select both compatible entries in **History**.
5. Inspect the merged geometric overlay and, if useful, calculate the sensitivity projection.
6. Export the analysis. Do not report the outputs as measured SNR or validated radar performance.

---

*GeotRadarSim is free and open source — [GitHub](https://github.com/nibaldox/GeotRadarSim).*
