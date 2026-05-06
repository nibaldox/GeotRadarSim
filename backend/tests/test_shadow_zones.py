"""Tests for shadow zone grouping — contiguous region labeling."""

import pytest
import numpy as np


class TestShadowZones:
    """Tests for grouping contiguous shadowed cells into named zones."""

    def test_single_contiguous_zone(self):
        """GIVEN shadow grid with one contiguous region, WHEN grouped, THEN one zone returned."""
        from app.services.los_engine import group_shadow_zones
        # 5x5 grid with one contiguous shadow block (rows 0-2, cols 0-2)
        shadow = [
            [True,  True,  True,  False, False],
            [True,  True,  True,  False, False],
            [True,  True,  True,  False, False],
            [False, False, False, False, False],
            [False, False, False, False, False],
        ]
        zones = group_shadow_zones(shadow)
        assert len(zones) == 1
        assert zones[0]["zone_id"] == 1
        assert zones[0]["cell_count"] == 9

    def test_multiple_disjoint_zones(self):
        """GIVEN shadow grid with multiple separated regions, WHEN grouped, THEN each zone independent."""
        from app.services.los_engine import group_shadow_zones
        shadow = [
            [True,  True,  False, False, False],
            [True,  True,  False, False, False],
            [False, False, False, False, False],
            [False, False, False, True,  True],
            [False, False, False, True,  True],
        ]
        zones = group_shadow_zones(shadow)
        assert len(zones) == 2
        # Each zone has 4 cells
        counts = {z["zone_id"]: z["cell_count"] for z in zones}
        assert counts[1] == 4
        assert counts[2] == 4

    def test_no_shadows_returns_empty(self):
        """GIVEN all-visible grid, WHEN grouped, THEN no zones."""
        from app.services.los_engine import group_shadow_zones
        shadow = [[False] * 5 for _ in range(5)]
        zones = group_shadow_zones(shadow)
        assert len(zones) == 0

    def test_all_shadowed_single_zone(self):
        """GIVEN all-shadowed grid, WHEN grouped, THEN one large zone."""
        from app.services.los_engine import group_shadow_zones
        shadow = [[True] * 4 for _ in range(3)]
        zones = group_shadow_zones(shadow)
        assert len(zones) == 1
        assert zones[0]["cell_count"] == 12

    def test_diagonal_cells_separate_zones(self):
        """GIVEN diagonally touching shadows, WHEN grouped, THEN separate zones (4-connectivity)."""
        from app.services.los_engine import group_shadow_zones
        shadow = [
            [True,  False],
            [False, True],
        ]
        zones = group_shadow_zones(shadow)
        assert len(zones) == 2
        assert all(z["cell_count"] == 1 for z in zones)

    def test_zones_have_unique_ids(self):
        """GIVEN multiple zones, WHEN grouped, THEN each zone has unique ID."""
        from app.services.los_engine import group_shadow_zones
        shadow = [
            [True, False, True],
            [False, False, False],
            [True, False, True],
        ]
        zones = group_shadow_zones(shadow)
        ids = [z["zone_id"] for z in zones]
        assert len(set(ids)) == len(ids), "Zone IDs must be unique"
