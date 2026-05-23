# 📡 GeotRadarSim — Radar Coverage Simulator for Geotechnical Monitoring

**Free, open-source, browser-based tool for simulating slope monitoring radar coverage on real mine topography.**

> Built by a geotechnical engineer, for geotechnical engineers.  
> Because radar positioning decisions should be based on data — not intuition.

🌐 **Live app:** [https://nibaldox.github.io/GeotRadarSim/](https://nibaldox.github.io/GeotRadarSim/)

---

## The Problem

In open-pit mining, monitoring radars (SSR, GroundProbe, IBIS, etc.) are critical for slope stability. Deciding **where** to place them is often done by staring at the pit topography in software like Vulcan and mentally figuring out:

- Which slopes can the radar actually **"see"**?
- Are there crests or benches creating **blind spots**?
- At 2,500 m range, is the **signal quality** still acceptable?
- If I add a **second radar**, does it cover the gaps?

This mental 3D exercise is unreliable. Commercial tools exist — but their licenses are expensive and not always accessible to every mine site.

**GeotRadarSim solves this.** It's free, runs in your browser, no installation required, and gives you answers in seconds.

---

## Features

| Feature | Description |
|---|---|
| 🗺️ **Real topography** | Load DXF contour lines or STL meshes from your mine survey |
| 🏗️ **Synthetic terrain** | Generate example hilly terrain for quick testing |
| 📡 **LOS analysis** | Ray-traced Line-of-Sight analysis with signal quality map |
| 🎯 **Radar parameters** | Override range, elevation, and azimuth per analysis |
| 🔴 **Multi-radar network** | Dynamic union of multiple coverage overlays by toggling history checkboxes |
| 🧮 **3D Vector Synthesis** | Moore-Penrose analytical solver reconstructing 3D gravity vectors from 1D LOS |
| 📊 **Coverage metrics** | Coverage %, visible area (m²), shadow zones, and geometric sensitivity |
| 🕓 **History Panel** | Toggle checkboxes to merge multiple analyses, or click "X" to delete |
| 📄 **PDF Report** | Structured coverage report with tables |
| 📋 **CSV Export** | Full quality grid for post-processing |
| 🖼️ **PNG Snapshot** | Capture the 3D view as an image |
| 🌐 **100% browser** | No server, no Python, no installation |

---

## Screenshots

### Full Radar Coverage Analysis
Load your mine topography (STL or DXF), place a radar, and instantly see which slopes are covered. The color gradient shows signal quality — green = excellent, orange/yellow = moderate, red = poor.

![Full coverage analysis on real mine topography — GroundProbe SSR-FX with 44% coverage](docs/screenshots/01_full_coverage.png)

### Coverage from Different Angles
Rotate and explore the 3D model to understand shadow zones and coverage gaps from every perspective.

![Coverage viewed from a different angle — shadows clearly visible on far slopes](docs/screenshots/02_coverage_angle.png)

### Comparing Radar Positions
Click different locations on the terrain to compare coverage. Each analysis is logged in the History panel.

![Partial coverage at 24.8% from an alternative radar position](docs/screenshots/03_partial_coverage.png)

### Shadow Zone Identification
Clearly identify which benches and slopes fall outside the radar's line of sight.

![Shadow zones visible on slopes facing away from radar](docs/screenshots/04_shadow_zones.png)

### Multi-Radar Network Analysis
Deploy multiple radars with different configurations and compute the unified coverage in one click.

![Five different radar positions compared — coverage ranges from 17.6% to 45.3%](docs/screenshots/05_multiple_analyses.png)

---

## Quick Start

### Online (recommended)
Just open [https://nibaldox.github.io/GeotRadarSim/](https://nibaldox.github.io/GeotRadarSim/) — no installation needed.

### Run locally
```bash
git clone https://github.com/nibaldox/GeotRadarSim.git
cd GeotRadarSim/frontend
npm install
npm run dev
```
Open [http://localhost:5173/GeotRadarSim/](http://localhost:5173/GeotRadarSim/)

---

## How to Use

### Single Radar Analysis (3 steps)
1. **Load terrain** — upload a DXF or STL file, or click *Generate Synthetic Terrain*
2. **Configure radar** — select model and optional parameter overrides (range, elevation, azimuth)
3. **Click on terrain** — the radar is placed and analysis runs automatically

### Multi-Radar Network Analysis
1. **Place multiple radars** — configure and place a radar on the terrain. It is automatically analyzed and stored in the History panel.
2. **Toggle checkboxes** — in the **History** panel, tick the checkboxes of the past analyses you want to merge.
3. **Instant sub-millisecond merging** — the coverages are merged on-the-fly and displayed together in the 3D viewer, automatically updating global metrics!
4. **Delete records** — click the **"X"** button on any history card to instantly delete and clean up that entry.

### 3D Vector Reconstructions & Sensitivity Map
1. **Enable synthesis** — select/tick **at least 2** radar analysis entries in the **History** panel.
2. **Select overlay mode** — choose between **Calidad LOS (1D)** or **Sensibilidad (3D)** under the *Síntesis Vectorial 3D* panel.
3. **Global Sensitivity** — click **"🗺️ Calcular Mapa de Sensibilidad 3D"** to color-code the terrain according to the geometric sensitivity index ($S_v$). Shadowed/obstructed zones are automatically masked and kept transparent.
4. **Induce local slide (Double click)** — double-click any cell on the 3D terrain to trigger a local slide simulation. The Moore-Penrose pseudo-inverse solver immediately calculates and displays:
   - **True displacement vector** (3D direction & magnitude)
   - **Apparent reading** (1D Line-of-Sight) showing the signal loss percentage ($-\%$)
   - **Reconstructed 3D vector** highlighting geometric singular alignment or blind spot warnings.

### Supported Radar Models
| Model | Max Range | Pattern | Notes |
|---|---|---|---|
| GroundProbe SSR-FX | 850 m | RAR | Standard slope monitoring radar |
| IBIS-ArcSAR360 | 2500 m | 360° SAR | Full 360° azimuth, premium long range (+-60° elevation) |
| Reutech MSR | 500 m | RAR | 120° aperture |

---

## Supported File Formats

| Format | Extension | How to export from Vulcan |
|---|---|---|
| DXF contours | `.dxf` | Export contour lines or 3D polylines at full Z |
| STL mesh | `.stl` | Export surface as triangulated mesh (ASCII or binary) |

> ⚠️ For DXF files: export as 3D polylines/points with Z values. 2D DXFs without elevation will produce a flat terrain.

---

## Technical Architecture

```
Browser Only — No Server Required
┌─────────────────────────────────────────────────┐
│  React + R3F (Three.js)                         │
│  ┌────────────────┐  ┌───────────────────────┐  │
│  │ Terrain Worker │  │    LOS Worker         │  │
│  │ (Web Worker)   │  │    (Web Worker)       │  │
│  │ STL/DXF parse  │  │  Raycasting + SNR     │  │
│  │ IDW interpolat │  │  Multi-radar merge    │  │
│  └────────────────┘  └───────────────────────┘  │
│  Zustand (state)  ·  jsPDF (exports)            │
└─────────────────────────────────────────────────┘
```

- **Terrain processing**: DTM contour / STL triangulation parsed and mapped through high-performance 1D integer spatial bins in a Web Worker (10x faster IDW).
- **LOS engine**: Zero-copy Raycasting in Web Workers transferring flat float arrays (`Float32Array`) via Transferable Objects to bypass serialization overhead.
- **Direct GPU Texture Binding**: Raw float buffers bind directly to Three.js `THREE.DataTexture` for zero-allocation rendering, avoiding main-thread React packing loops.
- **Sub-millisecond merge**: Recalculates unified coverages in less than **1 millisecond** in 1D memory space.
- **No data leaves your browser** — everything runs locally in your browser.

---

## Limitations & Known Issues

- DXF support depends on 3D polyline/point structure. Some CAD exports may require preprocessing.
- Very large terrains (>8192×8192 grid) may be slow or exceed GPU texture limits.
- The app runs on GPU WebGL — requires a hardware-accelerated browser (Chrome or Firefox recommended).
- PDF and CSV exports reflect the currently displayed analysis only.

---

## Roadmap

- [ ] Contour line labels and 2D plan view
- [ ] Radar beam cone visualization in 3D
- [ ] Multi-radar coverage comparison table
- [ ] Import/export of radar network configuration (JSON)
- [ ] Custom radar model editor
- [ ] Mobile-responsive layout

---

## Contributing

PRs welcome. This is an operational tool, so stability and accuracy are the priorities over feature velocity.

```bash
# Run tests
cd frontend && npm test

# Build for production
npm run build
```

---

## License

MIT — Free to use, modify, and distribute.

---

## About

Built by a mine site geotechnical engineer frustrated with the cost of commercial radar planning software.  
If this tool saves you time or helps you make a better radar placement decision, that's the goal.

Issues and suggestions welcome → [GitHub Issues](https://github.com/nibaldox/GeotRadarSim/issues)
