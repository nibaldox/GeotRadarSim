import * as THREE from "three";
import { LOSCellState } from "../types/api";
import { classifyQualityValue } from "../utils/qualityMetrics";
import type { ReportCoverImage, ReportModel } from "./types";

type CoverRenderer = Pick<THREE.WebGLRenderer, "domElement" | "setSize" | "render" | "dispose" | "forceContextLoss"> & { getContext(): { isContextLost(): boolean } };
type CoverOptions = { width?: number; height?: number; rendererFactory?: () => CoverRenderer };

/** Cover image slot in the landscape A4 PDF, in millimetres. */
export const REPORT_COVER_SLOT = Object.freeze({ x: 12, y: 7, width: 273, height: 119 });

// Contract §4/4b: union blues and band-center colors from ShadowOverlay;
// coverage is blended with terrain at the raster's 0.75 opacity.
const unionColors = ["#9ecae1", "#4292c6", "#08519c"];
const incidence = [[0.9, 0.1, 0.1], [1, 0.8, 0], [0, 0.9, 0.2]];
const projectionStops = [[0.5, 0, 0.5], [0.1, 0.2, 0.8], [0, 0.8, 0.8], [0, 0.9, 0.2]];

function qualityColor(model: ReportModel, index: number): THREE.Color | null {
  const radar = model.radars[0]!;
  if (radar.cellStates[index] !== LOSCellState.VISIBLE) return null;
  const band = classifyQualityValue(radar.qualityValues?.[index] ?? NaN, model.policy);
  if (!band) return new THREE.Color("#9e9e9e");
  const bandIndex = band === "low" ? 0 : band === "medium" ? 1 : 2;
  let rgb = incidence[bandIndex]!;
  if (model.metric === "PROJECTION") {
    const centers = [model.policy.mediumMin / 2, (model.policy.mediumMin + model.policy.highMin) / 2, (model.policy.highMin + 1) / 2];
    const q = centers[bandIndex]!;
    const segment = q < 0.2 ? 0 : q < 0.6 ? 1 : 2;
    const start = [0, 0.2, 0.6][segment]!;
    const t = (q - start) / [0.2, 0.4, 0.4][segment]!;
    rgb = projectionStops[segment]!.map((v, i) => v + (projectionStops[segment + 1]![i]! - v) * t);
  }
  return new THREE.Color().setRGB(rgb[0]!, rgb[1]!, rgb[2]!, THREE.SRGBColorSpace);
}

/** Render a standalone, disposable cover without accessing the application's viewer. */
export async function renderReportCover3d(model: ReportModel, opts: CoverOptions = {}): Promise<ReportCoverImage> {
  const width = opts.width ?? 2400, height = opts.height ?? Math.round(width * REPORT_COVER_SLOT.height / REPORT_COVER_SLOT.width);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("Las dimensiones de la portada no son válidas.");
  let renderer: CoverRenderer;
  try {
    renderer = opts.rendererFactory ? opts.rendererFactory() : new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch {
    throw new Error("No se pudo iniciar WebGL para la portada.");
  }
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  let lost = false;
  const onLost = (event: Event) => { event.preventDefault(); lost = true; };
  const canvas = renderer.domElement;
  const checkContext = () => { if (lost || renderer.getContext().isContextLost()) throw new Error("Se perdió el contexto WebGL de la portada."); };
  const geometry = <T extends THREE.BufferGeometry>(g: T): T => { geometries.push(g); return g; };
  const material = <T extends THREE.Material>(m: T): T => { materials.push(m); return m; };
  try {
    canvas.addEventListener("webglcontextlost", onLost);
    checkContext();
    renderer.setSize(width, height, false);
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#f5f6f8");
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const light = new THREE.DirectionalLight(0xffffff, 1.5); light.position.set(-1, 2, -1); scene.add(light);
    const t = model.terrain, b = t.bounds;
    const cx = (b.min_x + b.max_x) / 2, cy = (b.min_y + b.max_y) / 2, cz = (b.min_z + b.max_z) / 2;
    const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x - cx, z - cz, cy - y);
    const nr = Math.min(512, t.rows), nc = Math.min(512, t.cols);
    const rows = Array.from({ length: nr }, (_, i) => nr === 1 ? 0 : Math.round(i * (t.rows - 1) / (nr - 1)));
    const cols = Array.from({ length: nc }, (_, i) => nc === 1 ? 0 : Math.round(i * (t.cols - 1) / (nc - 1)));
    const positions: number[] = [], colors: number[] = [], indices: number[] = [], framePoints: number[] = [];
    const base = new THREE.Color("#d7dae0");
    for (const r of rows) for (const c of cols) {
      const i = r * t.cols + c, z = t.elevations[i]!;
      const p = toWorld(b.min_x + c * t.resolution, b.min_y + r * t.resolution, Number.isFinite(z) ? z : cz);
      positions.push(p.x, p.y, p.z);
      if (Number.isFinite(z)) framePoints.push(p.x, p.y, p.z);
      const count = model.union?.visibleCount[i] ?? 0;
      const overlay = model.radars.length > 1 ? (count ? new THREE.Color(unionColors[Math.min(count, 3) - 1]!) : null) : qualityColor(model, i);
      const color = base.clone(); if (overlay) color.lerp(overlay, 0.75);
      colors.push(color.r, color.g, color.b);
    }
    for (let r = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++) {
      // A reduced quad is omitted if any source node beneath it is NODATA.
      let valid = true;
      for (let y = rows[r]!; y <= rows[r + 1]! && valid; y++) for (let x = cols[c]!; x <= cols[c + 1]!; x++) {
        if (!Number.isFinite(t.elevations[y * t.cols + x])) { valid = false; break; }
      }
      if (valid) { const a = r * nc + c, d = a + nc; indices.push(a, a + 1, d, a + 1, d + 1, d); }
    }
    const terrain = geometry(new THREE.BufferGeometry());
    terrain.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    terrain.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    terrain.setIndex(indices); terrain.computeVertexNormals();
    const mesh = new THREE.Mesh(terrain, material(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide })));
    mesh.name = "report-terrain"; scene.add(mesh);
    const span = Math.max(b.max_x - b.min_x, b.max_y - b.min_y, 1);
    const offset = span * 0.003;
    const elevationAt = (x: number, y: number): number | null => {
      const fx = (x - b.min_x) / t.resolution, fy = (y - b.min_y) / t.resolution;
      if (fx < 0 || fy < 0 || fx > t.cols - 1 || fy > t.rows - 1) return null;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, t.cols - 1), y0 = Math.floor(fy), y1 = Math.min(y0 + 1, t.rows - 1);
      const v = [t.elevations[y0 * t.cols + x0]!, t.elevations[y0 * t.cols + x1]!, t.elevations[y1 * t.cols + x0]!, t.elevations[y1 * t.cols + x1]!];
      if (!v.every(Number.isFinite)) return null;
      const u = fx - x0, w = fy - y0;
      return (v[0]! * (1 - u) + v[1]! * u) * (1 - w) + (v[2]! * (1 - u) + v[3]! * u) * w;
    };
    if (model.aoi && model.aoi.vertices.length > 1) {
      const points: number[] = [], vertices = model.aoi.vertices;
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i]!, d = vertices[(i + 1) % vertices.length]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(d.x - a.x, d.y - a.y) / t.resolution));
        let previous: THREE.Vector3 | null = null;
        for (let k = 0; k <= steps; k++) {
          const x = a.x + (d.x - a.x) * k / steps, y = a.y + (d.y - a.y) * k / steps, z = elevationAt(x, y);
          const next = z === null ? null : toWorld(x, y, z + offset);
          if (previous && next) points.push(...previous.toArray(), ...next.toArray());
          previous = next;
        }
      }
      const lineGeometry = geometry(new THREE.BufferGeometry()); lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      const line = new THREE.LineSegments(lineGeometry, material(new THREE.LineBasicMaterial({ color: "#2b2f36" })));
      line.name = "report-aoi"; scene.add(line);
    }
    if (framePoints.length === 0) throw new Error("No hay terreno válido para la portada.");
    for (const radar of model.radars) {
      const z = radar.groundZ ?? elevationAt(radar.position.x, radar.position.y);
      if (z === null) continue;
      const pinHeight = span * 0.055, radius = span * 0.0025;
      const group = new THREE.Group(); group.name = "report-radar"; group.position.copy(toWorld(radar.position.x, radar.position.y, z + offset));
      const pinMaterial = material(new THREE.MeshStandardMaterial({ color: radar.color, roughness: 1, metalness: 0 }));
      const stem = new THREE.Mesh(geometry(new THREE.CylinderGeometry(radius, radius, pinHeight, 8)), pinMaterial); stem.position.y = pinHeight / 2;
      const head = new THREE.Mesh(geometry(new THREE.SphereGeometry(radius * 2.5, 10, 8)), pinMaterial); head.position.y = pinHeight;
      group.add(stem, head); scene.add(group);
      const tip = group.position.clone().add(new THREE.Vector3(0, pinHeight, 0));
      const headRadius = radius * 2.5;
      // Include the extremities of the pin head, not just its centre.
      for (const [x, y, z] of [[0, headRadius, 0], [0, -headRadius, 0], [headRadius, 0, 0], [-headRadius, 0, 0], [0, 0, headRadius], [0, 0, -headRadius]]) {
        framePoints.push(tip.x + x!, tip.y + y!, tip.z + z!);
      }
    }
    const camera = new THREE.PerspectiveCamera(30, width / height, 0.01, 1);
    const angle = THREE.MathUtils.degToRad(35);
    const direction = new THREE.Vector3(-Math.cos(angle) / Math.SQRT2, Math.sin(angle), Math.cos(angle) / Math.SQRT2);
    // Project actual finite mesh vertices and pin tips rather than empty box corners.
    camera.far = Math.max(span * 1000, Math.abs(b.max_z - b.min_z) * 1000, 1000);
    camera.updateProjectionMatrix();
    const matrix = new THREE.Matrix4();
    let minX = 0, maxX = 0, minY = 0, maxY = 0, nearest = -Infinity, radius = 0;
    for (let i = 0; i < framePoints.length; i += 3) {
      const x = framePoints[i]!, y = framePoints[i + 1]!, z = framePoints[i + 2]!;
      nearest = Math.max(nearest, x * direction.x + y * direction.y + z * direction.z);
      radius = Math.max(radius, Math.hypot(x, y, z));
    }
    const occupancy = (distance: number) => {
      camera.position.copy(direction).multiplyScalar(distance); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
      const e = matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
      minX = minY = Infinity; maxX = maxY = -Infinity;
      for (let i = 0; i < framePoints.length; i += 3) {
        const x = framePoints[i]!, y = framePoints[i + 1]!, z = framePoints[i + 2]!;
        const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
        const px = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w;
        const py = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      return Math.max((maxX - minX) / 2, (maxY - minY) / 2);
    };
    let low = Math.max(nearest + camera.near + 0.1, 0.1);
    let high = Math.max(low * 2, 1);
    while (occupancy(high) > .85) high *= 2;
    for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (occupancy(mid) > .85) low = mid; else high = mid; }
    camera.far = Math.max(camera.far, high + radius + 1);
    camera.updateProjectionMatrix();
    occupancy(high);
    camera.projectionMatrix.elements[8]! += (maxX + minX) / 2;
    camera.projectionMatrix.elements[9]! += (maxY + minY) / 2;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    renderer.render(scene, camera); checkContext();
    const url = canvas.toDataURL("image/jpeg", 0.9); checkContext();
    if (!url.startsWith("data:image/jpeg;base64,")) throw new Error("No se pudo codificar la portada en JPEG.");
    const binary = atob(url.slice(url.indexOf(",") + 1));
    return { format: "JPEG", bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)), width, height };
  } finally {
    canvas.removeEventListener("webglcontextlost", onLost);
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    try { renderer.dispose(); } finally { renderer.forceContextLoss(); }
  }
}