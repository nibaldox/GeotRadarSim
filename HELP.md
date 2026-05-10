# 📡 GeotRadarSim — Getting Started Guide

Welcome to GeotRadarSim. This guide walks you through your first analysis in under 5 minutes.

---

## What this tool does

GeotRadarSim simulates whether a slope monitoring radar can **see** specific areas of your mine slope. It uses your actual topography to calculate Line-of-Sight (LOS), respecting the elevation angles, azimuth sector, and range limits of each radar model.

The result is a **color-coded coverage map** on your 3D terrain:

| Color | Meaning |
|---|---|
| 🟢 Green | High signal quality — radar has direct line of sight and good angle |
| 🟡 Yellow/Orange | Moderate quality — line of sight exists but angle is oblique or range is high |
| 🔴 Red | Poor quality — visible but at limit of coverage |
| ⬜ Grey | Shadow zone — the radar **cannot see** this area |

---

## Step 1 — Load your terrain

You have two options:

### Option A: Generate a synthetic terrain (quickest for testing)
1. In the left sidebar, click **"Generate Synthetic Terrain"**
2. A 200×200 m hilly terrain appears in 3D — drag to rotate, scroll to zoom

### Option B: Upload your own DXF or STL file
1. Click **"Upload DXF / STL"**
2. Select your file (`.dxf` or `.stl`)
3. Wait for processing — the terrain will appear in a few seconds

> **DXF tips:** Export from Vulcan as 3D contour polylines or a point cloud with full Z coordinates.  
> **STL tips:** Any triangulated surface mesh works — ASCII or binary format.

### Resolution slider
The **Grid Resolution** slider controls how detailed the terrain grid is:
- **Low (0.5 m):** High detail, slower analysis — use for final positioning
- **High (5 m):** Fast and fluid — use for exploring options

---

## Step 2 — Configure the radar

In the **"Radar Model"** section:

1. **Select a model** from the dropdown:
   - *GroundProbe SSR-FX* — most common slope monitoring radar, 850 m range, 90° aperture
   - *IBIS-ArcSAR360* — 360° SAR radar, 400 m range
   - *Reutech MSR* — 500 m range, 120° aperture

2. **Override parameters** (optional — leave empty to use the model defaults):

   | Field | Description | Example |
   |---|---|---|
   | Min Range (m) | Ignore cells closer than this | `10` |
   | Max Range (m) | Ignore cells farther than this | `600` |
   | Min Elevation (°) | Minimum vertical look angle | `-45` |
   | Max Elevation (°) | Maximum vertical look angle | `30` |
   | Azimuth Center (°) | Direction the radar faces (0=North, 90=East, 180=South, 270=West) | `270` |
   | Scan Aperture (°) | Total angular width of the scan sector | `120` |

---

## Step 3 — Place the radar and run the analysis

**Click anywhere on the terrain surface.**  
A white sphere appears at the clicked point — this is your radar position (+2 m elevation above ground).

The analysis runs automatically. In a few seconds, the coverage overlay appears on the terrain.

> **Tip:** Click different locations to quickly compare coverage from multiple positions. Each result is saved in the **History** panel.

---

## Step 4 — Read the results

In the **"Export"** panel you'll see:

- **Coverage %** — what percentage of the radar's sector has line of sight
- **Visible Area (m²)** — total monitored surface area
- **Shadow zones** — number of disconnected blind areas

Toggle the **"Show Shadow Overlay"** checkbox to turn the color map on or off while rotating the terrain.

---

## Step 5 — Multi-Radar Network Analysis (optional)

If one radar isn't enough, you can simulate a network:

1. Configure and place your **first radar** (Steps 2–3)
2. In the **"Radar Network"** panel → click **"+ Add Current Radar to Network"**
   - The radar is added to the list with a unique color
   - A colored sphere with a pole appears on the terrain

3. Configure and place your **second radar** (change model or azimuth)
4. Click **"+ Add Current Radar to Network"** again

5. Click **"▶ Run Network Analysis (2)"**
   - Both radars run simultaneously (parallel Web Workers)
   - The overlay updates to show **unified coverage**: a cell is visible if ANY radar can see it
   - Each radar's individual result is shown in the list

> **Rule:** A cell is considered "shadowed" only if **all** radars cannot see it.  
> Combined coverage is always ≥ the best single radar result.

---

## Exporting results

| Button | What it creates |
|---|---|
| 📄 **PDF Report** | A structured PDF with coverage metrics and shadow zone table |
| 📊 **CSV Data** | The full quality grid (row, col, quality, shadowed) for post-processing in Excel |
| 🖼️ **Image (PNG)** | A screenshot of the current 3D view |

---

## Restoring a past analysis

Every analysis is saved in the **"History"** panel at the bottom of the sidebar.  
Click any past entry to **instantly restore** that coverage overlay and radar position on the terrain.

---

## Keyboard shortcuts & navigation

| Action | How |
|---|---|
| Rotate terrain | Left-click + drag |
| Zoom | Scroll wheel |
| Pan | Right-click + drag |
| Reset view | Use the **compass gizmo** (bottom right corner) |
| Place radar | Left-click on the terrain surface |

---

## FAQ

**Q: The terrain looks like a solid block with vertical walls.**  
A: Your DXF or STL may have no Z data (elevation = 0 everywhere). Re-export from Vulcan with 3D coordinates enabled. The walls disappear when real elevation data is loaded.

**Q: The overlay is not showing after the analysis.**  
A: Make sure the **"Show Shadow Overlay"** checkbox is checked (left sidebar, below the Radar Network panel).

**Q: The analysis seems to ignore my azimuth setting.**  
A: Make sure you fill in **both** Azimuth Center AND Scan Aperture. If only one is set, the other defaults to the model value.

**Q: Coverage is 0% — the map is all grey.**  
A: The radar position may be outside the terrain, or the max range is too small. Try clicking closer to the center of the terrain, or increasing Max Range.

**Q: The PDF/CSV buttons are greyed out.**  
A: Run at least one analysis first. The buttons enable once a result is available.

**Q: The PNG image is blank.**  
A: This can happen if the browser tab is hidden or minimized during export. Bring the tab into focus and try again.

---

## Workflow example: choosing between two radar positions

1. Generate synthetic terrain (or load your DXF)
2. Select *GroundProbe SSR-FX*, set Max Range = 600 m, Azimuth Center = 0°, Aperture = 120°
3. Click on the **north edge** of the terrain → note coverage % in History
4. Click on the **south edge** of the terrain → note coverage % in History
5. Add both to the Radar Network and run **"▶ Run Network Analysis"** to see combined coverage
6. Export the best result as PDF for your report

---

*GeotRadarSim is free and open source — [github.com/nibaldox/GeotRadarSim](https://github.com/nibaldox/GeotRadarSim)*
