/**
 * WP15b · «Sugerir ubicación» panel (RTL) over the REAL tool path of WP8: stores, refs, schema
 * validator, `createSuggestRadarPositions` and the real WASM coarse pass in process (the same test
 * runner as the WP8 tests). The full-resolution LOS goes through the store over the WP4 fake API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../services/api", () => ({
  listRadars: vi.fn(), runLOSAnalysis: vi.fn(), getLOSJob: vi.fn(), cancelLOSAnalysis: vi.fn(), releaseLOSJob: vi.fn(),
  runSensitivityAnalysis: vi.fn(), cancelSensitivityAnalysis: vi.fn(), releaseSensitivityJob: vi.fn(),
  generateSynthetic: vi.fn(), getTerrainGrid: vi.fn(), activateTerrain: vi.fn(), releaseTerrain: vi.fn(),
  uploadDXF: vi.fn(), uploadSTL: vi.fn(), previewTerrainBounds: vi.fn(), exportPDF: vi.fn(), exportCSV: vi.fn(),
}));

const subscriptions = { active: 0, total: 0 };
vi.mock("../placement/suggestPositions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../placement/suggestPositions")>();
  return {
    ...real,
    subscribeOptimizerProgress: (listener: Parameters<typeof real.subscribeOptimizerProgress>[0]) => {
      const unsub = real.subscribeOptimizerProgress(listener);
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

import * as api from "../services/api";
import { mergeResults, useAnalysisStore } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useTerrainStore } from "../store/terrainStore";
import { computeQualitySummary } from "../utils/qualityMetrics";
import type { SyntheticTerrainRequest } from "../types/api";
import { loadRadarWasm } from "../wasm/loader";
import { runOptimizerJob, type OptimizerJobResult, type OptimizerWasm } from "../workers/optimizerWorker";
import { setOptimizerRunnerForTests, type OptimizerRunner } from "../placement/suggestPositions";
import { buildTerrain, ctxFor, drive, fake, installFakeApi, loadProfiles, loadTerrain, resetStores, createSuggestionToolkit } from "../placement/placement.testSupport";
import { HISTORY_LEGEND, SuggestPositionsPanel, errorText } from "./SuggestPositionsPanel";

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

describe("availability and defaults", () => {
  it("without terrain there is no form; with a terrain and no loads the form shows its defaults", async () => {
    render(<SuggestPositionsPanel />);
    expect(screen.getByText("Carga o genera un terreno para pedir una sugerencia.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Calcular sugerencia" })).toBeNull();
    await act(async () => { await ready(); });
    expect((screen.getByLabelText("Cantidad de radares") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Objetivo") as HTMLSelectElement).value).toBe("USEFUL_INCIDENCE");
    const area = screen.getByLabelText("Usar el área a monitorear") as HTMLInputElement;
    expect(area.checked).toBe(false);
    expect(area.disabled).toBe(true);
    expect((screen.getByLabelText("Conservar los radares seleccionados en el historial") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Separación mínima (m)") as HTMLInputElement).value).toBe("50");
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Objetivo"), { target: { value: "USEFUL_PROJECTION" } });
    expect(screen.getByTitle("Sin garantía de óptimo.")).toBeTruthy();
  });

  it("an analysis in flight hides the form", async () => {
    await ready();
    render(<SuggestPositionsPanel />);
    expect(button()).toBeTruthy();
    act(() => useAnalysisStore.setState({ loading: true }));
    expect(screen.queryByRole("button", { name: "Calcular sugerencia" })).toBeNull();
    expect(screen.getByText("Hay un análisis o una carga en curso; espera a que termine.")).toBeTruthy();
  });

  it("the area checkbox is checked by default when an area exists on the active terrain", async () => {
    await ready();
    render(<SuggestPositionsPanel />);
    act(() => useAoiStore.setState({
      polygon: { vertices: [{ x: O.x + 80, y: O.y + 40 }, { x: O.x + 120, y: O.y + 40 }, { x: O.x + 120, y: O.y + 80 }, { x: O.x + 80, y: O.y + 80 }] },
      terrainKey: { ...key() },
    }));
    const area = screen.getByLabelText("Usar el área a monitorear") as HTMLInputElement;
    expect(area.disabled).toBe(false);
    expect(area.checked).toBe(true);
    act(() => useAoiStore.setState({ terrainKey: { ...key(), epoch: key().epoch + 5 } }));
    expect((screen.getByLabelText("Usar el área a monitorear") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("a run", () => {
  it("shows one card per [A#] with the figures of computeQualitySummary of that entry, plus the union", async () => {
    await ready();
    render(<SuggestPositionsPanel />);
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    await calculate();
    const cards = screen.getAllByTestId("suggest-card");
    const history = useAnalysisStore.getState().history;
    expect(cards.length).toBe(history.length);
    expect(cards.length).toBeGreaterThan(0);
    const policy = useQualityPolicyStore.getState().policy;
    const { grid, metadata } = useTerrainStore.getState();
    // History is newest first; card 1 is the first verification (the oldest agent entry).
    const ordered = history.slice().reverse();
    cards.forEach((card, i) => {
      const entry = ordered[i]!;
      const summary = computeQualitySummary({
        metric: "INCIDENCE", policy, losResult: entry.result, terrainGrid: grid!, terrainResolution: metadata!.resolution,
        terrainKey: key(), snapshot: entry.snapshot!,
      })!;
      const text = card.textContent!;
      // R15b F3: the panel shows no private [A#].
      expect(card.querySelector("strong")!.textContent).toBe(`Sugerencia ${i + 1}`);
      expect(text).toContain(`${summary.usefulCoveragePct!.toFixed(1)}%`);
      expect(text).toContain(`${summary.usefulAreaM2!.toFixed(0)} m²`);
      expect(text).toContain(`${entry.result.coverage_pct!.toFixed(1)}%`);
      expect(text).toContain(`Este: ${entry.position.x.toFixed(1)}`);
      expect(text).toContain(`Norte: ${entry.position.y.toFixed(1)}`);
      expect(text).toContain(`Cota: ${entry.position.z.toFixed(1)}`);
      expect(text).toContain("Centro de azimut: Barrido completo (360°)");
    });
    expect(screen.getByTitle(HISTORY_LEGEND)).toBeTruthy();
    expect(screen.queryByText(/bestValue|coarse_score/u)).toBeNull();
    expect(subscriptions.active).toBe(0);
  });

  it("progress is filtered by its own run: an event of another run is not shown", async () => {
    await ready();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    setOptimizerRunnerForTests({
      available: () => true,
      runner: async (request, options) => {
        calls++;
        options.onProgress?.({ phase: "coarse_los", done: calls * 3, total: 10, bestValue: 999 });
        await gate;
        return realRunner(request, options);
      },
    });
    render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Evaluando candidatos 3/10")).toBeTruthy();
    // Another run (the agent tool) emits on the same global channel.
    const kit = createSuggestionToolkit();
    const tool = kit.tools.find((t) => t.name === "suggest_radar_positions")!;
    const other = tool.execute({ k: 1, candidate_set: "regular_grid", min_separation_m: 50, height_above_ground_m: 2, time_budget_s: 90, objective: "USEFUL_INCIDENCE", keep_analysis_refs: [] }, ctxFor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // R15b F2: the second run is BUSY (one suggestion at a time), so it never reaches the runner.
    const otherEnv = await drive(other);
    expect(otherEnv.ok ? "OK" : otherEnv.error.code).toBe("BUSY");
    expect(calls).toBe(1);
    expect(screen.queryByText("Evaluando candidatos 6/10")).toBeNull();
    expect(screen.getByText("Evaluando candidatos 3/10")).toBeTruthy();
    expect(screen.queryByText(/999/u)).toBeNull();
    release();
    await settle();
    expect(subscriptions.active).toBe(0);
  });

  it("Detener shows «Cancelando…» until the run settles, then «Búsqueda detenida.»", async () => {
    await ready();
    setOptimizerRunnerForTests({
      available: () => true,
      runner: (_request, { signal }) => new Promise((resolve) =>
        signal.addEventListener("abort", () => setTimeout(() => resolve({ status: "cancelled" }), 2000))),
    });
    render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Detener" })); });
    expect(screen.getByText("Cancelando…")).toBeTruthy();
    await settle(3000);
    expect(screen.getByRole("alert").textContent).toBe("Búsqueda detenida.");
    expect(useAnalysisStore.getState().history).toHaveLength(0);
    expect(subscriptions.active).toBe(0);
  });

  it("unmounting during a run stops it, unsubscribes and never paints", async () => {
    await ready();
    let aborted = false;
    setOptimizerRunnerForTests({
      available: () => true,
      runner: (_request, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve({ status: "cancelled" }); })),
    });
    const view = render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); await vi.advanceTimersByTimeAsync(0); });
    expect(subscriptions.active).toBe(1);
    view.unmount();
    await settle(1000);
    expect(aborted).toBe(true);
    expect(subscriptions.active).toBe(0);
  });
});

describe("errors, one per code", () => {
  const budget: OptimizerJobResult = {
    status: "BUDGET_EXCEEDED", coarse: null, reduced: {}, shortlistPerStep: 3, reductionNote: "",
    timing: { calibration_ms: 0, estimated_s: 0, elapsed_s: 0 },
  };
  it.each([
    ["NOT_AVAILABLE", async () => ({ status: "error", code: "NOT_AVAILABLE", message: "El motor de cálculo WebAssembly no se pudo iniciar." }) as const, /^El optimizador no está disponible en este navegador/u],
    ["TIMEOUT (watchdog)", async () => ({ status: "error", code: "TIMEOUT", message: "x" }) as const, /^Se agotó el tiempo\. Prueba con menos radares o sin el área\.$/u],
    ["BUDGET_EXCEEDED", async () => ({ status: "result", result: budget }) as const, /^Se agotó el tiempo\. Prueba con menos radares o sin el área\.$/u],
  ] as const)("%s", async (_name, runner, text) => {
    await ready();
    setOptimizerRunnerForTests({ available: () => true, runner: runner as unknown as OptimizerRunner });
    render(<SuggestPositionsPanel />);
    await calculate();
    expect(screen.getByRole("alert").textContent).toMatch(text);
    expect(screen.queryByTestId("suggest-results")).toBeNull();
  });

  it("NO_COVERAGE / no candidates → «El cálculo falló: …»", async () => {
    await drive(loadTerrain(2, 2, 1));
    await loadProfiles();
    useAnalysisStore.getState().selectRadar("perfil-a");
    render(<SuggestPositionsPanel />);
    await calculate();
    expect(screen.getByRole("alert").textContent).toMatch(/^El cálculo falló: /u);
  });

  it("INVALID_ARGUMENT: an invalid area is explained before running", async () => {
    await ready();
    useAoiStore.setState({ polygon: { vertices: [{ x: O.x + 1, y: O.y + 1 }, { x: O.x + 5, y: O.y + 1 }, { x: O.x + 9, y: O.y + 1 }] }, terrainKey: { ...key() } });
    render(<SuggestPositionsPanel />);
    await calculate();
    expect(screen.getByRole("alert").textContent).toMatch(/^Revisa las opciones: Los vértices del área a monitorear son colineales/u);
  });

  it("SUPERSEDED during the verification lists left_in_history", async () => {
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
    expect(fired).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/^La búsqueda se descartó.*Quedaron en el historial: Sugerencia 1 \(Este [\d.]+, Norte [\d.]+\)\./u);
    expect(screen.queryByTestId("suggest-results")).toBeNull();
  });

  it("a full history asks first; keeping a radar that would be pushed out is refused", async () => {
    await ready();
    for (let i = 0; i < 10; i++) {
      useAnalysisStore.getState().setRadarPosition({ x: O.x + 20 + 5 * i, y: O.y + 40, z: 112 });
      await drive(useAnalysisStore.getState().runAnalysisAndWait(key().terrain_id));
    }
    const ids = useAnalysisStore.getState().history.map((e) => e.snapshot!.analysisId!);
    useAnalysisStore.getState().setHistorySelection([ids[ids.length - 1]!]);
    let runnerCalls = 0;
    setOptimizerRunnerForTests({ runner: async (request, options) => { runnerCalls++; return realRunner(request, options); }, available: () => true });
    render(<SuggestPositionsPanel />);
    await act(async () => { fireEvent.click(button()); });
    expect(screen.getByRole("alertdialog").textContent).toMatch(/El historial quedará lleno: se descartarán 1 análisis antiguos/u);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancelar" })); });
    fireEvent.click(screen.getByLabelText("Conservar los radares seleccionados en el historial"));
    await act(async () => { fireEvent.click(button()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continuar" })); });
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/^Revisa las opciones: El historial está lleno/u);
    expect(useAnalysisStore.getState().history).toHaveLength(10);
    expect(runnerCalls).toBe(0);
  });

  it("errorText covers every code with Spanish text", () => {
    expect(errorText("CANCELLED_BY_USER", "x", "left_in_history: [A1, A2]")).toBe("Búsqueda detenida. Quedaron en el historial: Sugerencia 1, Sugerencia 2.");
    expect(errorText("BUSY", "x", undefined)).toMatch(/^Hay un análisis en curso/u);
    expect(errorText("NO_PROFILE", "Primero selecciona un perfil de radar.", undefined)).toBe("Selecciona un perfil de radar.");
  });
});

describe("integration · real WASM coarse pass on the P3c terrain (two pits)", () => {
  it("k = 2: two suggestions, two new [A#] in the history and the union equals mergeResults + computeQualitySummary", async () => {
    // P3c of optimizerWorker.test.ts: paraboloid pits at x = 30 and 90 m, a 40 m ridge at x = 58–60 m.
    vi.mocked(api.generateSynthetic).mockImplementation(async (request: SyntheticTerrainRequest) => {
      fake.nextTerrain += 1;
      const terrain = buildTerrain(request, `dtm-synth-${fake.nextTerrain}-x350000y6400000`);
      const res = terrain.metadata.resolution;
      terrain.grid = terrain.grid.map((row, r) => row.map((_, c) => {
        const x = c * res;
        const y = r * res;
        return 100 + (x === 58 || x === 60 ? 40 : 0.006 * ((x - (x < 59 ? 30 : 90)) ** 2 + (y - 40) ** 2));
      }));
      terrain.metadata = { ...terrain.metadata, bounds: { ...terrain.metadata.bounds, max_z: Math.max(...terrain.grid.flat()) } };
      fake.terrains.set(terrain.terrain_id, terrain);
      return terrain.metadata;
    });
    await ready([120, 80, 2]);
    useAnalysisStore.getState().setRangeOverrides(null, 200);
    render(<SuggestPositionsPanel />);
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Separación mínima (m)"), { target: { value: "10" } });
    await calculate();
    const cards = screen.getAllByTestId("suggest-card");
    expect(cards).toHaveLength(2);
    const history = useAnalysisStore.getState().history;
    expect(history).toHaveLength(2);
    expect(history.every((e) => e.origin === "agent" && e.selected)).toBe(true);
    // With the panel's candidate set (edges_and_berms, the schema default) only the left pit has flat
    // nodes next to the ridge face, so both picks are BERM nodes there (see REPORT); P3c's one-per-pit
    // geometry is asserted with regular_grid in optimizerWorker.test.ts.
    expect(new Set(history.map((e) => `${e.position.x},${e.position.y}`)).size).toBe(2);
    const { grid, metadata } = useTerrainStore.getState();
    const merged = mergeResults(history.map((e) => e.result));
    const union = computeQualitySummary({
      metric: "INCIDENCE", policy: useQualityPolicyStore.getState().policy, losResult: merged, terrainGrid: grid!,
      terrainResolution: metadata!.resolution, terrainKey: key(),
      snapshot: { terrainKey: key(), analysisId: null, sourceAnalysisIds: history.map((e) => e.snapshot!.analysisId!), generation: 0, radars: [] },
    })!;
    const unionCard = within(screen.getByTestId("suggest-union"));
    expect(unionCard.getByText("Unión: Sugerencia 2 + Sugerencia 1")).toBeTruthy();
    expect(screen.getByTestId("suggest-union").textContent).toContain(`${union.usefulCoveragePct!.toFixed(1)}%`);
    expect(screen.getByTestId("suggest-union").textContent).toContain(`${union.usefulAreaM2!.toFixed(0)} m²`);
    // The store's active union (what the map and the dashboard show) is the same.
    const active = useAnalysisStore.getState();
    expect(active.activeSnapshot!.sourceAnalysisIds).toEqual(history.map((e) => e.snapshot!.analysisId!));
  });
});
