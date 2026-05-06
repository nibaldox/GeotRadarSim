# Tasks: Radar Monitoring Simulator

## Phase 1: Foundation

- [x] 1.1 Create monorepo: `backend/pyproject.toml` (fastapi, uvicorn, ezdxf, scipy, numpy, reportlab, matplotlib, pytest, httpx) + `frontend/package.json` (react, three, @react-three/fiber, @react-three/drei, zustand, vite)
- [x] 1.2 Write tests for Pydantic models → Create `backend/app/models/domain.py` (`Point3D`, `BoundingBox`, `DTMMetadata`, `RadarConfig`, `LOSRequest`, `LOSResponse`)
- [x] 1.3 Write tests for YAML loader → Create `backend/app/config/radars/groundprobe-ssr-fx.yaml`, `ibis-arcsar360.yaml`, `reutech-msr.yaml` + `backend/app/services/radar_registry.py` (load configs at startup)
- [x] 1.4 Create `backend/app/main.py` — FastAPI app, CORS, health endpoint, stub routers

## Phase 2: Terrain Ingestion

- [x] 2.1 RED: tests for valid DXF / no elevation / malformed → GREEN: `backend/app/services/dxf_parser.py` using ezdxf to extract 3D POLYLINE vertices into point cloud
- [x] 2.2 RED: tests for dense (>1000 pts) and sparse (<100 pts) clouds → GREEN: `backend/app/services/dtm_generator.py` using scipy.griddata → regular grid `np.ndarray`
- [x] 2.3 RED: test for bowl shape generation → GREEN: `backend/app/services/synthetic_terrain.py` — configurable pit dimensions
- [x] 2.4 RED: integration tests for upload/synthetic/grid endpoints → GREEN: `backend/app/api/terrain.py` (`POST /upload`, `POST /synthetic`, `GET /{id}/grid`)

## Phase 3: LOS Analysis Engine

- [ ] 3.1 RED: tests (unobstructed, obstructed, range limit, angular sector) → GREEN: `backend/app/services/los_engine.py` — vectorized ray-cast over grid DTM with obstruction point recording
- [ ] 3.2 RED: tests (single zone, multiple disjoint zones) → GREEN: add shadow zone grouping (contiguous region labeling) to LOS engine
- [ ] 3.3 RED: integration test (recompute <5s on position change) → GREEN: `backend/app/api/analysis.py` (`POST /api/analysis/los`)
- [ ] 3.4 RED: tests → GREEN: `backend/app/api/radars.py` (`GET /api/radars`, `GET /api/radars/{model_id}`) + dynamic YAML discovery for extensibility

## Phase 4: Export Services

- [ ] 4.1 RED: test PDF contains view + radar info + coverage stats → GREEN: `backend/app/services/export_service.py` PDF generation with reportlab
- [ ] 4.2 RED: test CSV columns (x, y, z, visible, distance, zone_id) → GREEN: add CSV export to export service
- [ ] 4.3 RED: integration tests → GREEN: `backend/app/api/export.py` (`POST /pdf`, `POST /data`)

## Phase 5: Frontend — API & State

- [ ] 5.1 Create `frontend/src/services/api.ts` — typed fetch client for all endpoints
- [ ] 5.2 Create `frontend/src/hooks/useTerrain.ts` — upload, synthetic gen, grid fetch state
- [ ] 5.3 Create `frontend/src/hooks/useAnalysis.ts` — LOS trigger, shadow data, coverage state

## Phase 6: Frontend — 3D Visualization

- [ ] 6.1 Create `frontend/src/components/TerrainViewer.tsx` — R3F mesh with elevation gradient, OrbitControls, click-to-place raycasting
- [ ] 6.2 Add shadow zone overlay layer to TerrainViewer — semi-transparent per-vertex coloring, toggle via prop without clearing data
- [ ] 6.3 Create `frontend/src/components/RadarControls.tsx` — model selector, position readout
- [ ] 6.4 Create `frontend/src/components/ExportPanel.tsx` — PDF/PNG/CSV buttons with disabled states when no analysis

## Phase 7: E2E Verification

- [ ] 7.1 pytest e2e: synthetic DXF upload → DTM → LOS → PDF export (full pipeline fixture)
- [ ] 7.2 pytest e2e: synthetic terrain → radar place → CSV export with correct columns
- [ ] 7.3 Manual: verify 3D rendering, shadow overlay toggle, radar relocation <2s, FPS ≥30 on large mesh
