/// <reference types="vite/client" />
/**
 * U10 · Enmienda 3: las filas de campos lado a lado usan el patrón compartido `.field-row`
 * (alineación por la fila de controles) y la barra lateral es un contenedor para `@container`.
 * La alineación real y las reglas CSS (vitest no procesa CSS: `?raw` llega vacío) se miden en el navegador
 * (evidence/u10); aquí se fija que el patrón exista en las filas clave.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Section } from "../components/ui/Section";

const sources = import.meta.glob(
  [
    "../App.tsx",
    "../components/SuggestPositionsPanel.tsx",
    "../components/RadarControls.tsx",
    "../components/QualityPolicyControl.tsx",
    "../components/VectorSynthesisPanel.tsx",
    "../components/ExportPanel.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const src = (name: string): string => {
  const key = Object.keys(sources).find((k) => k.endsWith(name));
  if (!key) throw new Error(`falta ${name}`);
  return sources[key]!;
};

describe("fila de campos compartida (Enmienda 3)", () => {
  it.each([
    ["SuggestPositionsPanel.tsx", "suggest-row field-row"],
    ["RadarControls.tsx", "panel-overrides field-row"],
    ["RadarControls.tsx", "panel-position field-row"],
    ["QualityPolicyControl.tsx", "panel-policy-row field-row"],
    ["VectorSynthesisPanel.tsx", "panel-segments field-row"],
    ["ExportPanel.tsx", "panel-export-row field-row"],
    ["App.tsx", "terrain-actions field-row"],
  ])("%s usa «%s»", (file, cls) => {
    expect(src(file)).toContain(`className="${cls}"`);
  });

  it("«Radares» conserva el nombre completo en title y aria-label", () => {
    const s = src("SuggestPositionsPanel.tsx");
    expect(s).toContain('<label className="cs-field" title="Cantidad de radares">');
    expect(s).toContain('aria-label="Cantidad de radares"');
  });
});

describe("resumen de sección recortado (Enmienda 3, punto 4)", () => {
  it("lleva el texto completo en title cuando el resumen es texto", () => {
    render(<Section id="u10" title="Radar" summary="GroundProbe SSR-FX · 50–2500 m · 120°" defaultOpen storageKey="geotradar-collapse-u10-test">x</Section>);
    expect(document.querySelector(".cs-section-summary")).toHaveAttribute("title", "GroundProbe SSR-FX · 50–2500 m · 120°");
  });
});
