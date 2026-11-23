/**
 * Camera presets (Isométrica, Planta, Frontal, Lateral) for the viewer.
 *
 * Two things can overwrite a preset after it is applied (R4):
 * - OrbitControls inertia: with damping (drei's default) a drag leaves `sphericalDelta`,
 *   `panOffset` and a pending zoom `scale` that keep moving the camera on every later
 *   `update()`. three-stdlib's `update()` with damping off consumes them once and zeroes
 *   them (`sphericalDelta.set(0,0,0)`, `panOffset.set(0,0,0)`, `scale = 1`), so we flush
 *   them first and then place the camera.
 * - A running GizmoHelper tween: drei rewrites position, `up` and quaternion every frame
 *   until its own slerp ends. It calls `onTarget` when a tween starts and `onUpdate` on each
 *   tween frame; the coordinator uses them so that the latest request wins.
 */
import * as THREE from "three";

export interface PresetPose {
  target: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
}

/** The part of three-stdlib's OrbitControls a preset needs. */
export interface PresetControls {
  target: THREE.Vector3;
  enableDamping: boolean;
  update(): unknown;
}

function updateWithoutDamping(controls: PresetControls): void {
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  try {
    controls.update();
  } finally {
    controls.enableDamping = damping;
  }
}

/** Place the camera at `pose` with world-up +Y and no pending orbit, pan or zoom. */
export function applyCameraPose(camera: THREE.Camera, controls: PresetControls | null, pose: PresetPose): void {
  camera.up.set(0, 1, 0);
  if (controls) updateWithoutDamping(controls); // flush and zero the inertia left by a drag
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  if (controls) {
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    updateWithoutDamping(controls); // nothing pending now: only re-derives the orbit and lookAt
  }
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
}

/** Orders presets and gizmo tweens: whichever was requested last decides the pose. */
export class CameraPresetCoordinator {
  private sequence = 0;
  private tweenSequence = 0;
  private preset: { sequence: number; pose: PresetPose } | null = null;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly getControls: () => PresetControls | null,
  ) {}

  applyPreset(pose: PresetPose): void {
    this.preset = { sequence: ++this.sequence, pose };
    applyCameraPose(this.camera, this.getControls(), pose);
  }

  /** GizmoHelper `onTarget`: a gizmo click starts a tween; returns its focus point. */
  gizmoTweenStarted(): THREE.Vector3 {
    this.tweenSequence = ++this.sequence;
    return this.getControls()?.target ?? new THREE.Vector3();
  }

  /** GizmoHelper `onUpdate`: runs after the helper wrote its tween frame into the camera. */
  gizmoTweenFrame(): void {
    const preset = this.preset;
    if (preset && preset.sequence > this.tweenSequence) {
      // A preset arrived after this tween started: undo the frame the helper just wrote.
      applyCameraPose(this.camera, this.getControls(), preset.pose);
    } else {
      this.getControls()?.update(); // drei's default when no onUpdate is given
    }
  }
}
