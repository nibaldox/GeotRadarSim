"""STL parser service — parse STL files (ASCII/binary) and convert mesh to DTM.

Supports both ASCII and binary STL formats. Extracts triangulated mesh data
and converts it to a regular grid DTM using ray-casting against triangles.
"""

import struct
from pathlib import Path

import numpy as np

from app.models.domain import BoundingBox, DTMMetadata
from app.services.dtm_generator import DTMResult


class STLParseError(Exception):
    """Raised when STL parsing fails or file contains no valid mesh data."""


def parse_stl(file_path: str) -> list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]:
    """Parse an STL file and extract triangle vertices.

    Args:
        file_path: Path to the STL file.

    Returns:
        List of triangles, each triangle is a tuple of 3 vertices.
        Each vertex is a (x, y, z) tuple.

    Raises:
        STLParseError: If the file is malformed or contains no triangles.
    """
    path = Path(file_path)
    if not path.exists():
        raise STLParseError(f"File not found: {file_path}")

    try:
        with open(file_path, "rb") as f:
            header = f.read(80)
    except IOError as e:
        raise STLParseError(f"Failed to read STL file: {e}") from e

    # Detect format: if "solid" appears at start AND file contains "facet", it's ASCII
    try:
        header_text = header.decode("ascii", errors="replace").strip()
    except Exception:
        header_text = ""

    file_bytes = path.read_bytes()
    if header_text.lower().startswith("solid") and b"facet" in file_bytes[:1000]:
        triangles = _parse_ascii(file_path)
    else:
        try:
            triangles = _parse_binary(file_path)
        except (struct.error, IOError, ValueError) as e:
            raise STLParseError(
                f"Failed to parse binary STL file: {e}"
            ) from e

    if not triangles:
        raise STLParseError(
            "No valid triangles found in STL file. "
            "File may be empty or contain no mesh data."
        )

    return triangles


def _parse_ascii(file_path: str) -> list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]:
    """Parse an ASCII STL file."""
    triangles = []
    with open(file_path, "r") as f:
        lines = f.readlines()

    vertices: list[tuple[float, float, float]] = []
    for line in lines:
        line = line.strip()
        if line.startswith("vertex"):
            parts = line.split()
            if len(parts) >= 4:
                x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
                vertices.append((x, y, z))
                if len(vertices) == 3:
                    triangles.append((vertices[0], vertices[1], vertices[2]))
                    vertices = []

    return triangles


def _parse_binary(file_path: str) -> list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]:
    """Parse a binary STL file."""
    triangles = []
    with open(file_path, "rb") as f:
        f.read(80)  # header
        num_triangles = struct.unpack("<I", f.read(4))[0]

        for _ in range(num_triangles):
            # Skip normal vector (3 floats)
            f.read(12)
            # Read 3 vertices (9 floats)
            data = f.read(36)
            values = struct.unpack("<9f", data)
            v1 = (values[0], values[1], values[2])
            v2 = (values[3], values[4], values[5])
            v3 = (values[6], values[7], values[8])
            triangles.append((v1, v2, v3))
            # Skip attribute byte count
            f.read(2)

    return triangles


def _ray_triangle_intersect(
    ray_origin: np.ndarray,
    ray_dir: np.ndarray,
    v0: np.ndarray,
    v1: np.ndarray,
    v2: np.ndarray,
) -> float | None:
    """Möller–Trumbore ray-triangle intersection algorithm.

    Args:
        ray_origin: Origin point of the ray (3D).
        ray_dir: Direction of the ray (3D).
        v0, v1, v2: Triangle vertices.

    Returns:
        Distance along ray to intersection, or None if no hit.
    """
    epsilon = 1e-10
    edge1 = v1 - v0
    edge2 = v2 - v0
    h = np.cross(ray_dir, edge2)
    a = np.dot(edge1, h)

    if abs(a) < epsilon:
        return None  # Ray parallel to triangle

    f = 1.0 / a
    s = ray_origin - v0
    u = f * np.dot(s, h)

    if u < 0.0 or u > 1.0:
        return None

    q = np.cross(s, edge1)
    v = f * np.dot(ray_dir, q)

    if v < 0.0 or u + v > 1.0:
        return None

    t = f * np.dot(edge2, q)
    if t > epsilon:
        return t

    return None


def stl_to_dtm(
    file_path: str,
    resolution: float = 2.0,
) -> DTMResult:
    """Convert an STL mesh file to a regular grid DTM.

    For each grid cell center, casts a vertical ray downward and finds the
    intersection with the triangulated mesh. Uses the Z value at the intersection
    as the grid elevation.

    Args:
        file_path: Path to the STL file.
        resolution: Grid cell size in meters.

    Returns:
        DTMResult with grid, metadata, and optional warnings.
    """
    triangles = parse_stl(file_path)

    # Flatten all vertices to find bounding box
    all_vertices = []
    for tri in triangles:
        all_vertices.extend(tri)

    points_arr = np.array(all_vertices)
    x_coords = points_arr[:, 0]
    y_coords = points_arr[:, 1]
    z_coords = points_arr[:, 2]

    min_x, max_x = float(x_coords.min()), float(x_coords.max())
    min_y, max_y = float(y_coords.min()), float(y_coords.max())
    min_z, max_z = float(z_coords.min()), float(z_coords.max())

    eps = resolution * 0.01
    grid_cols = max(1, int(np.ceil((max_x - min_x + eps) / resolution)))
    grid_rows = max(1, int(np.ceil((max_y - min_y + eps) / resolution)))

    # Generate grid cell centers
    xi = np.linspace(min_x, max_x, grid_cols)
    yi = np.linspace(min_y, max_y, grid_rows)

    # Build array of triangle vertices for ray-casting
    tri_array = np.array(triangles, dtype=np.float64)  # shape: (N, 3, 3)

    # Cast rays from above (z = max_z + 100) downward
    ray_origin_z = max_z + 1000.0
    ray_dir = np.array([0.0, 0.0, -1.0])

    grid_z = np.full((grid_rows, grid_cols), np.nan)

    warnings: list[str] = []

    for row_idx in range(grid_rows):
        for col_idx in range(grid_cols):
            cx, cy = xi[col_idx], yi[row_idx]
            ray_origin = np.array([cx, cy, ray_origin_z])

            best_t = None
            for tri_idx in range(len(tri_array)):
                v0 = tri_array[tri_idx, 0]
                v1 = tri_array[tri_idx, 1]
                v2 = tri_array[tri_idx, 2]

                t = _ray_triangle_intersect(ray_origin, ray_dir, v0, v1, v2)
                if t is not None:
                    if best_t is None or t < best_t:
                        best_t = t

            if best_t is not None:
                # Z at intersection = ray_origin_z - t (since ray goes down)
                grid_z[row_idx, col_idx] = ray_origin_z - best_t

    # Fill NaN cells with nearest valid neighbor fallback
    if np.any(np.isnan(grid_z)):
        warnings.append(
            f"Some grid cells ({np.sum(np.isnan(grid_z))}) had no triangle intersection. "
            "Filled with nearest-neighbor interpolation."
        )
        from scipy.interpolate import griddata
        valid_mask = ~np.isnan(grid_z)
        if np.any(valid_mask):
            valid_points = np.column_stack([
                np.meshgrid(xi, yi)[0][valid_mask],
                np.meshgrid(xi, yi)[1][valid_mask],
            ])
            valid_values = grid_z[valid_mask]
            all_points = np.column_stack([
                np.meshgrid(xi, yi)[0].ravel(),
                np.meshgrid(xi, yi)[1].ravel(),
            ])
            filled = griddata(valid_points, valid_values, all_points, method="nearest")
            grid_z = filled.reshape(grid_rows, grid_cols)
        else:
            # No valid cells at all — fill with mean Z
            grid_z = np.full((grid_rows, grid_cols), float(np.mean(z_coords)))

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
