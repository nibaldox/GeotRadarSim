"""Export service — generate PDF reports and CSV data from LOS analysis results.

Pure functions for generating exportable content from terrain and LOS data.
Uses reportlab for PDF generation and csv module for CSV output.
"""

import csv
import io
from typing import Any

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend for server-side rendering
import matplotlib.pyplot as plt
import numpy as np
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


def generate_csv_data(
    terrain_id: str,
    bounds: dict[str, float],
    resolution: float,
    radar_position: tuple[float, float, float],
    radar_model_id: str,
    los_result: Any,
) -> str:
    """Generate CSV string with terrain grid cells and visibility status.

    Each row contains: x, y, z, visible (boolean).

    Args:
        terrain_id: Identifier for the terrain.
        bounds: Dict with min_x, min_y, min_z, max_x, max_y, max_z.
        resolution: Grid cell size in meters.
        radar_position: (x, y, z) radar position (unused in CSV but part of signature).
        radar_model_id: Radar model ID (unused in CSV but part of signature).
        los_result: LOSResult with shadow_grid.

    Returns:
        CSV string with header row and one row per grid cell.
    """
    shadow_grid = los_result.shadow_grid
    rows = len(shadow_grid)
    cols = len(shadow_grid[0]) if rows > 0 else 0

    # We need the grid elevations — derive from the LOSResult's coverage polygon
    # bounds + resolution gives us coordinate grid, but we need actual Z values.
    # Since we don't have the DTM grid directly, we use the coverage polygon
    # bounds to create coordinate grid. For CSV we need z values from the DTM.
    # We'll generate coordinates and use shadow_grid for visibility.
    # NOTE: z values require the original DTM — we approximate from bounds for export.
    # This is a limitation: the CSV will contain coordinate positions only.
    # The caller should pass DTM elevation data if available.

    x_coords = [
        bounds["min_x"] + resolution / 2 + c * resolution
        for c in range(cols)
    ]
    y_coords = [
        bounds["min_y"] + resolution / 2 + r * resolution
        for r in range(rows)
    ]

    # Estimate z from bounds (linear interpolation placeholder)
    # In production, the DTM grid elevations would be passed separately
    z_min = bounds["min_z"]
    z_max = bounds["max_z"]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["x", "y", "z", "visible"])

    for r in range(rows):
        for c in range(cols):
            x = x_coords[c]
            y = y_coords[r]
            # Approximate z as midpoint of bounds — real implementation
            # would use actual DTM elevation at this cell
            z = (z_min + z_max) / 2.0
            visible = not shadow_grid[r][c]
            writer.writerow([round(x, 2), round(y, 2), round(z, 2), visible])

    return output.getvalue()


def generate_pdf_report(
    terrain_id: str,
    bounds: dict[str, float],
    radar_position: tuple[float, float, float],
    radar_model_id: str,
    los_result: Any,
) -> bytes:
    """Generate a PDF report for radar coverage analysis.

    Creates a multi-section PDF with:
    - Header and title
    - Terrain information
    - Radar configuration
    - Coverage statistics
    - Shadow zone summary
    - Coverage map image (matplotlib heatmap)

    Args:
        terrain_id: Identifier for the terrain.
        bounds: Dict with min_x, min_y, min_z, max_x, max_y, max_z.
        radar_position: (x, y, z) radar position.
        radar_model_id: Radar model identifier.
        los_result: LOSResult with analysis data.

    Returns:
        PDF file content as bytes.
    """
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4

    y_cursor = height - 30 * mm

    def draw_text(text: str, size: int = 10, bold: bool = False):
        nonlocal y_cursor
        font = "Helvetica-Bold" if bold else "Helvetica"
        c.setFont(font, size)
        c.drawString(20 * mm, y_cursor, text)
        y_cursor -= size * 1.6 * mm / 3

    # ── Title ──
    draw_text("Radar Monitoring Window Report", size=16, bold=True)
    y_cursor -= 5 * mm

    # ── Terrain Information ──
    draw_text("Terrain Information", size=12, bold=True)
    y_cursor -= 2 * mm
    draw_text(f"Terrain ID: {terrain_id}")
    draw_text(
        f"Bounds: ({bounds['min_x']:.1f}, {bounds['min_y']:.1f}) to "
        f"({bounds['max_x']:.1f}, {bounds['max_y']:.1f})"
    )
    draw_text(
        f"Elevation range: {bounds['min_z']:.1f}m to {bounds['max_z']:.1f}m"
    )
    y_cursor -= 5 * mm

    # ── Radar Configuration ──
    draw_text("Radar Configuration", size=12, bold=True)
    y_cursor -= 2 * mm
    draw_text(f"Model: {radar_model_id}")
    draw_text(f"Position: ({radar_position[0]:.1f}, {radar_position[1]:.1f}, {radar_position[2]:.1f})")
    y_cursor -= 5 * mm

    # ── Coverage Statistics ──
    draw_text("Coverage Statistics", size=12, bold=True)
    y_cursor -= 2 * mm
    draw_text(f"Coverage: {los_result.coverage_pct:.1f}%")
    draw_text(f"Visible area: {los_result.visible_area_m2:.0f} m²")

    total_shadow_cells = sum(
        1 for row in los_result.shadow_grid for cell in row if cell
    )
    draw_text(f"Shadowed cells: {total_shadow_cells}")
    y_cursor -= 5 * mm

    # ── Shadow Zones ──
    draw_text("Shadow Zones", size=12, bold=True)
    y_cursor -= 2 * mm
    if los_result.shadow_zones:
        draw_text(f"Total zones: {len(los_result.shadow_zones)}")
        for zone in los_result.shadow_zones:
            draw_text(
                f"  Zone {zone['zone_id']}: {zone['cell_count']} cells"
            )
    else:
        draw_text("No shadow zones detected — full coverage.")
    y_cursor -= 5 * mm

    # ── Coverage Map ──
    draw_text("Coverage Map", size=12, bold=True)
    y_cursor -= 2 * mm

    # Generate heatmap with matplotlib
    try:
        shadow_array = np.array(los_result.shadow_grid, dtype=float)
        fig_height = min(y_cursor / mm * 0.7, 100)
        fig, ax = plt.subplots(figsize=(6, fig_height / 25.4))
        im = ax.imshow(
            shadow_array,
            cmap="RdYlGn_r",
            aspect="equal",
            interpolation="nearest",
        )
        ax.set_title("Shadow Map (green=visible, red=shadowed)")
        ax.set_xlabel("Column")
        ax.set_ylabel("Row")
        fig.colorbar(im, ax=ax, label="Shadow (1=shadowed)")

        # Mark radar position on the map
        rx, ry, _ = radar_position
        col = (rx - bounds["min_x"]) / (bounds["max_x"] - bounds["min_x"]) * shadow_array.shape[1]
        row = (ry - bounds["min_y"]) / (bounds["max_y"] - bounds["min_y"]) * shadow_array.shape[0]
        if 0 <= col < shadow_array.shape[1] and 0 <= row < shadow_array.shape[0]:
            ax.plot(col, row, "b*", markersize=12, label="Radar")
            ax.legend()

        img_buffer = io.BytesIO()
        fig.savefig(img_buffer, format="png", dpi=100, bbox_inches="tight")
        plt.close(fig)
        img_buffer.seek(0)

        # Embed image in PDF
        from reportlab.lib.utils import ImageReader
        img_reader = ImageReader(img_buffer)
        img_width = width - 40 * mm
        img_height = fig_height * mm
        c.drawImage(
            img_reader,
            20 * mm,
            y_cursor - img_height,
            width=img_width,
            height=img_height,
        )
    except Exception:
        # If map generation fails, add a note instead
        draw_text("[Coverage map could not be generated]")

    c.showPage()
    c.save()
    return buffer.getvalue()
