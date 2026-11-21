/**
 * The terrain Worker must run the DXF preflight before handing the text to dxf-parser.
 * Both modules are spied here (the preflight calls through to the real implementation), so a
 * missing or misplaced preflight shows up as a wrong call order instead of a hung suite.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DXF_56_BYTES, VALID_TERRAIN_DXF } from "../utils/dxfFixtures.testSupport";

const calls = vi.hoisted(() => [] as Array<{ step: "preflight" | "parseSync"; text: string }>);

vi.mock("../utils/dxfPreflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/dxfPreflight")>();
  return {
    ...actual,
    preflightDxf: (text: string) => {
      calls.push({ step: "preflight", text });
      return actual.preflightDxf(text);
    },
  };
});

// Only the known-valid fixture reaches the real parser: a hanging fixture that slipped past a
// broken preflight fails here immediately instead of looping forever inside the suite.
vi.mock("dxf-parser", async (importOriginal) => {
  const actual = await importOriginal<{ default: new () => { parseSync(text: string): unknown } }>();
  const { VALID_TERRAIN_DXF: valid } = await import("../utils/dxfFixtures.testSupport");
  return {
    default: class {
      parseSync(text: string): unknown {
        calls.push({ step: "parseSync", text });
        if (text !== valid) throw new Error("parseSync reached with text the test did not vouch for");
        return new actual.default().parseSync(text);
      }
    },
  };
});

let handler: (event: MessageEvent) => Promise<void>;
let posted: Array<Record<string, unknown>>;

beforeAll(async () => {
  posted = [];
  (globalThis as unknown as { self: unknown }).self = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
  };
  await import("./terrainWorker");
  handler = (globalThis as unknown as { self: { onmessage: typeof handler } }).self.onmessage;
});

beforeEach(() => {
  calls.length = 0;
  posted.length = 0;
});

async function run(text: string, filename: string, mode: "bounds" | "full" = "bounds") {
  const fileData = new TextEncoder().encode(text).buffer as ArrayBuffer;
  await handler({ data: { fileData, filename, resolution: 1, mode } } as MessageEvent);
  expect(posted).toHaveLength(1);
  return posted[0]!;
}

describe("terrainWorker — DXF preflight order", () => {
  it("runs the preflight on the decoded text before parseSync for a valid DXF", async () => {
    const result = await run(VALID_TERRAIN_DXF, "valid.dxf");

    expect(result.error).toBeUndefined();
    expect(result.pointCount).toBe(9);
    expect(calls.map((call) => call.step)).toEqual(["preflight", "parseSync"]);
    expect(calls[0]!.text).toBe(VALID_TERRAIN_DXF);
  });

  it("rejects the 56-byte DXF in the preflight and never calls parseSync", async () => {
    for (const mode of ["bounds", "full"] as const) {
      calls.length = 0;
      posted.length = 0;
      const started = performance.now();
      const result = await run(DXF_56_BYTES, "hang.dxf", mode);

      expect(performance.now() - started).toBeLessThan(100);
      expect(result.error).toMatch(/^DXF rechazado: .*POLYLINE.*SEQEND/);
      expect(calls.map((call) => call.step)).toEqual(["preflight"]);
    }
  });

  it("does not run the DXF preflight for STL files", async () => {
    const stl = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    const result = await run(stl, "surface.stl");

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
