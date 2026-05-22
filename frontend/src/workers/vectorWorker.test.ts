/**
 * Tests for the Moore-Penrose least-squares Web Worker analytical solver.
 */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

// Setup global self mock for Web Worker environment simulation in Node
const globalSelf = global as any;
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

describe("vectorWorker — Moore-Penrose Least-Squares Solver", () => {
  it("accurately reconstructs a 3D vector from noiseless multi-LOS observations", () => {
    const cellPosition = { x: 120.0, y: 80.0, z: 15.0 }; // Easting, Northing, Elev
    const trueVector: [number, number, number] = [45.0, -25.0, -8.0]; // sliding failure vector (mm)

    // Deployed 3 radars in a non-coplanar triangular geometry
    const radarPositions = [
      { x: 10.0, y: 10.0, z: 0.0 },
      { x: 250.0, y: 10.0, z: 5.0 },
      { x: 130.0, y: 220.0, z: 45.0 },
    ];

    // Compute direct projected LOS measurements (noiseless dot product)
    const radarObservations: number[] = [];
    for (const rad of radarPositions) {
      const dx = cellPosition.x - rad.x;
      const dy = cellPosition.y - rad.y;
      const dz = cellPosition.z - rad.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;

      const ux = dx / dist;
      const uy = dy / dist;
      const uz = dz / dist;

      const expectedLOS = trueVector[0] * ux + trueVector[1] * uy + trueVector[2] * uz;
      radarObservations.push(expectedLOS);
    }

    // Call worker's message handler
    globalSelf.self.onmessage({
      data: {
        type: "RECONSTRUCT",
        radarPositions,
        radarObservations,
        cellPosition,
        trueVector,
        selectedRadarIndex: 0
      }
    } as MessageEvent);

    expect(messagesSent.length).toBe(1);
    const result = messagesSent[0];

    expect(result.error).toBeUndefined();
    expect(result.reconstructedVector).not.toBeNull();
    expect(result.determinant).toBeGreaterThan(1e-4);

    // Assert noiseless reconstruction matches the physical sliding vector perfectly
    const rec = result.reconstructedVector;
    expect(rec[0]).toBeCloseTo(trueVector[0], 2);
    expect(rec[1]).toBeCloseTo(trueVector[1], 2);
    expect(rec[2]).toBeCloseTo(trueVector[2], 2);
  });

  it("safely handles and warns about singular coplanar radar layouts", () => {
    const cellPosition = { x: 100.0, y: 100.0, z: 10.0 };
    const trueVector: [number, number, number] = [30.0, -10.0, -5.0];

    // Colinear/coplanar layout: all radars lie in a single plane (z=0) and form a line
    const radarPositions = [
      { x: 0.0, y: 0.0, z: 0.0 },
      { x: 100.0, y: 100.0, z: 0.0 },
      { x: 200.0, y: 200.0, z: 0.0 },
    ];

    globalSelf.self.onmessage({
      data: {
        type: "RECONSTRUCT",
        radarPositions,
        radarObservations: [5.0, 10.0, 15.0],
        cellPosition,
        trueVector,
        selectedRadarIndex: 0
      }
    } as MessageEvent);

    expect(messagesSent.length).toBe(1);
    const result = messagesSent[0];

    // Under singularity, Moore-Penrose determinant drops to 0, yielding a null reconstructed vector
    expect(result.reconstructedVector).toBeNull();
    expect(Math.abs(result.determinant)).toBeLessThan(1e-5);
  });
});
