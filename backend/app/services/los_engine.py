"""LOS engine — vectorized ray-casting over grid DTM.

For each terrain grid cell, cast a ray from the radar position and check
if any intermediate cell's elevation blocks the line of sight.
Uses NumPy vectorized operations for performance.
"""

import math
from dataclasses import dataclass, field

import os
from concurrent.futures import ProcessPoolExecutor
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
    quality_grid: list[list[float]] | None = None


def _check_cell_los_worker(
    chunk_indices: np.ndarray,
    grid: np.ndarray,
    rx: float, ry: float, rz: float,
    xx: np.ndarray, yy: np.ndarray,
    dist: np.ndarray,
    bounds_min_x: float, bounds_min_y: float,
    res: float,
    rows: int, cols: int
) -> list[tuple[int, int, bool]]:
    """Worker function to process a chunk of cells in parallel."""
    results = []
    for idx in chunk_indices:
        r, c = idx[0], idx[1]
        if dist[r, c] < res:
            results.append((r, c, False))
            continue

        target_z = grid[r, c]
        cell_x = xx[r, c]
        cell_y = yy[r, c]
        cell_dist = dist[r, c]

        # Sample points along the ray - increase density to 2x resolution
        n_samples = max(2, int(cell_dist / (res * 0.5)))
        t_values = np.linspace(0, 1, n_samples, endpoint=False)[1:]
 
        ray_x = rx + t_values * (cell_x - rx)
        ray_y = ry + t_values * (cell_y - ry)
        ray_z = rz + t_values * (target_z - rz)
 
        col_f = (ray_x - bounds_min_x) / res - 0.5
        row_f = (ray_y - bounds_min_y) / res - 0.5
 
        c0 = np.floor(col_f).astype(int).clip(0, cols - 1)
        r0 = np.floor(row_f).astype(int).clip(0, rows - 1)
        c1 = (c0 + 1).clip(0, cols - 1)
        r1 = (r0 + 1).clip(0, rows - 1)
 
        fc = col_f - np.floor(col_f)
        fr = row_f - np.floor(row_f)
 
        z00 = grid[r0, c0]
        z01 = grid[r0, c1]
        z10 = grid[r1, c0]
        z11 = grid[r1, c1]
 
        terrain_at_samples = (
            z00 * (1 - fc) * (1 - fr) +
            z01 * fc * (1 - fr) +
            z10 * (1 - fc) * fr +
            z11 * fc * fr
        )
 
        is_shadowed = np.any(terrain_at_samples > ray_z)
        results.append((r, c, bool(is_shadowed)))
    
    return results


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
    min_range = getattr(radar_config, "min_range_m", 0.0)
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

    # Elevation angle check
    dz = grid - rz
    elevation = np.degrees(np.arctan2(dz, dist))

    # Determine which cells are within range and angular sector
    in_range = (dist >= min_range) & (dist <= max_range)
    in_el_sector = (elevation >= radar_config.elevation_min_deg) & (elevation <= radar_config.elevation_max_deg)

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

    # Cells to analyze: within range AND horizontal sector AND vertical sector
    analyzable = in_range & in_sector & in_el_sector

    # Parallel LOS ray-casting
    shadow = np.ones((rows, cols), dtype=bool)
    analyzable_indices = np.argwhere(analyzable)
    
    if len(analyzable_indices) > 0:
        # Use ProcessPoolExecutor for multi-core processing
        num_workers = os.cpu_count() or 1
        # Divide work into chunks
        chunks = np.array_split(analyzable_indices, num_workers * 2)
        
        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            futures = [
                executor.submit(
                    _check_cell_los_worker,
                    chunk, grid, rx, ry, rz, xx, yy, dist,
                    bounds.min_x, bounds.min_y, res, rows, cols
                )
                for chunk in chunks if len(chunk) > 0
            ]
            
            for future in futures:
                chunk_results = future.result()
                for r, c, is_shadowed in chunk_results:
                    shadow[r, c] = is_shadowed

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

    # Compute quality grid (only for non-shadowed areas)
    quality = np.zeros((rows, cols), dtype=float)
    visible_mask = ~shadow & analyzable
    
    if visible_mask.any():
        # Calculate surface normals (simplified central differences)
        # Gradient in X (cols) and Y (rows)
        grad_y, grad_x = np.gradient(grid, res)
        # Surface normal unit vectors: n = (-grad_x, -grad_y, 1) / norm
        norm = np.sqrt(grad_x**2 + grad_y**2 + 1.0)
        nx = -grad_x / norm
        ny = -grad_y / norm
        nz = 1.0 / norm
        
        # Unit vectors from radar to each visible cell
        # Vector V = (dx, dy, dz)
        dz = grid - rz
        # dist is horizontal distance, let's get total 3D distance
        dist3d = np.sqrt(dx**2 + dy**2 + dz**2)
        dist3d = np.where(dist3d < 0.1, 0.1, dist3d) # Avoid division by zero
        vx = dx / dist3d
        vy = dy / dist3d
        vz = dz / dist3d
        
        # Incidence angle cosine: dot product between surface normal and inverse radar ray
        # dot = (-vx*nx) + (-vy*ny) + (-vz*nz)
        dot_product = -(vx * nx + vy * ny + vz * nz)
        dot_product = np.clip(dot_product, 0.0, 1.0)
        
        # Distance decay factor (1.0 at radar, 0.0 at max_range)
        # Using a softer decay (1 - R/Rmax)^0.5 for modern long-range radars
        dist_factor = (1.0 - (dist / max_range)).clip(0, 1) ** 0.5
        
        # Final quality score
        quality[visible_mask] = dot_product[visible_mask] * dist_factor[visible_mask]

    return LOSResult(
        shadow_grid=shadow_list,
        coverage_polygon=coverage_polygon,
        coverage_pct=round(coverage_pct, 2),
        visible_area_m2=round(visible_area_m2, 2),
        shadow_zones=shadow_zones,
        quality_grid=quality.tolist(),
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
