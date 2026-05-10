"""Terrain API endpoints — upload DXF/STL, generate synthetic terrain, retrieve grid."""

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from pydantic import BaseModel, Field

from app.services.dxf_parser import parse_dxf, DXFParseError
from app.services.stl_parser import stl_to_dtm, STLParseError
from app.services.dtm_generator import generate_dtm
from app.services.synthetic_terrain import generate_synthetic_terrain
from app.services.terrain_store import store_terrain, get_terrain

router = APIRouter()


class SyntheticTerrainRequest(BaseModel):
    """Request body for synthetic terrain generation."""
    size_x: float = Field(gt=0, description="Extent in X direction (meters)")
    size_y: float = Field(gt=0, description="Extent in Y direction (meters)")
    depth: float = Field(gt=0, description="Maximum pit depth (meters)")
    resolution: float = Field(default=2.0, gt=0, description="Grid cell size (meters)")


@router.post("/upload")
async def upload_terrain(resolution: float = 1.0, file: UploadFile = File(...)):
    """Upload a DXF file and generate a DTM."""
    if not file.filename:
        raise HTTPException(status_code=422, detail="No filename provided")

    contents = await file.read()

    # Save to temp file for ezdxf
    import tempfile
    import os
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
    tmp.write(contents)
    tmp.close()

    try:
        points = await run_in_threadpool(parse_dxf, tmp.name)
    except DXFParseError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        os.unlink(tmp.name)

    # Generate DTM from points
    dtm_result = await run_in_threadpool(generate_dtm, points, resolution=resolution)
    terrain_id = store_terrain(dtm_result)

    return dtm_result.metadata.model_dump()


@router.post("/upload-stl")
async def upload_stl_terrain(resolution: float = 1.0, file: UploadFile = File(...)):
    """Upload an STL file and generate a DTM."""
    if not file.filename:
        raise HTTPException(status_code=422, detail="No filename provided")

    contents = await file.read()

    import tempfile
    import os
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False)
    tmp.write(contents)
    tmp.close()

    try:
        dtm_result = await run_in_threadpool(stl_to_dtm, tmp.name, resolution=resolution)
    except STLParseError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        os.unlink(tmp.name)

    terrain_id = store_terrain(dtm_result)

    return dtm_result.metadata.model_dump()


@router.post("/synthetic")
def create_synthetic_terrain(req: SyntheticTerrainRequest):
    """Generate synthetic bowl-shaped terrain."""
    dtm_result = generate_synthetic_terrain(
        size_x=req.size_x,
        size_y=req.size_y,
        depth=req.depth,
        resolution=req.resolution,
    )
    terrain_id = store_terrain(dtm_result)

    return dtm_result.metadata.model_dump()


@router.get("/{terrain_id}/grid")
def get_terrain_grid(terrain_id: str):
    """Retrieve terrain grid data."""
    dtm = get_terrain(terrain_id)
    if dtm is None:
        raise HTTPException(status_code=404, detail=f"Terrain '{terrain_id}' not found")

    return {
        "terrain_id": terrain_id,
        "grid": dtm.grid.tolist(),
        "metadata": dtm.metadata.model_dump(),
    }
