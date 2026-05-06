"""Tests for STL parser service — triangulated mesh parsing and DTM conversion.

Tests verify:
1. ASCII STL format parsing
2. Binary STL format parsing
3. Mesh-to-grid DTM conversion with ray-casting
4. Error handling for empty/invalid STL files
5. Grid resolution is respected
6. Edge cases: degenerate triangles, single triangle
"""

import pytest
import struct
import tempfile
import os
import numpy as np


def _create_ascii_stl(triangles: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]) -> str:
    """Helper: create an ASCII STL file with given triangles and return its path.

    Each triangle is a tuple of 3 vertices: ((x1,y1,z1), (x2,y2,z2), (x3,y3,z3)).
    Normal is computed as (0,0,1) for simplicity.
    """
    lines = ["solid test"]
    for v1, v2, v3 in triangles:
        lines.append("  facet normal 0 0 1")
        lines.append("    outer loop")
        lines.append(f"      vertex {v1[0]} {v1[1]} {v1[2]}")
        lines.append(f"      vertex {v2[0]} {v2[1]} {v2[2]}")
        lines.append(f"      vertex {v3[0]} {v3[1]} {v3[2]}")
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid test")
    content = "\n".join(lines) + "\n"

    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="w")
    tmp.write(content)
    tmp.close()
    return tmp.name


def _create_binary_stl(triangles: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]) -> str:
    """Helper: create a binary STL file with given triangles and return its path."""
    # Binary STL format: 80-byte header + 4-byte triangle count + triangle data
    header = b'\x00' * 80
    num_triangles = len(triangles)
    data = struct.pack('<I', num_triangles)

    for v1, v2, v3 in triangles:
        # Normal (0, 0, 1)
        data += struct.pack('<fff', 0.0, 0.0, 1.0)
        # Vertex 1
        data += struct.pack('<fff', v1[0], v1[1], v1[2])
        # Vertex 2
        data += struct.pack('<fff', v2[0], v2[1], v2[2])
        # Vertex 3
        data += struct.pack('<fff', v3[0], v3[1], v3[2])
        # Attribute byte count
        data += struct.pack('<H', 0)

    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="wb")
    tmp.write(header + data)
    tmp.close()
    return tmp.name


def _create_invalid_stl() -> str:
    """Helper: create an invalid file with .stl extension."""
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="w")
    tmp.write("THIS IS NOT A VALID STL FILE {{{corrupted}}}")
    tmp.close()
    return tmp.name


def _create_empty_ascii_stl() -> str:
    """Helper: create an empty ASCII STL (no facets)."""
    content = "solid empty\nendsolid empty\n"
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="w")
    tmp.write(content)
    tmp.close()
    return tmp.name


class TestSTLParserASCII:
    """Tests for ASCII STL file parsing."""

    def test_ascii_stl_extracts_single_triangle(self):
        """GIVEN ASCII STL with 1 triangle, WHEN parsed, THEN 1 triangle extracted."""
        from app.services.stl_parser import parse_stl
        path = _create_ascii_stl([
            ((0.0, 0.0, 10.0), (10.0, 0.0, 10.0), (5.0, 10.0, 10.0)),
        ])
        try:
            triangles = parse_stl(path)
            assert len(triangles) == 1
            v1, v2, v3 = triangles[0]
            assert v1 == pytest.approx((0.0, 0.0, 10.0))
            assert v2 == pytest.approx((10.0, 0.0, 10.0))
            assert v3 == pytest.approx((5.0, 10.0, 10.0))
        finally:
            os.unlink(path)

    def test_ascii_stl_extracts_multiple_triangles(self):
        """GIVEN ASCII STL with 4 triangles, WHEN parsed, THEN all 4 extracted."""
        from app.services.stl_parser import parse_stl
        triangles_input = [
            ((0, 0, 10), (10, 0, 10), (5, 10, 10)),
            ((10, 0, 10), (20, 0, 10), (15, 10, 10)),
            ((0, 10, 20), (10, 10, 20), (5, 20, 20)),
            ((10, 10, 20), (20, 10, 20), (15, 20, 20)),
        ]
        path = _create_ascii_stl(triangles_input)
        try:
            triangles = parse_stl(path)
            assert len(triangles) == 4
        finally:
            os.unlink(path)

    def test_ascii_stl_preserves_z_elevation(self):
        """GIVEN ASCII STL with varied Z values, WHEN parsed, THEN Z values preserved."""
        from app.services.stl_parser import parse_stl
        path = _create_ascii_stl([
            ((0, 0, 5.5), (10, 0, 15.3), (5, 10, 25.7)),
        ])
        try:
            triangles = parse_stl(path)
            all_z = [v[2] for tri in triangles for v in tri]
            assert 5.5 in all_z
            assert 15.3 in all_z
            assert 25.7 in all_z
        finally:
            os.unlink(path)


class TestSTLParserBinary:
    """Tests for binary STL file parsing."""

    def test_binary_stl_extracts_single_triangle(self):
        """GIVEN binary STL with 1 triangle, WHEN parsed, THEN 1 triangle extracted."""
        from app.services.stl_parser import parse_stl
        path = _create_binary_stl([
            ((0.0, 0.0, 10.0), (10.0, 0.0, 10.0), (5.0, 10.0, 10.0)),
        ])
        try:
            triangles = parse_stl(path)
            assert len(triangles) == 1
            v1, v2, v3 = triangles[0]
            assert v1 == pytest.approx((0.0, 0.0, 10.0))
            assert v2 == pytest.approx((10.0, 0.0, 10.0))
            assert v3 == pytest.approx((5.0, 10.0, 10.0))
        finally:
            os.unlink(path)

    def test_binary_stl_extracts_multiple_triangles(self):
        """GIVEN binary STL with 3 triangles, WHEN parsed, THEN all 3 extracted."""
        from app.services.stl_parser import parse_stl
        path = _create_binary_stl([
            ((0, 0, 10), (10, 0, 10), (5, 10, 10)),
            ((10, 0, 10), (20, 0, 10), (15, 10, 10)),
            ((0, 10, 20), (10, 10, 20), (5, 20, 20)),
        ])
        try:
            triangles = parse_stl(path)
            assert len(triangles) == 3
        finally:
            os.unlink(path)


class TestSTLParserErrors:
    """Tests for error handling in STL parsing."""

    def test_invalid_stl_raises_error(self):
        """GIVEN corrupted file, WHEN parsed, THEN STLParseError raised."""
        from app.services.stl_parser import parse_stl, STLParseError
        path = _create_invalid_stl()
        try:
            with pytest.raises(STLParseError):
                parse_stl(path)
        finally:
            os.unlink(path)

    def test_empty_stl_raises_error(self):
        """GIVEN empty STL with no facets, WHEN parsed, THEN STLParseError raised."""
        from app.services.stl_parser import parse_stl, STLParseError
        path = _create_empty_ascii_stl()
        try:
            with pytest.raises(STLParseError):
                parse_stl(path)
        finally:
            os.unlink(path)

    def test_nonexistent_file_raises_error(self):
        """GIVEN nonexistent file path, WHEN parsed, THEN STLParseError raised."""
        from app.services.stl_parser import parse_stl, STLParseError
        with pytest.raises(STLParseError):
            parse_stl("/nonexistent/path/file.stl")


class TestMeshToGridConversion:
    """Tests for converting triangulated mesh to regular grid DTM."""

    def test_flat_mesh_produces_constant_grid(self):
        """GIVEN flat mesh at Z=10, WHEN converted to grid, THEN all cells are 10."""
        from app.services.stl_parser import stl_to_dtm
        # Create two triangles forming a flat square at Z=10
        triangles = [
            ((0, 0, 10), (10, 0, 10), (10, 10, 10)),
            ((0, 0, 10), (10, 10, 10), (0, 10, 10)),
        ]
        path = _create_ascii_stl(triangles)
        try:
            dtm = stl_to_dtm(path, resolution=5.0)
            # All grid values should be ~10
            assert dtm.grid is not None
            assert dtm.grid.shape[0] > 0
            assert dtm.grid.shape[1] > 0
            # Every cell should be approximately 10
            np.testing.assert_allclose(dtm.grid, 10.0, atol=0.5)
        finally:
            os.unlink(path)

    def test_inclined_mesh_produces_varying_grid(self):
        """GIVEN inclined mesh (Z varies with X), WHEN converted to grid, THEN grid varies."""
        from app.services.stl_parser import stl_to_dtm
        # Triangle sloping from Z=0 at X=0 to Z=20 at X=20
        triangles = [
            ((0, 0, 0), (20, 0, 20), (20, 20, 20)),
            ((0, 0, 0), (20, 20, 20), (0, 20, 0)),
        ]
        path = _create_ascii_stl(triangles)
        try:
            dtm = stl_to_dtm(path, resolution=5.0)
            # Grid should have varying Z values
            assert dtm.grid is not None
            # The max Z should be substantially higher than the min Z
            assert float(dtm.grid.max()) > float(dtm.grid.min()) + 5.0
        finally:
            os.unlink(path)

    def test_grid_resolution_respected(self):
        """GIVEN resolution=5.0 for a 20x20 mesh, WHEN converted, THEN grid has correct dimensions."""
        from app.services.stl_parser import stl_to_dtm
        triangles = [
            ((0, 0, 10), (20, 0, 10), (20, 20, 10)),
            ((0, 0, 10), (20, 20, 10), (0, 20, 10)),
        ]
        path = _create_ascii_stl(triangles)
        try:
            dtm = stl_to_dtm(path, resolution=5.0)
            # 20 / 5 = 4 cols, 20 / 5 = 4 rows (approximately, depends on linspace)
            assert dtm.metadata.grid_cols >= 3
            assert dtm.metadata.grid_rows >= 3
            assert dtm.metadata.resolution == 5.0
        finally:
            os.unlink(path)

    def test_dtm_result_has_correct_metadata(self):
        """GIVEN valid STL mesh, WHEN converted to DTM, THEN metadata has all required fields."""
        from app.services.stl_parser import stl_to_dtm
        triangles = [
            ((0, 0, 5), (10, 0, 15), (10, 10, 25)),
            ((0, 0, 5), (10, 10, 25), (0, 10, 10)),
        ]
        path = _create_ascii_stl(triangles)
        try:
            dtm = stl_to_dtm(path, resolution=2.0)
            assert dtm.metadata.terrain_id.startswith("dtm-")
            assert dtm.metadata.bounds.min_x == pytest.approx(0.0)
            assert dtm.metadata.bounds.max_x == pytest.approx(10.0)
            assert dtm.metadata.bounds.min_z == pytest.approx(5.0)
            assert dtm.metadata.bounds.max_z == pytest.approx(25.0)
            assert dtm.metadata.grid_rows > 0
            assert dtm.metadata.grid_cols > 0
        finally:
            os.unlink(path)

    def test_stl_to_dtm_returns_dtm_result_type(self):
        """GIVEN valid STL mesh, WHEN converted, THEN returns DTMResult compatible with DXF pipeline."""
        from app.services.stl_parser import stl_to_dtm
        from app.services.dtm_generator import DTMResult
        triangles = [
            ((0, 0, 10), (10, 0, 10), (10, 10, 10)),
        ]
        path = _create_ascii_stl(triangles)
        try:
            dtm = stl_to_dtm(path)
            assert isinstance(dtm, DTMResult)
            assert isinstance(dtm.grid, np.ndarray)
            assert hasattr(dtm, 'metadata')
            assert hasattr(dtm, 'warnings')
        finally:
            os.unlink(path)

    def test_degenerate_triangle_handled(self):
        """GIVEN degenerate triangle (all vertices collinear), WHEN converted, THEN no crash."""
        from app.services.stl_parser import stl_to_dtm
        # Degenerate: all vertices on same line
        triangles = [
            ((0, 0, 0), (5, 0, 0), (10, 0, 0)),
            # Add a valid triangle to make it work
            ((0, 0, 0), (10, 0, 0), (5, 10, 5)),
        ]
        path = _create_ascii_stl(triangles)
        try:
            dtm = stl_to_dtm(path, resolution=5.0)
            # Should not crash — degenerate triangles are skipped
            assert dtm is not None
            assert dtm.grid is not None
        finally:
            os.unlink(path)
