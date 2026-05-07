"""STL parser service — parse STL files (ASCII/binary) and convert mesh to DTM.

Supports both ASCII and binary STL formats. Extracts triangulated mesh data
and converts it to a regular grid DTM using fast scipy interpolation.
"""

import struct
from pathlib import Path

import numpy as np
from scipy.interpolate import griddata

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


def stl_to_dtm(
    file_path: str,
    resolution: float = 2.0,
) -> DTMResult:
    """Convert an STL mesh file to a regular grid DTM.

    Uses scipy griddata interpolation for fast conversion — extracts all
    triangle vertices as a point cloud, deduplicates, and interpolates onto
    a regular grid. This is orders of magnitude faster than ray-casting
    for large meshes (seconds instead of hours for 700K+ triangles).

    Args:
        file_path: Path to the STL file.
        resolution: Grid cell size in meters.

    Returns:
        DTMResult with grid, metadata, and optional warnings.
    """
    triangles = parse_stl(file_path)

    # Extract all vertices and deduplicate
    all_vertices = np.array(
        [v for tri in triangles for v in tri],
        dtype=np.float64,
    )

    # Deduplicate vertices (shared between adjacent triangles)
    # Round to mm precision to merge near-identical points
    rounded = np.round(all_vertices, 3)
    unique_vertices = np.unique(rounded, axis=0)

    x_all = unique_vertices[:, 0]
    y_all = unique_vertices[:, 1]
    z_all = unique_vertices[:, 2]

    min_x, max_x = float(x_all.min()), float(x_all.max())
    min_y, max_y = float(y_all.min()), float(y_all.max())
    min_z, max_z = float(z_all.min()), float(z_all.max())

    eps = resolution * 0.01
    grid_cols = max(1, int(np.ceil((max_x - min_x + eps) / resolution)))
    grid_rows = max(1, int(np.ceil((max_y - min_y + eps) / resolution)))

    # Generate regular grid
    xi = np.linspace(min_x, max_x, grid_cols)
    yi = np.linspace(min_y, max_y, grid_rows)
    grid_x, grid_y = np.meshgrid(xi, yi)

    # Interpolate Z values onto regular grid using linear interpolation
    # Falls back to nearest-neighbor for cells outside the convex hull
    warnings: list[str] = []

    grid_z = griddata(
        points=(x_all, y_all),
        values=z_all,
        xi=(grid_x, grid_y),
        method="linear",
    )

    # Fill NaN cells (outside convex hull) with nearest-neighbor
    nan_count = int(np.sum(np.isnan(grid_z)))
    if nan_count > 0:
        grid_z_nn = griddata(
            points=(x_all, y_all),
            values=z_all,
            xi=(grid_x, grid_y),
            method="nearest",
        )
        nan_mask = np.isnan(grid_z)
        grid_z[nan_mask] = grid_z_nn[nan_mask]

        warnings.append(
            f"{nan_count} grid cells fell outside the surface convex hull "
            f"and were filled with nearest-neighbor interpolation."
        )

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
