/**
 * Orientation contract of the viewer (S4): terrain X = East, Y = North, Z = elevation.
 * The scene must be a rotation of the terrain (never a reflection), the plan view must
 * show North up and East right, and a click must map back to the clicked terrain point.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildTerrainCameraPose, buildTerrainMeshGeometry, type TerrainCameraView } from "./TerrainViewer";
import { localToTerrain, terrainToLocal } from "../utils/localFrame";

// Rectangular, asymmetric grid: 41 columns (E) × 31 rows (N), 10 m, with a hill only in the NE quadrant.
const resolution = 10;
const rows = 31;
const cols = 41;
const bounds = { min_x: 1000, min_y: 5000, min_z: 100 };
const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) =>
  100 + 80 * Math.exp(-(((c * 10 - 300) ** 2 + (r * 10 - 225) ** 2) / (2 * 35 ** 2)))));
const minElev = Math.min(...grid.flat());

function cameraFor(view: TerrainCameraView | null, aspect = 1.3): THREE.PerspectiveCamera {
  const pose = buildTerrainCameraPose(grid, resolution, view)!;
  const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100000);
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Terrain (E, N, Z) → scene point, exactly as the mesh places DEM nodes (relative to the minimum elevation). */
function sceneOf(e: number, n: number, z = minElev): THREE.Vector3 {
  const local = terrainToLocal({ x: e, y: n, z }, { ...bounds, min_z: minElev });
  return new THREE.Vector3(local.x, local.y, local.z);
}

const ndc = (camera: THREE.PerspectiveCamera, p: THREE.Vector3) => p.clone().project(camera);

describe("viewer orientation", () => {
  it("maps terrain to the scene with a rotation (determinant +1), never a reflection", () => {
    const o = sceneOf(1000, 5000, 100);
    const e = sceneOf(1001, 5000, 100).sub(o);
    const n = sceneOf(1000, 5001, 100).sub(o);
    const u = sceneOf(1000, 5000, 101).sub(o);
    const det = new THREE.Matrix3().set(e.x, n.x, u.x, e.y, n.y, u.y, e.z, n.z, u.z).determinant();
    expect(det).toBe(1);
  });

  it("places mesh vertices where terrainToLocal puts the DEM node (picking uses localToTerrain)", () => {
    const geometry = buildTerrainMeshGeometry(grid, resolution, minElev);
    const position = geometry.getAttribute("position");
    for (const [r, c] of [[0, 0], [30, 40], [22, 30], [5, 37]] as const) {
      const v = r * cols + c;
      const node = { x: bounds.min_x + c * resolution, y: bounds.min_y + r * resolution, z: grid[r]![c]! };
      const local = terrainToLocal(node, { ...bounds, min_z: minElev });
      expect(position.getX(v)).toBeCloseTo(local.x, 4);
      expect(position.getY(v)).toBeCloseTo(local.y, 4);
      expect(position.getZ(v)).toBeCloseTo(local.z, 4);
    }
  });

  it("shows North up and East right in the plan view", () => {
    const camera = cameraFor("TOP");
    const center = ndc(camera, sceneOf(1200, 5150));
    const east = ndc(camera, sceneOf(1300, 5150));
    const north = ndc(camera, sceneOf(1200, 5250));
    const ne = ndc(camera, sceneOf(1300, 5225));
    expect(east.x).toBeGreaterThan(center.x + 0.1);
    expect(Math.abs(east.y - center.y)).toBeLessThan(1e-3);
    expect(north.y).toBeGreaterThan(center.y + 0.1);
    expect(Math.abs(north.x - center.x)).toBeLessThan(1e-3);
    expect(ne.x).toBeGreaterThan(0);
    expect(ne.y).toBeGreaterThan(0);
  });

  it("picks the clicked terrain point in the plan view: the upper-right of the screen is NE", () => {
    const camera = cameraFor("TOP");
    const mesh = new THREE.Mesh(buildTerrainMeshGeometry(grid, resolution, minElev), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    const pick = (x: number, y: number) => {
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const hit = raycaster.intersectObject(mesh)[0]!;
      return localToTerrain(hit.point, { ...bounds, min_z: minElev });
    };
    const centre = pick(0, 0);
    const upperRight = pick(0.3, 0.3);
    expect(upperRight.x).toBeGreaterThan(centre.x);
    expect(upperRight.y).toBeGreaterThan(centre.y);
    // Round trip: project a terrain node, click there, get the same node back.
    const node = { e: 1300, n: 5220 };
    const r = (node.n - bounds.min_y) / resolution, c = (node.e - bounds.min_x) / resolution;
    const target = ndc(camera, sceneOf(node.e, node.n, grid[r]![c]!));
    const back = pick(target.x, target.y);
    expect(back.x).toBeCloseTo(node.e, 3);
    expect(back.y).toBeCloseTo(node.n, 3);
  });

  it("keeps East on the right when the front view looks north", () => {
    const camera = cameraFor("FRONT");
    const forward = camera.getWorldDirection(new THREE.Vector3());
    expect(forward.z).toBeLessThan(-0.99); // north is −Z in the scene
    const west = ndc(camera, sceneOf(1100, 5150, 150));
    const east = ndc(camera, sceneOf(1300, 5150, 150));
    expect(east.x).toBeGreaterThan(west.x);
  });

  it.each(["TOP", "HOME", null] as const)("does not mirror the ground seen from above (%s view)", (view) => {
    const camera = cameraFor(view);
    const o = ndc(camera, sceneOf(1200, 5150));
    const e = ndc(camera, sceneOf(1210, 5150)).sub(o);
    const n = ndc(camera, sceneOf(1200, 5160)).sub(o);
    // Screen-space cross product (E × N) > 0 ⇔ turning from East to North is counter-clockwise, as on a map.
    expect(e.x * n.y - e.y * n.x).toBeGreaterThan(0);
  });
});
