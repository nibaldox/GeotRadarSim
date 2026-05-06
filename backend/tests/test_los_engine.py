"""Tests for LOS engine — vectorized ray-casting over grid DTM."""

import pytest
import numpy as np

from app.services.synthetic_terrain import generate_synthetic_terrain
from app.services.dtm_generator import DTMResult
from app.models.domain import RadarConfig, BoundingBox, DTMMetadata


def _flat_terrain(size=200, resolution=10) -> DTMResult:
    """Helper: create a perfectly flat terrain at z=0."""
    cols = size // resolution
    rows = size // resolution
    grid = np.zeros((rows, cols))
    meta = DTMMetadata(
        terrain_id="flat",
        bounds=BoundingBox(min_x=0, min_y=0, min_z=0, max_x=size, max_y=size, max_z=0),
        resolution=resolution,
        grid_rows=rows,
        grid_cols=cols,
    )
    return DTMResult(grid=grid, metadata=meta, warnings=[])


def _ridge_terrain(resolution=10) -> DTMResult:
    """Helper: create terrain with a ridge blocking middle section."""
    size = 200
    cols = size // resolution
    rows = size // resolution
    grid = np.zeros((rows, cols))
    # Add a ridge along column range [9..11] at z=50
    grid[:, 9:12] = 50.0
    meta = DTMMetadata(
        terrain_id="ridge",
        bounds=BoundingBox(min_x=0, min_y=0, min_z=0, max_x=size, max_y=size, max_z=50),
        resolution=resolution,
        grid_rows=rows,
        grid_cols=cols,
    )
    return DTMResult(grid=grid, metadata=meta, warnings=[])


def _default_radar() -> RadarConfig:
    """Helper: a simple RAR radar for testing."""
    return RadarConfig(
        model_id="test-radar",
        display_name="Test Radar",
        manufacturer="Test",
        max_range_m=500.0,
        h_beam_width_deg=120.0,
        v_beam_width_deg=30.0,
        elevation_min_deg=-30.0,
        elevation_max_deg=30.0,
        scan_pattern="RAR",
        azimuth_range_deg=(-60.0, 60.0),
    )


class TestLOSEngine:
    """Tests for LOS ray-casting engine."""

    def test_unobstructed_flat_terrain_all_visible(self):
        """GIVEN radar above flat terrain, WHEN LOS cast, THEN all cells within range are visible."""
        from app.services.los_engine import compute_los
        dtm = _flat_terrain()
        radar_pos = (100.0, 100.0, 50.0)  # center, elevated
        radar_cfg = _default_radar()

        result = compute_los(dtm, radar_pos, radar_cfg)
        # On flat terrain, all cells within range/sector should be visible
        # coverage_pct = visible/analyzable cells — should be ~100% on flat terrain
        assert result.shadow_grid is not None
        assert result.coverage_pct > 90.0, f"Expected >90% coverage on flat terrain, got {result.coverage_pct}"

    def test_obstructed_by_ridge(self):
        """GIVEN terrain with ridge, WHEN LOS cast from one side, THEN cells behind ridge are shadowed."""
        from app.services.los_engine import compute_los
        dtm = _ridge_terrain()
        # Place radar at left side (x=30, y=100) at z=5 (below ridge)
        radar_pos = (30.0, 100.0, 5.0)
        radar_cfg = _default_radar()

        result = compute_los(dtm, radar_pos, radar_cfg)
        # Some cells should be shadowed behind the ridge
        shadowed_count = sum(1 for row in result.shadow_grid for v in row if v)
        assert shadowed_count > 0, "Expected some shadowed cells behind the ridge"

    def test_range_limit_excludes_distant_cells(self):
        """GIVEN radar with short range, WHEN LOS cast, THEN cells beyond range excluded."""
        from app.services.los_engine import compute_los
        dtm = _flat_terrain(size=400, resolution=10)
        radar_pos = (200.0, 200.0, 50.0)
        # Very short range
        short_range_radar = RadarConfig(
            model_id="short",
            display_name="Short",
            manufacturer="Test",
            max_range_m=50.0,
            h_beam_width_deg=360.0,
            v_beam_width_deg=60.0,
            elevation_min_deg=-30.0,
            elevation_max_deg=30.0,
            scan_pattern="RAR",
            azimuth_range_deg=None,
        )

        result = compute_los(dtm, radar_pos, short_range_radar)
        # With 50m range on 400x400 terrain, visible area should be a small fraction
        total_area = 400 * 400  # 160,000 m²
        assert result.visible_area_m2 < total_area * 0.1, (
            f"Expected <10% of terrain visible with 50m range, got {result.visible_area_m2}m²"
        )

    def test_angular_sector_limits_coverage(self):
        """GIVEN radar with narrow sector, WHEN LOS cast, THEN only sector cells analyzed."""
        from app.services.los_engine import compute_los
        dtm = _flat_terrain()
        radar_pos = (100.0, 100.0, 50.0)
        narrow_radar = RadarConfig(
            model_id="narrow",
            display_name="Narrow",
            manufacturer="Test",
            max_range_m=500.0,
            h_beam_width_deg=20.0,
            v_beam_width_deg=30.0,
            elevation_min_deg=-30.0,
            elevation_max_deg=30.0,
            scan_pattern="RAR",
            azimuth_range_deg=(-10.0, 10.0),
        )

        result = compute_los(dtm, radar_pos, narrow_radar)
        # Narrow sector covers much less area than full terrain
        total_area = 200 * 200  # 40,000 m²
        assert result.visible_area_m2 < total_area * 0.2, (
            f"Expected <20% of terrain visible with narrow sector, got {result.visible_area_m2}m²"
        )

    def test_sar360_full_rotation(self):
        """GIVEN SAR360 radar, WHEN LOS cast, THEN all directions scanned."""
        from app.services.los_engine import compute_los
        dtm = _flat_terrain()
        radar_pos = (100.0, 100.0, 50.0)
        sar360_radar = RadarConfig(
            model_id="sar360",
            display_name="SAR360",
            manufacturer="Test",
            max_range_m=500.0,
            h_beam_width_deg=360.0,
            v_beam_width_deg=40.0,
            elevation_min_deg=-20.0,
            elevation_max_deg=20.0,
            scan_pattern="SAR360",
            azimuth_range_deg=None,
        )

        result = compute_los(dtm, radar_pos, sar360_radar)
        # Full 360 should cover more than narrow sector
        assert result.coverage_pct > 50.0

    def test_response_includes_coverage_stats(self):
        """GIVEN any LOS computation, WHEN complete, THEN response has coverage stats."""
        from app.services.los_engine import compute_los
        dtm = _flat_terrain()
        radar_pos = (100.0, 100.0, 50.0)
        radar_cfg = _default_radar()

        result = compute_los(dtm, radar_pos, radar_cfg)
        assert 0 <= result.coverage_pct <= 100
        assert result.visible_area_m2 >= 0
        assert result.coverage_polygon is not None

    def test_bowl_terrain_has_shadows(self):
        """GIVEN bowl-shaped terrain, WHEN radar at edge, THEN some areas shadowed."""
        from app.services.los_engine import compute_los
        dtm = generate_synthetic_terrain(200, 200, 50, 10)
        radar_pos = (10.0, 100.0, 5.0)  # at edge
        radar_cfg = _default_radar()

        result = compute_los(dtm, radar_pos, radar_cfg)
        # Bowl should create shadows on opposite side
        shadowed = sum(1 for row in result.shadow_grid for v in row if v)
        assert shadowed > 0
