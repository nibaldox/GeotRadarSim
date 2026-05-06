"""Tests for radar YAML configuration loading and registry."""

import pytest
from pathlib import Path


class TestRadarRegistry:
    """Tests for loading radar configs from YAML files."""

    def test_load_all_configs_returns_three_models(self):
        """GIVEN the radar YAML configs directory, WHEN loading all, THEN 3 radar models returned."""
        from app.services.radar_registry import load_all_radar_configs
        configs = load_all_radar_configs()
        assert len(configs) == 3

    def test_load_all_configs_contains_expected_ids(self):
        """GIVEN loaded configs, WHEN checking model IDs, THEN all 3 expected IDs present."""
        from app.services.radar_registry import load_all_radar_configs
        configs = load_all_radar_configs()
        ids = {c.model_id for c in configs}
        assert "groundprobe-ssr-fx" in ids
        assert "ibis-arcsar360" in ids
        assert "reutech-msr" in ids

    def test_groundprobe_ssr_fx_has_expected_range(self):
        """GIVEN GroundProbe SSR-FX config, WHEN loaded, THEN max_range_m is 850."""
        from app.services.radar_registry import get_radar_config
        cfg = get_radar_config("groundprobe-ssr-fx")
        assert cfg.max_range_m == 850.0
        assert cfg.scan_pattern == "RAR"

    def test_ibis_arcsar360_has_full_rotation(self):
        """GIVEN IBIS config, WHEN loaded, THEN 360-degree scan and SAR360 pattern."""
        from app.services.radar_registry import get_radar_config
        cfg = get_radar_config("ibis-arcsar360")
        assert cfg.scan_pattern == "SAR360"
        assert cfg.azimuth_range_deg is None
        assert cfg.h_beam_width_deg == 360.0

    def test_reutech_msr_has_expected_params(self):
        """GIVEN Reutech MSR config, WHEN loaded, THEN correct range and pattern."""
        from app.services.radar_registry import get_radar_config
        cfg = get_radar_config("reutech-msr")
        assert cfg.max_range_m == 500.0
        assert cfg.scan_pattern == "RAR"

    def test_get_nonexistent_radar_raises(self):
        """GIVEN a non-existent model ID, WHEN queried, THEN KeyError raised."""
        from app.services.radar_registry import get_radar_config
        with pytest.raises(KeyError):
            get_radar_config("nonexistent-radar")

    def test_each_config_has_required_fields(self):
        """GIVEN all configs, WHEN inspecting, THEN each has all required RadarConfig fields."""
        from app.services.radar_registry import load_all_radar_configs
        configs = load_all_radar_configs()
        for cfg in configs:
            assert cfg.model_id
            assert cfg.display_name
            assert cfg.manufacturer
            assert cfg.max_range_m > 0
            assert cfg.h_beam_width_deg > 0
            assert cfg.v_beam_width_deg > 0
            assert cfg.elevation_min_deg < cfg.elevation_max_deg

    def test_groundprobe_azimuth_sector(self):
        """GIVEN GroundProbe config, WHEN loaded, THEN azimuth sector is a non-None tuple."""
        from app.services.radar_registry import get_radar_config
        cfg = get_radar_config("groundprobe-ssr-fx")
        assert cfg.azimuth_range_deg is not None
        start, end = cfg.azimuth_range_deg
        assert start < end
