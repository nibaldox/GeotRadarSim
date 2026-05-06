# Proposal: Radar Monitoring Simulator

## Intent

Geotechnical engineers operating slope-monitoring radar systems in open pit mines currently cannot visualize terrain shadow zones from 2D topography. When positioning a radar, berms, crests, and benches create blind spots where the radar has no line-of-sight — requiring costly field visits to discover poor installation points. This webapp loads mine topography from DXF files, lets engineers place a radar, and shows shadow zones and coverage in real-time.

## Scope

### In Scope
- DXF file ingestion (POLYLINE/LWPOLYLINE contour lines with Z elevation)
- Digital Terrain Model (DTM) generation from contour data
- 3D terrain visualization with radar placement interaction
- Line-of-sight ray-casting engine for shadow zone computation
- Radar monitoring window projection onto pit walls (2.5D minimum)
- Support for all 3 radar models from day 1: GroundProbe SSR-FX, IBIS-ArcSAR360, Reutech MSR
- Synthetic test terrain data (user has no DXF files yet)
- Export: PDF coverage reports, images, data files
- Rapid iteration: move radar point, see updated coverage immediately

### Out of Scope
- Multi-pit scenarios (single pit only for v1)
- Real-time radar data feeds or sensor integration
- GPS/geodetic coordinate system transformations (use local coordinates)
- User authentication or multi-user collaboration
- Mobile/responsive design (desktop-focused engineering tool)

## Capabilities

### New Capabilities
- `terrain-ingestion`: DXF file parsing and DTM generation from contour line data
- `terrain-visualization`: 3D terrain rendering with interactive radar placement
- `los-analysis`: Line-of-sight ray-casting engine and shadow zone computation
- `radar-models`: Radar parameter management for GroundProbe, IBIS, and Reutech models
- `coverage-export`: PDF report, image, and data file export of coverage analysis

### Modified Capabilities
None — greenfield project.

## Approach

**Backend (Python/FastAPI)**: `ezdxf` parses DXF contour lines → interpolate into a regular-grid DTM (NumPy array) → line-of-sight ray-casting with `scipy.interpolate` + `shapely` for 2D geometry ops → expose results via REST API.

**Frontend (React + Three.js)**: Three.js renders the DTM as a 3D mesh → user clicks to place radar → sends coordinates to backend → receives shadow map + coverage polygon → overlays on terrain in real-time. React manages radar model selection and export controls.

**Radar models** are data-driven: each model defines range, beam angle, elevation limits, and scan pattern (RAR configurable-beam vs SAR 360° rotation). Stored as configuration, not hardcoded.

**Synthetic terrain**: Generate realistic pit geometry (benches, berms, haul roads) via procedural algorithms for development and demo.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `backend/` | New | FastAPI app — DXF parsing, DTM generation, LOS engine, radar configs, export endpoints |
| `frontend/` | New | React + Three.js app — 3D terrain viewer, radar placement, coverage overlay, export UI |
| `shared/synthetic-terrain/` | New | Procedural terrain generator for testing and demo |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| DXF format variability across survey tools | Medium | Support common POLYLINE/LWPOLYLINE; validate on import with clear error messages |
| Large terrain DTM causing slow ray-casting | Medium | Use grid resolution control + spatial indexing; profile early with synthetic data |
| Three.js performance with dense terrain meshes | Low | Level-of-detail (LOD) rendering; decimate mesh for distant views |
| LOS accuracy on steep pit walls | Medium | Validate against known survey benchmarks; allow configurable grid resolution |

## Rollback Plan

Greenfield project — no existing systems to break. Each capability is independently deployable:
1. Remove the deployed container/package
2. Delete the project directory
3. No data migration concerns in v1

## Dependencies

- `ezdxf` — DXF file parsing (Python)
- `numpy` / `scipy` — numerical computation and interpolation
- `shapely` — 2D geometry operations
- `fastapi` + `uvicorn` — backend API framework
- `three.js` + `@react-three/fiber` — 3D terrain rendering
- `reportlab` or `weasyprint` — PDF report generation
- `matplotlib` — optional, for server-side image export fallback

## Success Criteria

- [ ] User can load a DXF file and see 3D terrain rendered correctly with elevation
- [ ] User can place a radar on the terrain and see shadow zones computed in < 5 seconds
- [ ] All 3 radar models (GroundProbe, IBIS, Reutech) produce correct coverage windows
- [ ] Coverage can be exported as PDF, PNG, and CSV
- [ ] Synthetic terrain generates a realistic open pit geometry for testing
- [ ] Moving the radar point updates shadow zones in real-time (< 2s response)
