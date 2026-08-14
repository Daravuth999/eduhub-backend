import { AnimatePresence, motion } from "framer-motion";
import { Bug, Loader2, RefreshCw, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { PollDebug } from "../../hooks/usePoints";

interface Props {
  debug: PollDebug;
  loading: boolean;
  currentPoints: number;
  onRefreshNow: () => void;
  onTriggerTest: (amount: number) => void;
}

/**
 * Diagnostic drawer for points-celebration. Hidden by default — visible only
 * when the URL contains `?debug=1` (also wired up via TopBar bug button).
 *
 * Shows:
 *  - last successful poll time
 *  - prev / current balance, last delta
 *  - the RAW value the backend returned (catches type mismatches)
 *  - "Refresh now" button
 *  - "Trigger test +N" buttons for each tier
 */
export function DebugDrawer({
  debug,
  loading,
  currentPoints,
  onRefreshNow,
  onTriggerTest,
}: Props) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-open if URL has ?debug=1
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "1") setOpen(true);
  }, []);

  const ago = debug.lastPolledAt
    ? Math.max(0, Math.round((now - debug.lastPolledAt) / 1000))
    : null;

  return (
    <>
      {/* Floating bug icon to toggle the drawer */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Toggle debug drawer"
        data-testid="debug-toggle"
        className="no-print fixed bottom-6 left-6 z-30 h-11 w-11 rounded-full ink-shadow-lg flex items-center justify-center transition"
        style={{
          background: open ? "var(--color-needs)" : "var(--color-surface)",
          color: open ? "var(--color-surface)" : "var(--color-ink-soft)",
          border: "1px solid var(--color-line-strong)",
        }}
      >
        <Bug className="h-4 w-4" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: -380, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -380, opacity: 0 }}
            transition={{ type: "spring", damping: 24, stiffness: 220 }}
            className="no-print fixed bottom-20 left-6 z-30 w-[340px] max-w-[90vw] rounded-2xl border ink-shadow-lg overflow-hidden"
            style={{
              background: "var(--color-surface)",
              borderColor: "var(--color-line-strong)",
            }}
            data-testid="debug-drawer"
          >
            <div
              className="flex items-center gap-2 px-4 py-2.5 text-[color:var(--color-surface)]"
              style={{ background: "var(--color-ink)" }}
            >
              <Bug className="h-4 w-4" />
              <span className="display font-bold text-sm">Points Debug</span>
              <button
                onClick={() => setOpen(false)}
                className="ml-auto h-7 w-7 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="p-4 space-y-3 text-[13px]">
              {/* Live state */}
              <div className="rounded-xl border p-3 space-y-1.5"
                style={{ background: "var(--color-surface-2)", borderColor: "var(--color-line)" }}
              >
                <Row label="Current balance">
                  <span className="mono font-bold tnum">
                    {currentPoints.toLocaleString()}
                  </span>
                </Row>
                <Row label="Previous polled">
                  <span className="mono tnum">
                    {debug.previous.toLocaleString()}
                  </span>
                </Row>
                <Row label="Last delta" tone={debug.lastDelta > 0 ? "good" : "muted"}>
                  <span className="mono tnum font-bold">
                    {debug.lastDelta > 0 ? "+" : ""}
                    {debug.lastDelta}
                  </span>
                </Row>
                <Row label="Persisted baseline">
                  <span className="mono tnum text-[12px]">
                    {debug.baselineFromMemory === null
                      ? "(none yet)"
                      : debug.baselineFromMemory.toLocaleString()}
                    {debug.baselineWrittenAt && (
                      <span
                        className="ml-1.5"
                        style={{ color: "var(--color-ink-mute)" }}
                      >
                        {Math.round(
                          (Date.now() - debug.baselineWrittenAt) / 60000,
                        )}m ago
                      </span>
                    )}
                  </span>
                </Row>
                <Row label="Backend raw value">
                  <code
                    className="mono text-[11px] px-1.5 py-0.5 rounded"
                    style={{ background: "var(--color-bg)" }}
                  >
                    {JSON.stringify(debug.lastRawPoints)}
                  </code>
                </Row>
                <Row label="Last poll">
                  <span className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                    {ago === null ? "never" : `${ago}s ago`}
                    {" · "}#{debug.pollCount}
                  </span>
                </Row>
              </div>

              {/* Manual refresh */}
              <button
                onClick={onRefreshNow}
                disabled={loading}
                data-testid="debug-refresh-btn"
                className="w-full py-2 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition disabled:opacity-60"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-surface)",
                }}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh balance now
              </button>

              {/* Test triggers — verify the UI works without backend changes */}
              <div className="space-y-1.5">
                <div
                  className="text-[10px] uppercase tracking-wider font-bold"
                  style={{ color: "var(--color-ink-soft)" }}
                >
                  Trigger test celebration
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { amount: 5, label: "+5 (tiny)" },
                    { amount: 25, label: "+25 (nice)" },
                    { amount: 100, label: "+100 (big) 🎆" },
                    { amount: 500, label: "+500 (huge) 🎇" },
                  ].map((b) => (
                    <button
                      key={b.amount}
                      onClick={() => onTriggerTest(b.amount)}
                      data-testid={`debug-trigger-${b.amount}`}
                      className="py-1.5 px-2 rounded-lg text-[12px] font-semibold border transition flex items-center justify-center gap-1"
                      style={{
                        background: "var(--color-surface-2)",
                        borderColor: "var(--color-line)",
                        color: "var(--color-ink)",
                      }}
                    >
                      <Zap className="h-3 w-3" />
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className="text-[11px] leading-relaxed pt-2 border-t"
                style={{
                  color: "var(--color-ink-soft)",
                  borderColor: "var(--color-line)",
                }}
              >
                <strong>Tip:</strong> open browser DevTools → Console to see
                <code className="mono mx-1 px-1 rounded" style={{ background: "var(--color-bg)" }}>
                  [points] poll …
                </code>
                logs from every refresh — confirms what the backend returns.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function Row({
  label,
  children,
  tone = "default",
}: {
  label: string;
  children: React.ReactNode;
  tone?: "default" | "good" | "muted";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className="text-[11px] uppercase tracking-wider font-bold"
        style={{ color: "var(--color-ink-soft)" }}
      >
        {label}
      </span>
      <span
        style={{
          color:
            tone === "good"
              ? "var(--color-excellent)"
              : tone === "muted"
                ? "var(--color-ink-mute)"
                : "var(--color-ink)",
        }}
      >
        {children}
      </span>
    </div>
  );
}
