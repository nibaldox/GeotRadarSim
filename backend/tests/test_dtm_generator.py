"""Tests for DTM generator — point cloud to regular grid interpolation."""

import pytest
import numpy as np


class TestDTMGenerator:
    """Tests for generating a Digital Terrain Model from a point cloud."""

    def test_dense_cloud_produces_grid(self):
        """GIVEN >1000 points, WHEN DTM generated, THEN valid grid produced."""
        from app.services.dtm_generator import generate_dtm
        # Generate 1200 points on a sloped surface
        np.random.seed(42)
        x = np.random.uniform(0, 100, 1200)
        y = np.random.uniform(0, 100, 1200)
        z = x * 0.5 + y * 0.3 + 10  # simple plane
        points = list(zip(x.tolist(), y.tolist(), z.tolist()))

        result = generate_dtm(points, resolution=2.0)
        assert result.grid is not None
        assert result.grid.shape[0] > 0
        assert result.grid.shape[1] > 0
        assert result.metadata.resolution == 2.0

    def test_sparse_cloud_warns(self):
        """GIVEN <100 points, WHEN DTM generated, THEN warning issued but grid still produced."""
        from app.services.dtm_generator import generate_dtm
        # 50 points — sparse
        np.random.seed(42)
        x = np.random.uniform(0, 100, 50)
        y = np.random.uniform(0, 100, 50)
        z = x * 0.5 + y * 0.3 + 10
        points = list(zip(x.tolist(), y.tolist(), z.tolist()))

        result = generate_dtm(points, resolution=5.0)
        assert result.warnings is not None
        assert len(result.warnings) > 0
        assert result.grid is not None

    def test_grid_values_match_input_range(self):
        """GIVEN points with known z range, WHEN DTM generated, THEN grid values within range (with tolerance)."""
        from app.services.dtm_generator import generate_dtm
        np.random.seed(42)
        x = np.random.uniform(0, 50, 200)
        y = np.random.uniform(0, 50, 200)
        z = 100 + x * 0.1 + y * 0.1
        points = list(zip(x.tolist(), y.tolist(), z.tolist()))

        result = generate_dtm(points, resolution=2.0)
        grid = result.grid
        assert np.nanmin(grid) >= 99  # slight tolerance for interpolation
        assert np.nanmax(grid) <= 112

    def test_metadata_contains_correct_bounds(self):
        """GIVEN points in known range, WHEN DTM generated, THEN bbox matches."""
        from app.services.dtm_generator import generate_dtm
        points = [(0, 0, 10), (100, 200, 50)]
        result = generate_dtm(points, resolution=10.0)
        meta = result.metadata
        assert meta.bounds.min_x == pytest.approx(0.0)
        assert meta.bounds.max_x == pytest.approx(100.0)
        assert meta.bounds.min_y == pytest.approx(0.0)
        assert meta.bounds.max_y == pytest.approx(200.0)

    def test_resolution_affects_grid_size(self):
        """GIVEN same points but different resolutions, WHEN grids compared, THEN finer resolution → more cells."""
        from app.services.dtm_generator import generate_dtm
        np.random.seed(42)
        x = np.random.uniform(0, 100, 300)
        y = np.random.uniform(0, 100, 300)
        z = x * 0.5 + y * 0.3
        points = list(zip(x.tolist(), y.tolist(), z.tolist()))

        coarse = generate_dtm(points, resolution=10.0)
        fine = generate_dtm(points, resolution=2.0)
        # Finer resolution should have more cells
        assert fine.metadata.grid_rows * fine.metadata.grid_cols > coarse.metadata.grid_rows * coarse.metadata.grid_cols

    def test_single_point_cloud(self):
        """GIVEN a single point, WHEN DTM generated, THEN grid produced with minimal size."""
        from app.services.dtm_generator import generate_dtm
        points = [(50.0, 50.0, 100.0)]
        result = generate_dtm(points, resolution=10.0)
        assert result.grid is not None
        assert result.warnings is not None
        assert len(result.warnings) > 0  # sparse warning
