"""Synthetic terrain generator — bowl-shaped open pit for testing."""

import numpy as np
import uuid

from app.models.domain import BoundingBox, DTMMetadata
from app.services.dtm_generator import DTMResult


def generate_synthetic_terrain(
    size_x: float,
    size_y: float,
    depth: float,
    resolution: float = 2.0,
) -> DTMResult:
    """Generate a synthetic bowl-shaped open pit terrain.

    The bowl is centered in the bounding box with edges at z=0 and
    the center at z=-depth. Uses a quadratic profile for natural shape.

    Args:
        size_x: Extent in x direction (meters).
        size_y: Extent in y direction (meters).
        depth: Maximum depth of the pit (meters, positive value).
        resolution: Grid cell size (meters).

    Returns:
        DTMResult with the generated terrain grid and metadata.
    """
    grid_cols = max(1, int(round(size_x / resolution)))
    grid_rows = max(1, int(round(size_y / resolution)))

    # Create coordinate arrays centered at (0, 0)
    x = np.linspace(-size_x / 2, size_x / 2, grid_cols)
    y = np.linspace(-size_y / 2, size_y / 2, grid_rows)
    xx, yy = np.meshgrid(x, y)

    # Normalized distance from center (0 at center, 1 at edges)
    r_x = xx / (size_x / 2)
    r_y = yy / (size_y / 2)

    # Quadratic bowl: z = depth * (r^2 - 1) — deepest at center, zero at edges
    r_squared = r_x**2 + r_y**2
    grid_z = -depth * (1.0 - r_squared)
    grid_z = np.minimum(grid_z, 0.0)  # Cap at 0 outside the bowl

    terrain_id = f"synthetic-{uuid.uuid4().hex[:8]}"

    metadata = DTMMetadata(
        terrain_id=terrain_id,
        bounds=BoundingBox(
            min_x=0.0, min_y=0.0, min_z=-depth,
            max_x=size_x, max_y=size_y, max_z=0.0,
        ),
        resolution=resolution,
        grid_rows=grid_rows,
        grid_cols=grid_cols,
    )

    return DTMResult(grid=grid_z, metadata=metadata, warnings=[])
