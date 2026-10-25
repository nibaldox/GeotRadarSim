import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as THREE from "three";
import { buildTerrainCameraPose, buildTerrainMeshGeometry, getTerrainMeshCenter, TerrainViewer } from "./TerrainViewer";
import * as TerrainViewerApi from "./TerrainViewer";
import { useAnalysisStore, RADAR_COLORS } from "../store/analysisStore";
import type { HistoryEntry } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import type { AnalysisSnapshot, LOSResponse } from "../types/api";

vi.mock("@react-three/fiber", async () => {
  const React = await import("react");
  return {
    Canvas: ({ children }: { children: import("react").ReactNode }) => React.createElement(
      "div",
      { "data-testid": "webgl-canvas" },
      React.createElement("canvas"),
      React.createElement("div", { "data-testid": "terrain-scene" }, children),
    ),
    useThree: () => ({
      camera: {
        position: { set: () => undefined },
        lookAt: () => undefined,
        updateProjectionMatrix: () => undefined,
      },
    }),
  };
});

vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  GizmoHelper: () => null,
  GizmoViewport: () => null,
}));

const grid = [
  [0, 0, 0, 0],
  [0, 20, 0, 0],
  [0, 0, 0, 0],
];
const bounds = { min_x: 100, min_y: 200, max_x: 106, max_y: 204, min_z: 200, max_z: 206 };
const terrainKey = { terrain_id: "terrain-a", epoch: 3 };
const losResult: LOSResponse = {
  shadow_grid: [[false]],
  cell_states: new Uint8Array([5]),
  grid_rows: 1,
  grid_cols: 1,
  resolution: 1,
  coverage_polygon: [[0, 0]],
  coverage_pct: 100,
  completeness_pct: 100,
  visible_area_m2: 1,
  shadow_zones: [],
};
const multiSnapshot: AnalysisSnapshot = {
  terrainKey,
  analysisId: null,
  sourceAnalysisIds: ["job-a", "job-b"],
  generation: 9,
  radars: [
    { radarId: "east", radarModelId: "model-a", position: { x: 101, y: 205, z: 202 }, overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } },
    { radarId: "west", radarModelId: "model-b", position: { x: 104, y: 208, z: 204 }, overrides: { rangeMin: null, rangeMax: null, elMin: null, elMax: null, azCenter: null, azWidth: null } },
  ],
};

function entry(timestamp: string, position: { x: number; y: number; z: number }, key = terrainKey): HistoryEntry {
  return {
    position,
    coveragePct: 100,
    timestamp,
    result: losResult,
    radarId: timestamp,
    selected: true,
    terrain_id: key.terrain_id,
    terrain_epoch: key.epoch,
  };
}

function resetViewerStores() {
  useAnalysisStore.setState({
    radarPosition: null,
    history: [],
    activeSnapshot: null,
    losResult: null,
    terrainKey: null,
    terrainTransitioning: false,
  });
  useTerrainStore.setState({
    grid: null,
    metadata: null,
    terrainKey: null,
    terrainEpoch: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetViewerStores();
});

describe("TerrainViewer DEM geometry", () => {
  it("places DEM nodes at the same geographic samples and triangle surface used by LOS", async () => {
    vi.stubGlobal("self", { onmessage: null, postMessage: vi.fn() });
    const { sampleTerrainAtCoordinates } = await import("../workers/losWorker");
    const geometry = buildTerrainMeshGeometry(grid, 2);
    const positions = geometry.getAttribute("position");
    const indices = Array.from(geometry.getIndex()!.array);
    const row = 1;
    const col = 1;
    const vertex = row * grid[0]!.length + col;
    const localX = positions.getX(vertex);
    const localY = positions.getY(vertex);
    const localZ = positions.getZ(vertex);

    expect([bounds.min_x + localX, bounds.min_y - localZ]).toEqual([102, 202]);
    expect(localY).toBe(20);
    expect(indices.slice(0, 12)).toEqual([0, 1, 4, 1, 5, 4, 1, 2, 5, 2, 6, 5]);

    expect(sampleTerrainAtCoordinates(grid, bounds, 2, 100, 200)).toBe(0);
    expect(sampleTerrainAtCoordinates(grid, bounds, 2, 106, 204)).toBe(0);
    expect(sampleTerrainAtCoordinates(grid, bounds, 2, 106.01, 204)).toBeNull();

    const sampleX = 100 + (4 / 3) * 2;
    const sampleY = 200 + (2 / 3) * 2;
    const losHeight = sampleTerrainAtCoordinates(grid, bounds, 2, sampleX, sampleY);
    expect(losHeight).toBeCloseTo(40 / 3, 8);
    geometry.dispose();
  });

  it("does not render terrain cells containing infinite elevations", () => {
    const invalidGrid = [[2, Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY, 4]];
    const geometry = buildTerrainMeshGeometry(invalidGrid, 1);
    const positions = geometry.getAttribute("position");

    expect(geometry.getIndex()?.count).toBe(0);
    expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
    geometry.dispose();
  });

  it("keeps camera targets and positions finite for either infinite elevation", () => {
    const invalidGrid = [[2, Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY, 4]];

    for (const view of [null, "TOP"] as const) {
      const pose = buildTerrainCameraPose(invalidGrid, 1, view);

      expect(pose).not.toBeNull();
      expect(Object.values(pose!.extent).every(Number.isFinite)).toBe(true);
      expect(Object.values(pose!.target).every(Number.isFinite)).toBe(true);
      expect(Object.values(pose!.position).every(Number.isFinite)).toBe(true);
    }
  });

  it("centers the camera on DEM vertices instead of shifting half a cell", () => {
    expect(getTerrainMeshCenter(grid, 2)).toEqual({ centerX: 3, centerZ: -2 });
  });
});

describe("TerrainViewer radar markers", () => {
  function activateTestTerrain(key = terrainKey) {
    useAnalysisStore.setState({ terrainKey: key, terrainTransitioning: false });
    useTerrainStore.setState({
      grid,
      metadata: {
        terrain_id: key.terrain_id,
        bounds,
        resolution: 2,
        grid_rows: grid.length,
        grid_cols: grid[0]!.length,
      },
      terrainKey: key,
      terrainEpoch: key.epoch,
    });
  }

  it("keeps the placed radar and current-epoch history without duplicate or stale markers when no snapshot exists", () => {
    activateTestTerrain();
    const placed = { x: 101, y: 205, z: 202 };
    const distinctHistory = { x: 103, y: 207, z: 204 };
    useAnalysisStore.setState({
      radarPosition: placed,
      history: [
        entry("same-as-placement", placed),
        entry("keep-this-history", distinctHistory),
        entry("other-epoch", { x: 108, y: 209, z: 208 }, { terrain_id: terrainKey.terrain_id, epoch: 2 }),
      ],
    });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    expect(scene.querySelector('mesh[name="radar-current-marker"]')).toHaveAttribute("position", "1,2,-5");
    const historyMarkers = scene.querySelectorAll('group[name^="radar-history-"]');
    expect(historyMarkers).toHaveLength(1);
    expect(historyMarkers[0]).toHaveAttribute("position", "3,4,-7");
  });

  it("hides snapshot, placement, and history markers from a different terrain epoch", () => {
    activateTestTerrain();
    const oldKey = { terrain_id: terrainKey.terrain_id, epoch: terrainKey.epoch - 1 };
    const staleSnapshot: AnalysisSnapshot = { ...multiSnapshot, terrainKey: oldKey };
    useAnalysisStore.setState({
      activeSnapshot: staleSnapshot,
      losResult,
      radarPosition: multiSnapshot.radars[0]!.position,
      history: [entry("stale-snapshot-history", multiSnapshot.radars[0]!.position, oldKey)],
    });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    expect(scene.querySelectorAll("mesh")).toHaveLength(1);
    expect(scene.querySelectorAll("group")).toHaveLength(1);
  });
});

describe("TerrainViewer geometric projection legend", () => {
  it("describes projection bands and transparent no-data in English and Spanish", () => {
    useTerrainStore.setState({
      grid,
      metadata: {
        terrain_id: terrainKey.terrain_id,
        bounds,
        resolution: 2,
        grid_rows: grid.length,
        grid_cols: grid[0]!.length,
      },
      terrainKey,
      terrainEpoch: terrainKey.epoch,
    });
    useAnalysisStore.setState({ terrainKey, terrainTransitioning: false });
    useVectorStore.setState({ visualizationMode: "SENSITIVITY" });

    render(<TerrainViewer showShadowOverlay />);

    expect(screen.getByText("Geometric projection index")).toBeInTheDocument();
    expect(screen.getByText("Índice de proyección geométrica")).toBeInTheDocument();
    expect(screen.getByText("No data — transparent")).toBeInTheDocument();
    expect(screen.getByText("Sin datos — transparente")).toBeInTheDocument();
    expect(screen.getByText("Low geometric projection (0.0 - 0.2)")).toBeInTheDocument();
    expect(screen.getByText("Proyección geométrica baja (0.0 - 0.2)")).toBeInTheDocument();
    expect(screen.getByText("Intermediate geometric projection (0.2 - 0.6)")).toBeInTheDocument();
    expect(screen.getByText("Proyección geométrica intermedia (0.2 - 0.6)")).toBeInTheDocument();
    expect(screen.getByText("High geometric projection (0.6 - 1.0)")).toBeInTheDocument();
    expect(screen.getByText("Proyección geométrica alta (0.6 - 1.0)")).toBeInTheDocument();
    expect(screen.getByText(
      "Transparent means no contributing observation: no individual LOS is VISIBLE with a computable terrain gradient. This can result from NODATA, an unknown ray state, outside range/FOV, shadow, or a VISIBLE cell without a computable gradient; transparency alone does not identify shadow.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Transparente significa que no hay observación contribuyente: ningún LOS individual es VISIBLE con un gradiente del terreno calculable. Puede deberse a NODATA, un estado de rayo desconocido, fuera de alcance/FOV, sombra o una celda VISIBLE sin gradiente calculable; la transparencia por sí sola no identifica la sombra.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "One contributor: |dot| between the maximum-slope direction and radar line of sight (LOS); multiple contributors: RMS(dotᵢ) across contributors. A measured zero has at least one contributor; no contributors means no data, not zero. These are geometric-index ranges, not detection thresholds or RF/SNR performance.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Con un contribuyente: |dot| entre la dirección de máxima pendiente y la línea de vista (LOS) del radar; con varios contribuyentes: RMS(dotᵢ) entre ellos. Un cero medido tiene al menos un contribuyente; sin contribuyentes no hay datos, no un cero. Son intervalos de un índice geométrico, no umbrales de detección ni rendimiento RF/SNR.",
    )).toBeInTheDocument();

    const legend = screen.getByText("Geometric projection index").closest(".geotechnical-hud-legend");
    expect(legend).not.toBeNull();
    expect(legend).not.toHaveTextContent(/complete detection failure|signal detects|blind zone|optimal sensitivity|radar visual is parallel/i);
  });
});

describe("TerrainViewer quality legend", () => {
  it("describes geometric index bands and groups shadows with transparent states", () => {
    useTerrainStore.setState({
      grid,
      metadata: {
        terrain_id: terrainKey.terrain_id,
        bounds,
        resolution: 2,
        grid_rows: grid.length,
        grid_cols: grid[0]!.length,
      },
      terrainKey,
      terrainEpoch: terrainKey.epoch,
    });
    useAnalysisStore.setState({ terrainKey, terrainTransitioning: false });
    useVectorStore.setState({ visualizationMode: "QUALITY" });

    render(<TerrainViewer showShadowOverlay />);

    expect(screen.getByText("Geometric line-of-sight (LOS) index")).toBeInTheDocument();
    expect(screen.getByText("Índice geométrico de línea de vista (LOS)")).toBeInTheDocument();
    expect(screen.getByText("Low geometric index (0.0 - 0.3)")).toBeInTheDocument();
    expect(screen.getByText("Índice geométrico bajo (0.0 - 0.3)")).toBeInTheDocument();
    expect(screen.getByText("Intermediate geometric index (0.3 - 0.7)")).toBeInTheDocument();
    expect(screen.getByText("Índice geométrico intermedio (0.3 - 0.7)")).toBeInTheDocument();
    expect(screen.getByText("High geometric index (0.7 - 1.0)")).toBeInTheDocument();
    expect(screen.getByText("Índice geométrico alto (0.7 - 1.0)")).toBeInTheDocument();

    expect(screen.queryByText("Confirmed obstruction shadow")).not.toBeInTheDocument();
    expect(screen.queryByText("Sombra por obstrucción confirmada")).not.toBeInTheDocument();
    expect(screen.getByText(
      "SHADOW marks an obstruction on the terrain LOS ray; it is distinct from OUT_OF_RANGE and OUTSIDE_FOV.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "SHADOW indica una obstrucción del terreno en el rayo LOS; es distinto de OUT_OF_RANGE y OUTSIDE_FOV.",
    )).toBeInTheDocument();

    expect(screen.getByText("Transparent — no index value")).toBeInTheDocument();
    expect(screen.getByText("Transparente — sin valor de índice")).toBeInTheDocument();
    expect(screen.getByText(
      "NODATA, UNKNOWN_RAY, OUT_OF_RANGE, OUTSIDE_FOV and SHADOW have no displayed index and appear transparent, showing the base terrain; transparency alone does not identify the cause.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "NODATA, UNKNOWN_RAY, OUT_OF_RANGE, OUTSIDE_FOV y SHADOW no tienen un índice mostrado y aparecen transparentes, mostrando el terreno base; la transparencia por sí sola no identifica la causa.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Only VISIBLE cells have this geometric index. A displayed value of 0.0 is measured; missing data is transparent.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "El índice geométrico se calcula solo para celdas VISIBLE. Un valor mostrado de 0.0 es medido; los datos ausentes son transparentes.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "For VISIBLE cells, the 0–1 score combines terrain-normal/LOS alignment with distance relative to the configured maximum range; it is a geometric index, not an estimate of sensor signal or data reliability.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Para celdas VISIBLE, el valor de 0–1 combina la orientación de la normal del terreno respecto al LOS con la distancia relativa al alcance máximo configurado; es un índice geométrico, no una estimación de la señal del sensor ni de la fiabilidad de los datos.",
    )).toBeInTheDocument();

    const legend = screen.getByText("Geometric line-of-sight (LOS) index").closest(".geotechnical-hud-legend");
    expect(legend).not.toBeNull();
    expect(legend).not.toHaveTextContent(/suboptimal signal angle|hard to monitor|adequate signal|reliable geotechnical|perfect angle of incidence|ideal snr/i);
    const qualityColors = [
      screen.getByText("Low geometric index (0.0 - 0.3)").closest(".hud-legend-row"),
      screen.getByText("Intermediate geometric index (0.3 - 0.7)").closest(".hud-legend-row"),
      screen.getByText("High geometric index (0.7 - 1.0)").closest(".hud-legend-row"),
    ].map((row) => row?.querySelector<HTMLElement>(".hud-legend-color")?.style.background);
    expect(qualityColors).toEqual([
      "rgb(230, 26, 56)",
      "rgb(218, 142, 11)",
      "rgb(11, 218, 80)",
    ]);
  });
});

describe("TerrainViewer radar marker visibility", () => {
  // QA baseline case: f8_relimit.stl 217 x 274 m at 5 m, TOP auto-fit, 3 selected snapshots.
  const qaBounds = { min_x: 93222, min_y: 2900, max_x: 93439, max_y: 3200, min_z: 21700, max_z: 21974 };
  const qaKey = { terrain_id: "terrain-f8", epoch: 1 };
  const qaPositions = [
    { x: 93250, y: 3018, z: 21750 },
    { x: 93320, y: 3020, z: 21800 },
    { x: 93400, y: 3022, z: 21850 },
  ];

  const api = TerrainViewerApi as unknown as {
    radarMarkerRadii?: (bounds: typeof qaBounds) => { core: number; ring: number; outer: number };
    createMarkerHalo?: (core: number, ring: number, outer: number) => THREE.Group;
  };

  function activateQaTerrain() {
    useAnalysisStore.setState({ terrainKey: qaKey, terrainTransitioning: false });
    useTerrainStore.setState({
      grid,
      metadata: {
        terrain_id: qaKey.terrain_id,
        bounds: qaBounds,
        resolution: 5,
        grid_rows: grid.length,
        grid_cols: grid[0]!.length,
      },
      terrainKey: qaKey,
      terrainEpoch: qaKey.epoch,
    });
  }

  function qaSnapshot(): AnalysisSnapshot {
    return {
      ...multiSnapshot,
      terrainKey: qaKey,
      radars: qaPositions.map((position, index) => ({
        radarId: `qa-${index}`,
        radarModelId: "model-a",
        position,
        overrides: multiSnapshot.radars[0]!.overrides,
      })),
    };
  }

  function sphereRadius(container: Element): number {
    return Number(container.querySelector("spheregeometry")!.getAttribute("args")!.split(",")[0]);
  }

  it("enlarges snapshot icons on the QA terrain with a contour and keeps each radar color on the core", () => {
    activateQaTerrain();
    useAnalysisStore.setState({ activeSnapshot: qaSnapshot(), losResult });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    const groups = scene.querySelectorAll('group[name^="radar-snapshot-"]');
    expect(groups).toHaveLength(3);
    groups.forEach((group, index) => {
      expect(sphereRadius(group)).toBeGreaterThanOrEqual(10);
      expect(sphereRadius(group)).toBeLessThanOrEqual(12);
      expect(group.querySelector("meshstandardmaterial")).toHaveAttribute("color", RADAR_COLORS[index]);
      expect(group.querySelector("primitive")).not.toBeNull();
    });
  });

  it("enlarges the placed icon with the same contour and keeps the real terrain anchor", () => {
    activateQaTerrain();
    useAnalysisStore.setState({ radarPosition: qaPositions[0]! });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    const placed = scene.querySelector('mesh[name="radar-current-marker"]')!;
    expect(sphereRadius(placed)).toBeGreaterThanOrEqual(10);
    expect(sphereRadius(placed)).toBeLessThanOrEqual(12);
    expect(placed.querySelector("meshstandardmaterial")).toHaveAttribute("color", "white");
    expect(placed).toHaveAttribute("position", "28,50,-118");
    const halo = scene.querySelector('primitive[name="radar-current-marker-halo"]')!;
    expect(halo).not.toBeNull();
    expect(halo).toHaveAttribute("position", "28,50,-118");
  });

  it("enlarges selected history icons like the snapshot icons", () => {
    activateQaTerrain();
    useAnalysisStore.setState({
      history: [entry("qa-history-1", qaPositions[0]!, qaKey), entry("qa-history-2", qaPositions[1]!, qaKey)],
    });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    const groups = scene.querySelectorAll('group[name^="radar-history-"]');
    expect(groups).toHaveLength(2);
    groups.forEach((group) => {
      expect(sphereRadius(group)).toBeGreaterThanOrEqual(10);
      expect(sphereRadius(group)).toBeLessThanOrEqual(12);
      expect(group.querySelector("primitive")).not.toBeNull();
    });
  });

  it("scales the analysis marker post with the icon instead of a fixed thin mast", () => {
    activateQaTerrain();
    useAnalysisStore.setState({ activeSnapshot: qaSnapshot(), losResult });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    const groups = scene.querySelectorAll('group[name^="radar-snapshot-"]');
    expect(groups).toHaveLength(3);
    groups.forEach((group) => {
      const [postRadius, , postHeight] = group.querySelector("cylindergeometry")!
        .getAttribute("args")!.split(",").map(Number);
      expect(postRadius!).toBeGreaterThan(1);
      expect(postHeight!).toBeGreaterThan(24);
      expect(postHeight!).toBeLessThanOrEqual(40);
    });
  });

  it("derives icon radii from terrain extent: QA bands, no giant icons on 200 m synthetic terrain, bounded extremes", () => {
    expect(api.radarMarkerRadii).toBeTypeOf("function");
    const radii = api.radarMarkerRadii!(qaBounds);
    expect(radii.outer).toBeGreaterThanOrEqual(21);
    expect(radii.outer).toBeLessThanOrEqual(25);
    expect(radii.core).toBeGreaterThanOrEqual(10);
    expect(radii.core).toBeLessThanOrEqual(12);
    expect(radii.core).toBeLessThan(radii.ring);
    expect(radii.ring).toBeLessThan(radii.outer);

    const synthetic = api.radarMarkerRadii!({ min_x: 0, min_y: 0, max_x: 200, max_y: 100, min_z: 0, max_z: 200 });
    expect(synthetic.outer).toBeLessThan(22);

    const huge = api.radarMarkerRadii!({ min_x: 0, min_y: 0, max_x: 5000, max_y: 100, min_z: 0, max_z: 5000 });
    expect(huge.outer).toBeLessThanOrEqual(30);

    const tiny = api.radarMarkerRadii!({ min_x: 0, min_y: 0, max_x: 20, max_y: 100, min_z: 0, max_z: 20 });
    expect(tiny.outer).toBeGreaterThanOrEqual(12);
  });

  it("draws the contour as a white ring and black rim that never capture clicks", () => {
    expect(api.createMarkerHalo).toBeTypeOf("function");
    const halo = api.createMarkerHalo!(11, 17, 23);
    expect(halo.children).toHaveLength(2);
    const [ring, rim] = halo.children as THREE.Mesh[];
    for (const [shell, hex, extent] of [[ring!, "ffffff", 17], [rim!, "000000", 23]] as const) {
      shell.geometry.computeBoundingSphere();
      expect(shell.geometry.boundingSphere!.radius).toBeCloseTo(extent, 4);
      const material = shell.material as THREE.MeshBasicMaterial;
      expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(material.color.getHexString()).toBe(hex);
      expect(shell.position.y).toBeGreaterThan(0);
    }
    const hits: THREE.Intersection[] = [];
    const probe = (shell: THREE.Mesh, x: number) => {
      const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 1.2, 5), new THREE.Vector3(0, 0, -1));
      const shellHits: THREE.Intersection[] = [];
      shell.raycast(raycaster, shellHits);
      hits.push(...shellHits);
    };
    probe(ring!, 14);
    probe(rim!, 20);
    expect(hits).toHaveLength(0);
  });
});
