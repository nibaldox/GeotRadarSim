import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  TerrainBoundsWorkerOutput,
  TerrainWorkerInput,
  TerrainWorkerMessage,
  TerrainWorkerOutput,
} from "./terrainWorker";

type Point = [number, number, number];
type Triangle = [Point, Point, Point];

const SURFACE: Triangle[] = [
  [[0, 0, 0], [1, 0, 1], [1, 1, 3]],
  [[0, 0, 0], [1, 1, 3], [0, 1, 2]],
];

const globalSelf = globalThis as any;
const messagesSent: TerrainWorkerMessage[] = [];
let workerHandler!: (event: MessageEvent<TerrainWorkerInput>) => Promise<void>;

beforeAll(async () => {
  globalSelf.self = {
    postMessage: (message: TerrainWorkerMessage) => messagesSent.push(message),
    onmessage: null,
  };

  await import("./terrainWorker");
  workerHandler = globalSelf.self.onmessage;
});

beforeEach(() => {
  messagesSent.length = 0;
});

function encodeAscii(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function dxfDocument(entities: string): ArrayBuffer {
  return encodeAscii([
    "0", "SECTION", "2", "ENTITIES",
    entities.trim(),
    "0", "ENDSEC", "0", "EOF",
  ].join("\n"));
}

function dxfPointEntities(points: Point[]): string {
  return points.map(([x, y, z]) => [
    "0", "POINT", "10", String(x), "20", String(y), "30", String(z),
  ].join("\n")).join("\n");
}

function asciiStl(triangles: Triangle[], name = "terrain"): string {
  const lines = [`solid ${name}`];
  for (const triangle of triangles) {
    lines.push("  facet normal 0 0 1", "    outer loop");
    for (const [x, y, z] of triangle) {
      lines.push(`      vertex ${x} ${y} ${z}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return lines.join("\n");
}

function binaryStl(triangles: Triangle[], header = "solid binary surface"): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const headerBytes = new TextEncoder().encode(header).subarray(0, 80);
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);

  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    const triangleOffset = 84 + index * 50;
    // The normal is followed by the three vertices and a 2-byte attribute count.
    for (let vertexIndex = 0; vertexIndex < triangle.length; vertexIndex++) {
      const vertexOffset = triangleOffset + 12 + vertexIndex * 12;
      const [x, y, z] = triangle[vertexIndex]!;
      view.setFloat32(vertexOffset, x, true);
      view.setFloat32(vertexOffset + 4, y, true);
      view.setFloat32(vertexOffset + 8, z, true);
    }
  });

  return buffer;
}

async function runWorker(fileData: ArrayBuffer, resolution = 1, filename = "surface.stl"): Promise<TerrainWorkerOutput> {
  const message = await runWorkerRaw(fileData, resolution, filename);
  expect(message.mode).not.toBe('bounds');
  return message as TerrainWorkerOutput;
}

async function runBoundsWorker(fileData: ArrayBuffer, filename: string): Promise<TerrainBoundsWorkerOutput | { error: string }> {
  const message = await runWorkerRaw(fileData, 1, filename, 'bounds');
  // Bounds mode can also surface a parse error (e.g. an empty STL). Return
  // whatever the worker posted and let the test branch on shape.
  return message as TerrainBoundsWorkerOutput | { error: string };
}

async function runWorkerRaw(
  fileData: ArrayBuffer,
  resolution: number,
  filename: string,
  mode: 'full' | 'bounds' = 'full',
): Promise<TerrainWorkerMessage> {
  messagesSent.length = 0;
  await workerHandler({
    data: { fileData, filename, resolution, mode },
  } as MessageEvent<TerrainWorkerInput>);

  expect(messagesSent).toHaveLength(1);
  return messagesSent[0]!;
}

describe("terrainWorker — STL parsing", () => {
  it("produces the same coordinate bounds and relief from equivalent ASCII and binary surfaces", async () => {
    const asciiResult = await runWorker(encodeAscii(asciiStl(SURFACE)));
    // A binary STL may legally use a header that begins with the word 'solid'.
    const binaryResult = await runWorker(binaryStl(SURFACE, "solid binary surface"));

    expect(asciiResult.error).toBeUndefined();
    expect(binaryResult.error).toBeUndefined();
    expect(asciiResult.metadata).toEqual(binaryResult.metadata);
    expect(asciiResult.grid).toEqual(binaryResult.grid);
    expect(asciiResult.metadata?.bounds).toEqual({
      min_x: 0,
      min_y: 0,
      min_z: 0,
      max_x: 1,
      max_y: 1,
      max_z: 3,
    });
    expect(asciiResult.metadata?.grid_rows).toBe(2);
    expect(asciiResult.metadata?.grid_cols).toBe(2);

    const grid = asciiResult.grid!;
    expect(grid[0]![0]).toBeCloseTo(0, 1);
    expect(grid[0]![1]).toBeCloseTo(1, 1);
    expect(grid[1]![0]).toBeCloseTo(2, 1);
    expect(grid[1]![1]).toBeCloseTo(3, 1);
  });

  it("keeps a flat STL grid anchored to its non-zero geographic origin at 2 m resolution", async () => {
    const flatSurface: Triangle[] = [
      [[100, 200, 7], [104, 200, 7], [104, 204, 7]],
      [[100, 200, 7], [104, 204, 7], [100, 204, 7]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(flatSurface)), 2);

    expect(result.error).toBeUndefined();
    expect(result.metadata?.bounds).toEqual({
      min_x: 100,
      min_y: 200,
      min_z: 7,
      max_x: 104,
      max_y: 204,
      max_z: 7,
    });
    expect(result.metadata?.grid_rows).toBe(3);
    expect(result.metadata?.grid_cols).toBe(3);
    expect(result.grid).toHaveLength(3);
    for (const row of result.grid!) {
      expect(row).toHaveLength(3);
      for (const elevation of row) expect(elevation).toBeCloseTo(7, 6);
    }
  });

  it("accepts ASCII STL with CRLF, blank lines, tabs, indentation, and unnamed solid markers", async () => {
    const asciiVariant = [
      "solid",
      "",
      "\tfacet   normal\t0 0 1",
      "  outer\tloop",
      "    vertex 0 0 0",
      "    vertex 1 0 1",
      "    vertex 1 1 3",
      "  endloop",
      "  endfacet",
      "",
      "facet normal 0 0 1",
      "outer loop",
      "vertex 0 0 0",
      "vertex 1 1 3",
      "vertex 0 1 2",
      "endloop",
      "endfacet",
      "endsolid",
    ].join("\r\n");

    const result = await runWorker(encodeAscii(asciiVariant));

    expect(result.error).toBeUndefined();
    expect(result.metadata?.bounds).toEqual({
      min_x: 0,
      min_y: 0,
      min_z: 0,
      max_x: 1,
      max_y: 1,
      max_z: 3,
    });
    expect(result.grid).toHaveLength(2);
    expect(result.grid?.[1]?.[1]).toBeCloseTo(3, 1);
  });

  it("rejects truncated ASCII STL instead of interpolating a partial surface", async () => {
    const truncated = [
      "solid incomplete",
      "facet normal 0 0 1",
      "outer loop",
      "vertex 0 0 0",
      "vertex 1 0 1",
      "vertex 1 1 3",
      "endloop",
    ].join("\n");

    const result = await runWorker(encodeAscii(truncated));

    expect(result.error).toMatch(/invalid ASCII STL/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects a binary STL whose declared triangles extend past the buffer", async () => {
    const truncatedBinary = binaryStl(SURFACE).slice(0, 84 + 50);

    const result = await runWorker(truncatedBinary);

    expect(result.error).toMatch(/truncated|length|invalid/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects malformed ASCII coordinates instead of producing a terrain grid", async () => {
    const malformed = asciiStl(SURFACE).replace("vertex 0 0 0", "vertex 0 NaN 0");

    const result = await runWorker(encodeAscii(malformed));

    expect(result.error).toMatch(/invalid ASCII STL/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects non-positive resolution before allocating a grid", async () => {
    const result = await runWorker(encodeAscii(asciiStl(SURFACE)), 0);

    expect(result.error).toMatch(/resolution/i);
    expect(result.grid).toBeUndefined();
  });

  it("reports the last sampled STL node as its bounds maximum for a non-divisible span", async () => {
    const wideSurface: Triangle[] = [
      [[0, 0, 0], [200, 0, 1], [0, 200, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(wideSurface)), 3);

    expect(result.error).toBeUndefined();
    expect(result.metadata?.grid_rows).toBe(67);
    expect(result.metadata?.grid_cols).toBe(67);
    expect(result.metadata?.bounds).toMatchObject({ min_x: 0, min_y: 0, max_x: 198, max_y: 198 });
  });

  it("keeps decimal near-divisible bounds aligned to the regular grid within one ULP", async () => {
    const decimalSurface: Triangle[] = [
      [[0, 0, 0], [0.3, 0, 1], [0, 0.3, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(decimalSurface)), 0.1);

    expect(result.error).toBeUndefined();
    expect(result.metadata?.grid_rows).toBe(4);
    expect(result.metadata?.grid_cols).toBe(4);
    const { max_x: maxX, max_y: maxY } = result.metadata!.bounds;
    // min + index * resolution is the actual last node; decimal 0.3 rounds one ULP upward.
    expect(maxX).toBe(0 + (result.metadata!.grid_cols - 1) * 0.1);
    expect(maxY).toBe(0 + (result.metadata!.grid_rows - 1) * 0.1);
    expect(maxX).toBe(0.30000000000000004);
    expect(maxY).toBe(0.30000000000000004);
    expect(maxX - 0.3).toBeLessThanOrEqual(Number.EPSILON * 0.3);
    expect(maxY - 0.3).toBeLessThanOrEqual(Number.EPSILON * 0.3);
    expect(maxX * maxY - 0.3 * 0.3).toBeLessThanOrEqual(2 * Number.EPSILON * 0.3 * 0.3);
    expect(result.grid?.[3]).toHaveLength(4);
  });

  it("recovers a near-divisible ASCII STL endpoint at a large shifted origin", async () => {
    const shiftedSurface: Triangle[] = [
      [[500_000, -500_000.3, 0], [500_000.3, -500_000.3, 1], [500_000, -500_000, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(shiftedSurface)), 0.1);

    expect(result.error).toBeUndefined();
    expect(result.metadata?.grid_rows).toBe(4);
    expect(result.metadata?.grid_cols).toBe(4);
    expect(result.metadata?.bounds.max_x).toBe(500_000 + 3 * 0.1);
    expect(result.metadata?.bounds.max_y).toBe(-500_000.3 + 3 * 0.1);
    expect(result.grid).toHaveLength(4);
    expect(result.grid?.every((row) => row.length === 4)).toBe(true);
  });

  it("does not include a candidate endpoint when a billion-scale origin loses too much local precision", async () => {
    const shiftedSurface: Triangle[] = [
      [[1_000_000_000, 1_000_000_000, 0], [1_000_000_000.3, 1_000_000_000, 1], [1_000_000_000, 1_000_000_000.3, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(shiftedSurface)), 0.1);

    expect(result.error).toBeUndefined();
    expect(result.metadata?.grid_rows).toBe(3);
    expect(result.metadata?.grid_cols).toBe(3);
    expect(result.metadata?.bounds.max_x).toBe(1_000_000_000 + 2 * 0.1);
    expect(result.metadata?.bounds.max_y).toBe(1_000_000_000 + 2 * 0.1);
  });

  it("rejects imported terrain whose extent is smaller than one grid interval", async () => {
    const narrowSurface: Triangle[] = [
      [[0, 0, 0], [2, 0, 1], [0, 4, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(narrowSurface)), 3);

    expect(result.error).toMatch(/at least 2.*nodes|one resolution/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects a positive subnormal resolution whose squared cell area underflows", async () => {
    const degenerateSurface: Triangle[] = [
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    ];
    const result = await runWorker(encodeAscii(asciiStl(degenerateSurface)), Number.MIN_VALUE);

    expect(result.error).toMatch(/resolution.*area|area.*resolution/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects a finite resolution whose squared cell area overflows", async () => {
    const degenerateSurface: Triangle[] = [
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    ];
    const result = await runWorker(encodeAscii(asciiStl(degenerateSurface)), 1e200);

    expect(result.error).toMatch(/resolution.*area|area.*resolution/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects an import grid whose single axis exceeds the shared LOS-safe limit", async () => {
    const wideSurface: Triangle[] = [
      [[0, 0, 0], [16_384, 0, 1], [0, 1, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(wideSurface, "axis-limit")));

    expect(result.error).toMatch(/terrain grid dimension.*16,384|dimension.*16,384/i);
    expect(result.grid).toBeUndefined();
  });

  it("rejects bounds that would allocate a grid beyond the worker limit", async () => {
    const wideSurface: Triangle[] = [
      [[0, 0, 0], [2048, 0, 1], [0, 2048, 2]],
    ];

    const result = await runWorker(encodeAscii(asciiStl(wideSurface, "wide")));

    expect(result.error).toMatch(/grid exceeds the maximum size/i);
    expect(result.grid).toBeUndefined();
  });
});

describe("terrainWorker — DXF parsing", () => {
  it("imports POINT positions produced by the real dxf-parser", async () => {
    const dxf = dxfDocument(`
0
POINT
10
100
20
200
30
10
0
POINT
10
102
20
200
30
11
0
POINT
10
102
20
202
30
13
0
POINT
10
100
20
202
30
12
`);

    const result = await runWorker(dxf, 1, "points.dxf");

    expect(result.error).toBeUndefined();
    expect(result.metadata?.bounds).toEqual({
      min_x: 100,
      min_y: 200,
      min_z: 10,
      max_x: 102,
      max_y: 202,
      max_z: 13,
    });
    expect(result.grid).toHaveLength(3);
    expect(result.grid?.[0]).toHaveLength(3);
    expect(result.grid?.[0]?.[0]).toBeCloseTo(10, 1);
    expect(result.grid?.[2]?.[2]).toBeCloseTo(13, 1);
  });

  it("includes a near-divisible positive DXF endpoint when coordinates are shifted by 500,000", async () => {
    const points: Point[] = [
      [500_000, 500_000, 1],
      [500_000.3, 500_000, 2],
      [500_000.3, 500_000.3, 3],
      [500_000, 500_000.3, 4],
    ];

    const result = await runWorker(dxfDocument(dxfPointEntities(points)), 0.1, "shifted-positive.dxf");

    expect(result.error).toBeUndefined();
    expect(result.metadata?.grid_rows).toBe(4);
    expect(result.metadata?.grid_cols).toBe(4);
    expect(result.metadata?.bounds.max_x).toBe(500_000 + 3 * 0.1);
    expect(result.metadata?.bounds.max_y).toBe(500_000 + 3 * 0.1);
    expect(result.grid).toHaveLength(4);
    expect(result.grid?.every((row) => row.length === 4)).toBe(true);
  });

  it("includes a near-divisible negative DXF endpoint when coordinates are shifted by 500,000", async () => {
    const points: Point[] = [
      [-500_000.3, -500_000.3, 1],
      [-500_000, -500_000.3, 2],
      [-500_000, -500_000, 3],
      [-500_000.3, -500_000, 4],
    ];

    const result = await runWorker(dxfDocument(dxfPointEntities(points)), 0.1, "shifted-negative.dxf");

    expect(result.error).toBeUndefined();
    expect(result.metadata?.grid_rows).toBe(4);
    expect(result.metadata?.grid_cols).toBe(4);
    expect(result.metadata?.bounds.max_x).toBe(-500_000.3 + 3 * 0.1);
    expect(result.metadata?.bounds.max_y).toBe(-500_000.3 + 3 * 0.1);
    expect(result.grid).toHaveLength(4);
    expect(result.grid?.every((row) => row.length === 4)).toBe(true);
  });

  it("uses an LWPOLYLINE entity elevation when its vertices omit Z", async () => {
    const dxf = dxfDocument(`
0
LWPOLYLINE
90
4
70
0
38
7.5
10
100
20
200
10
102
20
200
10
102
20
202
10
100
20
202
`);

    const result = await runWorker(dxf, 1, "elevation.dxf");

    expect(result.error).toBeUndefined();
    expect(result.metadata?.bounds).toEqual({
      min_x: 100,
      min_y: 200,
      min_z: 7.5,
      max_x: 102,
      max_y: 202,
      max_z: 7.5,
    });
    for (const row of result.grid!) {
      for (const elevation of row) expect(elevation).toBeCloseTo(7.5, 6);
    }
  });

  it("prefers explicit LWPOLYLINE vertex Z, including zero, over entity elevation", async () => {
    const dxf = dxfDocument(`
0
LWPOLYLINE
90
4
70
0
38
7.5
10
100
20
200
30
0
10
102
20
200
30
9
10
102
20
202
10
100
20
202
`);

    const result = await runWorker(dxf, 1, "mixed-elevation.dxf");

    expect(result.error).toBeUndefined();
    expect(result.metadata?.bounds.min_z).toBe(0);
    expect(result.metadata?.bounds.max_z).toBe(9);
    expect(result.grid?.[0]?.[0]).toBeCloseTo(0, 1);
    expect(result.grid?.[0]?.[2]).toBeCloseTo(9, 1);
    expect(result.grid?.[2]?.[2]).toBeCloseTo(7.5, 1);
  });

  it("rejects missing or non-finite Z instead of inventing zero and leaves later STL IDW intact", async () => {
    const missingZ = dxfDocument(`
0
POINT
10
0
20
0
`);
    const malformedResult = await runWorker(missingZ, 1, "missing-z.dxf");

    expect(malformedResult.error).toMatch(/invalid DXF.*Z elevation/i);
    expect(malformedResult.grid).toBeUndefined();

    const nonFiniteZ = dxfDocument(`
0
LWPOLYLINE
90
1
70
0
38
5
10
0
20
0
30
NaN
`);
    const nonFiniteResult = await runWorker(nonFiniteZ, 1, "non-finite-z.dxf");

    expect(nonFiniteResult.error).toMatch(/invalid DXF.*finite/i);
    expect(nonFiniteResult.grid).toBeUndefined();

    const asciiResult = await runWorker(encodeAscii(asciiStl(SURFACE)));
    const binaryResult = await runWorker(binaryStl(SURFACE));

    expect(asciiResult.error).toBeUndefined();
    expect(binaryResult.error).toBeUndefined();
    expect(asciiResult.metadata).toEqual(binaryResult.metadata);
    expect(asciiResult.grid).toEqual(binaryResult.grid);
  });
});

describe("terrainWorker — bounds preview mode", () => {
  it("returns the X/Y/Z envelope of an ASCII STL without allocating a grid", async () => {
    const result = await runBoundsWorker(encodeAscii(asciiStl(SURFACE)), "preview-ascii.stl");
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);

    expect(result.source).toBe("STL");
    // SURFACE has 2 triangles, 3 vertices each = 6 points (step=1 in scanAsciiSTL).
    expect(result.pointCount).toBe(6);
    expect(result.bbox).toEqual({ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 3 });
    expect(result.span).toEqual({ x: 1, y: 1, z: 3 });
    expect(result.mode).toBe("bounds");
  });

  it("matches the bounding box from binary STL preview to the ASCII preview of the same surface", async () => {
    const asciiResult = await runBoundsWorker(encodeAscii(asciiStl(SURFACE)), "preview-ascii.stl");
    const binaryResult = await runBoundsWorker(binaryStl(SURFACE, "solid binary surface"), "preview-binary.stl");
    if ('error' in asciiResult) throw new Error(`unexpected error: ${asciiResult.error}`);
    if ('error' in binaryResult) throw new Error(`unexpected error: ${binaryResult.error}`);

    expect(asciiResult.bbox).toEqual(binaryResult.bbox);
    expect(asciiResult.span).toEqual(binaryResult.span);
    expect(asciiResult.pointCount).toBe(binaryResult.pointCount);
  });

  it("reads bounds from a DXF POINT cloud and tags the source as DXF", async () => {
    const dxf = dxfDocument(dxfPointEntities([
      [10, 20, 5],
      [-5, 30, 15],
      [12, 0, -3],
    ]));
    const result = await runBoundsWorker(dxf, "preview.dxf");
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`);

    expect(result.source).toBe("DXF");
    expect(result.pointCount).toBe(3);
    expect(result.bbox).toEqual({
      minX: -5, maxX: 12,
      minY: 0, maxY: 30,
      minZ: -3, maxZ: 15,
    });
    expect(result.span).toEqual({ x: 17, y: 30, z: 18 });
  });

  it("propagates empty-file errors back as a single { error } message", async () => {
    // An STL that has no usable points must surface the parse error rather than
    // returning an "empty" bounds envelope, which would mislead the upload UI.
    // Empty file: 0 triangles, no vertices.
    const result = await runBoundsWorker(encodeAscii("solid empty\nendsolid empty\n"), "empty.stl");
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/no facets found/i);
  });

  it("does not allocate a grid or DTM metadata in bounds mode", async () => {
    const result = await runBoundsWorker(encodeAscii(asciiStl(SURFACE)), "preview.stl");
    // Bounds-mode messages must not carry full-mode fields; tests for the upload
    // path rely on this contract to short-circuit UI suggestions.
    const fullOnly = result as TerrainWorkerOutput;
    expect(fullOnly.grid).toBeUndefined();
    expect(fullOnly.metadata).toBeUndefined();
  });
});
