"""Analysis API endpoints — LOS ray-casting."""

from fastapi import APIRouter, HTTPException

from app.models.domain import LOSRequest
from app.services.los_engine import compute_los
from app.services.radar_registry import get_radar_config
from app.services.terrain_store import get_terrain

router = APIRouter()


@router.post("/los")
async def run_los_analysis(req: LOSRequest):
    """Run Line-of-Sight analysis for a given terrain and radar configuration."""
    dtm = get_terrain(req.terrain_id)
    if dtm is None:
        raise HTTPException(status_code=404, detail=f"Terrain '{req.terrain_id}' not found")

    try:
        radar_cfg = get_radar_config(req.radar_model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Radar model '{req.radar_model_id}' not found")

    radar_pos = (req.radar_position.x, req.radar_position.y, req.radar_position.z)
    result = compute_los(dtm, radar_pos, radar_cfg)

    return {
        "shadow_grid": result.shadow_grid,
        "coverage_polygon": result.coverage_polygon,
        "coverage_pct": result.coverage_pct,
        "visible_area_m2": result.visible_area_m2,
        "shadow_zones": result.shadow_zones,
    }
