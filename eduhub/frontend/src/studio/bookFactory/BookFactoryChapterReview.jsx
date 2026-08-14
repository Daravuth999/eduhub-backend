/**
 * BookFactoryChapterReview.jsx — post-generation review with per-chapter
 * controls: manual retry (retryable/unknown only — a terminal chapter is NEVER
 * auto-retried), lock / unlock, regenerate (completed + unlocked only, with an
 * optional focused instruction), an explicit confirmed "Retry Chapter" escape
 * hatch for failed_terminal/unknown_outcome chapters, a "Retry All Failed"
 * bulk action, and job cancel. All operations use the stable chapterId, never
 * an array index. Raw internal state strings / warning codes are shown only
 * under a collapsible "Details" section — the primary UI uses friendly
 * teacher-facing labels.
 */
import { useState } from "react";
import { RefreshCw, AlertTriangle, Lock, Unlock, Wand2, XCircle, CheckCircle2, HelpCircle } from "lucide-react";

const RETRYABLE = new Set(["failed_retryable", "unknown_outcome"]); // terminal excluded
const TERMINAL_RETRYABLE = new Set(["failed_terminal", "unknown_outcome"]);

// Friendly, non-technical status the teacher sees by default. Raw state +
// warning codes remain available under "Details" — never hidden entirely.
function friendlyStatus(ch) {
  const warnings = ch.warnings || [];
  switch (ch.state) {
    case "pending": return { label: "Waiting", tone: "muted" };
    case "claimed":
    case "provider_pending": return { label: "Generating…", tone: "active" };
    case "completed":
      return warnings.length > 0
        ? { label: "Complete with review notes", tone: "good" }
        : { label: "Complete", tone: "good" };
    case "failed_retryable": return { label: "Needs retry", tone: "warn" };
    case "failed_terminal": return { label: "Failed — you can retry this chapter", tone: "bad" };
    case "unknown_outcome": return { label: "Outcome uncertain — manual review", tone: "warn" };
    default: return { label: "Waiting", tone: "muted" };
  }
}

const TONE_CLASS = {
  muted: "text-faded",
  active: "text-gold",
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
};
const TONE_ICON = { good: CheckCircle2, warn: AlertTriangle, bad: AlertTriangle, active: RefreshCw, muted: HelpCircle };

export const BookFactoryChapterReview = ({
  job, onRetry, onRegenerate, onRetryFailed, onToggleLock, onCancel, busyChapterId,
}) => {
  const [focusFor, setFocusFor] = useState(null);
  const [focusText, setFocusText] = useState("");
  const [detailsFor, setDetailsFor] = useState(() => new Set());
  const [confirmRetryFor, setConfirmRetryFor] = useState(null);
  const [confirmRetryAll, setConfirmRetryAll] = useState(false);
  if (!job) return null;
  const order = job.chapterOrder || [];
  const chapters = job.chapters || {};
  const cancelled = job.state === "cancelled";

  const failedChapterIds = order.filter((cid) => TERMINAL_RETRYABLE.has((chapters[cid] || {}).state));

  const toggleDetails = (cid) => {
    setDetailsFor((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid); else next.add(cid);
      return next;
    });
  };

  const runRetryFailed = (cid) => { setConfirmRetryFor(null); onRetryFailed?.(cid); };
  const runRetryAllFailed = () => {
    setConfirmRetryAll(false);
    failedChapterIds.forEach((cid) => onRetryFailed?.(cid));
  };

  return (
    <div className="space-y-2" data-testid="book-factory-chapter-review">
      {failedChapterIds.length > 0 && onRetryFailed && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-900/10 p-2.5" data-testid="bf-retry-all-failed-panel">
          {!confirmRetryAll ? (
            <button data-testid="bf-retry-all-failed" onClick={() => setConfirmRetryAll(true)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 px-3 py-1 text-[11px] text-amber-200 hover:bg-amber-900/20">
              <RefreshCw className="h-3 w-3" /> Retry All Failed Chapters ({failedChapterIds.length})
            </button>
          ) : (
            <div className="space-y-1.5" data-testid="bf-retry-all-failed-confirm">
              <p className="text-[11.5px] text-amber-100/90">
                {failedChapterIds.length} chapter{failedChapterIds.length === 1 ? "" : "s"} will be retried — up to{" "}
                {failedChapterIds.length * 2} new Gemini call{failedChapterIds.length * 2 === 1 ? "" : "s"} total. Continue?
              </p>
              <div className="flex gap-2">
                <button data-testid="bf-retry-all-failed-confirm-go" onClick={runRetryAllFailed}
                        className="rounded-full bg-gold px-3 py-1 text-[11px] font-bold text-ink">Retry all</button>
                <button data-testid="bf-retry-all-failed-cancel" onClick={() => setConfirmRetryAll(false)}
                        className="rounded-full border border-parchment/30 px-3 py-1 text-[11px] text-parchment">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {order.map((cid) => {
        const ch = chapters[cid] || {};
        const warnings = ch.warnings || [];
        const canRetry = RETRYABLE.has(ch.state);
        const canRetryFailed = TERMINAL_RETRYABLE.has(ch.state);
        const canRegen = ch.state === "completed" && !ch.locked;
        const busy = busyChapterId === cid;
        const status = friendlyStatus(ch);
        const StatusIcon = TONE_ICON[status.tone] || HelpCircle;
        const detailsOpen = detailsFor.has(cid);
        return (
          <div key={cid} className="rounded-lg border border-gold/15 bg-walnut/20 p-3"
               data-testid="bf-review-chapter" data-chapter-id={cid} data-state={ch.state} data-locked={ch.locked ? "1" : "0"}>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-parchment/90">{ch.title || cid}</span>
              <span data-testid={`bf-friendly-status-${cid}`}
                    className={`inline-flex items-center gap-1 text-[11px] ${TONE_CLASS[status.tone]}`}>
                <StatusIcon className={`h-3 w-3 ${status.tone === "active" ? "animate-spin" : ""}`} />
                {status.label}{ch.locked ? " · locked" : ""}
              </span>
            </div>

            <button data-testid={`bf-toggle-details-${cid}`} onClick={() => toggleDetails(cid)}
                    className="mt-1 text-[10.5px] text-faded underline underline-offset-2">
              {detailsOpen ? "Hide details" : "Details"}
            </button>
            {detailsOpen && (
              <div className="mt-1 space-y-1" data-testid={`bf-details-${cid}`}>
                <p className="text-[10.5px] text-faded">Raw state: {ch.state}{ch.lastError ? ` · ${ch.lastError}` : ""}</p>
                {warnings.length > 0 && (
                  <ul className="space-y-0.5" data-testid="bf-review-warnings">
                    {warnings.map((w, i) => (
                      <li key={i} className="text-[11px] text-amber-300/90 inline-flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> {w.type}{w.reason ? ` · ${w.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-1.5">
              {canRetry && (
                <button data-testid={`bf-retry-${cid}`} disabled={busy} onClick={() => onRetry(cid)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 px-3 py-1 text-[11px] text-gold hover:bg-gold/10 disabled:opacity-40">
                  <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} /> Retry
                </button>
              )}
              {canRetryFailed && onRetryFailed && confirmRetryFor !== cid && (
                <button data-testid={`bf-retry-failed-${cid}`} disabled={busy} onClick={() => setConfirmRetryFor(cid)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-red-400/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-900/20 disabled:opacity-40">
                  <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} /> Retry Chapter
                </button>
              )}
              {onToggleLock && (
                <button data-testid={`bf-lock-${cid}`} onClick={() => onToggleLock(cid, !!ch.locked)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 px-3 py-1 text-[11px] text-gold hover:bg-gold/10">
                  {ch.locked ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />} {ch.locked ? "Unlock" : "Lock"}
                </button>
              )}
              {canRegen && onRegenerate && (
                <button data-testid={`bf-regenerate-${cid}`} disabled={busy}
                        onClick={() => { setFocusFor(focusFor === cid ? null : cid); setFocusText(""); }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 px-3 py-1 text-[11px] text-gold hover:bg-gold/10 disabled:opacity-40">
                  <Wand2 className="h-3 w-3" /> Regenerate
                </button>
              )}
            </div>

            {confirmRetryFor === cid && (
              <div className="mt-2 flex items-center gap-2" data-testid={`bf-retry-failed-confirm-${cid}`}>
                <span className="text-[11px] text-amber-100/90">Retry this chapter? This will call Gemini again.</span>
                <button data-testid={`bf-retry-failed-confirm-go-${cid}`} onClick={() => runRetryFailed(cid)}
                        className="rounded-full bg-gold px-3 py-1 text-[11px] font-bold text-ink">Retry</button>
                <button data-testid={`bf-retry-failed-cancel-${cid}`} onClick={() => setConfirmRetryFor(null)}
                        className="rounded-full border border-parchment/30 px-3 py-1 text-[11px] text-parchment">Cancel</button>
              </div>
            )}

            {focusFor === cid && (
              <div className="mt-2 flex gap-2" data-testid={`bf-focus-${cid}`}>
                <input value={focusText} onChange={(e) => setFocusText(e.target.value)} data-testid={`bf-focus-input-${cid}`}
                       placeholder="Optional focused instruction…"
                       className="flex-1 rounded-lg bg-walnut/40 border border-gold/20 px-2 py-1 text-[12px] text-parchment outline-none" />
                <button data-testid={`bf-focus-go-${cid}`}
                        onClick={() => { onRegenerate(cid, focusText); setFocusFor(null); }}
                        className="rounded-full bg-gold px-3 py-1 text-[11px] font-bold text-ink">Go</button>
              </div>
            )}
          </div>
        );
      })}
      {onCancel && !cancelled && (
        <button data-testid="bf-cancel-job" onClick={onCancel}
                className="inline-flex items-center gap-1.5 rounded-full border border-red-400/40 px-3 py-1 text-[11px] text-red-300 hover:bg-red-900/20">
          <XCircle className="h-3 w-3" /> Cancel job
        </button>
      )}
      {cancelled && <p className="text-[11px] text-red-300" data-testid="bf-cancelled-note">This job is cancelled.</p>}
    </div>
  );
};

export default BookFactoryChapterReview;
