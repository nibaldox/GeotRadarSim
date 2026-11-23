import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Section } from "./Section";

const KEY = "geotradar-collapse-test-section";

beforeEach(() => {
  localStorage.clear();
});

function renderSection(props: Partial<Parameters<typeof Section>[0]> = {}) {
  return render(
    <Section id="test" title="Terreno" summary="101 × 101 · 2 m" defaultOpen storageKey={KEY} {...props}>
      <button type="button">Contenido interno</button>
    </Section>,
  );
}

describe("Section", () => {
  it("renders an accessible toggle button wired to its body", () => {
    renderSection();
    const toggle = screen.getByRole("button", { name: /Terreno/ });
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const bodyId = toggle.getAttribute("aria-controls");
    expect(bodyId).toBeTruthy();
    const body = document.getElementById(bodyId!);
    expect(body).not.toBeNull();
    expect(body).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Contenido interno" })).toBeVisible();
    // Title and summary live inside the header button; the section is labelled by its title.
    expect(toggle).toHaveTextContent("101 × 101 · 2 m");
    expect(screen.getByRole("region", { name: "Terreno" })).toBeInTheDocument();
  });

  it("collapses and expands with a click and persists the state in localStorage", () => {
    renderSection();
    const toggle = screen.getByRole("button", { name: /Terreno/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: "Contenido interno" })).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(KEY)).toBe("false");
  });

  it("is keyboard operable: it is a native button reachable by Tab, toggled by Enter/Space", () => {
    renderSection();
    const toggle = screen.getByRole("button", { name: /Terreno/ });
    toggle.focus();
    expect(toggle).toHaveFocus();
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).not.toHaveAttribute("tabindex", "-1");
    // Native buttons turn Enter/Space into a click; jsdom does not, so the click is the contract.
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("restores the stored state over the default", () => {
    localStorage.setItem(KEY, "true");
    renderSection({ defaultOpen: true });
    expect(screen.getByRole("button", { name: /Terreno/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("uses defaultOpen when nothing is stored", () => {
    renderSection({ defaultOpen: false });
    expect(screen.getByRole("button", { name: /Terreno/ })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("keeps collapsed children mounted (hidden) so form drafts survive", () => {
    renderSection({ defaultOpen: false });
    expect(screen.getByText("Contenido interno")).toBeInTheDocument();
    expect(screen.getByText("Contenido interno")).not.toBeVisible();
  });

  it("does not fold when an action in the actions slot is pressed", () => {
    let cleared = 0;
    renderSection({
      actions: (
        <button type="button" onClick={() => { cleared++; }}>
          Borrar todo
        </button>
      ),
    });
    const toggle = screen.getByRole("button", { name: /Terreno/ });
    fireEvent.click(screen.getByRole("button", { name: "Borrar todo" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Borrar todo" }), { key: "Enter" });
    expect(cleared).toBe(1);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(KEY)).toBeNull();
    // The action is not part of the toggle's accessible name.
    expect(toggle).not.toHaveTextContent("Borrar todo");
  });

  it("omits an empty summary", () => {
    renderSection({ summary: "" });
    expect(document.querySelector(".cs-section-summary")).toBeNull();
  });
});
