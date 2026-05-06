# Design: Radar Monitoring Simulator

## Technical Approach

Two-process architecture: Python/FastAPI backend handles computation (DXF parsing, DTM generation, LOS ray-casting, export); React/Three.js frontend handles 3D visualization and interaction. Backend is the analysis source of truth; frontend sends radar positions and receives shadow maps. Radar models are data-driven YAML configs.

## Architecture Decisions

| Decision | Choice | Rejected | Why |
|----------|--------|----------|-----|
| DTM representation | Regular grid (NumPy 2D array) | TIN | Grid enables vectorized ray-casting with simple indexing; TIN requires triangle intersection — slower, harder to vectorize |
| LOS computation | Backend (Python/SciPy) | Frontend (WebGL shaders) | Testable with pytest, NumPy-vectorized, serializable; shaders are untestable and lock logic into renderer |
| 3D rendering | Three.js + @react-three/fiber | CesiumJS | Local coords, no globe needed; CesiumJS is 5MB+ with Ion dependency |
| Radar model storage | YAML config files | Database / hardcoded | 3 static models; YAML is version-controlled, readable, loads at startup |
| Client-server | REST | WebSocket | Simpler to implement/test; WebSocket upgrade path if < 2s target unmet |
| Session management | In-memory dict | File/Redis | Single-user desktop tool; cleared on restart, acceptable for v1 |

## Data Flow

```
DXF Upload → ezdxf Parser → Contour Lines (x,y,z)
    → DTM Generator (scipy.griddata) → Regular Grid (np.ndarray)
    → Stored in memory (terrain_id keyed)

Radar Place → POST /api/analysis/los {position, model_id}
    → LOS Engine (ray-cast over DTM)
    → Shadow Map + Coverage Polygon + Stats
    → Frontend overlays on Three.js mesh
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `backend/app/main.py` | Create | FastAPI entry, CORS, routers |
| `backend/app/api/terrain.py` | Create | Upload, DTM retrieval, synthetic terrain endpoints |
| `backend/app/api/analysis.py` | Create | LOS analysis endpoint |
| `backend/app/api/radars.py` | Create | Radar model CRUD |
| `backend/app/api/export.py` | Create | PDF/PNG/CSV export |
| `backend/app/services/dxf_parser.py` | Create | DXF POLYLINE → contour lines |
| `backend/app/services/dtm_generator.py` | Create | Contours → grid DTM |
| `backend/app/services/los_engine.py` | Create | Ray-casting shadow computation |
| `backend/app/services/export_service.py` | Create | Report generation (reportlab + matplotlib) |
| `backend/app/services/synthetic_terrain.py` | Create | Procedural pit terrain generator |
| `backend/app/config/radars/*.yaml` | Create | 3 radar model configs (GroundProbe, IBIS, Reutech) |
| `backend/app/models/domain.py` | Create | Pydantic domain models |
| `backend/tests/` | Create | Full test suite |
| `frontend/src/components/TerrainViewer.tsx` | Create | Three.js terrain mesh + shadow overlay |
| `frontend/src/components/RadarControls.tsx` | Create | Model selector, position display |
| `frontend/src/components/ExportPanel.tsx` | Create | Export buttons |
| `frontend/src/hooks/useTerrain.ts` | Create | Terrain data management |
| `frontend/src/hooks/useAnalysis.ts` | Create | LOS analysis state + API calls |
| `frontend/src/services/api.ts` | Create | API client |
| `backend/pyproject.toml` | Create | Python dependencies |
| `frontend/package.json` | Create | JS dependencies (react, three, r3f, drei) |

## Interfaces / Contracts

### Domain Types

```python
class Point3D(BaseModel):
    x: float; y: float; z: float

class DTMMetadata(BaseModel):
    terrain_id: str
    bounds: BoundingBox
    resolution: float  # meters per cell
    grid_rows: int; grid_cols: int

class RadarConfig(BaseModel):
    model_id: str
    max_range_m: float
    h_beam_width_deg: float
    v_beam_width_deg: float
    elevation_min_deg: float
    elevation_max_deg: float
    scan_pattern: Literal["RAR", "SAR360"]
    azimuth_range_deg: tuple[float, float] | None  # None for SAR360

class LOSRequest(BaseModel):
    terrain_id: str
    radar_position: Point3D
    radar_model_id: str

class LOSResponse(BaseModel):
    shadow_grid: list[list[bool]]
    coverage_polygon: list[tuple[float, float]]
    coverage_pct: float
    visible_area_m2: float
```

### API Endpoints

```
POST /api/terrain/upload       → DTMMetadata
POST /api/terrain/synthetic    → DTMMetadata
GET  /api/terrain/{id}/grid    → JSON grid
POST /api/analysis/los         → LOSResponse
GET  /api/radars               → list[RadarConfig]
GET  /api/radars/{model_id}    → RadarConfig
POST /api/export/pdf|image|data → file download
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | DXF parser, DTM generator, LOS engine, radar configs, synthetic terrain | pytest + fixtures |
| Integration | All API endpoints | httpx.AsyncClient + FastAPI TestClient |
| Integration | Full pipeline (DXF → analysis → export) | pytest e2e with synthetic DXF |
| Visual | 3D rendering | Manual v1 |

## Migration / Rollout

No migration required. Greenfield — single release.

## Open Questions

- [ ] Exact radar parameters for all 3 models (beam widths, elevation limits — needs domain expert)
- [ ] Grid resolution default (propose 2m — depends on typical mine DTM size)
- [ ] PDF report layout (needs UX wireframe)
