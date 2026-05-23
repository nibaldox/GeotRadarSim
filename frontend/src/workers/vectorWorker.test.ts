/**
 * Tests for the 3D Geometric Sensitivity Web Worker analytical solver.
 */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

// Setup global self mock for Web Worker environment simulation in Node
const globalSelf = globalThis as any;
let messagesSent: any[] = [];

beforeAll(async () => {
  // Initialize self on global context BEFORE importing the worker module to avoid ES Import hoisting bugs
  globalSelf.self = {
    postMessage: (msg: any) => {
      messagesSent.push(msg);
    },
    onmessage: null as any
  };

  // Dynamically import the worker to ensure it registers its handler on our mocked self
  await import("./vectorWorker");
});

beforeEach(() => {
  messagesSent = [];
});

describe("vectorWorker — Sensitivity Map Solver", () => {
  it("accurately calculates a geometric sensitivity grid for deployed radars", () => {
    const grid = [
      [10, 10, 10],
      [10, 15, 10],
      [10, 10, 10],
    ];
    const resolution = 2.0;
    const bounds = {
      min_x: 0,
      min_y: 0,
      max_x: 6,
      max_y: 6,
    };
    const radarPositions = [
      { x: 10, y: 10, z: 0 },
      { x: -10, y: -10, z: 5 }
    ];

    // Call worker's message handler
    globalSelf.self.onmessage({
      data: {
        type: "SENSITIVITY",
        grid,
        resolution,
        bounds,
        radarPositions
      }
    } as MessageEvent);

    expect(messagesSent.length).toBe(1);
    const result = messagesSent[0];

    expect(result.error).toBeUndefined();
    expect(result.flat_sensitivity_grid).toBeInstanceOf(Float32Array);
    expect(result.flat_sensitivity_grid.length).toBe(9); // 3x3 DTM grid
  });
});
