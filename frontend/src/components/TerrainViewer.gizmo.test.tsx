/** The axis gizmo must name the terrain direction each scene axis really points to. */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TerrainViewer } from "./TerrainViewer";
import { useAnalysisStore } from "../store/analysisStore";
import { useTerrainStore } from "../store/terrainStore";

const gizmoLabels: unknown[] = [];

vi.mock("@react-three/fiber", async () => {
  const React = await import("react");
  return {
    Canvas: ({ children }: { children: import("react").ReactNode }) => React.createElement("div", null, children),
    useThree: () => ({ camera: { position: { set: () => undefined }, up: { set: () => undefined }, lookAt: () => undefined, updateProjectionMatrix: () => undefined } }),
  };
});

vi.mock("@react-three/drei", async () => {
  const React = await import("react");
  return {
    OrbitControls: () => null,
    GizmoHelper: ({ children }: { children: import("react").ReactNode }) => React.createElement(React.Fragment, null, children),
    GizmoViewport: (props: { labels?: unknown }) => { gizmoLabels.push(props.labels); return null; },
  };
});

describe("viewer axis gizmo", () => {
  it("labels +X as East, +Y as elevation (Z) and +Z as South, because North is −Z in the scene", () => {
    const grid = [[0, 0], [0, 0]];
    useAnalysisStore.setState({ terrainKey: { terrain_id: "t", epoch: 1 }, terrainTransitioning: false });
    useTerrainStore.setState({
      grid,
      metadata: { terrain_id: "t", bounds: { min_x: 0, min_y: 0, max_x: 1, max_y: 1, min_z: 0, max_z: 0 }, resolution: 1, grid_rows: 2, grid_cols: 2 },
      terrainKey: { terrain_id: "t", epoch: 1 },
      terrainEpoch: 1,
    });
    render(<TerrainViewer />);
    expect(gizmoLabels.length).toBeGreaterThan(0);
    expect(gizmoLabels[gizmoLabels.length - 1]).toEqual(["E", "Z", "S"]);
  });
});
