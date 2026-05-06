"""LOS engine — vectorized ray-casting over grid DTM.

For each terrain grid cell, cast a ray from the radar position and check
if any intermediate cell's elevation blocks the line of sight.
Uses NumPy vectorized operations for performance.
"""

import math
from dataclasses import dataclass, field

import numpy as np

from app.models.domain import RadarConfig
from app.services.dtm_generator import DTMResult


@dataclass
class LOSResult:
    """Result of Line-of-Sight analysis."""
    shadow_grid: list[list[bool]]  # True = shadowed
    coverage_polygon: list[tuple[float, float]]
    coverage_pct: float
    visible_area_m2: float
    shadow_zones: list[dict] = field(default_factory=list)


def compute_los(
    dtm: DTMResult,
    radar_position: tuple[float, float, float],
    radar_config: RadarConfig,
) -> LOSResult:
    """Compute Line-of-Sight visibility from radar position over the DTM.

    For each grid cell within range and angular limits, casts a ray and
    checks for terrain obstructions along the line.

    Args:
        dtm: Digital Terrain Model with grid and metadata.
        radar_position: (x, y, z) of the radar in world coordinates.
        radar_config: Radar model configuration (range, angles, pattern).

    Returns:
        LOSResult with shadow grid, coverage polygon, and statistics.
    """
    grid = dtm.grid
    meta = dtm.metadata
    bounds = meta.bounds
    res = meta.resolution
    rows, cols = grid.shape

    rx, ry, rz = radar_position
    max_range = radar_config.max_range_m

    # Build coordinate arrays for each grid cell
    x_coords = np.linspace(bounds.min_x + res / 2, bounds.max_x - res / 2, cols)
    y_coords = np.linspace(bounds.min_y + res / 2, bounds.max_y - res / 2, rows)
    xx, yy = np.meshgrid(x_coords, y_coords)

    # Distance from radar to each cell center
    dx = xx - rx
    dy = yy - ry
    dist = np.sqrt(dx**2 + dy**2)

    # Angular check: compute azimuth angle of each cell relative to radar
    azimuth = np.degrees(np.arctan2(dx, dy))  # 0=North, clockwise

    # Determine which cells are within range and angular sector
    in_range = dist <= max_range

    if radar_config.scan_pattern == "SAR360" or radar_config.azimuth_range_deg is None:
        in_sector = np.ones((rows, cols), dtype=bool)
    else:
        az_start, az_end = radar_config.azimuth_range_deg
        # Normalize azimuth to [-180, 180]
        azimuth = np.where(azimuth > 180, azimuth - 360, azimuth)
        azimuth = np.where(azimuth < -180, azimuth + 360, azimuth)
        if az_start <= az_end:
            in_sector = (azimuth >= az_start) & (azimuth <= az_end)
        else:
            # Sector wraps around ±180
            in_sector = (azimuth >= az_start) | (azimuth <= az_end)

    # Cells to analyze: within range AND within sector
    analyzable = in_range & in_sector

    # LOS ray-casting: for each analyzable cell, check if terrain blocks the ray
    shadow = np.ones((rows, cols), dtype=bool)  # Default: shadowed

    # Get analyzable cell indices
    analyzable_indices = np.argwhere(analyzable)

    for idx in analyzable_indices:
        r, c = idx[0], idx[1]
        if dist[r, c] < res:
            # Cell is at radar position — visible
            shadow[r, c] = False
            continue

        target_z = grid[r, c]
        cell_x = xx[r, c]
        cell_y = yy[r, c]
        cell_dist = dist[r, c]

        # Sample points along the ray
        n_samples = max(2, int(cell_dist / res))
        t_values = np.linspace(0, 1, n_samples, endpoint=False)[1:]  # Skip start point

        ray_x = rx + t_values * (cell_x - rx)
        ray_y = ry + t_values * (cell_y - ry)

        # Elevation of the ray at each sample point
        ray_z = rz + t_values * (target_z - rz)

        # Get terrain elevation at each sample point (bilinear lookup)
        col_f = (ray_x - bounds.min_x) / res - 0.5
        row_f = (ray_y - bounds.min_y) / res - 0.5

        col_i = np.clip(np.round(col_f).astype(int), 0, cols - 1)
        row_i = np.clip(np.round(row_f).astype(int), 0, rows - 1)

        terrain_at_samples = grid[row_i, col_i]

        # If any terrain point is above the ray, the target is shadowed
        if np.any(terrain_at_samples > ray_z):
            shadow[r, c] = True
        else:
            shadow[r, c] = False

    # Cells not analyzable are out of range — mark as shadowed
    # (already True by default)

    # Compute coverage statistics
    total_analyzable = int(analyzable.sum())
    if total_analyzable == 0:
        return LOSResult(
            shadow_grid=shadow.tolist(),
            coverage_polygon=[],
            coverage_pct=0.0,
            visible_area_m2=0.0,
            shadow_zones=[],
        )

    visible_in_range = int((~shadow & analyzable).sum())
    coverage_pct = (visible_in_range / total_analyzable) * 100.0 if total_analyzable > 0 else 0.0
    cell_area = res * res
    visible_area_m2 = visible_in_range * cell_area

    # Compute coverage polygon (convex hull of visible cells)
    visible_mask = ~shadow & analyzable
    coverage_polygon = _compute_coverage_polygon(xx, yy, visible_mask)

    # Group contiguous shadowed regions into zones
    shadow_list = shadow.tolist()
    shadow_zones = group_shadow_zones(shadow_list)

    return LOSResult(
        shadow_grid=shadow_list,
        coverage_polygon=coverage_polygon,
        coverage_pct=round(coverage_pct, 2),
        visible_area_m2=round(visible_area_m2, 2),
        shadow_zones=shadow_zones,
    )


def _compute_coverage_polygon(
    xx: np.ndarray,
    yy: np.ndarray,
    visible_mask: np.ndarray,
) -> list[tuple[float, float]]:
    """Compute a simple bounding polygon of visible cells.

    Returns the convex hull of visible cell centers, or an empty list if none visible.
    """
    if not visible_mask.any():
        return []

    from shapely.geometry import MultiPoint

    vis_x = xx[visible_mask]
    vis_y = yy[visible_mask]

    if len(vis_x) < 3:
        return [(float(x), float(y)) for x, y in zip(vis_x, vis_y)]

    points = MultiPoint(list(zip(vis_x, vis_y)))
    hull = points.convex_hull

    if hull.geom_type == "Polygon":
        return [(float(x), float(y)) for x, y in hull.exterior.coords]
    elif hull.geom_type == "LineString":
        return [(float(x), float(y)) for x, y in hull.coords]
    else:
        return [(float(x), float(y)) for x, y in zip(vis_x, vis_y)]


def group_shadow_zones(
    shadow_grid: list[list[bool]],
) -> list[dict]:
    """Group contiguous shadowed cells into named zones using flood fill.

    Uses 4-connectivity (up/down/left/right). Diagonal cells are NOT adjacent.

    Args:
        shadow_grid: 2D grid where True = shadowed cell.

    Returns:
        List of dicts with zone_id and cell_count.
    """
    if not shadow_grid or not shadow_grid[0]:
        return []

    rows = len(shadow_grid)
    cols = len(shadow_grid[0])
    visited = [[False] * cols for _ in range(rows)]
    zones = []
    zone_id = 0

    for r in range(rows):
        for c in range(cols):
            if shadow_grid[r][c] and not visited[r][c]:
                # BFS flood fill
                zone_id += 1
                count = 0
                queue = [(r, c)]
                visited[r][c] = True
                while queue:
                    cr, cc = queue.pop(0)
                    count += 1
                    # 4-connectivity neighbors
                    for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                        nr, nc = cr + dr, cc + dc
                        if (0 <= nr < rows and 0 <= nc < cols
                                and not visited[nr][nc]
                                and shadow_grid[nr][nc]):
                            visited[nr][nc] = True
                            queue.append((nr, nc))
                zones.append({"zone_id": zone_id, "cell_count": count})

    return zones
