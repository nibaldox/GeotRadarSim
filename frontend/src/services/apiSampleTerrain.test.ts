/**
 * api.loadSampleTerrain: fetches the bundled sample under BASE_URL, verifies it and caches it as a
 * provisional terrain exactly like an import. `fetch` is stubbed with a small fixture asset.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getTerrainGrid, loadSampleTerrain, releaseTerrain } from "./api";
import {
  SAMPLE_TERRAIN_DATA_FILE,
  SAMPLE_TERRAIN_LOAD_ERROR,
  SAMPLE_TERRAIN_MANIFEST_FILE,
} from "./sampleTerrain";
import { buildSampleFixture, sampleFixtureGrid, type SampleFixture } from "./sampleTerrain.testSupport";

function stubSampleFetch(fixture: SampleFixture, overrides: { manifestStatus?: number; dataStatus?: number; data?: ArrayBuffer } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`samples/${SAMPLE_TERRAIN_MANIFEST_FILE}`)) {
      return new Response(JSON.stringify(fixture.manifest), { status: overrides.manifestStatus ?? 200 });
    }
    if (url.endsWith(`samples/${SAMPLE_TERRAIN_DATA_FILE}`)) {
      return new Response(overrides.data ?? fixture.buffer.slice(0), { status: overrides.dataStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.loadSampleTerrain", () => {
  it("fetches both files under BASE_URL/samples/ and caches the decoded 2 m grid", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(6, 9, [[0, 0]]));
    const fetchMock = stubSampleFetch(fixture);

    const metadata = await loadSampleTerrain(2);

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual([
      `${import.meta.env.BASE_URL}samples/${SAMPLE_TERRAIN_MANIFEST_FILE}`,
      `${import.meta.env.BASE_URL}samples/${SAMPLE_TERRAIN_DATA_FILE}`,
    ]);
    expect(metadata.resolution).toBe(2);
    expect(metadata.grid_rows).toBe(6);
    expect(metadata.grid_cols).toBe(9);
    expect(metadata.bounds).toEqual(fixture.manifest.bounds);
    expect(metadata.terrain_id).toMatch(/^sample-pit-2-import-/);

    const cached = await getTerrainGrid(metadata.terrain_id);
    expect(cached.grid.length).toBe(6);
    expect(Number.isNaN(cached.grid[0]![0]!)).toBe(true);
    expect(cached.grid[3]![4]!).toBeCloseTo(sampleFixtureGrid(6, 9)[3]![4]!, 2);
    releaseTerrain(metadata.terrain_id);
  });

  it("uses the 2 m base for finer preferences", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(6, 9));
    stubSampleFetch(fixture);
    const metadata = await loadSampleTerrain(0.5);
    expect(metadata.resolution).toBe(2);
    expect(metadata.grid_cols).toBe(9);
    releaseTerrain(metadata.terrain_id);
  });

  it("resamples to coarser preferences inside the source envelope", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(21, 31));
    stubSampleFetch(fixture);
    const metadata = await loadSampleTerrain(4);
    const ext = fixture.manifest.source_extent;
    expect(metadata.resolution).toBe(4);
    expect(metadata.grid_cols).toBe(Math.floor((ext.maxX - ext.minX) / 4) + 1);
    expect(metadata.grid_rows).toBe(Math.floor((ext.maxY - ext.minY) / 4) + 1);
    const cached = await getTerrainGrid(metadata.terrain_id);
    expect(cached.grid.length).toBe(metadata.grid_rows);
    releaseTerrain(metadata.terrain_id);
  });

  it.each([
    ["the manifest request fails", { manifestStatus: 404 }],
    ["the data request fails", { dataStatus: 500 }],
    ["the data is truncated", { data: new ArrayBuffer(10) }],
  ])("rejects with the Spanish message when %s", async (_label, overrides) => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(6, 9));
    stubSampleFetch(fixture, overrides);
    await expect(loadSampleTerrain(2)).rejects.toThrow(SAMPLE_TERRAIN_LOAD_ERROR);
  });

  it("rejects with the Spanish message when the bytes do not match the SHA-256", async () => {
    const fixture = await buildSampleFixture(sampleFixtureGrid(6, 9));
    const tampered = fixture.buffer.slice(0);
    const view = new Uint8Array(tampered);
    view[3] = view[3]! ^ 0xff;
    stubSampleFetch(fixture, { data: tampered });
    await expect(loadSampleTerrain(2)).rejects.toThrow(SAMPLE_TERRAIN_LOAD_ERROR);
  });

  it("rejects with the Spanish message when fetch itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(loadSampleTerrain(2)).rejects.toThrow(SAMPLE_TERRAIN_LOAD_ERROR);
  });
});
