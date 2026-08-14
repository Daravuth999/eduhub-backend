/**
 * ReconcileQueue.jsx — admin UI over the backend's existing (previously
 * frontend-less) purchase reconciliation route. A purchase lands in
 * `reconcile` only when a GAS debit outcome was ambiguous (timeout,
 * network error, unparseable response) — never auto-resolved, per
 * video_library_tools.py's own discipline. An admin must confirm whether
 * the debit actually applied (via the student's own GAS ledger/balance)
 * before choosing Grant (succeeded) or Deny (failed, safe retry).
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, X, RefreshCw } from "lucide-react";
import { listReconcilePurchases, resolveReconcile } from "./videoLibraryApi";

export default function ReconcileQueue() {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      setQueue(await listReconcilePurchases());
    } catch (e) {
      setErr(e.message || "Failed to load the reconciliation queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const resolve = async (purchase, resolution) => {
    const key = `${purchase.studentId}::${purchase.lessonId}`;
    setBusyKey(key);
    setErr(null);
    try {
      await resolveReconcile(purchase.studentId, purchase.lessonId, resolution);
      await refresh();
    } catch (e) {
      setErr(e.message || "Resolution failed.");
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) return <div className="text-xs text-faded">Loading reconciliation queue…</div>;

  return (
    <div className="space-y-3" data-testid="reconcile-queue">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-300" />
          <h3 className="text-sm font-semibold text-parchment">Purchase Reconciliation</h3>
          {queue.length > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-300">
              {queue.length}
            </span>
          )}
        </div>
        <button onClick={refresh} data-testid="reconcile-refresh-button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 hover:bg-black/30 px-2.5 py-1 text-[11px] text-parchment">
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {err && <div className="text-xs text-red-400" data-testid="reconcile-error">{err}</div>}

      {queue.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-faded" data-testid="reconcile-empty">
          No ambiguous purchases pending — every GAS debit outcome resolved cleanly.
        </div>
      ) : (
        <div className="space-y-2">
          {queue.map((p) => {
            const key = `${p.studentId}::${p.lessonId}`;
            const busy = busyKey === key;
            return (
              <div key={key} className="rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-3 flex items-center justify-between gap-3 flex-wrap"
                   data-testid={`reconcile-row-${key}`}>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-parchment truncate">
                    {p.lessonTitle || p.lessonId}
                  </div>
                  <div className="text-[11px] text-faded">
                    Student {p.studentId} · {p.price} pts · reason: {p.reason || "unknown"}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => resolve(p, "failed")} disabled={busy}
                          data-testid={`reconcile-deny-${key}`}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-red-400/30 text-red-300 hover:bg-red-400/10 disabled:opacity-40">
                    <X size={11} /> Deny (retry)
                  </button>
                  <button onClick={() => resolve(p, "succeeded")} disabled={busy}
                          data-testid={`reconcile-grant-${key}`}
                          className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-black disabled:opacity-40">
                    <Check size={11} /> Grant ownership
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
