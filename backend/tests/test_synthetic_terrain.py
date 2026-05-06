"""Tests for synthetic terrain generator — bowl-shaped open pit."""

import pytest
import numpy as np


class TestSyntheticTerrain:
    """Tests for procedural bowl-shaped terrain generation."""

    def test_generates_bowl_shape(self):
        """GIVEN dimensions, WHEN generating, THEN center is deeper than edges."""
        from app.services.synthetic_terrain import generate_synthetic_terrain
        result = generate_synthetic_terrain(
            size_x=200.0, size_y=200.0, depth=50.0, resolution=10.0
        )
        grid = result.grid
        rows, cols = grid.shape
        # Center should be the deepest (lowest z)
        center_z = grid[rows // 2, cols // 2]
        edge_z = grid[0, 0]
        assert center_z < edge_z

    def test_produces_correct_grid_dimensions(self):
        """GIVEN size and resolution, WHEN generating, THEN grid dims match."""
        from app.services.synthetic_terrain import generate_synthetic_terrain
        result = generate_synthetic_terrain(
            size_x=100.0, size_y=200.0, depth=30.0, resolution=10.0
        )
        # 100m / 10m = 10 cols, 200m / 10m = 20 rows
        assert result.metadata.grid_cols == 10
        assert result.metadata.grid_rows == 20

    def test_metadata_has_correct_bounds(self):
        """GIVEN dimensions, WHEN generating, THEN bbox reflects specified size."""
        from app.services.synthetic_terrain import generate_synthetic_terrain
        result = generate_synthetic_terrain(
            size_x=300.0, size_y=400.0, depth=80.0, resolution=5.0
        )
        bb = result.metadata.bounds
        assert bb.min_x == pytest.approx(0.0)
        assert bb.max_x == pytest.approx(300.0)
        assert bb.min_y == pytest.approx(0.0)
        assert bb.max_y == pytest.approx(400.0)

    def test_depth_parameter_controls_depth(self):
        """GIVEN different depths, WHEN generating, THEN center depth scales."""
        from app.services.synthetic_terrain import generate_synthetic_terrain
        shallow = generate_synthetic_terrain(200, 200, 10, 10)
        deep = generate_synthetic_terrain(200, 200, 100, 10)
        # Deeper pit should have lower center z
        s_center = shallow.grid[shallow.grid.shape[0]//2, shallow.grid.shape[1]//2]
        d_center = deep.grid[deep.grid.shape[0]//2, deep.grid.shape[1]//2]
        assert d_center < s_center

    def test_edges_are_at_zero_elevation(self):
        """GIVEN a bowl, WHEN checking corners, THEN corner elevations are ~0."""
        from app.services.synthetic_terrain import generate_synthetic_terrain
        result = generate_synthetic_terrain(200, 200, 50, 10)
        grid = result.grid
        # All four corners should be close to 0
        assert grid[0, 0] == pytest.approx(0.0, abs=1.0)
        assert grid[0, -1] == pytest.approx(0.0, abs=1.0)
        assert grid[-1, 0] == pytest.approx(0.0, abs=1.0)
        assert grid[-1, -1] == pytest.approx(0.0, abs=1.0)

    def test_symmetric_bowl(self):
        """GIVEN square dimensions, WHEN generating, THEN bowl is symmetric."""
        from app.services.synthetic_terrain import generate_synthetic_terrain
        result = generate_synthetic_terrain(200, 200, 50, 10)
        grid = result.grid
        rows, cols = grid.shape
        # Check rough symmetry: center row should mirror
        mid_row = rows // 2
        mid_col = cols // 2
        assert grid[mid_row, 1] == pytest.approx(grid[mid_row, -2], abs=0.1)
        assert grid[1, mid_col] == pytest.approx(grid[-2, mid_col], abs=0.1)
