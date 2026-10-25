import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildTerrainCameraPose, buildTerrainMeshGeometry, getTerrainMeshCenter, TerrainViewer } from "./TerrainViewer";
import * as TerrainViewerApi from "./TerrainViewer";
import { useAnalysisStore, RADAR_COLORS } from "../store/analysisStore";
import type { HistoryEntry } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";
import { useVectorStore } from "../store/vectorStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
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

vi.mock("@react-three/drei", async () => {
  return {
    OrbitControls: () => null,
    GizmoHelper: () => null,
    GizmoViewport: () => null,
  };
});

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
  it("describes movement-projection bands and transparent no-data in English and Spanish", () => {
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
    useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });

    render(<TerrainViewer showShadowOverlay />);

    expect(screen.getByText("Movement projection")).toBeInTheDocument();
    expect(screen.getByText("Proyección del movimiento")).toBeInTheDocument();
    expect(screen.getByText("No data — transparent")).toBeInTheDocument();
    expect(screen.getByText("Sin datos — transparente")).toBeInTheDocument();
    expect(screen.getByText("Low projection ([0, 0.3))")).toBeInTheDocument();
    expect(screen.getByText("Proyección baja ([0, 0.3))")).toBeInTheDocument();
    expect(screen.getByText("Medium projection ([0.3, 0.7))")).toBeInTheDocument();
    expect(screen.getByText("Proyección media ([0.3, 0.7))")).toBeInTheDocument();
    expect(screen.getByText("High projection ([0.7, 1])")).toBeInTheDocument();
    expect(screen.getByText("Proyección alta ([0.7, 1])")).toBeInTheDocument();
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
    expect(screen.getByText(
      "The 3D layer paints a scalar projection on the terrain surface under the assumed maximum-slope motion; it is not a volumetric reconstruction nor a full 3-axis displacement inversion.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "La capa 3D pinta una proyección escalar sobre la superficie del terreno bajo el movimiento supuesto de máxima pendiente; no es una reconstrucción volumétrica ni una inversión completa de desplazamiento en 3 ejes.",
    )).toBeInTheDocument();

    const legend = screen.getByText("Movement projection").closest(".geotechnical-hud-legend");
    expect(legend).not.toBeNull();
    expect(legend).not.toHaveTextContent(/complete detection failure|signal detects|blind zone|optimal sensitivity|radar visual is parallel/i);
  });

  it("follows the editable policy thresholds in the band labels", () => {
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
    useQualityPolicyStore.setState({ policy: { mediumMin: 0.25, highMin: 0.8 } });

    render(<TerrainViewer showShadowOverlay />);

    expect(screen.getByText("Low projection ([0, 0.25))")).toBeInTheDocument();
    expect(screen.getByText("Medium projection ([0.25, 0.8))")).toBeInTheDocument();
    expect(screen.getByText("High projection ([0.8, 1])")).toBeInTheDocument();
    useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });
  });
});

describe("TerrainViewer quality legend", () => {
  it("describes surface-incidence bands and groups shadows with transparent states", () => {
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
    useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });

    render(<TerrainViewer showShadowOverlay />);

    expect(screen.getByText("Surface incidence index (geometric v2)")).toBeInTheDocument();
    expect(screen.getByText("Índice de incidencia superficial (geométrico v2)")).toBeInTheDocument();
    expect(screen.getByText("Low incidence ([0, 0.3))")).toBeInTheDocument();
    expect(screen.getByText("Incidencia baja ([0, 0.3))")).toBeInTheDocument();
    expect(screen.getByText("Medium incidence ([0.3, 0.7))")).toBeInTheDocument();
    expect(screen.getByText("Incidencia media ([0.3, 0.7))")).toBeInTheDocument();
    expect(screen.getByText("High incidence ([0.7, 1])")).toBeInTheDocument();
    expect(screen.getByText("Incidencia alta ([0.7, 1])")).toBeInTheDocument();

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
      "For VISIBLE cells, the 0-1 score is the alignment of the terrain surface normal with the LOS direction from terrain to radar. Distance is not a multiplier: the configured maximum range only gates which cells are eligible for LOS and cannot change the score of a cell that stays VISIBLE. It is a geometric index, not an estimate of sensor signal or data reliability.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Para celdas VISIBLE, el valor de 0-1 es la alineación de la normal superficial del terreno con la dirección LOS desde el terreno hacia el radar. La distancia no es un multiplicador: el alcance máximo configurado solo delimita qué celdas son elegibles para el LOS y no puede cambiar el puntaje de una celda que sigue siendo VISIBLE. Es un índice geométrico, no una estimación de la señal del sensor ni de la fiabilidad de los datos.",
    )).toBeInTheDocument();

    const legend = screen.getByText("Surface incidence index (geometric v2)").closest(".geotechnical-hud-legend");
    expect(legend).not.toBeNull();
    expect(legend).not.toHaveTextContent(/suboptimal signal angle|hard to monitor|adequate signal|reliable geotechnical|perfect angle of incidence|ideal snr/i);
    expect(legend).not.toHaveTextContent(/combines terrain-normal\/LOS alignment with distance/i);
    const qualityColors = [
      screen.getByText("Low incidence ([0, 0.3))").closest(".hud-legend-row"),
      screen.getByText("Medium incidence ([0.3, 0.7))").closest(".hud-legend-row"),
      screen.getByText("High incidence ([0.7, 1])").closest(".hud-legend-row"),
    ].map((row) => row?.querySelector<HTMLElement>(".hud-legend-color")?.style.background);
    expect(qualityColors).toEqual([
      "rgb(230, 26, 56)",
      "rgb(218, 142, 11)",
      "rgb(11, 218, 80)",
    ]);
  });

  it("labels the bands as configurable provisional policy, not certified thresholds", () => {
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
    useQualityPolicyStore.setState({ policy: { ...DEFAULT_QUALITY_POLICY } });

    render(<TerrainViewer showShadowOverlay />);

    expect(screen.getByText(
      "The bands are a configurable shared policy copied from the legacy legend (provisional); they are not equipment-certified detection thresholds.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Las bandas son una política compartida configurable copiada de la leyenda anterior (provisional); no son umbrales de detección certificados por equipo.",
    )).toBeInTheDocument();
  });
});

describe("TerrainViewer radar marker visibility", () => {
  // QA baseline: real f8 terrain metadata — bounds and radar positions as
  // reported by the backend (274 cols x 217 rows at 5 m resolution = 1365 m
  // E-W x 1080 m N-S horizontal extent, 322 m elevation relief). Terrain
  // heights come from the shared synthetic grid fixture, not from the real STL.
  const qaBounds = {
    min_x: 92829.5859375,
    max_x: 94194.5859375,
    min_y: 21521.220703125,
    max_y: 22601.220703125,
    min_z: 2899.84619140625,
    max_z: 3222.44482421875,
  };
  const qaKey = { terrain_id: "terrain-f8", epoch: 1 };
  const qaPositions = [
    { x: 93329.5859375, y: 21791.220703125, z: 3018.204698917729 },
    { x: 93514.5859375, y: 21791.220703125, z: 3078.937841253482 },
    { x: 93699.5859375, y: 21791.220703125, z: 3019.598779685979 },
  ];

  const api = TerrainViewerApi as unknown as {
    radarMarkerRadii?: (bounds: {
      min_x: number;
      max_x: number;
      min_y: number;
      max_y: number;
      min_z?: number;
      max_z?: number;
    }) => { core: number };
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

  function expectNoHaloArtifacts(scene: HTMLElement) {
    expect(scene.querySelector("primitive")).toBeNull();
    expect(scene.querySelector("billboard")).toBeNull();
    expect(scene.querySelector("ringgeometry")).toBeNull();
    expect(scene.querySelector('[name*="halo"]')).toBeNull();
    expect(scene.innerHTML).not.toMatch(/halo/i);
  }

  it("renders snapshot icons as the colored core at the QA size and keeps each radar color", () => {
    activateQaTerrain();
    useAnalysisStore.setState({ activeSnapshot: qaSnapshot(), losResult });

    render(<TerrainViewer />);
    const scene = screen.getByTestId("terrain-scene");
    const groups = scene.querySelectorAll('group[name^="radar-snapshot-"]');
    expect(groups).toHaveLength(3);
    groups.forEach((group, index) => {
      expect(sphereRadius(group)).toBeCloseTo(11.00736, 10);
      expect(group.querySelector("meshstandardmaterial")).toHaveAttribute("color", RADAR_COLORS[index]);
    });
  });

  it("keeps the placed icon core white and the real terrain anchor without any halo", () => {
    activateQaTerrain();
    useAnalysisStore.setState({ radarPosition: qaPositions[0]! });

    render(<TerrainViewer />);

    const scene = screen.getByTestId("terrain-scene");
    const placed = scene.querySelector('mesh[name="radar-current-marker"]')!;
    expect(sphereRadius(placed)).toBeCloseTo(11.00736, 10);
    expect(placed.querySelector("meshstandardmaterial")).toHaveAttribute("color", "white");
    const placedAnchor = placed.getAttribute("position")!.split(",").map(Number);
    expect(placedAnchor[0]).toBeCloseTo(qaPositions[0]!.x - qaBounds.min_x, 6);
    expect(placedAnchor[1]).toBeCloseTo(qaPositions[0]!.z - qaBounds.min_z, 6);
    expect(placedAnchor[2]).toBeCloseTo(qaBounds.min_y - qaPositions[0]!.y, 6);
    expectNoHaloArtifacts(scene);
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
      expect(sphereRadius(group)).toBeCloseTo(11.00736, 10);
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
      // core 11.00736 m → post radius core/8 = 1.37592 m, height core*3 = 33.02208 m.
      expect(postRadius!).toBeCloseTo(1.37592, 10);
      expect(postHeight!).toBeCloseTo(33.02208, 10);
    });
  });

  it("derives the exact core radius from the horizontal map extent in metres, clamped to 6-40 m", () => {
    expect(api.radarMarkerRadii).toBeTypeOf("function");
    const radii = api.radarMarkerRadii!(qaBounds);
    // 1365 m span → clamp(1365 * 0.0168, 6, 40) = 22.932 m; core = 0.48 × 22.932 = 11.00736 m.
    expect(radii.core).toBe(0.48 * Math.min(Math.max(1365 * 0.0168, 6), 40));
    expect(radii.core).toBeCloseTo(11.00736, 10);

    // 200 m and 20 m synthetic terrains clamp to the 6 m minimum (core 2.88 m);
    // huge terrains clamp to the 40 m maximum (core 19.2 m). No giant icons on
    // small terrain.
    expect(api.radarMarkerRadii!({ min_x: 0, max_x: 200, min_y: 0, max_y: 100 }).core).toBe(6 * 0.48);
    expect(api.radarMarkerRadii!({ min_x: 0, max_x: 5000, min_y: 0, max_y: 100 }).core).toBe(40 * 0.48);
    expect(api.radarMarkerRadii!({ min_x: 0, max_x: 20, min_y: 0, max_y: 100 }).core).toBe(6 * 0.48);
  });

  it("sizes icons from horizontal spans only: elevation height never changes size, permuting X/Y spans keeps the scale", () => {
    const northSouth = { min_x: 0, max_x: 400, min_y: 0, max_y: 1000, min_z: 0, max_z: 50 };
    const deepCliff = { ...northSouth, min_z: -500, max_z: 5000 };
    expect(api.radarMarkerRadii!(deepCliff)).toEqual(api.radarMarkerRadii!(northSouth));

    const eastWest = { min_x: 0, max_x: 1000, min_y: 0, max_y: 400, min_z: 0, max_z: 50 };
    expect(api.radarMarkerRadii!(eastWest)).toEqual(api.radarMarkerRadii!(northSouth));
    // 1000 m span → 16.8 m shell; core 0.48 × 16.8 = 8.064 m.
    expect(api.radarMarkerRadii!(northSouth)!.core).toBeCloseTo(8.064, 10);
  });

  it("renders no ring/primitive/billboard halo in any marker type — only the color core and post", () => {
    activateQaTerrain();
    useAnalysisStore.setState({ activeSnapshot: qaSnapshot(), losResult });
    const snapshotRender = render(<TerrainViewer />);
    const snapshotScene = screen.getByTestId("terrain-scene");
    expect(snapshotScene.querySelectorAll('group[name^="radar-snapshot-"]')).toHaveLength(3);
    expectNoHaloArtifacts(snapshotScene);
    snapshotRender.unmount();

    useAnalysisStore.setState({
      activeSnapshot: null,
      losResult: null,
      radarPosition: qaPositions[0]!,
      history: [entry("qa-clean-core", qaPositions[1]!, qaKey)],
    });
    render(<TerrainViewer />);
    const scene = screen.getByTestId("terrain-scene");
    expect(scene.querySelector('mesh[name="radar-current-marker"]')).not.toBeNull();
    expect(scene.querySelectorAll('group[name^="radar-history-"]')).toHaveLength(1);
    expectNoHaloArtifacts(scene);
    expect((TerrainViewerApi as unknown as Record<string, unknown>)["createMarkerHalo"]).toBeUndefined();
  });
});
