/**
 * While the bounds are still being parsed, or after the parse failed, the dialog must offer an
 * explicit way to cancel: that is what terminates a slow or stuck terrain Worker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UploadTerrainDialog } from "./UploadTerrainDialog";

const cancelUploadPreview = vi.fn();
const state: { loading: boolean; error: string | null } = { loading: false, error: null };

vi.mock("../store/terrainStore", () => ({
  useTerrainStore: (selector: (s: unknown) => unknown) =>
    selector({
      uploadPreview: { file: new File(["x"], "pending.dxf"), filename: "pending.dxf" },
      uploadPreviewLoading: state.loading,
      uploadPreviewError: state.error,
      cancelUploadPreview,
      confirmUploadPreview: vi.fn(),
    }),
}));

beforeEach(() => {
  cancelUploadPreview.mockClear();
  state.loading = false;
  state.error = null;
});

describe("UploadTerrainDialog — cancel before bounds arrive", () => {
  it("offers an enabled Cancelar button while the file is still being parsed", () => {
    state.loading = true;
    render(<UploadTerrainDialog />);

    const cancel = screen.getByRole("button", { name: /cancelar/i }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(cancelUploadPreview).toHaveBeenCalledTimes(1);
  });

  it("lets the user close the dialog after a preflight rejection", () => {
    state.error = "DXF rechazado: la POLYLINE de la línea 5 no termina con SEQEND";
    render(<UploadTerrainDialog />);

    expect(screen.getByRole("alert")).toHaveTextContent(/SEQEND/);
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(cancelUploadPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Cargar con/i })).toBeNull();
  });
});
