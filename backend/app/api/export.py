"""Export API endpoints — PDF report and CSV data export.

Accepts LOSRequest-like body, runs LOS analysis, generates export.
"""

import io

from fastapi import APIRouter, HTTPException
from starlette.responses import StreamingResponse

from app.models.domain import LOSRequest
from app.services.los_engine import compute_los
from app.services.radar_registry import get_radar_config
from app.services.terrain_store import get_terrain
from app.services.export_service import generate_csv_data, generate_pdf_report

router = APIRouter()


@router.post("/pdf")
async def export_pdf(req: LOSRequest):
    """Generate and download PDF report for radar coverage analysis.

    Accepts terrain_id, radar_position, and radar_model_id.
    Runs LOS analysis and produces a downloadable PDF report.
    """
    dtm = get_terrain(req.terrain_id)
    if dtm is None:
        raise HTTPException(status_code=404, detail=f"Terrain '{req.terrain_id}' not found")

    try:
        radar_cfg = get_radar_config(req.radar_model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Radar model '{req.radar_model_id}' not found")

    radar_pos = (req.radar_position.x, req.radar_position.y, req.radar_position.z)
    los_result = compute_los(dtm, radar_pos, radar_cfg)

    bounds_dict = dtm.metadata.bounds.model_dump()

    pdf_bytes = generate_pdf_report(
        terrain_id=req.terrain_id,
        bounds=bounds_dict,
        radar_position=radar_pos,
        radar_model_id=req.radar_model_id,
        los_result=los_result,
    )

    buffer = io.BytesIO(pdf_bytes)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=coverage-report-{req.terrain_id}.pdf"},
    )


@router.post("/data")
async def export_csv(req: LOSRequest):
    """Generate and download CSV data for terrain grid with visibility status.

    Accepts terrain_id, radar_position, and radar_model_id.
    Runs LOS analysis and produces a downloadable CSV file.
    """
    dtm = get_terrain(req.terrain_id)
    if dtm is None:
        raise HTTPException(status_code=404, detail=f"Terrain '{req.terrain_id}' not found")

    try:
        radar_cfg = get_radar_config(req.radar_model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Radar model '{req.radar_model_id}' not found")

    radar_pos = (req.radar_position.x, req.radar_position.y, req.radar_position.z)
    los_result = compute_los(dtm, radar_pos, radar_cfg)

    bounds_dict = dtm.metadata.bounds.model_dump()

    csv_str = generate_csv_data(
        terrain_id=req.terrain_id,
        bounds=bounds_dict,
        resolution=dtm.metadata.resolution,
        radar_position=radar_pos,
        radar_model_id=req.radar_model_id,
        los_result=los_result,
    )

    buffer = io.BytesIO(csv_str.encode("utf-8"))
    return StreamingResponse(
        buffer,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=coverage-data-{req.terrain_id}.csv"},
    )
