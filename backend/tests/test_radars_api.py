"""Tests for radar model API endpoints and YAML extensibility."""

import pytest
from httpx import ASGITransport, AsyncClient
import yaml
import tempfile
import os
from pathlib import Path


class TestRadarsAPI:
    """Integration tests for /api/radars endpoints."""

    @pytest.fixture
    def app(self):
        from app.main import app
        return app

    @pytest.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    async def test_list_radars_returns_all(self, client):
        """GIVEN app initialized, WHEN GET /api/radars, THEN 3 models returned."""
        resp = await client.get("/api/radars")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3
        ids = {r["model_id"] for r in data}
        assert "groundprobe-ssr-fx" in ids
        assert "ibis-arcsar360" in ids
        assert "reutech-msr" in ids

    async def test_get_specific_radar(self, client):
        """GIVEN model ID, WHEN GET /api/radars/{id}, THEN correct config returned."""
        resp = await client.get("/api/radars/groundprobe-ssr-fx")
        assert resp.status_code == 200
        data = resp.json()
        assert data["model_id"] == "groundprobe-ssr-fx"
        assert data["max_range_m"] == 850.0

    async def test_get_nonexistent_radar_404(self, client):
        """GIVEN non-existent model ID, WHEN GET /api/radars/{id}, THEN 404."""
        resp = await client.get("/api/radars/nonexistent")
        assert resp.status_code == 404

    async def test_radar_config_has_all_fields(self, client):
        """GIVEN any radar, WHEN GET details, THEN all required fields present."""
        resp = await client.get("/api/radars/ibis-arcsar360")
        data = resp.json()
        required_fields = [
            "model_id", "display_name", "manufacturer", "max_range_m",
            "h_beam_width_deg", "v_beam_width_deg", "elevation_min_deg",
            "elevation_max_deg", "scan_pattern", "azimuth_range_deg"
        ]
        for field in required_fields:
            assert field in data, f"Missing field: {field}"

    def test_dynamic_yaml_discovery(self):
        """GIVEN a new YAML config file, WHEN registry reloads, THEN new model appears."""
        from app.services.radar_registry import load_all_radar_configs, clear_registry

        # Create a temporary YAML file
        radars_dir = Path(__file__).parent.parent / "app" / "config" / "radars"
        test_yaml = radars_dir / "test-experimental.yaml"

        try:
            test_config = {
                "model_id": "test-experimental",
                "display_name": "Test Experimental",
                "manufacturer": "Test Labs",
                "max_range_m": 1000.0,
                "h_beam_width_deg": 180.0,
                "v_beam_width_deg": 45.0,
                "elevation_min_deg": -45.0,
                "elevation_max_deg": 45.0,
                "scan_pattern": "RAR",
                "azimuth_range_deg": [-90.0, 90.0],
            }
            with open(test_yaml, "w") as f:
                yaml.dump(test_config, f)

            # Clear and reload
            clear_registry()
            configs = load_all_radar_configs()
            ids = {c.model_id for c in configs}
            assert "test-experimental" in ids
            assert len(configs) == 4
        finally:
            if test_yaml.exists():
                test_yaml.unlink()
            clear_registry()
