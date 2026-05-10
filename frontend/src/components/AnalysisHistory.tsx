import { useAnalysisStore } from "../store/analysisStore";

export function AnalysisHistory() {
  const history = useAnalysisStore((s) => s.history);
  const clearHistory = useAnalysisStore((s) => s.clearHistory);
  const restoreHistoryEntry = useAnalysisStore((s) => s.restoreHistoryEntry);

  if (history.length === 0) return null;

  return (
    <div className="glass-panel mt-4">
      <div className="flex-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h3 style={{ margin: 0 }}>History</h3>
        <button
          onClick={clearHistory}
          style={{
            background: "transparent",
            border: "none",
            color: "#ff5555",
            cursor: "pointer",
            fontSize: "10px",
            textTransform: "uppercase",
            fontWeight: "bold"
          }}
        >
          Clear
        </button>
      </div>

      <div className="flex-col" style={{ gap: "6px" }}>
        {history.map((entry, idx) => (
          <button
            key={`${entry.timestamp}-${idx}`}
            onClick={() => restoreHistoryEntry(idx)}
            title="Click to restore this coverage result"
            style={{
              all: "unset",
              display: "block",
              width: "100%",
              padding: "8px",
              background: "rgba(255,255,255,0.05)",
              borderRadius: "4px",
              fontSize: "11px",
              cursor: "pointer",
              boxSizing: "border-box",
              transition: "background 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
          >
            <div className="flex-row" style={{ justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ opacity: 0.6 }}>{entry.timestamp}</span>
              <span style={{ color: entry.coveragePct > 50 ? "#0adb21" : "#ffbb00", fontWeight: "bold" }}>
                {entry.coveragePct.toFixed(1)}%
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px" }}>
              <span><span style={{ opacity: 0.5 }}>X:</span> {entry.position.x.toFixed(0)}</span>
              <span><span style={{ opacity: 0.5 }}>Y:</span> {entry.position.y.toFixed(0)}</span>
              <span><span style={{ opacity: 0.5 }}>Z:</span> {entry.position.z.toFixed(0)}</span>
            </div>
            <div style={{ opacity: 0.4, marginTop: "4px", fontSize: "9px", textAlign: "right" }}>
              ▶ click to restore
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
