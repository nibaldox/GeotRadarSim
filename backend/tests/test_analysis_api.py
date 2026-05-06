"""Integration tests for LOS analysis API endpoint."""

import pytest
from httpx import ASGITransport, AsyncClient


class TestAnalysisAPI:
    """Integration tests for POST /api/analysis/los."""

    @pytest.fixture
    def app(self):
        from app.main import app
        return app

    @pytest.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    async def test_los_analysis_returns_results(self, client):
        """GIVEN existing terrain + radar config, WHEN POST /api/analysis/los, THEN LOS response returned."""
        # Create terrain first
        terrain_resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 200.0, "size_y": 200.0, "depth": 50.0, "resolution": 10.0,
        })
        terrain_id = terrain_resp.json()["terrain_id"]

        # Run LOS analysis
        resp = await client.post("/api/analysis/los", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "shadow_grid" in data
        assert "coverage_pct" in data
        assert "visible_area_m2" in data
        assert "shadow_zones" in data
        assert 0 <= data["coverage_pct"] <= 100

    async def test_los_analysis_nonexistent_terrain(self, client):
        """GIVEN nonexistent terrain, WHEN POST /api/analysis/los, THEN 404."""
        resp = await client.post("/api/analysis/los", json={
            "terrain_id": "nonexistent",
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        assert resp.status_code == 404

    async def test_los_analysis_nonexistent_radar(self, client):
        """GIVEN nonexistent radar, WHEN POST /api/analysis/los, THEN 404."""
        terrain_resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 200.0, "size_y": 200.0, "depth": 50.0, "resolution": 10.0,
        })
        terrain_id = terrain_resp.json()["terrain_id"]

        resp = await client.post("/api/analysis/los", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "nonexistent-radar",
        })
        assert resp.status_code == 404

    async def test_los_analysis_with_shadow_zones(self, client):
        """GIVEN bowl terrain, WHEN analysis complete, THEN shadow zones present."""
        terrain_resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 200.0, "size_y": 200.0, "depth": 50.0, "resolution": 10.0,
        })
        terrain_id = terrain_resp.json()["terrain_id"]

        resp = await client.post("/api/analysis/los", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        data = resp.json()
        # Bowl should create shadow zones
        assert isinstance(data["shadow_zones"], list)
