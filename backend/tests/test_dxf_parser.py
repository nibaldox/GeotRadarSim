"""Tests for DXF parser service — 3D POLYLINE extraction from DXF files."""

import pytest
import ezdxf
import tempfile
import os
from pathlib import Path


def _create_dxf_with_3d_polylines(vertices: list[tuple[float, float, float]]) -> str:
    """Helper: create a DXF file with a 3D POLYLINE entity and return its path."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    msp.add_polyline3d(vertices)
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
    doc.write(tmp)
    tmp.close()
    return tmp.name


def _create_dxf_with_2d_polylines(vertices: list[tuple[float, float]]) -> str:
    """Helper: create a DXF file with only 2D POLYLINE entities."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    msp.add_polyline2d(vertices)
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
    doc.write(tmp)
    tmp.close()
    return tmp.name


def _create_malformed_dxf() -> str:
    """Helper: create a corrupted DXF file."""
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
    tmp.write("THIS IS NOT A VALID DXF FILE {{{corrupted}}}")
    tmp.close()
    return tmp.name


class TestDXFParser:
    """Tests for DXF file parsing with 3D point cloud extraction."""

    def test_valid_dxf_extracts_vertices(self):
        """GIVEN DXF with 3D POLYLINES, WHEN parsed, THEN extracts vertex coordinates."""
        from app.services.dxf_parser import parse_dxf
        path = _create_dxf_with_3d_polylines([(0, 0, 100), (10, 0, 110), (10, 10, 120), (0, 10, 130)])
        try:
            result = parse_dxf(path)
            assert len(result) == 4
            assert result[0] == (0.0, 0.0, 100.0)
            assert result[3] == (0.0, 10.0, 130.0)
        finally:
            os.unlink(path)

    def test_valid_dxf_reports_bbox_and_point_count(self):
        """GIVEN DXF with 3D POLYLINES, WHEN parsed, THEN bbox and count are correct."""
        from app.services.dxf_parser import parse_dxf
        path = _create_dxf_with_3d_polylines([(0, 0, 100), (100, 200, 300)])
        try:
            result = parse_dxf(path)
            assert len(result) == 2
            # Verify the coordinates are present
            xs = {p[0] for p in result}
            ys = {p[1] for p in result}
            zs = {p[2] for p in result}
            assert 0.0 in xs
            assert 200.0 in ys
            assert 300.0 in zs
        finally:
            os.unlink(path)

    def test_no_elevation_raises_error(self):
        """GIVEN 2D-only DXF, WHEN parsed, THEN validation error raised."""
        from app.services.dxf_parser import parse_dxf, DXFParseError
        path = _create_dxf_with_2d_polylines([(0, 0), (10, 10)])
        try:
            with pytest.raises(DXFParseError) as exc_info:
                parse_dxf(path)
            assert "elevation" in str(exc_info.value).lower() or "3d" in str(exc_info.value).lower()
        finally:
            os.unlink(path)

    def test_malformed_dxf_raises_descriptive_error(self):
        """GIVEN corrupted DXF, WHEN parsed, THEN descriptive parse error raised."""
        from app.services.dxf_parser import parse_dxf, DXFParseError
        path = _create_malformed_dxf()
        try:
            with pytest.raises(DXFParseError):
                parse_dxf(path)
        finally:
            os.unlink(path)

    def test_multiple_polylines_merged(self):
        """GIVEN DXF with multiple 3D polylines, WHEN parsed, THEN all vertices extracted."""
        from app.services.dxf_parser import parse_dxf
        doc = ezdxf.new("R2010")
        msp = doc.modelspace()
        msp.add_polyline3d([(0, 0, 10), (5, 5, 20)])
        msp.add_polyline3d([(100, 100, 30), (105, 105, 40)])
        tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
        doc.write(tmp)
        tmp.close()
        try:
            result = parse_dxf(tmp.name)
            assert len(result) == 4
        finally:
            os.unlink(tmp.name)

    def test_3d_points_extracted(self):
        """GIVEN DXF with POINT entities with elevation, WHEN parsed, THEN points extracted."""
        from app.services.dxf_parser import parse_dxf
        doc = ezdxf.new("R2010")
        msp = doc.modelspace()
        msp.add_point((10, 20, 50))
        msp.add_point((30, 40, 60))
        tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
        doc.write(tmp)
        tmp.close()
        try:
            result = parse_dxf(tmp.name)
            assert len(result) >= 2
            zs = {p[2] for p in result}
            assert 50.0 in zs
            assert 60.0 in zs
        finally:
            os.unlink(tmp.name)

    def test_empty_dxf_no_3d_data(self):
        """GIVEN empty DXF with no entities, WHEN parsed, THEN DXFParseError raised."""
        from app.services.dxf_parser import parse_dxf, DXFParseError
        doc = ezdxf.new("R2010")
        tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
        doc.write(tmp)
        tmp.close()
        try:
            with pytest.raises(DXFParseError):
                parse_dxf(tmp.name)
        finally:
            os.unlink(tmp.name)
