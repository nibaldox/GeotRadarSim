"""Integration tests for terrain API endpoints — upload, synthetic, grid retrieval."""

import pytest
from httpx import ASGITransport, AsyncClient
import numpy as np
import ezdxf
import tempfile
import os


class TestTerrainAPI:
    """Integration tests for /api/terrain endpoints."""

    @pytest.fixture
    def app(self):
        from app.main import app
        return app

    @pytest.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    async def test_synthetic_terrain_creates_dtm(self, client):
        """GIVEN valid parameters, WHEN POST /api/terrain/synthetic, THEN DTM metadata returned."""
        resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 200.0,
            "size_y": 200.0,
            "depth": 50.0,
            "resolution": 5.0,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "terrain_id" in data
        assert data["resolution"] == 5.0
        assert data["grid_rows"] == 40
        assert data["grid_cols"] == 40

    async def test_synthetic_terrain_with_defaults(self, client):
        """GIVEN minimal parameters, WHEN POST synthetic, THEN defaults applied."""
        resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 100.0,
            "size_y": 100.0,
            "depth": 30.0,
        })
        assert resp.status_code == 200

    async def test_upload_valid_dxf_creates_dtm(self, client):
        """GIVEN valid DXF file, WHEN POST /api/terrain/upload, THEN DTM metadata returned."""
        # Create a valid DXF with 3D polylines
        doc = ezdxf.new("R2010")
        msp = doc.modelspace()
        # Create a grid of points
        for x in range(0, 100, 10):
            for y in range(0, 100, 10):
                msp.add_point((x, y, x * 0.1 + y * 0.1 + 10))
        tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False, mode="w")
        doc.write(tmp)
        tmp.close()
        try:
            with open(tmp.name, "rb") as f:
                resp = await client.post(
                    "/api/terrain/upload",
                    files={"file": ("test.dxf", f, "application/octet-stream")},
                )
            assert resp.status_code == 200
            data = resp.json()
            assert "terrain_id" in data
            assert data["grid_rows"] > 0
        finally:
            os.unlink(tmp.name)

    async def test_upload_no_file_returns_error(self, client):
        """GIVEN no file uploaded, WHEN POST /api/terrain/upload, THEN error returned."""
        resp = await client.post("/api/terrain/upload")
        assert resp.status_code == 422

    async def test_get_grid_returns_data(self, client):
        """GIVEN existing terrain, WHEN GET /api/terrain/{id}/grid, THEN grid data returned."""
        # First create terrain
        create_resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 100.0, "size_y": 100.0, "depth": 30.0, "resolution": 10.0,
        })
        terrain_id = create_resp.json()["terrain_id"]

        resp = await client.get(f"/api/terrain/{terrain_id}/grid")
        assert resp.status_code == 200
        data = resp.json()
        assert "grid" in data
        assert len(data["grid"]) > 0

    async def test_get_nonexistent_grid_returns_404(self, client):
        """GIVEN nonexistent terrain ID, WHEN GET grid, THEN 404."""
        resp = await client.get("/api/terrain/nonexistent/grid")
        assert resp.status_code == 404
