"""Domain models for the Radar Monitoring Simulator.

Defines Pydantic models for terrain data, radar configurations,
and line-of-sight analysis requests/responses.
"""

from typing import Literal

from pydantic import BaseModel, Field


class Point3D(BaseModel):
    """A 3D point in space (x, y, z)."""
    x: float
    y: float
    z: float


class BoundingBox(BaseModel):
    """Axis-aligned bounding box defined by min/max corners."""
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float


class DTMMetadata(BaseModel):
    """Metadata for a Digital Terrain Model (regular grid)."""
    terrain_id: str
    bounds: BoundingBox
    resolution: float = Field(gt=0, description="Grid cell size in meters")
    grid_rows: int = Field(gt=0, description="Number of grid rows")
    grid_cols: int = Field(gt=0, description="Number of grid columns")


class RadarConfig(BaseModel):
    """Configuration for a radar model, loaded from YAML."""
    model_id: str
    display_name: str
    manufacturer: str
    min_range_m: float = 0.0
    max_range_m: float
    h_beam_width_deg: float
    v_beam_width_deg: float
    elevation_min_deg: float
    elevation_max_deg: float
    scan_pattern: Literal["RAR", "SAR360"]
    azimuth_range_deg: tuple[float, float] | None = Field(
        default=None,
        description="Horizontal scanning sector (start, end) in degrees. None for SAR360 full rotation.",
    )


class LOSRequest(BaseModel):
    """Request payload for a Line-of-Sight analysis."""
    terrain_id: str = Field(min_length=1, description="ID of the terrain to analyze")
    radar_position: Point3D
    radar_model_id: str
    range_min_m: float | None = None
    range_max_m: float | None = None
    el_min_deg: float | None = None
    el_max_deg: float | None = None
    az_center_deg: float | None = None
    az_width_deg: float | None = None


class ShadowZone(BaseModel):
    """A contiguous region of shadowed cells."""
    zone_id: int
    cell_count: int


class LOSResponse(BaseModel):
    """Response from a Line-of-Sight analysis."""
    shadow_grid: list[list[bool]]
    coverage_polygon: list[tuple[float, float]]
    coverage_pct: float = Field(ge=0, le=100, description="Percentage of visible terrain")
    visible_area_m2: float
    shadow_zones: list[ShadowZone] = Field(default_factory=list)
    quality_grid: list[list[float]] | None = None
