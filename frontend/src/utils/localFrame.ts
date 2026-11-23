export interface FramePoint {
  x: number;
  y: number;
  z: number;
}

export interface LocalFrameBounds {
  min_x: number;
  min_y: number;
  min_z: number;
}

/** Convert a viewer point to terrain coordinates; no radar height offset is applied. */
export function localToTerrain(point: FramePoint, bounds: LocalFrameBounds): FramePoint {
  return {
    x: point.x + bounds.min_x,
    y: bounds.min_y - point.z,
    z: point.y + bounds.min_z,
  };
}

/** Convert terrain coordinates to the viewer's local frame. */
export function terrainToLocal(point: FramePoint, bounds: LocalFrameBounds): FramePoint {
  return {
    x: point.x - bounds.min_x,
    y: point.z - bounds.min_z,
    z: bounds.min_y - point.y,
  };
}

const ORIGIN: LocalFrameBounds = { min_x: 0, min_y: 0, min_z: 0 };
/** Scene direction of terrain North (+Y): −Z. The frame is a rotation (determinant +1). */
export const LOCAL_NORTH: Readonly<FramePoint> = terrainToLocal({ x: 0, y: 1, z: 0 }, ORIGIN);

/** Terrain name of the direction a local (scene) unit axis points to. */
function terrainAxisLabel(axis: FramePoint): string {
  const t = localToTerrain(axis, ORIGIN);
  if (t.x === 1) return "E";
  if (t.x === -1) return "O";
  if (t.y === 1) return "N";
  if (t.y === -1) return "S";
  return "Z"; // elevation (cota)
}

/** Gizmo labels for the scene's +X, +Y and +Z axes, derived from this frame: ["E", "Z", "S"]. */
export const VIEWER_AXIS_LABELS: readonly [string, string, string] = [
  terrainAxisLabel({ x: 1, y: 0, z: 0 }),
  terrainAxisLabel({ x: 0, y: 1, z: 0 }),
  terrainAxisLabel({ x: 0, y: 0, z: 1 }),
];
