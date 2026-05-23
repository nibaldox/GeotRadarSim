import { useAnalysisStore } from "../store/analysisStore";

export function AnalysisHistory() {
  const history = useAnalysisStore((s) => s.history);
  const clearHistory = useAnalysisStore((s) => s.clearHistory);
  const toggleHistoryEntrySelection = useAnalysisStore((s) => s.toggleHistoryEntrySelection);
  const removeHistoryEntry = useAnalysisStore((s) => s.removeHistoryEntry);

  if (history.length === 0) return null;

  return (
    <div className="glass-panel mt-4">
      <div className="flex-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h3 style={{ margin: 0 }}>History</h3>
        <button
          onClick={clearHistory}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--danger)",
            cursor: "pointer",
            fontSize: "10px",
            textTransform: "uppercase",
            fontWeight: "bold",
            letterSpacing: "0.05em"
          }}
        >
          Clear All
        </button>
      </div>

      <div className="flex-col" style={{ gap: "8px" }}>
        {history.map((entry, idx) => {
          const isSelected = !!entry.selected;
          return (
            <div
              key={`${entry.timestamp}-${idx}`}
              onClick={() => toggleHistoryEntrySelection(idx)}
              title="Click to toggle selection & merge coverage"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                width: "100%",
                padding: "10px",
                background: isSelected ? "var(--accent-glow)" : "rgba(255,255,255,0.03)",
                border: isSelected ? "1px solid var(--accent-color)" : "1px solid var(--panel-border)",
                borderRadius: "8px",
                fontSize: "11px",
                cursor: "pointer",
                boxSizing: "border-box",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                position: "relative"
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                  e.currentTarget.style.borderColor = "var(--panel-border-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                  e.currentTarget.style.borderColor = "var(--panel-border)";
                }
              }}
            >
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => {}} // Toggled by parent div onClick
                style={{
                  cursor: "pointer",
                  accentColor: "var(--accent-color)",
                  width: "14px",
                  height: "14px"
                }}
              />

              {/* Card info */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "2px" }}>
                <div className="flex-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ opacity: 0.6, fontSize: "10px", fontFamily: "var(--font-mono)" }}>
                    {entry.timestamp}
                  </span>
                  <span style={{ color: entry.coveragePct > 50 ? "var(--success)" : "var(--warning)", fontWeight: "bold", fontFamily: "var(--font-mono)" }}>
                    {entry.coveragePct.toFixed(1)}%
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", opacity: 0.8, fontFamily: "var(--font-mono)", fontSize: "10px" }}>
                  <span><span style={{ opacity: 0.4 }}>X:</span> {entry.position.x.toFixed(0)}</span>
                  <span><span style={{ opacity: 0.4 }}>Y:</span> {entry.position.y.toFixed(0)}</span>
                  <span><span style={{ opacity: 0.4 }}>Z:</span> {entry.position.z.toFixed(0)}</span>
                </div>
              </div>

              {/* Deletion "X" Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation(); // Prevent parent toggle
                  removeHistoryEntry(idx);
                }}
                title="Remove from history"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: "bold",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--danger)";
                  e.currentTarget.style.background = "rgba(255, 0, 0, 0.1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-secondary)";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                &times;
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
