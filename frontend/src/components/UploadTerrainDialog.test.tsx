/**
 * Tests for UploadTerrainDialog — verifies the dialog renders the file's parsed
 * bounds, suggests a resolution, allows the user to override it, and forwards
 * the chosen resolution to confirmUploadPreview when committing.
 *
 * Mocks the terrain store's selectors/actions and the limits utility so we
 * can drive every state from the dialog without booting up a worker.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UploadTerrainDialog } from "./UploadTerrainDialog";
import { MAX_TERRAIN_GRID_CELLS } from "../utils/terrainLimits";

// Capture the store actions and state selectors we need to drive from tests.
const cancelUploadPreview = vi.fn();
const confirmUploadPreview = vi.fn();
const overrides: {
  previewState: unknown;
  loadingState: boolean;
  errorState: string | null;
} = {
  previewState: null,
  loadingState: false,
  errorState: null,
};

vi.mock("../store/terrainStore", () => ({
  useTerrainStore: (selector: (s: any) => unknown) =>
    selector({
      uploadPreview: overrides.previewState,
      uploadPreviewLoading: overrides.loadingState,
      uploadPreviewError: overrides.errorState,
      cancelUploadPreview,
      confirmUploadPreview,
    }),
}));

beforeEach(() => {
  cancelUploadPreview.mockClear();
  confirmUploadPreview.mockClear();
  overrides.previewState = null;
  overrides.loadingState = false;
  overrides.errorState = null;
});

describe("UploadTerrainDialog", () => {
  it("renders nothing when no upload preview is active", () => {
    const { container } = render(<UploadTerrainDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a loading hint while bounds are still parsing", () => {
    overrides.previewState = { file: new File(["x"], "terrain.stl"), filename: "terrain.stl" };
    overrides.loadingState = true;
    render(<UploadTerrainDialog />);
    expect(screen.getByText("terrain.stl")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/parseando/i);
  });

  it("surfaces a parse error and offers no confirm action", () => {
    overrides.previewState = { file: new File(["x"], "bad.stl"), filename: "bad.stl" };
    overrides.errorState = "Invalid binary STL: vertex coordinates must be finite";
    render(<UploadTerrainDialog />);
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid binary stl/i);
    // No confirm button when there is no source/bounds.
    expect(screen.queryByRole("button", { name: /Cargar con/i })).toBeNull();
  });

  it("renders parsed bounds and a confirmation form once bounds arrive", async () => {
    overrides.previewState = {
      file: new File(["x"], "surface.stl"),
      filename: "surface.stl",
      source: "STL",
      pointCount: 42,
      bbox: { minX: 0, maxX: 1000, minY: 0, maxY: 1000, minZ: 0, maxZ: 5 },
      span: { x: 1000, y: 1000, z: 5 },
    };
    render(<UploadTerrainDialog />);

    // Stats from the parsed envelope. Match individual values rather than the
    // formatted string because React splits text across sibling nodes.
    expect(screen.getByText("STL")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText(/Dimensión X × Y/i)).toBeInTheDocument();
    expect(screen.getByText(/Rango Z/i)).toBeInTheDocument();

    // The dialog must suggest a resolution that keeps the grid under the cap.
    // 1000 m / 1 m = 1001 nodes per axis → ~1M cells, over the 850k budget →
    // suggested should be 2 m.
    const resolutionInput = screen.getByLabelText(/resolución de muestreo/i) as HTMLInputElement;
    await waitFor(() => {
      expect(resolutionInput.value).toBe("2");
    });
    expect(screen.getByText(/✓ Entra en el límite/i)).toBeInTheDocument();

    // Cancel and confirm buttons both present.
    expect(screen.getByRole("button", { name: /cancelar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cargar con/i })).toBeInTheDocument();
  });

  it("shows an over-limit warning and disables confirm for an unfit resolution", async () => {
    overrides.previewState = {
      file: new File(["x"], "huge.stl"),
      filename: "huge.stl",
      source: "STL",
      pointCount: 100,
      bbox: { minX: 0, maxX: 5000, minY: 0, maxY: 5000, minZ: 0, maxZ: 5 },
      span: { x: 5000, y: 5000, z: 5 },
    };
    render(<UploadTerrainDialog />);

    const resolutionInput = screen.getByLabelText(/resolución de muestreo/i) as HTMLInputElement;
    // The dialog suggests 10 m for a 5 km terrain.
    await waitFor(() => expect(resolutionInput.value).toBe("10"));

    // Force a finer (over-cap) value and verify the warning + disabled confirm.
    fireEvent.change(resolutionInput, { target: { value: "1" } });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/excede/i);
    });
    const confirmButton = screen.getByRole("button", { name: /Cargar con/i }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it("forwards the chosen resolution to confirmUploadPreview on click", async () => {
    overrides.previewState = {
      file: new File(["x"], "surface.stl"),
      filename: "surface.stl",
      source: "STL",
      pointCount: 42,
      bbox: { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: 0, maxZ: 5 },
      span: { x: 100, y: 100, z: 5 },
    };
    render(<UploadTerrainDialog />);
    const resolutionInput = screen.getByLabelText(/resolución de muestreo/i) as HTMLInputElement;
    // 100 m / 0.25 m = 401 nodes per axis → 160,801 cells, fits within the 850k
    // budget, so the dialog suggests 0.25 m (the finest step that still fits).
    await waitFor(() => expect(resolutionInput.value).toBe("0.25"));

    fireEvent.change(resolutionInput, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Cargar con/i }));

    expect(confirmUploadPreview).toHaveBeenCalledWith(1);
    expect(cancelUploadPreview).not.toHaveBeenCalled();
  });

  it("invokes cancelUploadPreview when the user clicks Cancelar", () => {
    overrides.previewState = {
      file: new File(["x"], "surface.stl"),
      filename: "surface.stl",
      source: "STL",
      pointCount: 42,
      bbox: { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: 0, maxZ: 5 },
      span: { x: 100, y: 100, z: 5 },
    };
    render(<UploadTerrainDialog />);
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(cancelUploadPreview).toHaveBeenCalledTimes(1);
  });

  it("suggests a fresh resolution each time a new bounds envelope arrives", async () => {
    const initial = {
      file: new File(["x"], "small.stl"),
      filename: "small.stl",
      source: "STL",
      pointCount: 42,
      bbox: { minX: 0, maxX: 200, minY: 0, maxY: 200, minZ: 0, maxZ: 5 },
      span: { x: 200, y: 200, z: 5 },
    };
    overrides.previewState = initial;
    const { rerender } = render(<UploadTerrainDialog />);

    const input = screen.getByLabelText(/resolución de muestreo/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("0.25"));

    // Simulate the user picking a coarser resolution; that's only local state.
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("5");

    // A new bounds envelope must reset the suggested value.
    overrides.previewState = {
      file: new File(["x"], "big.stl"),
      filename: "big.stl",
      source: "STL",
      pointCount: 100,
      bbox: { minX: 0, maxX: 5000, minY: 0, maxY: 5000, minZ: 0, maxZ: 5 },
      span: { x: 5000, y: 5000, z: 5 },
    };
    rerender(<UploadTerrainDialog />);
    await waitFor(() => expect(input.value).toBe("10"));
  });

  it("exposes the cell cap in the user-facing preview text", () => {
    overrides.previewState = {
      file: new File(["x"], "surface.stl"),
      filename: "surface.stl",
      source: "STL",
      pointCount: 1,
      bbox: { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: 0, maxZ: 0 },
      span: { x: 100, y: 100, z: 0 },
    };
    render(<UploadTerrainDialog />);
    expect(screen.getByText(new RegExp(MAX_TERRAIN_GRID_CELLS.toLocaleString('es-CL')))).toBeInTheDocument();
  });
});
