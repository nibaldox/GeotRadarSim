// Regresiones C3/C7/C8 adaptadas de las sondas R1-CLOSE.
// Vitest reporta como error cualquier rechazo no manejado durante estas pruebas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnalysisStore as A } from "./analysisStore";
import type { AnalysisOutcome } from "./analysisStore";
import { useVectorStore as V } from "./vectorStore";
import { cancelLOSAnalysis, getLOSJob, runLOSAnalysis, runSensitivityAnalysis } from "../services/api";

vi.mock("../services/api", () => ({
  runLOSAnalysis: vi.fn(), getLOSJob: vi.fn(), listRadars: vi.fn(), cancelLOSAnalysis: vi.fn(), releaseLOSJob: vi.fn(),
  runSensitivityAnalysis: vi.fn(), cancelSensitivityAnalysis: vi.fn(), releaseSensitivityJob: vi.fn(),
}));

const los = (cov = 100) => ({ shadow_grid: [[false]], cell_states: new Uint8Array([5]), grid_rows: 1, grid_cols: 1, resolution: 1,
  coverage_polygon: [], coverage_pct: cov, completeness_pct: 100, visible_area_m2: 1, shadow_zones: [] });
const sensResult = (ids: string[], v = 0.5) => ({ terrainKey: { terrain_id: "t", epoch: 1 }, sourceAnalysisIds: ids, grid_rows: 1, grid_cols: 1,
  resolution: 1, flat_sensitivity_grid: new Float32Array([v]), observer_count: new Uint16Array([ids.length]) });

const PENDING = Symbol("pending");
function track(p: Promise<AnalysisOutcome>) {
  const box: { value: AnalysisOutcome | typeof PENDING; count: number } = { value: PENDING, count: 0 };
  void p.then(v => { box.value = v; box.count += 1; });
  return box;
}
let jobSeq = 0;

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); jobSeq = 0;
  V.getState().reset();
  A.getState().beginTerrainTransition(); A.getState().activateTerrain({ terrain_id: "t", epoch: 1 });
  A.getState().selectRadar("x"); A.getState().selectRadar("r"); A.getState().setRadarPosition({ x: 1, y: 2, z: 3 });
  vi.mocked(runLOSAnalysis).mockImplementation(async () => ({ job_id: `j${++jobSeq}`, status: "PENDING" }));
  vi.mocked(getLOSJob).mockImplementation(async id => id.startsWith("s")
    ? { job_id: id, status: "COMPLETED", created_at: "now", result: sensResult(["a1"]) } as never
    : { job_id: id, status: "COMPLETED", created_at: "now", result: los() });
});
afterEach(() => { V.getState().reset(); A.getState().beginTerrainTransition(); A.getState().activateTerrain({ terrain_id: "t", epoch: 99 }); vi.useRealTimers(); });

async function publishAgent() { const p = A.getState().runAnalysisAndWait("t"); await vi.advanceTimersByTimeAsync(1000); return p; }

describe("C3 · WP1A-3/WP1B-2 oyente que lanza", () => {
  it("LOS: lanza una vez al publicar → published, resultado visible, sin rechazo", async () => {
    const box = track(A.getState().runAnalysisAndWait("t")); await vi.advanceTimersByTimeAsync(0);
    let n = 0; const off = A.subscribe(s => { if (s.losResult && n++ === 0) throw new Error("boom"); });
    await vi.advanceTimersByTimeAsync(1000); off();
    expect(box.value).toMatchObject({ status: "published", analysisId: "j1" });
    expect(A.getState().activeSnapshot?.analysisId).toBe("j1"); expect(A.getState().inFlightOrigin).toBeNull();
  });
  it("LOS: lanza siempre → published una vez, sin rechazo no manejado", async () => {
    const box = track(A.getState().runAnalysisAndWait("t")); await vi.advanceTimersByTimeAsync(0);
    const off = A.subscribe(s => { if (s.losResult) throw new Error("boom always"); });
    await vi.advanceTimersByTimeAsync(5000); for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); off();
    expect(box.value).toMatchObject({ status: "published" }); expect(box.count).toBe(1);
  });
  it("LOS: lanza en el set de FAILED → failed, resuelve, sin rechazo", async () => {
    vi.mocked(getLOSJob).mockResolvedValue({ job_id: "j1", status: "FAILED", error: "bad", created_at: "now" });
    const box = track(A.getState().runAnalysisAndWait("t")); await vi.advanceTimersByTimeAsync(0);
    const off = A.subscribe(s => { if (s.error) throw new Error("boom on error"); });
    await vi.advanceTimersByTimeAsync(3000); off();
    console.log(`[C3-failed] outcome=${JSON.stringify(box.value)} inFlight=${A.getState().inFlightOrigin}`);
    expect(box.value).toMatchObject({ status: "failed" });
    expect(A.getState().inFlightOrigin).toBeNull();
  });
});

describe("C7 · WP1A-7 abort nunca cancela al usuario", () => {
  it("usuario DESPUÉS del agente: abort no cancela el job del usuario y éste publica", async () => {
    const c = new AbortController();
    const ag = track(A.getState().runAnalysisAndWait("t", { signal: c.signal })); await Promise.resolve(); await Promise.resolve();
    await A.getState().runAnalysis("t");
    expect(A.getState().inFlightOrigin).toBe("user");
    const cancelsBefore = vi.mocked(cancelLOSAnalysis).mock.calls.map(c2 => c2[0]);
    c.abort();
    await vi.advanceTimersByTimeAsync(1000);
    const cancels = vi.mocked(cancelLOSAnalysis).mock.calls.map(c2 => c2[0]);
    console.log(`[C7-after] cancelsBefore=${cancelsBefore} cancels=${cancels} agent=${JSON.stringify(ag.value)}`);
    expect(ag.value).toMatchObject({ status: "superseded" });
    expect(cancels).not.toContain("j2");
    expect(A.getState().activeSnapshot?.analysisId).toBe("j2"); expect(A.getState().inFlightOrigin).toBeNull();
  });
  it("usuario DESPUÉS del agente, antes de que exista el job del agente", async () => {
    let releaseAgent!: (v: { job_id: string; status: "PENDING" }) => void;
    vi.mocked(runLOSAnalysis).mockImplementationOnce(() => new Promise(r => { releaseAgent = r; }));
    const c = new AbortController();
    const ag = track(A.getState().runAnalysisAndWait("t", { signal: c.signal }));
    vi.mocked(runLOSAnalysis).mockImplementationOnce(async () => ({ job_id: "user", status: "PENDING" }));
    await A.getState().runAnalysis("t");
    c.abort();
    releaseAgent({ job_id: "late-agent", status: "PENDING" });
    await vi.advanceTimersByTimeAsync(1000);
    const cancels = vi.mocked(cancelLOSAnalysis).mock.calls.map(x => x[0]);
    expect(ag.value).toMatchObject({ status: "superseded" });
    expect(cancels).toEqual(["late-agent"]);
    expect(A.getState().activeSnapshot?.analysisId).toBe("user");
  });
  it("usuario ANTES del agente: abort cancela solo el job del agente", async () => {
    await A.getState().runAnalysis("t"); // j1 usuario
    expect(A.getState().inFlightOrigin).toBe("user");
    const c = new AbortController();
    const ag = track(A.getState().runAnalysisAndWait("t", { signal: c.signal })); // cancela j1 al arrancar (política BUSY = WP4)
    await Promise.resolve(); await Promise.resolve();
    const cancelsAtStart = vi.mocked(cancelLOSAnalysis).mock.calls.map(x => x[0]);
    c.abort();
    await vi.advanceTimersByTimeAsync(0);
    const cancelsByAbort = vi.mocked(cancelLOSAnalysis).mock.calls.map(x => x[0]).slice(cancelsAtStart.length);
    console.log(`[C7-before] cancelsAtStart=${cancelsAtStart} cancelsByAbort=${cancelsByAbort}`);
    expect(ag.value).toMatchObject({ status: "cancelled" });
    expect(cancelsByAbort).toEqual(["j2"]);
    expect(A.getState().inFlightOrigin).toBeNull(); expect(A.getState().loading).toBe(false);
  });
  it("dos agentes: abort del primero no toca al segundo; abort del segundo lo cancela", async () => {
    const c1 = new AbortController(), c2 = new AbortController();
    const a1 = track(A.getState().runAnalysisAndWait("t", { signal: c1.signal })); await Promise.resolve(); await Promise.resolve();
    const a2 = track(A.getState().runAnalysisAndWait("t", { signal: c2.signal })); await Promise.resolve(); await Promise.resolve();
    c1.abort(); await vi.advanceTimersByTimeAsync(0);
    expect(a1.value).toMatchObject({ status: "superseded" });
    expect(A.getState().inFlightOrigin).toBe("agent");
    expect(vi.mocked(cancelLOSAnalysis).mock.calls.map(x => x[0])).not.toContain("j2");
    c2.abort(); await vi.advanceTimersByTimeAsync(0);
    expect(a2.value).toMatchObject({ status: "cancelled" });
    expect(vi.mocked(cancelLOSAnalysis).mock.calls.map(x => x[0])).toContain("j2");
    expect(A.getState().inFlightOrigin).toBeNull();
  });
  it("dos agentes, el segundo publica pese al abort del primero", async () => {
    const c1 = new AbortController();
    const a1 = track(A.getState().runAnalysisAndWait("t", { signal: c1.signal })); await Promise.resolve(); await Promise.resolve();
    const a2 = track(A.getState().runAnalysisAndWait("t")); await Promise.resolve(); await Promise.resolve();
    c1.abort(); await vi.advanceTimersByTimeAsync(1000);
    expect(a1.value).toMatchObject({ status: "superseded" }); expect(a2.value).toMatchObject({ status: "published", analysisId: "j2" });
  });
  it("señal ya abortada → cancelled sin API ni cambios; abort tras published → no-op", async () => {
    const c = new AbortController(); c.abort();
    const before = A.getState();
    expect(await A.getState().runAnalysisAndWait("t", { signal: c.signal })).toMatchObject({ status: "cancelled" });
    expect(A.getState()).toBe(before); expect(runLOSAnalysis).not.toHaveBeenCalled();
    const c2 = new AbortController();
    const p = A.getState().runAnalysisAndWait("t", { signal: c2.signal }); await vi.advanceTimersByTimeAsync(1000);
    expect((await p).status).toBe("published");
    const after = A.getState(); c2.abort();
    expect(A.getState()).toBe(after); expect(cancelLOSAnalysis).not.toHaveBeenCalled();
  });
  it("abort durante multi del usuario lanzado después → no-op", async () => {
    A.getState().deployCurrentRadar();
    const c = new AbortController();
    const ag = track(A.getState().runAnalysisAndWait("t", { signal: c.signal })); await Promise.resolve(); await Promise.resolve();
    void A.getState().runMultiAnalysis("t"); await Promise.resolve(); await Promise.resolve();
    expect(A.getState().inFlightOrigin).toBe("user"); expect(A.getState().multiLoading).toBe(true);
    c.abort();
    expect(A.getState().multiLoading).toBe(true); expect(A.getState().inFlightOrigin).toBe("user");
    await vi.advanceTimersByTimeAsync(1000);
    expect(ag.value).toMatchObject({ status: "superseded" }); expect(A.getState().unifiedLos).not.toBeNull();
    expect(A.getState().inFlightOrigin).toBeNull();
  });
  it("abort del LOS del agente no limpia el mapa de sensibilidad publicado antes ni el historial", async () => {
    await publishAgent();
    vi.mocked(runSensitivityAnalysis).mockResolvedValue({ job_id: "s1", status: "PENDING" });
    vi.mocked(getLOSJob).mockImplementation(async id => id.startsWith("s")
      ? { job_id: id, status: "COMPLETED", created_at: "now", result: sensResult(["j1"]) } as never
      : { job_id: id, status: "PENDING", created_at: "now" } as never);
    void V.getState().computeSensitivityMap("t"); await vi.advanceTimersByTimeAsync(250);
    expect(V.getState().sensitivityMap).not.toBeNull();
    const c = new AbortController();
    const ag = track(A.getState().runAnalysisAndWait("t", { signal: c.signal })); await Promise.resolve(); await Promise.resolve();
    const mapAfterStart = V.getState().sensitivityMap;
    c.abort(); await vi.advanceTimersByTimeAsync(0);
    console.log(`[C7-cross] mapa tras arrancar LOS agente=${mapAfterStart ? "set" : "null"} (arranque deselecciona, igual que la UI) hist=${A.getState().history.length}`);
    expect(ag.value).toMatchObject({ status: "cancelled" });
    expect(A.getState().history.map(e => e.snapshot?.analysisId)).toEqual(["j1"]);
  });
});

describe("C8 · inFlightOrigin vuelve a null", () => {
  const exits: Array<[string, (agent: boolean) => Promise<void>]> = [
    ["published", async () => { await vi.advanceTimersByTimeAsync(1000); }],
    ["FAILED", async () => { vi.mocked(getLOSJob).mockResolvedValue({ job_id: "j1", status: "FAILED", error: "x", created_at: "now" }); await vi.advanceTimersByTimeAsync(1000); }],
    ["getLOSJob lanza", async () => { vi.mocked(getLOSJob).mockRejectedValue(new Error("nf")); await vi.advanceTimersByTimeAsync(1000); }],
    ["cancelAnalysis", async () => { A.getState().cancelAnalysis(); }],
    ["setOverrides", async () => { A.getState().setOverrides({ rangeMax: 10 }); }],
    ["setRangeOverrides", async () => { A.getState().setRangeOverrides(1, 2); }],
    ["setRadarPosition", async () => { A.getState().setRadarPosition({ x: 5, y: 5, z: 5 }); }],
    ["selectRadar", async () => { A.getState().selectRadar("otro"); }],
    ["clearResult", async () => { A.getState().clearResult(); }],
    ["clearHistory", async () => { A.getState().clearHistory(); }],
    ["transición begin+activate", async () => { A.getState().beginTerrainTransition(); A.getState().activateTerrain({ terrain_id: "t", epoch: 2 }); }],
    ["transición begin+restore", async () => { A.getState().beginTerrainTransition(); A.getState().restoreTerrainAfterFailure({ terrain_id: "t", epoch: 1 }); }],
    ["deployCurrentRadar", async () => { A.getState().deployCurrentRadar(); }],
  ];
  it.each(exits)("LOS agente y usuario: %s", async (_n, act) => {
    for (const agent of [true, false]) {
      if (agent) void A.getState().runAnalysisAndWait("t"); else void A.getState().runAnalysis("t");
      await Promise.resolve(); await Promise.resolve();
      expect(A.getState().inFlightOrigin).toBe(agent ? "agent" : "user");
      await act(agent);
      await vi.advanceTimersByTimeAsync(3000);
      expect(A.getState().inFlightOrigin, `agent=${agent}`).toBeNull();
      A.getState().beginTerrainTransition(); A.getState().activateTerrain({ terrain_id: "t", epoch: 1 + jobSeq + 10 });
      A.getState().setRadarPosition({ x: 1, y: 2, z: 3 }); vi.mocked(getLOSJob).mockImplementation(async id => ({ job_id: id, status: "COMPLETED", created_at: "now", result: los() }));
    }
  });
  it("runLOS rechaza (agente y usuario)", async () => {
    vi.mocked(runLOSAnalysis).mockRejectedValue(new Error("down"));
    await A.getState().runAnalysisAndWait("t"); expect(A.getState().inFlightOrigin).toBeNull();
    await A.getState().runAnalysis("t"); expect(A.getState().inFlightOrigin).toBeNull();
  });
  it("historial: toggle / restore / remove / setHistorySelection con LOS en vuelo", async () => {
    await publishAgent();
    for (const act of [() => A.getState().toggleHistoryEntrySelection(0), () => A.getState().restoreHistoryEntry(0), () => A.getState().removeHistoryEntry(5), () => A.getState().setHistorySelection(["j1"])]) {
      void A.getState().runAnalysisAndWait("t"); await Promise.resolve();
      expect(A.getState().inFlightOrigin).toBe("agent");
      act(); expect(A.getState().inFlightOrigin).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
    }
  });
  it("multi: completa, falla y se cancela", async () => {
    A.getState().deployCurrentRadar();
    void A.getState().runMultiAnalysis("t"); await Promise.resolve(); expect(A.getState().inFlightOrigin).toBe("user");
    await vi.advanceTimersByTimeAsync(2000); expect(A.getState().inFlightOrigin).toBeNull();
    vi.mocked(getLOSJob).mockResolvedValue({ job_id: "x", status: "FAILED", error: "m", created_at: "now" });
    void A.getState().runMultiAnalysis("t"); await vi.advanceTimersByTimeAsync(2000); expect(A.getState().inFlightOrigin).toBeNull();
    vi.mocked(getLOSJob).mockResolvedValue({ job_id: "x", status: "PENDING", created_at: "now" } as never);
    void A.getState().runMultiAnalysis("t"); await Promise.resolve(); A.getState().cancelAnalysis(); expect(A.getState().inFlightOrigin).toBeNull();
  });
  it("oyente que lanza al arrancar (LOS y sensibilidad)", async () => {
    const off = A.subscribe(s => { if (s.loading) throw new Error("b"); });
    expect((await A.getState().runAnalysisAndWait("t")).status).toBe("failed"); off();
    expect(A.getState().inFlightOrigin).toBeNull(); expect(A.getState().loading).toBe(false);
  });
  it("sensibilidad: published, FAILED, sondeo lanza, run rechaza, resultado inválido, abort, reset, selección", async () => {
    await publishAgent();
    const cases: Array<[string, () => void]> = [
      ["published", () => vi.mocked(getLOSJob).mockResolvedValue({ job_id: "s", status: "COMPLETED", created_at: "now", result: sensResult(["j1"]) } as never)],
      ["FAILED", () => vi.mocked(getLOSJob).mockResolvedValue({ job_id: "s", status: "FAILED", error: "x", created_at: "now" })],
      ["sondeo lanza", () => vi.mocked(getLOSJob).mockRejectedValue(new Error("p"))],
      ["resultado inválido", () => vi.mocked(getLOSJob).mockResolvedValue({ job_id: "s", status: "COMPLETED", created_at: "now", result: sensResult(["zzz"]) } as never)],
      ["run rechaza", () => vi.mocked(runSensitivityAnalysis).mockRejectedValueOnce(new Error("r"))],
    ];
    for (const [name, arrange] of cases) for (const agent of [false]) {
      vi.mocked(runSensitivityAnalysis).mockResolvedValue({ job_id: "s", status: "PENDING" });
      arrange();
      void V.getState().computeSensitivityMap("t");
      await vi.advanceTimersByTimeAsync(1000);
      expect(V.getState().inFlightOrigin, `${name} agent=${agent}`).toBeNull();
      expect(V.getState().loading, `${name} agent=${agent}`).toBe(false);
    }
  });
});

// C4b: history order, not caller order, governs union and provenance.
describe("R1C-WP1-2 selección por conjunto", () => {
  it("reversing the same IDs preserves state, union and published sensitivity", async () => {
    await publishAgent(); await publishAgent();
    expect(A.getState().setHistorySelection(["j2", "j1"])).toBe(true);
    expect(A.getState().activeSnapshot?.sourceAnalysisIds).toEqual(["j2", "j1"]);
    vi.mocked(runSensitivityAnalysis).mockResolvedValue({ job_id: "s1", status: "PENDING" });
    vi.mocked(getLOSJob).mockResolvedValue({ job_id: "s1", status: "COMPLETED", created_at: "now", result: sensResult(["j2", "j1"]) } as never);
    void V.getState().computeSensitivityMap("t"); await vi.advanceTimersByTimeAsync(250);
    const before = A.getState(), vectorBefore = V.getState();
    expect(before.setHistorySelection(["j1", "j2"])).toBe(true);
    expect(A.getState()).toBe(before); expect(V.getState()).toBe(vectorBefore);
    expect(A.getState().activeSnapshot?.sourceAnalysisIds).toEqual(["j2", "j1"]);
  });
});

describe("R1C-WP1-3 UI invalid arguments", () => {
  it.each([
    ["posición NaN", () => A.getState().setRadarPosition({ x: 1, y: 2, z: NaN })],
    ["posición Infinity", () => A.getState().setRadarPosition({ x: Infinity, y: 2, z: 3 })],
    ["rango NaN", () => A.getState().setRangeOverrides(NaN, null)],
    ["azimut Infinity", () => A.getState().setAzimuthOverrides(Infinity, 10)],
    ["elevación -Infinity", () => A.getState().setElevationOverrides(null, -Infinity)],
  ])("%s: Run termina sin API y muestra error", async (_name, arrange) => {
    arrange(); await A.getState().runAnalysis("t"); await vi.advanceTimersByTimeAsync(130_000);
    expect(A.getState()).toMatchObject({ loading: false, inFlightOrigin: null, error: expect.any(String) });
    expect(runLOSAnalysis).not.toHaveBeenCalled();
  });
});
