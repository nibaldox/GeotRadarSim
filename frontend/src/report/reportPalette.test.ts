import { describe, expect, it } from "vitest";
import { reportBandColors } from "./reportPalette";

const sources = import.meta.glob("../components/ShadowOverlay.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("report palette", () => {
  it("tracks the source shader's palette anchors and projection stops", () => {
    const shader = Object.values(sources)[0]!;
    for (const anchor of ["vec3(0.9, 0.1, 0.1)", "vec3(1.0, 0.8, 0.0)", "vec3(0.0, 0.9, 0.2)", "vec3(0.5, 0.0, 0.5)", "vec3(0.1, 0.2, 0.8)", "vec3(0.0, 0.8, 0.8)", "q < 0.2", "q < 0.6", "(q - 0.6) / 0.4"]) expect(shader).toContain(anchor);
  });
  it("matches shader threshold precedence at degenerate endpoint bands", () => {
    expect(reportBandColors("INCIDENCE", { mediumMin: 0, highMin: 1 })).toEqual(["#f2730d", "#ffcc00", "#80d91a"]);
  });
  it("evaluates each metric at the policy band centers", () => {
    expect(reportBandColors("INCIDENCE", { mediumMin: 0.3, highMin: 0.7 })).toEqual(["#e61a1a", "#ffcc00", "#00e633"]);
    expect(reportBandColors("PROJECTION", { mediumMin: 0.4, highMin: 0.8 })).toEqual(["#1a33cc", "#00cccc", "#00df59"]);
  });
});
