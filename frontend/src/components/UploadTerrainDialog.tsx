/**
 * UploadTerrainDialog — pops up when a user selects an STL or DXF file.
 *
 * Surfaces the file's parsed X/Y/Z envelope and lets the user override the
 * resolution before committing to the full DTM build. Defaults to the
 * finest resolution that fits the 1M-cell cap (see suggestResolutionForSpan)
 * and shows a live preview of the resulting grid.
 *
 * State lives in the terrain store via startUploadPreview / cancelUploadPreview /
 * confirmUploadPreview; this component is a pure projection of that slice.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTerrainStore } from "../store/terrainStore";
import { MAX_TERRAIN_GRID_CELLS, suggestResolutionForSpan } from "../utils/terrainLimits";

interface Projection {
  rows: number;
  cols: number;
  cells: number;
  exceeds: boolean;
}

/**
 * A parsed envelope is only usable when it carries a source and a strictly
 * positive, finite X/Y span. This mirrors suggestResolutionForSpan's guard
 * (RangeError on non-finite or <=0 X/Y) so degenerate files are surfaced as a
 * user-facing alert instead of crashing the dialog.
 */
function hasUsableBounds(preview: {
  source?: string;
  span?: { x: number; y: number; z: number };
}): boolean {
  if (!preview?.source || !preview?.span) return false;
  const { x, y } = preview.span;
  return Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0;
}

export function UploadTerrainDialog() {
  const preview = useTerrainStore((s) => s.uploadPreview);
  const loading = useTerrainStore((s) => s.uploadPreviewLoading);
  const error = useTerrainStore((s) => s.uploadPreviewError);
  const cancelUploadPreview = useTerrainStore((s) => s.cancelUploadPreview);
  const confirmUploadPreview = useTerrainStore((s) => s.confirmUploadPreview);

  const [resolutionInput, setResolutionInput] = useState<string>('');

  const hasBounds = hasUsableBounds(preview ?? {});

  // Suggest a resolution each time a fresh bounds envelope arrives.
  useEffect(() => {
    if (hasBounds && preview?.span) {
      const suggested = suggestResolutionForSpan(preview.span.x, preview.span.y);
      setResolutionInput(suggested.toString());
    }
  }, [hasBounds, preview?.source, preview?.span?.x, preview?.span?.y]); // eslint-disable-line react-hooks/exhaustive-deps

  const projected = useMemo<Projection | null>(() => {
    if (!hasBounds || !preview) return null;
    const r = Number(resolutionInput);
    if (!Number.isFinite(r) || r <= 0) return null;
    const cols = Math.floor(preview.span.x / r) + 1;
    const rows = Math.floor(preview.span.y / r) + 1;
    const cells = rows * cols;
    return { rows, cols, cells, exceeds: cells > MAX_TERRAIN_GRID_CELLS };
  }, [hasBounds, preview, resolutionInput]);

  const handleResolutionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setResolutionInput(e.target.value);
  }, []);

  const handleConfirm = useCallback(() => {
    const r = Number(resolutionInput);
    if (!Number.isFinite(r) || r <= 0) return;
    if (projected && !projected.exceeds) {
      void confirmUploadPreview(r);
    }
  }, [resolutionInput, projected, confirmUploadPreview]);

  if (!preview) return null;

  const suggestedResolution = hasBounds && preview
    ? suggestResolutionForSpan(preview.span.x, preview.span.y)
    : null;

  const canConfirm = !!projected && !projected.exceeds && !loading;

  return (
    <div className="upload-dialog-backdrop" role="presentation" onClick={cancelUploadPreview}>
      <div
        className="upload-dialog glass-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="upload-dialog-title" className="upload-dialog-title">
          Subir topografía
        </h2>
        <p className="text-sm" style={{ marginBottom: '8px', opacity: 0.8 }}>
          {preview.filename}
        </p>

        {loading && !hasBounds && (
          <p className="text-sm" role="status">Parseando extensión del archivo…</p>
        )}

        {error && (
          <div className="error-text" role="alert">
            Error al parsear: {error}
          </div>
        )}

        {preview?.source && !hasBounds && (
          <>
            <div className="error-text" role="alert">
              El archivo no tiene una extensión X/Y válida: necesita dimensiones X e Y finitas y mayores a 0 para calcular una grilla.
            </div>
            <div className="upload-dialog-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={cancelUploadPreview}
                disabled={loading}
              >
                Cancelar
              </button>
            </div>
          </>
        )}

        {hasBounds && preview && (
          <>
            <dl className="upload-dialog-stats">
              <div className="upload-dialog-stat-row">
                <dt>Fuente</dt>
                <dd>{preview.source}</dd>
              </div>
              <div className="upload-dialog-stat-row">
                <dt>Puntos analizados</dt>
                <dd>{preview.pointCount.toLocaleString('es-CL')}</dd>
              </div>
              <div className="upload-dialog-stat-row">
                <dt>Dimensión X × Y</dt>
                <dd>
                  {preview.span.x.toFixed(1)} m × {preview.span.y.toFixed(1)} m
                </dd>
              </div>
              <div className="upload-dialog-stat-row">
                <dt>Rango Z (elevación)</dt>
                <dd>{preview.span.z.toFixed(1)} m</dd>
              </div>
              <div className="upload-dialog-stat-row">
                <dt>Resolución sugerida</dt>
                <dd>
                  <strong>{suggestedResolution} m</strong> (entra en el límite con margen)
                </dd>
              </div>
            </dl>

            <label className="upload-dialog-field">
              <span>Resolución (m)</span>
              <input
                type="number"
                inputMode="decimal"
                min="0.1"
                step="0.1"
                value={resolutionInput}
                onChange={handleResolutionChange}
                disabled={loading}
                aria-label="Resolución de muestreo en metros"
              />
            </label>

            {projected && (
              <div
                className={projected.exceeds ? 'upload-dialog-warning' : 'upload-dialog-preview'}
                role={projected.exceeds ? 'alert' : 'status'}
              >
                <div>
                  Grilla resultante: {projected.rows.toLocaleString('es-CL')} ×{' '}
                  {projected.cols.toLocaleString('es-CL')} ={' '}
                  <strong>{projected.cells.toLocaleString('es-CL')}</strong> celdas
                </div>
                <div>
                  {projected.exceeds
                    ? `⚠ Excede el límite de ${MAX_TERRAIN_GRID_CELLS.toLocaleString('es-CL')} celdas. Aumentá la resolución.`
                    : `✓ Entra en el límite de ${MAX_TERRAIN_GRID_CELLS.toLocaleString('es-CL')} celdas.`}
                </div>
              </div>
            )}

            <div className="upload-dialog-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={cancelUploadPreview}
                disabled={loading}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleConfirm}
                disabled={!canConfirm}
              >
                Cargar con {resolutionInput || '?'} m
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
