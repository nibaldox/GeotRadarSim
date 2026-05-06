"""DTM generator service — convert point cloud to regular grid using scipy interpolation."""

from dataclasses import dataclass, field

import numpy as np
from scipy.interpolate import griddata

from app.models.domain import BoundingBox, DTMMetadata

SPARSE_THRESHOLD = 100


@dataclass
class DTMResult:
    """Result of DTM generation."""
    grid: np.ndarray
    metadata: DTMMetadata
    warnings: list[str] = field(default_factory=list)


def generate_dtm(
    points: list[tuple[float, float, float]],
    resolution: float = 2.0,
) -> DTMResult:
    """Generate a regular grid DTM from a 3D point cloud.

    Uses scipy.griddata for interpolation. Warns if point cloud is sparse.

    Args:
        points: List of (x, y, z) tuples.
        resolution: Grid cell size in meters.

    Returns:
        DTMResult with grid, metadata, and optional warnings.
    """
    points_arr = np.array(points)
    x = points_arr[:, 0]
    y = points_arr[:, 1]
    z = points_arr[:, 2]

    warnings: list[str] = []

    if len(points) < SPARSE_THRESHOLD:
        warnings.append(
            f"Sparse point cloud: {len(points)} points (threshold: {SPARSE_THRESHOLD}). "
            "Interpolation may be inaccurate."
        )

    min_x, max_x = float(x.min()), float(x.max())
    min_y, max_y = float(y.min()), float(y.max())
    min_z, max_z = float(z.min()), float(z.max())

    # Add small padding to avoid edge issues
    eps = resolution * 0.01
    grid_cols = max(1, int(np.ceil((max_x - min_x + eps) / resolution)))
    grid_rows = max(1, int(np.ceil((max_y - min_y + eps) / resolution)))

    # Generate regular grid
    xi = np.linspace(min_x, max_x, grid_cols)
    yi = np.linspace(min_y, max_y, grid_rows)
    xi_grid, yi_grid = np.meshgrid(xi, yi)

    # Handle degenerate cases: too few points for Delaunay triangulation
    # Need at least 3 non-collinear points for linear interpolation
    if len(points) < 3:
        # Flat grid at average elevation
        grid_z = np.full((grid_rows, grid_cols), float(np.mean(z)))
    else:
        # Interpolate with linear, fallback to nearest for gaps
        try:
            grid_z = griddata(
                points_arr[:, :2],
                z,
                (xi_grid, yi_grid),
                method="linear",
            )
        except Exception:
            grid_z = np.full((grid_rows, grid_cols), np.nan)

        # Fill NaNs with nearest-neighbor fallback
        if np.any(np.isnan(grid_z)):
            nearest = griddata(
                points_arr[:, :2],
                z,
                (xi_grid, yi_grid),
                method="nearest",
            )
            nan_mask = np.isnan(grid_z)
            grid_z[nan_mask] = nearest[nan_mask]

    terrain_id = f"dtm-{min_x:.0f}-{min_y:.0f}-{resolution}"

    metadata = DTMMetadata(
        terrain_id=terrain_id,
        bounds=BoundingBox(
            min_x=min_x, min_y=min_y, min_z=min_z,
            max_x=max_x, max_y=max_y, max_z=max_z,
        ),
        resolution=resolution,
        grid_rows=grid_rows,
        grid_cols=grid_cols,
    )

    return DTMResult(grid=grid_z, metadata=metadata, warnings=warnings)
