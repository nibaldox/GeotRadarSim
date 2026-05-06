"""Integration tests for export API endpoints — PDF and CSV export."""

import pytest
from httpx import ASGITransport, AsyncClient


class TestExportAPI:
    """Integration tests for POST /api/export/pdf and /api/export/data."""

    @pytest.fixture
    def app(self):
        from app.main import app
        return app

    @pytest.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    async def _create_terrain(self, client: AsyncClient) -> str:
        """Helper: create synthetic terrain and return its ID."""
        resp = await client.post("/api/terrain/synthetic", json={
            "size_x": 200.0, "size_y": 200.0, "depth": 50.0, "resolution": 10.0,
        })
        assert resp.status_code == 200
        return resp.json()["terrain_id"]

    async def test_export_pdf_returns_pdf_content(self, client):
        """GIVEN terrain + radar params, WHEN POST /api/export/pdf, THEN PDF bytes returned."""
        terrain_id = await self._create_terrain(client)

        resp = await client.post("/api/export/pdf", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        content = resp.content
        assert content[:5] == b"%PDF-"
        assert len(content) > 200

    async def test_export_csv_returns_csv_content(self, client):
        """GIVEN terrain + radar params, WHEN POST /api/export/data, THEN CSV text returned."""
        terrain_id = await self._create_terrain(client)

        resp = await client.post("/api/export/data", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        assert resp.status_code == 200
        assert "text/csv" in resp.headers["content-type"]
        text = resp.text
        assert "x,y,z,visible" in text
        lines = text.strip().split("\n")
        # Header + grid data rows
        assert len(lines) > 1

    async def test_export_pdf_nonexistent_terrain_returns_404(self, client):
        """GIVEN nonexistent terrain, WHEN POST /api/export/pdf, THEN 404."""
        resp = await client.post("/api/export/pdf", json={
            "terrain_id": "nonexistent",
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        assert resp.status_code == 404

    async def test_export_csv_nonexistent_terrain_returns_404(self, client):
        """GIVEN nonexistent terrain, WHEN POST /api/export/data, THEN 404."""
        resp = await client.post("/api/export/data", json={
            "terrain_id": "nonexistent",
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "groundprobe-ssr-fx",
        })
        assert resp.status_code == 404

    async def test_export_pdf_nonexistent_radar_returns_404(self, client):
        """GIVEN nonexistent radar model, WHEN POST /api/export/pdf, THEN 404."""
        terrain_id = await self._create_terrain(client)

        resp = await client.post("/api/export/pdf", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "nonexistent-radar",
        })
        assert resp.status_code == 404

    async def test_export_csv_nonexistent_radar_returns_404(self, client):
        """GIVEN nonexistent radar model, WHEN POST /api/export/data, THEN 404."""
        terrain_id = await self._create_terrain(client)

        resp = await client.post("/api/export/data", json={
            "terrain_id": terrain_id,
            "radar_position": {"x": 10.0, "y": 100.0, "z": 5.0},
            "radar_model_id": "nonexistent-radar",
        })
        assert resp.status_code == 404
