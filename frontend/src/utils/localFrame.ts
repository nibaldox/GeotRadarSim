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
