/**
 * R15b-FIX · inverted probes of the R15b review (evidence/r15b/A.md, B.md, ARBITRAJE.md): F1 frozen
 * confirmed options, F2 one suggestion at a time, F3 no private [A#] in the UI, F4 user texts, F5
 * reentrancy. Same harness as SuggestPositionsPanel.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../services/api", () => ({
  listRadars: vi.fn(), runLOSAnalysis: vi.fn(), getLOSJob: vi.fn(), cancelLOSAnalysis: vi.fn(), releaseLOSJob: vi.fn(),
  runSensitivityAnalysis: vi.fn(), cancelSensitivityAnalysis: vi.fn(), releaseSensitivityJob: vi.fn(),
  generateSynthetic: vi.fn(), getTerrainGrid: vi.fn(), activateTerrain: vi.fn(), releaseTerrain: vi.fn(),
  uploadDXF: vi.fn(), uploadSTL: vi.fn(), previewTerrainBounds: vi.fn(), exportPDF: vi.fn(), exportCSV: vi.fn(),
}));

const subscriptions = { active: 0, total: 0, listeners: [] as Array<(event: any) => void> };
vi.mock("../placement/suggestPositions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../placement/suggestPositions")>();
  return {
    ...real,
    subscribeOptimizerProgress: (listener: Parameters<typeof real.subscribeOptimizerProgress>[0]) => {
      const unsub = real.subscribeOptimizerProgress(listener);
      subscriptions.listeners.push(listener);
      subscriptions.active++;
      subscriptions.total++;
      let done = false;
      return () => {
        if (!done) subscriptions.active--;
        done = true;
        return unsub();
      };
    },
  };
});

import { useAnalysisStore } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useTerrainStore } from "../store/terrainStore";
import { loadRadarWasm } from "../wasm/loader";
import { runOptimizerJob, type OptimizerJobResult, type OptimizerWasm } from "../workers/optimizerWorker";
import { setOptimizerRunnerForTests, type OptimizerRunner } from "../placement/suggestPositions";
import { ctxFor, drive, installFakeApi, loadProfiles, loadTerrain, resetStores, createSuggestionToolkit } from "../placement/placement.testSupport";
import { SuggestPositionsPanel, errorText } from "./SuggestPositionsPanel";

let wasm: OptimizerWasm;
const realRunner: OptimizerRunner = async (request, { signal }) => {
  if (signal.aborted) return { status: "cancelled" };
  return { status: "result", result: runOptimizerJob(request, { wasm, now: () => 0 }) };
};
const O = { x: 350_000.5, y: 6_400_000.25 };

beforeEach(async () => {
  wasm = (await loadRadarWasm()) as unknown as OptimizerWasm;
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetStores();
  useAoiStore.getState().clear();
  useQualityPolicyStore.getState().resetPolicy();
  installFakeApi();
  // U6: the section is collapsed by default (contract §1.1 row 6); these tests work on its body.
  localStorage.setItem("geotradar-collapse-suggest", "false");
  subscriptions.active = 0;
  subscriptions.total = 0;
  subscriptions.listeners = [];
  setOptimizerRunnerForTests({ runner: realRunner, available: () => true });
});
afterEach(() => {
  cleanup();
  setOptimizerRunnerForTests(null);
  resetStores();
  vi.useRealTimers();
});

async function ready(size: [number, number, number] = [200, 120, 2], profile = "perfil-a"): Promise<void> {
  await drive(loadTerrain(...size));
  await loadProfiles();
  useAnalysisStore.getState().selectRadar(profile);
}
const key = () => useTerrainStore.getState().terrainKey!;
const button = () => screen.getByRole("button", { name: "Calcular sugerencia" });
async function settle(ms = 30_000) {
  for (let t = 0; t < ms; t += 250) await act(async () => { await vi.advanceTimersByTimeAsync(250); });
}
async function calculate() {
  await act(async () => { fireEvent.click(button()); });
  await settle();
}


const LEAK = /\bA\d{1,3}\b|\bC\d{1,3}\b|suggest_radar_positions|run_los_analysis|list_analyses|left_in_history/u;
const square = (x0 = 80, y0 = 40, s = 40) => ({
  polygon: { vertices: [{ x: O.x + x0, y: O.y + y0 }, { x: O.x + x0 + s, y: O.y + y0 }, { x: O.x + x0 + s, y: O.y + y0 + s }, { x: O.x + x0, y: O.y + y0 + s }] },
  terrainKey: { ...key() },
});
async function fillHistory(n: number) {
  for (let i = 0; i < n; i++) {
    useAnalysisStore.getState().setRadarPosition({ x: O.x + 20 + 5 * i, y: O.y + 40, z: 112 });
    await drive(useAnalysisStore.getState().runAnalysisAndWait(key().terrain_id));
  }
}
const AGENT_ARGS = { k: 1, candidate_set: "regular_grid", min_separation_m: 50, height_above_ground_m: 2, time_budget_s: 90, objective: "USEFUL_INCIDENCE", keep_analysis_refs: [] };

describe("F1 · the confirmed options are frozen (RA-H1 = B-1)", () => {
  it("RA-3: area unchecked + destructive card + the area changes before «Continuar» → the card closes with a warning, nothing runs", async () => {
    await ready();
    await fillHistory(10);
    useAoiStore.setState(square());
    let runs = 0;
    setOptimizerRunnerForTests({ available: () => true, runner: async (r, o) => { runs++; return realRunner(r, o); } });
    render(<SuggestPositionsPanel />);
    fireEvent.click(screen.getByLabelText("Usar el área a monitorear"));
    await act(async () => { fireEvent.click(button()); });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    act(() => useAoiStore.setState(square(20)));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("El área a monitorear cambió; revisa las opciones y vuelve a calcular.");
    // The user's choice survives: the box is not re-checked behind their back.
    expect((screen.getByLabelText("Usar el área a monitorear") as HTMLInputElement).checked).toBe(false);
    expect(runs).toBe(0);
    expect(useAnalysisStore.getState().history).toHaveLength(10);
  });

  it("B-1/B7: with the box unchecked, the run never receives the area even if it is redrawn meanwhile", async () => {
    await ready();
    await fillHistory(10);
    useAoiStore.setState(square());
    const seen: boolean[] = [];
    setOptimizerRunnerForTests({ available: () => true, runner: async (r, o) => { seen.push(!!r.aoi); return realRunner(r, o); } });
    render(<SuggestPositionsPanel />);
    fireEvent.click(screen.getByLabelText("Usar el área a monitorear"));
    await act(async () => { fireEvent.click(button()); });
    // Redraw: the card closes; the user re-submits with the box still unchecked.
    act(() => useAoiStore.setState(square(70)));
    await act(async () => { fireEvent.click(button()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continuar" })); });
    await settle();
    expect(seen).toEqual([false]);
    expect(useAnalysisStore.getState().azCenterOverride).toBeNull();
    expect(screen.queryByText(/fijó el centro del azimut/u)).toBeNull();
  });

  it("the frozen value wins: unchecking the box after «Calcular» does not change the running request", async () => {
    await ready();
    useAoiStore.setState(square());
    const seen: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setOptimizerRunnerForTests({ available: () => true, runner: async (r, o) => { await gate; seen.push(!!r.aoi); return realRunner(r, o); } });
    render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); await vi.advanceTimersByTimeAsync(0); });
    act(() => useAoiStore.setState(square(60)));
    release();
    await settle();
    // The area changed during the run: the tool's run signature makes it SUPERSEDED; it was sent with the area.
    expect(seen).toEqual([true]);
  });
});

describe("F2 · one suggestion at a time (B-2)", () => {
  it("B1 probe: panel running + agent call → the agent gets BUSY «Ya hay una sugerencia de ubicación en curso.»; the panel ends OK", async () => {
    await ready();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    setOptimizerRunnerForTests({ available: () => true, runner: async (req, opt) => { calls++; await gate; return realRunner(req, opt); } });
    render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); await vi.advanceTimersByTimeAsync(0); });
    const tool = createSuggestionToolkit().tools.find((t) => t.name === "suggest_radar_positions")!;
    const env = await drive(tool.execute(AGENT_ARGS, ctxFor()));
    expect(env.ok ? "OK" : env.error.code).toBe("BUSY");
    expect(env.ok ? "" : env.error.message).toBe("Ya hay una sugerencia de ubicación en curso.");
    expect(calls).toBe(1);
    release();
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByTestId("suggest-card").length).toBeGreaterThan(0);
  });

  it("while the agent holds the lock the panel disables «Calcular sugerencia», and enables it again on release", async () => {
    await ready();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setOptimizerRunnerForTests({ available: () => true, runner: async (req, opt) => { await gate; return realRunner(req, opt); } });
    render(<SuggestPositionsPanel />);
    const tool = createSuggestionToolkit().tools.find((t) => t.name === "suggest_radar_positions")!;
    const agent = tool.execute(AGENT_ARGS, ctxFor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Ya hay una sugerencia de ubicación en curso.")).toBeTruthy();
    release();
    await act(async () => { await drive(agent); });
    // The agent's LOS left the history; the form is back once nothing is loading.
    await settle(2000);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["ok", "error", "throw"] as const)("the lock is released on every exit (%s)", async (exit) => {
    await ready();
    const { isSuggestionRunning } = await import("../placement/suggestPositions");
    setOptimizerRunnerForTests({
      available: () => true,
      runner: async (req, opt) => {
        if (exit === "error") return { status: "error", code: "OPTIMIZER_FAILED", message: "x" };
        if (exit === "throw") throw new Error("boom");
        return realRunner(req, opt);
      },
    });
    const tool = createSuggestionToolkit().tools.find((t) => t.name === "suggest_radar_positions")!;
    const pending = tool.execute(AGENT_ARGS, ctxFor());
    expect(isSuggestionRunning()).toBe(true);
    await drive(pending.catch(() => null));
    expect(isSuggestionRunning()).toBe(false);
  });
});

describe("F3 · no private [A#] in the UI (RA-M1)", () => {
  it("RA-7: the cards say «Sugerencia n» and the DOM shows no A# after OK", async () => {
    await ready();
    await fillHistory(1);
    useAnalysisStore.getState().removeHistoryEntry(0);
    render(<SuggestPositionsPanel />);
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    await calculate();
    const titles = screen.getAllByTestId("suggest-card").map((c) => c.querySelector("strong")!.textContent);
    expect(titles[0]).toBe("Sugerencia 1");
    expect(LEAK.exec(document.body.textContent ?? "")).toBeNull();
  });

  it("RA-8: after SUPERSEDED the left entries are listed as «Sugerencia n» with Este and Norte, no A#", async () => {
    await ready();
    let fired = false;
    const unsub = useAnalysisStore.subscribe((s) => {
      if (!fired && s.history.length === 1 && !s.loading) {
        fired = true;
        queueMicrotask(() => useAnalysisStore.getState().setRangeOverrides(null, 7));
      }
    });
    render(<SuggestPositionsPanel />);
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    await calculate();
    unsub();
    const entry = useAnalysisStore.getState().history[0]!;
    const text = screen.getByRole("alert").textContent!;
    expect(text).toContain(`Quedaron en el historial: Sugerencia 1 (Este ${entry.position.x.toFixed(1)}, Norte ${entry.position.y.toFixed(1)}).`);
    expect(LEAK.exec(document.body.textContent ?? "")).toBeNull();
  });
});

describe("F4 · texts written for the app user (RA-L1)", () => {
  it.each([
    ["TIMEOUT", "x", "Se agotó el tiempo. Prueba con menos radares o sin el área."],
    ["ANALYSIS_FAILED", "El optimizador falló.", /^El cálculo falló/u],
    ["OPTIMIZER_FAILED", "x", /^El cálculo falló/u],
    ["REF_EXHAUSTED", "x", /recarga la app/u],
    ["STALE_REF", "A3 ya no está en el historial (tope de 10 entradas).", /^El terreno, el área o el historial cambiaron/u],
    ["NO_TERRAIN", "x", /^Carga o genera un terreno/u],
    ["BUSY", "Hay un análisis del usuario en curso; no lo interrumpo.", /^Hay un análisis en curso/u],
    ["BUSY", "Ya hay una sugerencia de ubicación en curso.", "Ya hay una sugerencia de ubicación en curso; espera a que termine."],
    ["INVALID_ARGUMENT", "Los radares fijos más k no pueden superar 10, el tope del historial.", /^Revisa las opciones: /u],
    ["CANCELLED_BY_USER", "El usuario canceló el análisis en la app; no lo repito.", "Búsqueda detenida."],
  ] as const)("%s → user text", (code, message, expected) => {
    const text = errorText(code, message, undefined, () => "");
    if (typeof expected === "string") expect(text).toBe(expected);
    else expect(text).toMatch(expected);
    expect(LEAK.exec(text)).toBeNull();
    expect(text).not.toMatch(/presupuesto mayor|no lo repito|no lo interrumpo|\bk\b|herramienta/u);
    expect(text).not.toMatch(/No se encontró/u);
  });

  it("BUDGET_EXCEEDED in the panel shows the timeout text", async () => {
    await ready();
    const budget: OptimizerJobResult = {
      status: "BUDGET_EXCEEDED", coarse: null, reduced: {}, shortlistPerStep: 3, reductionNote: "",
      timing: { calibration_ms: 0, estimated_s: 0, elapsed_s: 0 },
    };
    setOptimizerRunnerForTests({ available: () => true, runner: async () => ({ status: "result", result: budget }) });
    render(<SuggestPositionsPanel />);
    await calculate();
    expect(screen.getByRole("alert").textContent).toBe("Se agotó el tiempo. Prueba con menos radares o sin el área.");
  });
});

describe("F5 · reentrancy (B-S1)", () => {
  it("B3: two submits before a re-render start one run only", async () => {
    await ready();
    let calls = 0;
    setOptimizerRunnerForTests({ available: () => true, runner: async (r, o) => { calls++; return realRunner(r, o); } });
    render(<SuggestPositionsPanel />);
    const form = button().closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    await settle();
    expect(calls).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("progress filter with a foreign event on the global channel", () => {
  it("an event of another call or run is ignored", async () => {
    await ready();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setOptimizerRunnerForTests({
      available: () => true,
      runner: async (request, options) => {
        options.onProgress?.({ phase: "coarse_los", done: 3, total: 10, bestValue: 999 });
        await gate;
        return realRunner(request, options);
      },
    });
    render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Evaluando candidatos 3/10")).toBeTruthy();
    act(() => {
      for (const listener of subscriptions.listeners) {
        listener({ phase: "coarse_los", done: 6, total: 10, bestValue: 1, runId: "optim-other", callId: "c-agent" });
        listener({ phase: "coarse_los", done: 7, total: 10, bestValue: 1, runId: "optim-other", callId: "ui-suggest-1" });
      }
    });
    expect(screen.getByText("Evaluando candidatos 3/10")).toBeTruthy();
    release();
    await settle();
    expect(subscriptions.active).toBe(0);
  });
});
