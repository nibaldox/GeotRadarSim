/**
 * U6 · compact «Sugerir ubicación»: the collapsible Section, one line per suggestion with its detail
 * on click, LOW-1 (left entries listed on ANALYSIS_FAILED / TIMEOUT / REF_EXHAUSTED), LOW-2 (no tool
 * names) and «Continuar» disabled while another run holds the lock. Same harness as the WP15b test.
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

import { useAnalysisStore } from "../store/analysisStore";
import { useAoiStore } from "../store/aoiStore";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { useTerrainStore } from "../store/terrainStore";
import { computeQualitySummary } from "../utils/qualityMetrics";
import { loadRadarWasm } from "../wasm/loader";
import { runOptimizerJob, type OptimizerWasm } from "../workers/optimizerWorker";
import { setOptimizerRunnerForTests, type OptimizerRunner } from "../placement/suggestPositions";
import { ctxFor, drive, fake, installFakeApi, loadProfiles, loadTerrain, resetStores, createSuggestionToolkit } from "../placement/placement.testSupport";
import { SuggestPositionsPanel, errorText } from "./SuggestPositionsPanel";
import { formatKpiHectares, formatKpiPercent } from "./KpiBar";
import { radarMarkerColor } from "../hooks/useGlobalQuality";

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
  localStorage.removeItem("geotradar-collapse-suggest");
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
async function settle(ms = 30_000) {
  for (let t = 0; t < ms; t += 250) await act(async () => { await vi.advanceTimersByTimeAsync(250); });
}


const openSection = () => fireEvent.click(screen.getByRole("button", { name: /^Sugerir ubicación/u }));
const AGENT_ARGS = { k: 1, candidate_set: "regular_grid", min_separation_m: 50, height_above_ground_m: 2, time_budget_s: 90, objective: "USEFUL_INCIDENCE", keep_analysis_refs: [] };

describe("U6 · Section", () => {
  it("is collapsed by default with «k radar(es) · objetivo» in the header, and opens with its storage key", async () => {
    await ready();
    render(<SuggestPositionsPanel />);
    const header = screen.getByRole("button", { name: /^Sugerir ubicación/u });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toContain("1 radar · útil por incidencia");
    expect(screen.queryByRole("button", { name: "Calcular sugerencia" })).toBeNull();
    openSection();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("geotradar-collapse-suggest")).toBe("false");
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Objetivo"), { target: { value: "USEFUL_PROJECTION" } });
    expect(header.textContent).toContain("2 radares · útil por proyección");
    // «Sin garantía de óptimo» moved behind an «i» (title).
    expect(screen.getByTitle("Sin garantía de óptimo.")).toBeTruthy();
    expect(screen.queryByText("Sin garantía de óptimo.")).toBeNull();
  });
});

describe("U6 · one line per suggestion, detail on click", () => {
  it("each line shows dot, «Sugerencia n», «útil X%» and the useful area of its history entry; the detail opens on click", async () => {
    await ready();
    render(<SuggestPositionsPanel />);
    openSection();
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Calcular sugerencia" })); });
    await settle();
    const items = screen.getAllByTestId("suggest-card");
    const ordered = useAnalysisStore.getState().history.slice().reverse();
    expect(items.length).toBe(ordered.length);
    const policy = useQualityPolicyStore.getState().policy;
    const { grid, metadata } = useTerrainStore.getState();
    const active = useAnalysisStore.getState().activeSnapshot!;
    items.forEach((item, i) => {
      const entry = ordered[i]!;
      const summary = computeQualitySummary({
        metric: "INCIDENCE", policy, losResult: entry.result, terrainGrid: grid!, terrainResolution: metadata!.resolution,
        terrainKey: key(), snapshot: entry.snapshot!,
      })!;
      const line = within(item).getAllByRole("button")[0]!;
      expect(line.textContent).toBe(`Sugerencia ${i + 1}útil ${formatKpiPercent(summary.usefulCoveragePct)} · ${formatKpiHectares(summary.usefulAreaM2)}`);
      const dot = item.querySelector(".suggest-dot") as HTMLElement;
      const index = active.sourceAnalysisIds.indexOf(entry.snapshot!.analysisId!);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(dot.style.background).toBe(hexToRgb(radarMarkerColor(index)));
      const detail = within(item).getByTestId("suggest-detail");
      expect(detail.hidden).toBe(true);
      expect(line.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(line);
      expect(detail.hidden).toBe(false);
      expect(line.getAttribute("aria-expanded")).toBe("true");
      expect(detail.textContent).toContain(`Este: ${entry.position.x.toFixed(1)}`);
      expect(detail.textContent).toContain("Centro de azimut:");
      expect(detail.textContent).toContain(`${summary.usefulCoveragePct!.toFixed(1)}%`);
      fireEvent.click(line);
      expect(detail.hidden).toBe(true);
    });
    if (items.length > 1) {
      const union = screen.getByTestId("suggest-union");
      const line = within(union).getByRole("button");
      expect(line.textContent).toMatch(/^Unión: Sugerencia \d \+ Sugerencia \d/u);
      fireEvent.click(line);
      expect(within(union).getByTestId("suggest-detail").hidden).toBe(false);
    }
  });
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("U6 · LOW-1 and LOW-2", () => {
  it.each(["ANALYSIS_FAILED", "TIMEOUT", "REF_EXHAUSTED"] as const)("LOW-1: %s with left_in_history lists «Sugerencia n (Este …, Norte …)»", (code) => {
    const text = errorText(code, "El cálculo falló en la app.", "left_in_history: [A1, A2]", (refs) =>
      refs.map((_, i) => `Sugerencia ${i + 1} (Este 1.0, Norte 2.0)`).join(", "));
    expect(text).toMatch(/ Quedaron en el historial: Sugerencia 1 \(Este 1\.0, Norte 2\.0\), Sugerencia 2 \(Este 1\.0, Norte 2\.0\)\.$/u);
    expect(text).not.toMatch(/\bA\d\b/u);
  });

  it.each([
    ["ANALYSIS_FAILED", "boom"],
    ["TIMEOUT", "El análisis LOS superó el tiempo máximo de 120 segundos y fue cancelado."],
  ] as const)("LOW-1 in the panel: the 2nd verification fails (%s) and the alert lists Sugerencia 1 with Este and Norte", async (code, failure) => {
    await ready();
    let fired = false;
    const unsub = useAnalysisStore.subscribe((s) => {
      if (!fired && s.history.length === 1 && !s.loading) {
        fired = true;
        fake.failWith = failure;
      }
    });
    render(<SuggestPositionsPanel />);
    openSection();
    fireEvent.change(screen.getByLabelText("Cantidad de radares"), { target: { value: "2" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Calcular sugerencia" })); });
    await settle();
    unsub();
    expect(fired).toBe(true);
    const entry = useAnalysisStore.getState().history.find((e) => e.origin === "agent")!;
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toMatch(code === "TIMEOUT" ? /^Se agotó el tiempo\./u : /^El cálculo falló/u);
    expect(alert).toContain(`Quedaron en el historial: Sugerencia 1 (Este ${entry.position.x.toFixed(1)}, Norte ${entry.position.y.toFixed(1)}).`);
  });

  it("LOW-2: tool names never reach the panel", () => {
    const message = "Usa list_analyses y run_los_analysis, luego place_radar o suggest_radar_positions con A3.";
    for (const code of ["INVALID_ARGUMENT", "ANALYSIS_FAILED", "OPTIMIZER_FAILED"]) {
      const text = errorText(code, message);
      expect(text).not.toMatch(/list_analyses|run_los_analysis|place_radar|suggest_radar_positions|\bA3\b/u);
      expect(text).not.toMatch(/\s{2,}/u);
    }
  });
});

describe("U6 · «Continuar» while another run holds the lock", () => {
  it("is disabled (with the busy note) while the agent runs, and enabled again when it ends", async () => {
    await ready();
    for (let i = 0; i < 10; i++) {
      useAnalysisStore.getState().setRadarPosition({ x: O.x + 20 + 5 * i, y: O.y + 40, z: 112 });
      await drive(useAnalysisStore.getState().runAnalysisAndWait(key().terrain_id));
    }
    render(<SuggestPositionsPanel />);
    openSection();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Calcular sugerencia" })); });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setOptimizerRunnerForTests({ available: () => true, runner: async (req, opt) => { await gate; return realRunner(req, opt); } });
    const tool = createSuggestionToolkit().tools.find((t) => t.name === "suggest_radar_positions")!;
    const agent = tool.execute(AGENT_ARGS, ctxFor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const go = screen.getByRole("button", { name: "Continuar" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(within(screen.getByRole("alertdialog")).getByText("Ya hay una sugerencia de ubicación en curso.")).toBeTruthy();
    release();
    await act(async () => { await drive(agent); });
    await settle(2000);
    const dialog = screen.queryByRole("alertdialog");
    if (dialog) expect((within(dialog).getByRole("button", { name: "Continuar" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
