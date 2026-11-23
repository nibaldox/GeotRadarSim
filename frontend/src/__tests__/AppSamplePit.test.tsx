/**
 * «Terreno sintético» end to end in jsdom: real store and real api, with `fetch` stubbed to serve a
 * small fixture asset (or to fail). Only the WebGL viewer is mocked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div data-testid="r3f-canvas-mock">{children}</div>,
  useThree: () => ({ camera: { position: { set: vi.fn() }, lookAt: vi.fn(), updateProjectionMatrix: vi.fn() } }),
}));
vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  GizmoHelper: ({ children }: any) => <div>{children}</div>,
  GizmoViewport: () => null,
}));
vi.mock("../components/TerrainViewer", () => ({ TerrainViewer: () => <div data-testid="terrain-viewer-mock" /> }));

import App from "../App";
import { useTerrainStore } from "../store/terrainStore";
import { useAnalysisStore } from "../store/analysisStore";
import { SAMPLE_TERRAIN_DATA_FILE, SAMPLE_TERRAIN_LOAD_ERROR, SAMPLE_TERRAIN_MANIFEST_FILE } from "../services/sampleTerrain";
import { buildSampleFixture, sampleFixtureGrid, type SampleFixture } from "../services/sampleTerrain.testSupport";

function stubFetch(fixture: SampleFixture | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!fixture) return new Response("not found", { status: 404 });
    if (url.endsWith(`samples/${SAMPLE_TERRAIN_MANIFEST_FILE}`)) return new Response(JSON.stringify(fixture.manifest));
    if (url.endsWith(`samples/${SAMPLE_TERRAIN_DATA_FILE}`)) return new Response(fixture.buffer.slice(0));
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useTerrainStore.setState({
    metadata: null, grid: null, loading: false, error: null, terrainKey: null, terrainEpoch: 0,
    preferredResolution: 1.0, uploadPreview: null, uploadPreviewLoading: false, uploadPreviewError: null,
  });
  useAnalysisStore.setState({ terrainKey: null, terrainTransitioning: false, losResult: null, history: [], error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App — «Terreno sintético» loads the sample pit", () => {
  it("explains the button in its title", () => {
    stubFetch(null);
    render(<App />);
    const button = screen.getByRole("button", { name: /terreno sintético/i });
    expect(button).toHaveAttribute("title", "Carga un rajo sintético de ejemplo (≈1,4 × 1,1 km) para probar la app");
  });

  it("loads the sample with its dimensions at max(preferred, 2) m", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(12, 17));
    const fetchMock = stubFetch(fixture);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /terreno sintético/i }));

    await waitFor(() => expect(screen.getAllByText("17 × 12 · 2 m").length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const state = useTerrainStore.getState();
    expect(state.metadata?.terrain_id).toMatch(/^sample-pit-2-import-/);
    expect(state.grid?.length).toBe(12);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the Spanish error and keeps the previous terrain when the fetch fails", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(12, 17));
    stubFetch(fixture);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /terreno sintético/i }));
    await waitFor(() => expect(screen.getAllByText("17 × 12 · 2 m").length).toBeGreaterThan(0));
    const previousKey = useTerrainStore.getState().terrainKey;

    stubFetch(null);
    fireEvent.click(screen.getByRole("button", { name: /terreno sintético/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SAMPLE_TERRAIN_LOAD_ERROR);
    expect(screen.getAllByText("17 × 12 · 2 m").length).toBeGreaterThan(0);
    expect(useTerrainStore.getState().terrainKey).toEqual(previousKey);
    expect(useAnalysisStore.getState().terrainKey).toEqual(previousKey);
    expect(screen.getByRole("button", { name: /terreno sintético/i })).not.toBeDisabled();
  });
});
