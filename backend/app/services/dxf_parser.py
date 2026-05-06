"""DXF parser service — extract 3D point cloud from DXF files.

Supports POLYLINE3D and POINT entities with elevation data.
Rejects files without elevation data or malformed DXF.
"""

from pathlib import Path

import ezdxf


class DXFParseError(Exception):
    """Raised when DXF parsing fails or file lacks elevation data."""


def parse_dxf(file_path: str) -> list[tuple[float, float, float]]:
    """Parse a DXF file and extract 3D vertex coordinates.

    Args:
        file_path: Path to the DXF file.

    Returns:
        List of (x, y, z) tuples representing the 3D point cloud.

    Raises:
        DXFParseError: If the file is malformed or contains no 3D data.
    """
    try:
        doc = ezdxf.readfile(file_path)
    except (IOError, ezdxf.DXFStructureError) as e:
        raise DXFParseError(f"Failed to read DXF file: {e}") from e

    msp = doc.modelspace()
    points: list[tuple[float, float, float]] = []

    # Extract vertices from 3D POLYLINE entities
    for entity in msp.query("POLYLINE"):
        if entity.dxf.flags & 8:  # 3D polyline flag
            for vertex in entity.vertices:
                location = vertex.dxf.location
                points.append((location.x, location.y, location.z))

    # Extract POINT entities with elevation
    for entity in msp.query("POINT"):
        location = entity.dxf.location
        points.append((location.x, location.y, location.z))

    if not points:
        raise DXFParseError(
            "No 3D elevation data found in DXF file. "
            "File contains only 2D entities or has no geometric data."
        )

    return points
