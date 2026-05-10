"""Analysis API endpoints — LOS ray-casting."""

from fastapi import APIRouter, HTTPException, BackgroundTasks

from app.models.domain import LOSRequest
from app.services.los_engine import compute_los
from app.services.radar_registry import get_radar_config
from app.services.terrain_store import get_terrain
from app.services.job_manager import create_job, update_job, get_job

router = APIRouter()

def _process_los_job(job_id: str, dtm, radar_pos, radar_cfg):
    try:
        result = compute_los(dtm, radar_pos, radar_cfg)
        result_dict = {
            "shadow_grid": result.shadow_grid,
            "coverage_polygon": result.coverage_polygon,
            "coverage_pct": result.coverage_pct,
            "visible_area_m2": result.visible_area_m2,
            "shadow_zones": result.shadow_zones,
            "quality_grid": result.quality_grid,
        }
        update_job(job_id, status="COMPLETED", result=result_dict)
    except Exception as e:
        update_job(job_id, status="FAILED", error=str(e))

@router.post("/los")
def run_los_analysis(req: LOSRequest, background_tasks: BackgroundTasks):
    """Start Line-of-Sight analysis as a background job."""
    dtm = get_terrain(req.terrain_id)
    if dtm is None:
        raise HTTPException(status_code=404, detail=f"Terrain '{req.terrain_id}' not found")

    try:
        # Create a copy of the config so we don't modify the global registry with overrides
        radar_cfg = get_radar_config(req.radar_model_id).model_copy()
        
        # Apply overrides if provided
        if req.range_min_m is not None:
            radar_cfg.min_range_m = req.range_min_m
        if req.range_max_m is not None:
            radar_cfg.max_range_m = req.range_max_m
        if req.el_min_deg is not None:
            radar_cfg.elevation_min_deg = req.el_min_deg
        if req.el_max_deg is not None:
            radar_cfg.elevation_max_deg = req.el_max_deg
            
        # Apply azimuth overrides
        if req.az_center_deg is not None or req.az_width_deg is not None:
            # Use current config values as defaults for calculation
            current_center = 0.0
            current_width = 360.0
            
            if radar_cfg.azimuth_range_deg:
                start, end = radar_cfg.azimuth_range_deg
                current_width = (end - start) % 360
                current_center = (start + current_width / 2) % 360
                if current_center > 180: current_center -= 360
                
            center = req.az_center_deg if req.az_center_deg is not None else current_center
            width = req.az_width_deg if req.az_width_deg is not None else current_width
            
            az_start = center - (width / 2)
            az_end = center + (width / 2)
            
            # Normalize to [-180, 180]
            def norm(a):
                a %= 360
                return a - 360 if a > 180 else a
                
            radar_cfg.azimuth_range_deg = (norm(az_start), norm(az_end))
            
            # If width < 360, it's a sector scan (RAR)
            if width < 360:
                radar_cfg.scan_pattern = "RAR"
            else:
                radar_cfg.scan_pattern = "SAR360"

    except KeyError:
        raise HTTPException(status_code=404, detail=f"Radar model '{req.radar_model_id}' not found")

    radar_pos = (req.radar_position.x, req.radar_position.y, req.radar_position.z)
    
    job_id = create_job()
    background_tasks.add_task(_process_los_job, job_id, dtm, radar_pos, radar_cfg)
    
    return {"job_id": job_id, "status": "PENDING"}

@router.get("/jobs/{job_id}")
def get_job_status(job_id: str):
    """Get the status and result of a background job."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.model_dump()
