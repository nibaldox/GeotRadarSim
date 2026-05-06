"""Integration tests for STL upload terrain API endpoint."""

import pytest
import struct
import tempfile
import os
from httpx import ASGITransport, AsyncClient


def _create_binary_stl_file(triangles: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]) -> str:
    """Helper: create a binary STL file and return its path."""
    header = b'\x00' * 80
    num_triangles = len(triangles)
    data = struct.pack('<I', num_triangles)
    for v1, v2, v3 in triangles:
        data += struct.pack('<fff', 0.0, 0.0, 1.0)
        data += struct.pack('<fff', v1[0], v1[1], v1[2])
        data += struct.pack('<fff', v2[0], v2[1], v2[2])
        data += struct.pack('<fff', v3[0], v3[1], v3[2])
        data += struct.pack('<H', 0)
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="wb")
    tmp.write(header + data)
    tmp.close()
    return tmp.name


def _create_ascii_stl_file(triangles: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]) -> str:
    """Helper: create an ASCII STL file and return its path."""
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
    tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="w")
    tmp.write("\n".join(lines) + "\n")
    tmp.close()
    return tmp.name


class TestSTLUploadAPI:
    """Integration tests for POST /api/terrain/upload-stl endpoint."""

    @pytest.fixture
    def app(self):
        from app.main import app
        return app

    @pytest.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    async def test_upload_stl_returns_dtm_metadata(self, client):
        """GIVEN valid STL file, WHEN POST /api/terrain/upload-stl, THEN DTM metadata returned."""
        # Flat mesh with 2 triangles forming a 20x20 square at Z=10
        path = _create_binary_stl_file([
            ((0, 0, 10), (20, 0, 10), (20, 20, 10)),
            ((0, 0, 10), (20, 20, 10), (0, 20, 10)),
        ])
        try:
            with open(path, "rb") as f:
                resp = await client.post(
                    "/api/terrain/upload-stl",
                    files={"file": ("terrain.stl", f, "application/octet-stream")},
                )
            assert resp.status_code == 200
            data = resp.json()
            assert "terrain_id" in data
            assert data["terrain_id"].startswith("dtm-")
            assert data["grid_rows"] > 0
            assert data["grid_cols"] > 0
            assert "resolution" in data
            assert "bounds" in data
        finally:
            os.unlink(path)

    async def test_upload_ascii_stl_returns_dtm_metadata(self, client):
        """GIVEN valid ASCII STL file, WHEN POST /api/terrain/upload-stl, THEN DTM metadata returned."""
        path = _create_ascii_stl_file([
            ((0, 0, 5), (10, 0, 15), (10, 10, 25)),
            ((0, 0, 5), (10, 10, 25), (0, 10, 10)),
        ])
        try:
            with open(path, "rb") as f:
                resp = await client.post(
                    "/api/terrain/upload-stl",
                    files={"file": ("terrain.stl", f, "application/octet-stream")},
                )
            assert resp.status_code == 200
            data = resp.json()
            assert "terrain_id" in data
            assert data["bounds"]["min_z"] == 5.0
            assert data["bounds"]["max_z"] == 25.0
        finally:
            os.unlink(path)

    async def test_upload_stl_rejects_invalid_file(self, client):
        """GIVEN invalid (non-STL) content, WHEN POST /api/terrain/upload-stl, THEN 422 returned."""
        tmp = tempfile.NamedTemporaryFile(suffix=".stl", delete=False, mode="w")
        tmp.write("NOT A VALID STL FILE")
        tmp.close()
        try:
            with open(tmp.name, "rb") as f:
                resp = await client.post(
                    "/api/terrain/upload-stl",
                    files={"file": ("bad.stl", f, "application/octet-stream")},
                )
            assert resp.status_code == 422
        finally:
            os.unlink(tmp.name)

    async def test_upload_stl_no_file_returns_error(self, client):
        """GIVEN no file uploaded, WHEN POST /api/terrain/upload-stl, THEN error returned."""
        resp = await client.post("/api/terrain/upload-stl")
        assert resp.status_code == 422
