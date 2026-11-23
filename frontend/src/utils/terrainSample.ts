// Keep the interpolation arithmetic aligned with workers/losWorker.ts.
type TriangleVisitor = (
  row: number,
  col: number,
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
  secondTriangle: boolean,
) => void;

function snapGridCoordinate(coordinate: number): number {
  const nearestInteger = Math.round(coordinate);
  const roundingTolerance = Number.EPSILON * Math.max(1, Math.abs(nearestInteger));
  return Math.abs(coordinate - nearestInteger) <= roundingTolerance ? nearestInteger : coordinate;
}

/** Visit renderable triangles incident to a point, including exact shared mesh edges. */
function forEachIncidentTriangle(
  grid: number[][],
  rows: number,
  cols: number,
  x: number,
  y: number,
  visit: TriangleVisitor,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > cols - 1 || y < 0 || y > rows - 1) {
    return false;
  }
  const nearestCol = Math.round(x);
  const colOnGridLine = x === nearestCol;
  const firstCol = Math.max(0, colOnGridLine ? nearestCol - 1 : Math.floor(x));
  const lastCol = Math.min(cols - 2, colOnGridLine ? nearestCol : firstCol);
  const nearestRow = Math.round(y);
  const rowOnGridLine = y === nearestRow;
  const firstRow = Math.max(0, rowOnGridLine ? nearestRow - 1 : Math.floor(y));
  const lastRow = Math.min(rows - 2, rowOnGridLine ? nearestRow : firstRow);
  if (firstCol > lastCol || firstRow > lastRow) return false;

  let found = false;
  for (let row = firstRow; row <= lastRow; row++) {
    const localY = y - row;
    for (let col = firstCol; col <= lastCol; col++) {
      const localX = x - col;
      if (localX < 0 || localX > 1 || localY < 0 || localY > 1) continue;

      const topLeft = grid[row]![col]!;
      const topRight = grid[row]![col + 1]!;
      const bottomLeft = grid[row + 1]![col]!;
      const bottomRight = grid[row + 1]![col + 1]!;
      // TerrainViewer omits the whole quad unless all four vertices are renderable.
      if (!Number.isFinite(topLeft) || !Number.isFinite(topRight) ||
          !Number.isFinite(bottomLeft) || !Number.isFinite(bottomRight)) continue;

      const diagonalCoordinate = snapGridCoordinate(localX + localY);
      // Snap only machine-rounding-sized offsets; points farther off the diagonal stay on one side.
      if (diagonalCoordinate <= 1) {
        found = true;
        visit(row, col, topLeft, topRight, bottomLeft, bottomRight, false);
      }
      if (diagonalCoordinate >= 1) {
        found = true;
        visit(row, col, topLeft, topRight, bottomLeft, bottomRight, true);
      }
    }
  }
  return found;
}

function heightOnTriangle(
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
  localX: number,
  localY: number,
  secondTriangle: boolean,
): number {
  if (secondTriangle) {
    const weight0 = 1 - localY;
    const weight1 = localX + localY - 1;
    const weight2 = 1 - localX;
    if (localX >= 0 && localX <= 1 && localY >= 0 && localY <= 1 &&
        weight0 >= 0 && weight1 >= 0 && weight2 >= 0) {
      return topRight * weight0 + bottomRight * weight1 + bottomLeft * weight2;
    }
  } else {
    const weight0 = 1 - localX - localY;
    if (localX >= 0 && localX <= 1 && localY >= 0 && localY <= 1 && weight0 >= 0) {
      return topLeft * weight0 + topRight * localX + bottomLeft * localY;
    }
  }

  // Roundoff can put an intersection endpoint a few ulps beyond its selected triangle.
  // Project its barycentric weights into the simplex so interpolation never extrapolates.
  const x = Math.max(0, Math.min(1, localX));
  const y = Math.max(0, Math.min(1, localY));
  let weight0: number;
  let weight1: number;
  let weight2: number;
  if (secondTriangle) {
    weight0 = Math.max(0, 1 - y);
    weight1 = Math.max(0, x + y - 1);
    weight2 = Math.max(0, 1 - x);
  } else {
    weight0 = Math.max(0, 1 - x - y);
    weight1 = x;
    weight2 = y;
  }
  const totalWeight = weight0 + weight1 + weight2;
  if (totalWeight === 0) return Number.NaN;
  return secondTriangle
    ? (topRight * weight0 + bottomRight * weight1 + bottomLeft * weight2) / totalWeight
    : (topLeft * weight0 + topRight * weight1 + bottomLeft * weight2) / totalWeight;
}

export function sampleTerrainAtCoordinates(
  grid: number[][],
  bounds: { min_x: number; min_y: number },
  resolution: number,
  x: number,
  y: number,
): number | null {
  if (!Array.isArray(grid) || grid.length < 2 || !Array.isArray(grid[0]) || grid[0].length < 2 ||
      grid.some((row) => !Array.isArray(row) || row.length !== grid[0]!.length) ||
      !Number.isFinite(resolution) || resolution <= 0 ||
      !Number.isFinite(bounds.min_x) || !Number.isFinite(bounds.min_y) ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const rows = grid.length;
  const cols = grid[0]!.length;
  const gridX = snapGridCoordinate((x - bounds.min_x) / resolution);
  const gridY = snapGridCoordinate((y - bounds.min_y) / resolution);
  if (gridX < 0 || gridY < 0 || gridX > cols - 1 || gridY > rows - 1) return null;

  let height: number | null = null;
  forEachIncidentTriangle(grid, rows, cols, gridX, gridY,
    (row, col, topLeft, topRight, bottomLeft, bottomRight, secondTriangle) => {
      if (height !== null) return;
      const sample = heightOnTriangle(
        topLeft, topRight, bottomLeft, bottomRight, gridX - col, gridY - row, secondTriangle,
      );
      if (Number.isFinite(sample)) height = sample;
    });
  return height;
}
