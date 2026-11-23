import { describe, expect, it } from "vitest";
import { factoryAzimuthSector } from "./radarSector";

const base = { scan_pattern: "RAR" as const };

describe("factoryAzimuthSector", () => {
  it("returns the SSR-FX factory sector −75..+75 as 150° centred at 0°", () => {
    expect(factoryAzimuthSector({ ...base, azimuth_range_deg: [-75, 75] })).toEqual({ centerDeg: 0, widthDeg: 150 });
  });

  it("handles sectors that wrap across ±180°", () => {
    expect(factoryAzimuthSector({ ...base, azimuth_range_deg: [150, -170] })).toEqual({ centerDeg: 170, widthDeg: 40 });
    expect(factoryAzimuthSector({ ...base, azimuth_range_deg: [170, -150] })).toEqual({ centerDeg: -170, widthDeg: 40 });
  });

  it("treats a null range or the SAR360 scan pattern as the full circle, like the LOS Worker", () => {
    expect(factoryAzimuthSector({ ...base, azimuth_range_deg: null })).toEqual({ centerDeg: null, widthDeg: 360 });
    expect(factoryAzimuthSector({ scan_pattern: "SAR360", azimuth_range_deg: [-75, 75] })).toEqual({ centerDeg: null, widthDeg: 360 });
    expect(factoryAzimuthSector({ ...base, azimuth_range_deg: undefined as unknown as null })).toEqual({ centerDeg: null, widthDeg: 360 });
  });

  it("keeps a declared −180..+180 range as a 360° sector centred at 0°", () => {
    expect(factoryAzimuthSector({ ...base, azimuth_range_deg: [-180, 180] })).toEqual({ centerDeg: 0, widthDeg: 360 });
  });
});
