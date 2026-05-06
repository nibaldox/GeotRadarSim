"""Tests for domain Pydantic models: Point3D, BoundingBox, DTMMetadata, RadarConfig, LOSRequest, LOSResponse."""

import pytest
from pydantic import ValidationError


# --- Point3D tests ---

class TestPoint3D:
    def test_create_with_valid_coordinates(self):
        from app.models.domain import Point3D
        p = Point3D(x=1.5, y=2.5, z=3.5)
        assert p.x == 1.5
        assert p.y == 2.5
        assert p.z == 3.5

    def test_rejects_missing_z(self):
        from app.models.domain import Point3D
        with pytest.raises(ValidationError):
            Point3D(x=1.0, y=2.0)

    def test_negative_coordinates_allowed(self):
        from app.models.domain import Point3D
        p = Point3D(x=-10.0, y=-20.0, z=-5.0)
        assert p.z == -5.0

    def test_zero_coordinates(self):
        from app.models.domain import Point3D
        p = Point3D(x=0.0, y=0.0, z=0.0)
        assert p.x == 0.0


# --- BoundingBox tests ---

class TestBoundingBox:
    def test_create_with_min_max(self):
        from app.models.domain import BoundingBox
        bb = BoundingBox(
            min_x=0.0, min_y=0.0, min_z=0.0,
            max_x=100.0, max_y=200.0, max_z=50.0
        )
        assert bb.min_x == 0.0
        assert bb.max_x == 100.0

    def test_rejects_missing_field(self):
        from app.models.domain import BoundingBox
        with pytest.raises(ValidationError):
            BoundingBox(min_x=0.0, min_y=0.0, min_z=0.0, max_x=100.0)


# --- DTMMetadata tests ---

class TestDTMMetadata:
    def test_create_with_valid_fields(self):
        from app.models.domain import DTMMetadata, BoundingBox
        bb = BoundingBox(min_x=0, min_y=0, min_z=0, max_x=100, max_y=100, max_z=50)
        meta = DTMMetadata(
            terrain_id="test-terrain-1",
            bounds=bb,
            resolution=2.0,
            grid_rows=50,
            grid_cols=50,
        )
        assert meta.terrain_id == "test-terrain-1"
        assert meta.resolution == 2.0
        assert meta.grid_rows == 50

    def test_rejects_negative_resolution(self):
        from app.models.domain import DTMMetadata, BoundingBox
        bb = BoundingBox(min_x=0, min_y=0, min_z=0, max_x=100, max_y=100, max_z=50)
        with pytest.raises(ValidationError):
            DTMMetadata(
                terrain_id="bad",
                bounds=bb,
                resolution=-1.0,
                grid_rows=50,
                grid_cols=50,
            )

    def test_rejects_zero_grid_dimensions(self):
        from app.models.domain import DTMMetadata, BoundingBox
        bb = BoundingBox(min_x=0, min_y=0, min_z=0, max_x=100, max_y=100, max_z=50)
        with pytest.raises(ValidationError):
            DTMMetadata(
                terrain_id="bad",
                bounds=bb,
                resolution=2.0,
                grid_rows=0,
                grid_cols=50,
            )


# --- RadarConfig tests ---

class TestRadarConfig:
    def test_create_rar_pattern(self):
        from app.models.domain import RadarConfig
        cfg = RadarConfig(
            model_id="groundprobe-ssr-fx",
            display_name="GroundProbe SSR-FX",
            manufacturer="GroundProbe",
            max_range_m=850.0,
            h_beam_width_deg=90.0,
            v_beam_width_deg=30.0,
            elevation_min_deg=-30.0,
            elevation_max_deg=30.0,
            scan_pattern="RAR",
            azimuth_range_deg=(-45.0, 45.0),
        )
        assert cfg.model_id == "groundprobe-ssr-fx"
        assert cfg.max_range_m == 850.0
        assert cfg.scan_pattern == "RAR"
        assert cfg.azimuth_range_deg == (-45.0, 45.0)

    def test_create_sar360_pattern(self):
        from app.models.domain import RadarConfig
        cfg = RadarConfig(
            model_id="ibis-arcsar360",
            display_name="IBIS-ArcSAR360",
            manufacturer="IDS GeoRadar",
            max_range_m=400.0,
            h_beam_width_deg=360.0,
            v_beam_width_deg=40.0,
            elevation_min_deg=-20.0,
            elevation_max_deg=20.0,
            scan_pattern="SAR360",
            azimuth_range_deg=None,
        )
        assert cfg.scan_pattern == "SAR360"
        assert cfg.azimuth_range_deg is None

    def test_rejects_invalid_scan_pattern(self):
        from app.models.domain import RadarConfig
        with pytest.raises(ValidationError):
            RadarConfig(
                model_id="bad-radar",
                display_name="Bad",
                manufacturer="Bad",
                max_range_m=100.0,
                h_beam_width_deg=90.0,
                v_beam_width_deg=30.0,
                elevation_min_deg=-30.0,
                elevation_max_deg=30.0,
                scan_pattern="INVALID",
                azimuth_range_deg=(-45.0, 45.0),
            )


# --- LOSRequest tests ---

class TestLOSRequest:
    def test_create_with_valid_data(self):
        from app.models.domain import LOSRequest, Point3D
        req = LOSRequest(
            terrain_id="terrain-1",
            radar_position=Point3D(x=50.0, y=50.0, z=100.0),
            radar_model_id="groundprobe-ssr-fx",
        )
        assert req.terrain_id == "terrain-1"
        assert req.radar_position.z == 100.0
        assert req.radar_model_id == "groundprobe-ssr-fx"

    def test_rejects_empty_terrain_id(self):
        from app.models.domain import LOSRequest, Point3D
        with pytest.raises(ValidationError):
            LOSRequest(
                terrain_id="",
                radar_position=Point3D(x=50.0, y=50.0, z=100.0),
                radar_model_id="groundprobe-ssr-fx",
            )


# --- LOSResponse tests ---

class TestLOSResponse:
    def test_create_with_shadow_grid(self):
        from app.models.domain import LOSResponse
        resp = LOSResponse(
            shadow_grid=[[True, False], [False, True]],
            coverage_polygon=[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)],
            coverage_pct=55.5,
            visible_area_m2=12500.0,
            shadow_zones=[{"zone_id": 1, "cell_count": 50}],
        )
        assert resp.shadow_grid == [[True, False], [False, True]]
        assert resp.coverage_pct == 55.5
        assert len(resp.shadow_zones) == 1

    def test_coverage_pct_bounded(self):
        from app.models.domain import LOSResponse
        # Valid — within bounds
        resp = LOSResponse(
            shadow_grid=[],
            coverage_polygon=[],
            coverage_pct=100.0,
            visible_area_m2=0.0,
            shadow_zones=[],
        )
        assert resp.coverage_pct == 100.0
