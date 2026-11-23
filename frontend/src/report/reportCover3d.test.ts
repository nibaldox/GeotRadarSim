import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { reportFixture1, reportFixture3 } from "./fixtures";
import { renderReportCover3d } from "./reportCover3d";

function harness(fail = false) {
  let scene!: THREE.Scene;
  let camera!: THREE.PerspectiveCamera;
  const canvas = {
    toDataURL: vi.fn(() => "data:image/jpeg;base64,AQID"),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const renderer = {
    domElement: canvas, setSize: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn(),
    getContext: () => ({ isContextLost: () => false }),
    render: vi.fn((s: THREE.Scene, c: THREE.PerspectiveCamera) => {
      scene = s; camera = c;
      if (fail) throw new Error("render failed");
    }),
  };
  return { renderer, get scene() { return scene; }, get camera() { return camera; } };
}

describe("renderReportCover3d", () => {
  it("builds a terrain with union colors and an open NODATA hole", async () => {
    const h = harness(); const model = reportFixture3();
    model.union!.visibleCount[1] = 3;
    const result = await renderReportCover3d(model, { width: 800, height: 400, rendererFactory: () => h.renderer });
    expect(result).toEqual({ format: "JPEG", width: 800, height: 400, bytes: new Uint8Array([1, 2, 3]) });
    expect(h.renderer.domElement.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.9);
    const mesh = h.scene.children.find((x) => x.name === "report-terrain") as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    expect(geometry.getAttribute("position").count).toBe(1200);
    const index = geometry.index!;
    expect(Array.from(index.array)).not.toContain(29 * 40);
    const colors = geometry.getAttribute("color");
    const expected = new THREE.Color("#d7dae0").lerp(new THREE.Color("#9ecae1"), 0.75);
    expect(colors.getX(0)).toBeCloseTo(expected.r);
    expect(colors.getY(0)).toBeCloseTo(expected.g);
    expect(colors.getZ(0)).toBeCloseTo(expected.b);
    for (const [count, hex] of [[2, "#4292c6"], [3, "#08519c"]] as const) {
      const i = model.union!.visibleCount.findIndex((value) => value === count);
      expect(i).toBeGreaterThanOrEqual(0);
      const color = new THREE.Color("#d7dae0").lerp(new THREE.Color(hex), 0.75);
      expect(colors.getX(i)).toBeCloseTo(color.r);
      expect(colors.getY(i)).toBeCloseTo(color.g);
      expect(colors.getZ(i)).toBeCloseTo(color.b);
    }
    expect(h.scene.children.filter((x) => x.name === "report-radar")).toHaveLength(3);
    expect(h.scene.getObjectByName("report-aoi")).toBeTruthy();
  });

  it("uses single-radar quality bands and neutral terrain for shadow", async () => {
    const h = harness(); const model = reportFixture1();
    await renderReportCover3d(model, { rendererFactory: () => h.renderer });
    const mesh = h.scene.getObjectByName("report-terrain") as THREE.Mesh;
    const colors = mesh.geometry.getAttribute("color");
    const low = new THREE.Color().setRGB(0.9, 0.1, 0.1, THREE.SRGBColorSpace);
    const expected = new THREE.Color("#d7dae0").lerp(low, 0.75);
    expect(colors.getX(3)).toBeCloseTo(expected.r);
    expect(colors.getY(3)).toBeCloseTo(expected.g);
    const neutral = new THREE.Color("#d7dae0");
    expect(colors.getX(25 * 40)).toBeCloseTo(neutral.r);
  });

  it("reduces each axis to 512 vertices while preserving unsampled holes", async () => {
    const model = reportFixture1();
    model.terrain = { ...model.terrain, rows: 514, cols: 514, resolution: 1,
      bounds: { min_x: 0, max_x: 513, min_y: 0, max_y: 513, min_z: 0, max_z: 0 }, elevations: new Float32Array(514 * 514) };
    model.terrain.elevations[1 * 514 + 1] = NaN;
    const h = harness(); await renderReportCover3d(model, { rendererFactory: () => h.renderer });
    const mesh = h.scene.getObjectByName("report-terrain") as THREE.Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(512 * 512);
    expect(mesh.geometry.index!.count).toBeLessThan(511 * 511 * 6);
  });

  it("chooses the same 30-degree southwest camera for the same fixture", async () => {
    const a = harness(), b = harness();
    await renderReportCover3d(reportFixture3(), { rendererFactory: () => a.renderer });
    await renderReportCover3d(reportFixture3(), { rendererFactory: () => b.renderer });
    expect(a.camera.fov).toBe(30);
    expect(a.camera.position.toArray()).toEqual(b.camera.position.toArray());
    expect(a.camera.position.x).toBeLessThan(0);
    expect(a.camera.position.z).toBeGreaterThan(0);
    expect(a.camera.position.y).toBeGreaterThan(0);
  });

  it.each([[2400, 1240], [800, 800], [600, 1000]])("frames finite terrain vertices at about 85% for %sx%s", async (width, height) => {
    const model = reportFixture3(), h = harness();
    await renderReportCover3d(model, { width, height, rendererFactory: () => h.renderer });
    h.camera.updateMatrixWorld(true);
    const mesh = h.scene.getObjectByName("report-terrain") as THREE.Mesh;
    const attribute = mesh.geometry.getAttribute("position");
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < attribute.count; i++) if (Number.isFinite(model.terrain.elevations[i])) {
      points.push(new THREE.Vector3().fromBufferAttribute(attribute, i).project(h.camera));
    }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1);
    expect(Math.max(...ys.map(Math.abs))).toBeLessThan(1);
    const occupancy = Math.max((Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2);
    expect(occupancy).toBeGreaterThan(.80); expect(occupancy).toBeLessThan(.87);
  });

  it.each([false, true])("disposes scene resources and renderer on failure=%s", async (fail) => {
    const h = harness(fail);
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(THREE.Material.prototype, "dispose");
    const action = renderReportCover3d(reportFixture3(), { rendererFactory: () => h.renderer });
    if (fail) await expect(action).rejects.toThrow("render failed"); else await action;
    expect(geometryDispose).toHaveBeenCalled(); expect(materialDispose).toHaveBeenCalled();
    expect(h.renderer.dispose).toHaveBeenCalledOnce(); expect(h.renderer.forceContextLoss).toHaveBeenCalledOnce();
    geometryDispose.mockRestore(); materialDispose.mockRestore();
  });

  it("rejects clearly when WebGL cannot be initialized", async () => {
    await expect(renderReportCover3d(reportFixture3(), { rendererFactory: () => { throw new Error("no context"); } })).rejects.toThrow(/WebGL/);
  });

  it("rejects and cleans up if the context is lost", async () => {
    const h = harness(); h.renderer.getContext = () => ({ isContextLost: () => true });
    await expect(renderReportCover3d(reportFixture3(), { rendererFactory: () => h.renderer })).rejects.toThrow(/WebGL/);
    expect(h.renderer.dispose).toHaveBeenCalledOnce(); expect(h.renderer.forceContextLoss).toHaveBeenCalledOnce();
  });
});

it("encuadra puntos válidos de una malla irregular, con pines y cámara determinista", async () => {
  const model = reportFixture1();
  const t = model.terrain;
  t.elevations = t.elevations.slice();
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
    if (!(r > 3 && r < 25 && c > 3 && c < 12) && !(r > 16 && r < 25 && c > 3 && c < 32)) t.elevations[r * t.cols + c] = NaN;
  }
  model.radars = [{ ...model.radars[0]!, position: { x: 30, y: 35, z: 110 }, groundZ: 105 }];
  model.aoi = null;
  const a = harness(), b = harness();
  await renderReportCover3d(model, { rendererFactory: () => a.renderer });
  await renderReportCover3d(model, { rendererFactory: () => b.renderer });
  expect(a.camera.projectionMatrix.toArray()).toEqual(b.camera.projectionMatrix.toArray());
  expect(a.camera.matrixWorld.toArray()).toEqual(b.camera.matrixWorld.toArray());
  const terrain = a.scene.getObjectByName("report-terrain") as THREE.Mesh;
  const attr = terrain.geometry.getAttribute("position");
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < attr.count; i++) if (Number.isFinite(t.elevations[i])) points.push(new THREE.Vector3().fromBufferAttribute(attr, i).project(a.camera));
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const occupancy = Math.max((Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2);
  expect(occupancy).toBeGreaterThanOrEqual(.80);
  expect(Math.max(...xs.map(Math.abs), ...ys.map(Math.abs))).toBeLessThanOrEqual(.9);
  const pin = a.scene.getObjectByName("report-radar")!;
  pin.updateWorldMatrix(true, true);
  const head = pin.children[1] as THREE.Mesh;
  head.geometry.computeBoundingSphere();
  const tip = head.localToWorld(new THREE.Vector3(0, head.geometry.boundingSphere!.radius, 0)).project(a.camera);
  expect(Math.max(Math.abs(tip.x), Math.abs(tip.y))).toBeLessThan(1);
});

it("la portada predeterminada coincide con el aspecto del recuadro del PDF", async () => {
  const { REPORT_COVER_SLOT } = await import("./reportCover3d");
  const h = harness();
  const result = await renderReportCover3d(reportFixture1(), { rendererFactory: () => h.renderer });
  expect(Math.abs((result.width / result.height) / (REPORT_COVER_SLOT.width / REPORT_COVER_SLOT.height) - 1)).toBeLessThan(.01);
});


it("rechaza una malla sin nodos válidos incluso con radares y libera recursos", async () => {
  const model = reportFixture1(), h = harness();
  model.terrain.elevations = new Float32Array(model.terrain.elevations.length).fill(NaN);
  await expect(renderReportCover3d(model, { rendererFactory: () => h.renderer })).rejects.toThrow(/terreno válido/);
  expect(h.renderer.dispose).toHaveBeenCalledOnce();
  expect(h.renderer.forceContextLoss).toHaveBeenCalledOnce();
});


it("incluye en el encuadre la punta de un pin situado fuera de la malla válida", async () => {
  const model = reportFixture1(), h = harness();
  model.radars = [{ ...model.radars[0]!, position: { x: model.terrain.bounds.max_x * 3, y: 50, z: 100 }, groundZ: 100 }];
  model.aoi = null;
  await renderReportCover3d(model, { rendererFactory: () => h.renderer });
  const pin = h.scene.getObjectByName("report-radar")!;
  pin.updateWorldMatrix(true, true);
  const head = pin.children[1] as THREE.Mesh; head.geometry.computeBoundingSphere();
  const tip = head.localToWorld(new THREE.Vector3(0, head.geometry.boundingSphere!.radius, 0)).project(h.camera);
  expect(Math.abs(tip.x)).toBeLessThan(.9);
  expect(Math.abs(tip.y)).toBeLessThan(.9);
});
