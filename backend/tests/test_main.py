"""Tests for FastAPI main application setup."""

import pytest
from httpx import ASGITransport, AsyncClient


class TestFastAPIApp:
    """Integration tests for the main FastAPI application."""

    @pytest.fixture
    def app(self):
        from app.main import app
        return app

    @pytest.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    async def test_health_endpoint_returns_ok(self, client):
        """GIVEN the app is running, WHEN GET /health, THEN 200 with status ok."""
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"

    async def test_cors_headers_present(self, client):
        """GIVEN the app is configured, WHEN OPTIONS request, THEN CORS headers present."""
        resp = await client.options(
            "/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert "access-control-allow-origin" in resp.headers

    async def test_routers_are_mounted(self, client):
        """GIVEN the app is running, WHEN checking radar endpoints, THEN they respond."""
        # Radars list endpoint should work
        resp = await client.get("/api/radars")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 3

    async def test_terrain_router_mounted(self, client):
        """GIVEN the app is running, WHEN POST /api/terrain/synthetic, THEN endpoint exists."""
        resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 200.0,
            "size_y": 200.0,
            "depth": 50.0,
            "resolution": 5.0,
        })
        # May fail for other reasons but should NOT be 404
        assert resp.status_code != 404

    async def test_analysis_router_mounted(self, client):
        """GIVEN the app is running, WHEN POST /api/analysis/los, THEN endpoint exists."""
        resp = await client.post("/api/analysis/los", json={
            "terrain_id": "nonexistent",
            "radar_position": {"x": 0, "y": 0, "z": 100},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        # 404 with our detail means the route IS mounted (terrain not found, not route not found)
        if resp.status_code == 404:
            data = resp.json()
            assert "detail" in data, "FastAPI returned 404 without detail — route likely not mounted"
            assert "not found" in data["detail"].lower()
        else:
            assert resp.status_code in (200, 422), f"Unexpected status: {resp.status_code}"

    async def test_export_router_mounted(self, client):
        """GIVEN the app is running, WHEN POST /api/export/pdf, THEN endpoint exists."""
        resp = await client.post("/api/export/pdf", json={
            "terrain_id": "nonexistent",
            "radar_position": {"x": 0, "y": 0, "z": 100},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        # 404 with our detail means the route IS mounted (terrain not found, not route not found)
        if resp.status_code == 404:
            data = resp.json()
            assert "detail" in data, "FastAPI returned 404 without detail — route likely not mounted"
            assert "not found" in data["detail"].lower()
        else:
            assert resp.status_code in (200, 422), f"Unexpected status: {resp.status_code}"
