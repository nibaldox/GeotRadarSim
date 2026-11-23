/**
 * Camera presets against the real OrbitControls (three-stdlib, the class drei mounts) and a
 * line-by-line replica of drei's GizmoHelper tween (`@react-three/drei/core/GizmoHelper.js`).
 * R4: inertia left by a drag rotated the plan view ~180° after the preset; a gizmo tween that
 * was running when the preset arrived overwrote the requested pose.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three-stdlib";
import { buildTerrainCameraPose, type TerrainCameraView } from "./TerrainViewer";
import { CameraPresetCoordinator, applyCameraPose } from "./cameraPreset";

const resolution = 10;
const grid = Array.from({ length: 31 }, (_, r) => Array.from({ length: 41 }, (_, c) =>
  100 + 80 * Math.exp(-(((c * 10 - 300) ** 2 + (r * 10 - 225) ** 2) / (2 * 35 ** 2)))));
const pose = (view: TerrainCameraView | null) => buildTerrainCameraPose(grid, resolution, view)!;

function fakeElement() {
  const handlers = new Map<string, (event: unknown) => void>();
  const target = {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    removeEventListener: (type: string) => handlers.delete(type),
    fire: (type: string, event: unknown) => handlers.get(type)?.(event),
  };
  const ownerDocument = { ...target, fire: target.fire };
  const docHandlers = new Map<string, (event: unknown) => void>();
  ownerDocument.addEventListener = (type: string, fn: (event: unknown) => void) => docHandlers.set(type, fn);
  ownerDocument.removeEventListener = (type: string) => docHandlers.delete(type);
  ownerDocument.fire = (type: string, event: unknown) => docHandlers.get(type)?.(event);
  return Object.assign(target, {
    ownerDocument, clientWidth: 800, clientHeight: 600, style: {} as Record<string, string>,
    setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
  });
}

function rig(view: TerrainCameraView | null = null) {
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100000);
  const el = fakeElement();
  const controls = new OrbitControls(camera);
  controls.enableDamping = true; // drei's default
  controls.connect(el as unknown as HTMLElement);
  applyCameraPose(camera, controls, pose(view));
  return { camera, controls, el };
}

function drag(el: ReturnType<typeof fakeElement>, dx: number, dy = 0) {
  const e = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 };
  el.fire("pointerdown", e);
  el.ownerDocument.fire("pointermove", { ...e, clientX: 100 + dx, clientY: 100 + dy });
  el.ownerDocument.fire("pointerup", { ...e, clientX: 100 + dx, clientY: 100 + dy });
}

/** Screen right · terrain East (+X) and screen up · terrain North (−Z). */
function planAxes(camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  return { east: right.x, north: -up.z };
}

const frames = (controls: OrbitControls, n: number) => { for (let i = 0; i < n; i++) controls.update(); };

describe("camera presets cancel OrbitControls inertia (real controls)", () => {
  it("reproduces R4 without the fix: drag, release, TOP, 300 updates leaves the plan turned ~180°", () => {
    const { camera, controls, el } = rig();
    drag(el, 300);
    const top = pose("TOP"); // the old sequence: assign pose, update, lookAt — inertia survives
    camera.position.set(top.position.x, top.position.y, top.position.z);
    controls.target.set(top.target.x, top.target.y, top.target.z);
    controls.update();
    camera.lookAt(top.target.x, top.target.y, top.target.z);
    frames(controls, 300);
    expect(planAxes(camera).east).toBeLessThan(0);
    controls.dispose();
  });

  it("keeps East right and North up after a 300 px drag, an immediate plan view and 300+ updates", () => {
    const { camera, controls, el } = rig();
    drag(el, 300);
    applyCameraPose(camera, controls, pose("TOP"));
    frames(controls, 320);
    const axes = planAxes(camera);
    expect(axes.east).toBeGreaterThan(0.99);
    expect(axes.north).toBeGreaterThan(0.99);
    const top = pose("TOP");
    expect(camera.position.distanceTo(new THREE.Vector3(top.position.x, top.position.y, top.position.z))).toBeLessThan(1e-3);
    expect(controls.target.distanceTo(new THREE.Vector3(top.target.x, top.target.y, top.target.z))).toBeLessThan(1e-9);
    controls.dispose();
  });

  it("also cancels pending pan and zoom", () => {
    const { camera, controls, el } = rig();
    const e = { pointerId: 2, pointerType: "mouse", button: 2, clientX: 100, clientY: 100 };
    el.fire("pointerdown", e);
    el.ownerDocument.fire("pointermove", { ...e, clientX: 400, clientY: 300 });
    el.ownerDocument.fire("pointerup", { ...e, clientX: 400, clientY: 300 });
    el.fire("wheel", { deltaY: -500, preventDefault: () => undefined, ctrlKey: false, clientX: 400, clientY: 300 });
    applyCameraPose(camera, controls, pose("TOP"));
    frames(controls, 320);
    const top = pose("TOP");
    expect(controls.target.distanceTo(new THREE.Vector3(top.target.x, top.target.y, top.target.z))).toBeLessThan(1e-9);
    expect(camera.position.distanceTo(new THREE.Vector3(top.position.x, top.position.y, top.position.z))).toBeLessThan(1e-3);
    controls.dispose();
  });

  it("survives plan → 3D → plan with drags in between and keeps damping enabled", () => {
    const { camera, controls, el } = rig("TOP");
    drag(el, -250, 80);
    applyCameraPose(camera, controls, pose("HOME"));
    frames(controls, 5);
    drag(el, 300, -60);
    applyCameraPose(camera, controls, pose("TOP"));
    frames(controls, 320);
    const axes = planAxes(camera);
    expect(axes.east).toBeGreaterThan(0.99);
    expect(axes.north).toBeGreaterThan(0.99);
    expect(controls.enableDamping).toBe(true);
    // Orbiting still works after a preset (damping restored, deltas not frozen).
    drag(el, 200);
    frames(controls, 60);
    expect(planAxes(camera).east).toBeLessThan(0.99);
    controls.dispose();
  });
});

/** Replica of drei GizmoHelper's tween (v10.7.7, lines 46–85), driven with the coordinator's hooks. */
function gizmoTween(camera: THREE.PerspectiveCamera, coordinator: CameraPresetCoordinator) {
  const turnRate = 2 * Math.PI;
  const dummy = new THREE.Object3D();
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  const origin = new THREE.Vector3(); // drei measures the radius from its module-level zero vector
  const defaultUp = camera.up.clone();
  dummy.up.copy(camera.up);
  let animating = false, radius = 0, focus = new THREE.Vector3();
  return {
    start(direction: THREE.Vector3) {
      animating = true;
      focus = coordinator.gizmoTweenStarted();
      radius = camera.position.distanceTo(origin);
      q1.copy(camera.quaternion);
      dummy.lookAt(direction.clone().multiplyScalar(radius).add(origin));
      q2.copy(dummy.quaternion);
    },
    frame(delta: number) {
      if (!animating) return false;
      if (q1.angleTo(q2) < 0.01) { animating = false; camera.up.copy(defaultUp); return false; }
      q1.rotateTowards(q2, delta * turnRate);
      camera.position.set(0, 0, 1).applyQuaternion(q1).multiplyScalar(radius).add(focus);
      camera.up.set(0, 1, 0).applyQuaternion(q1).normalize();
      camera.quaternion.copy(q1);
      coordinator.gizmoTweenFrame(); // GizmoHelper's onUpdate
      return true;
    },
  };
}

describe("camera presets win over a running GizmoHelper tween", () => {
  it("ends in the requested plan pose when TOP is pressed mid-tween", () => {
    const { camera, controls } = rig();
    const coordinator = new CameraPresetCoordinator(camera, () => controls);
    const tween = gizmoTween(camera, coordinator);
    tween.start(new THREE.Vector3(0, 0, 1)); // gizmo «S» head: look from the south, horizontal
    tween.frame(1 / 60); tween.frame(1 / 60);
    coordinator.applyPreset(pose("TOP"));
    for (let i = 0; i < 400; i++) { tween.frame(1 / 60); controls.update(); }
    const top = pose("TOP");
    expect(camera.position.distanceTo(new THREE.Vector3(top.position.x, top.position.y, top.position.z))).toBeLessThan(1e-3);
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    const axes = planAxes(camera);
    expect(axes.east).toBeGreaterThan(0.99);
    expect(axes.north).toBeGreaterThan(0.99);
    controls.dispose();
  });

  it("lets a gizmo click made after the preset run normally", () => {
    const { camera, controls } = rig();
    const coordinator = new CameraPresetCoordinator(camera, () => controls);
    coordinator.applyPreset(pose("TOP"));
    const tween = gizmoTween(camera, coordinator);
    tween.start(new THREE.Vector3(0, 0, 1));
    let moving = 0;
    for (let i = 0; i < 400; i++) { if (tween.frame(1 / 60)) moving++; controls.update(); }
    expect(moving).toBeGreaterThan(3);
    const top = pose("TOP");
    expect(camera.position.distanceTo(new THREE.Vector3(top.position.x, top.position.y, top.position.z))).toBeGreaterThan(1);
    controls.dispose();
  });
});
