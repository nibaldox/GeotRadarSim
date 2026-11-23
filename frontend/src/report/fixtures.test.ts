import { describe, expect, it } from "vitest";
import { LOSCellState } from "../types/api";
import { classifyQualityValue } from "../utils/qualityMetrics";
import { reportFixture1, reportFixture3 } from "./fixtures";

describe("fixtures del informe", () => {
  it.each([reportFixture1, reportFixture3])("usa grilla rectangular y arreglos completos", (make) => {
    const model = make();
    const { rows, cols, elevations, resolution } = model.terrain;
    expect([cols, rows, resolution]).toEqual([40, 30, 5]);
    expect(elevations).toHaveLength(rows * cols);
    expect([...elevations].filter(Number.isNaN)).toHaveLength(1);
    for (const radar of model.radars) {
      expect(radar.cellStates).toHaveLength(rows * cols);
      expect(radar.qualityValues).toHaveLength(rows * cols);
    }
    if (model.union) {
      expect(model.union.cellStates).toHaveLength(rows * cols);
      expect(model.union.visibleCount).toHaveLength(rows * cols);
      expect(model.union.qualityValues).toHaveLength(rows * cols);
    }
  });

  it("reconcilia conteos, unión y áreas celda por celda", () => {
    const model = reportFixture3();
    const union = model.union!;
    expect(model.radars).toHaveLength(3);
    const exclusive = [0, 0, 0];
    let overlap = 0;
    let visible = 0;
    for (let i = 0; i < union.visibleCount.length; i++) {
      const seen = model.radars.map((r) => r.cellStates[i] === LOSCellState.VISIBLE);
      const count = seen.filter(Boolean).length;
      expect(union.visibleCount[i]).toBe(count);
      expect(union.cellStates[i] === LOSCellState.VISIBLE).toBe(count > 0);
      if (count === 1) exclusive[seen.indexOf(true)]!++;
      if (count >= 2) overlap++;
      if (count > 0) visible++;
    }
    const cellArea = model.terrain.resolution ** 2;
    model.radars.forEach((r, i) => expect(r.exclusiveAreaM2).toBe(exclusive[i]! * cellArea));
    expect(union.overlapAreaM2).toBe(overlap * cellArea);
    expect(union.metrics.visibleAreaM2).toBe(visible * cellArea);
    expect(model.radars.reduce((sum, r) => sum + r.exclusiveAreaM2!, 0) + union.overlapAreaM2).toBe(union.metrics.visibleAreaM2);
    expect(overlap).toBeGreaterThan(0);
    expect(exclusive.every((n) => n > 0)).toBe(true);
  });

  it("incluye sombra, bandas y valores visibles sin índice", () => {
    const model = reportFixture3();
    const bands = new Set<string | null>();
    for (const radar of model.radars) {
      expect([...radar.cellStates]).toContain(LOSCellState.SHADOW);
      radar.cellStates.forEach((state, i) => {
        if (state === LOSCellState.VISIBLE) bands.add(classifyQualityValue(radar.qualityValues![i]!, model.policy));
      });
    }
    expect([...bands]).toEqual(expect.arrayContaining(["low", "medium", "high", null]));
    expect(model.aoi?.vertices).toHaveLength(4);
  });

  it("no crea unión ni área exclusiva para un radar", () => {
    const model = reportFixture1();
    expect(model.radars).toHaveLength(1);
    expect(model.union).toBeNull();
    expect(model.radars[0]!.exclusiveAreaM2).toBeNull();
  });
});
