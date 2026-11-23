/**
 * QualityPolicyControl — compact control for the shared, editable quality
 * bands. Edits reclassify existing scores without rerunning LOS; invalid
 * changes are rejected visibly and never silently reordered.
 */

import { useState } from "react";
import { useQualityPolicyStore } from "../store/qualityPolicyStore";
import { DEFAULT_QUALITY_POLICY } from "../utils/qualityMetrics";
import "../styles/panels.css";

export function QualityPolicyControl() {
  const policy = useQualityPolicyStore((s) => s.policy);
  const setPolicy = useQualityPolicyStore((s) => s.setPolicy);
  const resetPolicy = useQualityPolicyStore((s) => s.resetPolicy);
  const [error, setError] = useState<string | null>(null);
  // Drafts keep partial edits visible; empty/non-numeric drafts never mutate the policy.
  const [mediumDraft, setMediumDraft] = useState(String(policy.mediumMin));
  const [highDraft, setHighDraft] = useState(String(policy.highMin));

  const apply = (raw: string, member: "mediumMin" | "highMin") => {
    const setDraft = member === "mediumMin" ? setMediumDraft : setHighDraft;
    setDraft(raw);
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) {
      setError("Complete ambos umbrales con valores numéricos entre 0 y 1.");
      return;
    }
    const next = member === "mediumMin"
      ? { mediumMin: Number(raw), highMin: policy.highMin }
      : { mediumMin: policy.mediumMin, highMin: Number(raw) };
    const accepted = setPolicy(next);
    if (accepted) {
      setError(null);
      // Keep the other field in sync with the accepted policy value.
      if (member === "mediumMin") setHighDraft(String(next.highMin));
      else setMediumDraft(String(next.mediumMin));
    } else {
      setError("Umbrales no válidos: se requiere 0 ≤ media mínima < alta mínima ≤ 1.");
    }
  };

  const reset = () => {
    resetPolicy();
    setMediumDraft(String(DEFAULT_QUALITY_POLICY.mediumMin));
    setHighDraft(String(DEFAULT_QUALITY_POLICY.highMin));
    setError(null);
  };

  return (
    <div className="panel-fields" data-testid="quality-policy-control">
      <div className="panel-info-row"><span className="cs-label">Bandas de calidad</span><details className="panel-info"><summary aria-label="Información de bandas">i</summary><div>Bandas configurables compartidas (provisionales, no certificadas por equipo). Editar los umbrales reclasifica los resultados existentes sin recalcular el LOS.</div></details></div>
      <div className="panel-policy-row field-row">
        <label style={{ fontSize: "10px", display: "flex", flexDirection: "column", gap: "2px" }}>
          Media desde
          <input aria-label="Media mínima"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={mediumDraft}
            onChange={(e) => apply(e.target.value, "mediumMin")}
            style={{ width: "70px" }}
          />
        </label>
        <label style={{ fontSize: "10px", display: "flex", flexDirection: "column", gap: "2px" }}>
          Alta desde
          <input aria-label="Alta mínima"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={highDraft}
            onChange={(e) => apply(e.target.value, "highMin")}
            style={{ width: "70px" }}
          />
        </label>
        <button className="btn-compact" onClick={reset}>
          Restablecer (0.30 / 0.70)
        </button>
      </div>
      {error && (
        <div className="error-text" role="alert" style={{ fontSize: "10px", marginTop: "6px" }}>
          {error}
        </div>
      )}

    </div>
  );
}
