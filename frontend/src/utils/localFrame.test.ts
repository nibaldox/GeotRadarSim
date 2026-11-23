import { describe, expect, it } from "vitest";
import { localToTerrain, terrainToLocal } from "./localFrame";

describe("local terrain frame", () => {
  it("matches the App axes without applying the radar's separate 2 m offset", () => {
    const bounds = { min_x: 100, min_y: -200, min_z: 500 };
    expect(localToTerrain({ x: 6, y: 30, z: -8 }, bounds)).toEqual({ x: 106, y: -192, z: 530 });
    expect(terrainToLocal({ x: 106, y: -192, z: 530 }, bounds)).toEqual({ x: 6, y: 30, z: -8 });
  });

  it("round trips exactly in both directions at every node of a shifted rectangular grid", () => {
    const bounds = { min_x: -128, min_y: 256, min_z: 512 };
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 13; col++) {
        const point = { x: bounds.min_x + col * 2, y: bounds.min_y + row * 2, z: bounds.min_z + (row * 13 + col) * 2 };
        const local = terrainToLocal(point, bounds);
        expect(localToTerrain(local, bounds)).toEqual(point);
        expect(terrainToLocal(localToTerrain(local, bounds), bounds)).toEqual(local);
      }
    }
  });
});
