/**
 * PrizePoolStudio.jsx — Author Studio's "Prize Pools" screen (architecture
 * continuation: the reusable Prize Pool Platform — "one pool, multiple
 * consumers, live synchronization, every deduction updates one ledger").
 *
 * This is an OPERATIONAL view, not a second ledger UI: balance and ledger
 * are both live reads through wallet_service (the pool's funds live in a
 * virtual `pool_<id>` wallet inside the same points_wallets/
 * points_transactions collections every student wallet uses). Contribute/
 * distribute here call the exact same admin routes any other consumer
 * (Event Engine, a future Weekly Rewards module, etc.) would call — this
 * screen exists mainly to create pools, audit them, and drive the
 * open -> locked -> settled/cancelled lifecycle, plus manual testing.
 *
 * Speaking Lab funding-source migration: "Fund" is the administrator
 * funding action (a pure wallet credit — no student ever pays into a
 * pool this way) and "Link session" associates a pool with a specific
 * speaking_lab_sessions doc so its Lucky Draw splits THIS pool's live
 * balance instead of summing student entry fees. Lucky Draw's own
 * settlement/payout logic is completely untouched — see lucky_draw.py's
 * module docstring.
 *
 * Backend: prize_pool.py, mounted at /api/v1/prize-pools*.
 */
import { useCallback, useEffect, useState } from "react";
import { Coins, RefreshCw, Plus, Lock, Unlock, Flag, XCircle, ArrowDownToLine, ArrowUpFromLine, History, Wallet, Link2 } from "lucide-react";
import {
  listPrizePools, createPrizePool, getPrizePoolBalance, getPrizePoolLedger,
  contributeToPrizePool, distributeFromPrizePool, lockPrizePool, unlockPrizePool,
  settlePrizePool, cancelPrizePool, fundPrizePool, linkPrizePoolToSession,
} from "./api";

const KNOWN_OWNER_TYPES = [
  "event", "speaking_lab_session", "weekly_reward", "tournament", "promotion",
  "topup_campaign", "referral_campaign", "seasonal_event",
];

function Badge({ children, color = "muted" }) {
  const colors = {
    gold:  { bg: "rgba(212,168,67,0.15)",  border: "rgba(212,168,67,0.4)",  text: "#FFE19A" },
    green: { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)", text: "#6ee7b7" },
    blue:  { bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.3)",  text: "#93c5fd" },
    red:   { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.35)", text: "#fca5a5" },
    muted: { bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)", text: "#9ca3af" },
  };
  const c = colors[color] || colors.muted;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
      {children}
    </span>
  );
}

const STATUS_COLOR = { open: "green", locked: "gold", settled: "blue", cancelled: "red" };

/* ── Create-pool form ─────────────────────────────────────────────────── */
function CreateForm({ onCreated }) {
  const [name, setName] = useState("");
  const [ownerType, setOwnerType] = useState("event");
  const [ownerRef, setOwnerRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const handleCreate = async () => {
    setErr(null);
    setSaving(true);
    try {
      await createPrizePool({ name: name.trim(), owner_type: ownerType.trim(), owner_ref: ownerRef.trim() });
      setName(""); setOwnerRef("");
      onCreated();
    } catch (e) {
      setErr(e.message || "Create failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="text-sm font-semibold text-parchment">Create a prize pool</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-xs text-faded">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="Speaking Lab — July Tournament"
                 data-testid="prize-pools-new-name-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Owner type
          <input value={ownerType} onChange={(e) => setOwnerType(e.target.value)}
                 list="prize-pools-owner-type-suggestions"
                 data-testid="prize-pools-new-owner-type-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
          <datalist id="prize-pools-owner-type-suggestions">
            {KNOWN_OWNER_TYPES.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs text-faded">
          Owner ref (optional)
          <input value={ownerRef} onChange={(e) => setOwnerRef(e.target.value)}
                 placeholder="event id, campaign id, …"
                 data-testid="prize-pools-new-owner-ref-input"
                 className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        </label>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      <button disabled={saving} onClick={handleCreate}
              data-testid="prize-pools-create-button"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
        <Plus className="h-3.5 w-3.5" /> {saving ? "Creating…" : "Create pool"}
      </button>
    </div>
  );
}

/* ── Balance panel ───────────────────────────────────────────────────────── */
function BalancePanel({ pool }) {
  const [balance, setBalance] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPrizePoolBalance(pool._id)
      .then((data) => { if (!cancelled) setBalance(data.balance); })
      .catch((e) => { if (!cancelled) setErr(e.message || "Failed to load balance."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pool._id]);

  if (loading) return <div className="text-xs text-faded" data-testid={`prize-pools-balance-${pool._id}`}>Loading balance…</div>;
  if (err) return <div className="text-xs text-red-400" data-testid={`prize-pools-balance-${pool._id}`}>{err}</div>;
  return (
    <div className="text-xs text-faded" data-testid={`prize-pools-balance-${pool._id}`}>
      Balance: <span className="text-parchment font-semibold">{balance}</span> pts
    </div>
  );
}

/* ── Ledger panel ────────────────────────────────────────────────────────── */
function LedgerPanel({ pool, onClose }) {
  const [entries, setEntries] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getPrizePoolLedger(pool._id)
      .then((data) => { if (!cancelled) setEntries(data.entries || []); })
      .catch((e) => { if (!cancelled) setErr(e.message || "Failed to load ledger."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pool._id]);

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2" data-testid={`prize-pools-ledger-${pool._id}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-parchment">Ledger — {pool.name}</div>
        <button onClick={onClose} className="text-xs text-faded hover:text-parchment">Close</button>
      </div>
      {loading ? (
        <div className="text-xs text-faded">Loading…</div>
      ) : err ? (
        <div className="text-xs text-red-400">{err}</div>
      ) : entries.length === 0 ? (
        <div className="text-xs text-faded">No ledger entries yet.</div>
      ) : (
        <div className="space-y-1">
          {entries.map((entry, idx) => (
            <div key={entry.id || entry._id || idx} className="text-[11px] text-faded flex justify-between gap-2">
              <span className="text-parchment">{entry.source || entry.type}</span>
              <span>{entry.amount}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Contribute / distribute form ───────────────────────────────────────── */
function TransferForm({ pool, mode, onDone, onCancel }) {
  const [studentId, setStudentId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const handleSubmit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const idempotencyKey = `studio-${mode}-${pool._id}-${Date.now()}`;
      if (mode === "contribute") {
        await contributeToPrizePool(pool._id, {
          student_id: studentId.trim(), amount: Number(amount), idempotency_key: idempotencyKey,
        });
      } else {
        await distributeFromPrizePool(pool._id, {
          student_id: studentId.trim(), amount: Number(amount), idempotency_key: idempotencyKey, reason: reason.trim(),
        });
      }
      onDone();
    } catch (e) {
      setErr(e.message || "Transfer failed.");
    } finally {
      setBusy(false);
    }
  };

  const testPrefix = mode === "contribute" ? "prize-pools-contribute" : "prize-pools-distribute";

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
      <div className="text-xs font-semibold text-parchment">
        {mode === "contribute" ? "Contribute into pool" : "Distribute from pool"}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input value={studentId} onChange={(e) => setStudentId(e.target.value)}
               placeholder="Student ID"
               data-testid={`${testPrefix}-student-${pool._id}`}
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)}
               placeholder="Amount" type="number"
               data-testid={`${testPrefix}-amount-${pool._id}`}
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      </div>
      {mode === "distribute" && (
        <input value={reason} onChange={(e) => setReason(e.target.value)}
               placeholder="Reason (optional)"
               data-testid={`${testPrefix}-reason-${pool._id}`}
               className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      )}
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={busy} onClick={handleSubmit}
                data-testid={`${testPrefix}-submit-${pool._id}`}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          {mode === "contribute" ? <ArrowDownToLine className="h-3.5 w-3.5" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
          {busy ? "Submitting…" : "Submit"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Fund form (admin credit — no student ever pays into the pool) ───────── */
function FundForm({ pool, onDone, onCancel }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const handleSubmit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await fundPrizePool(pool._id, {
        amount: Number(amount),
        idempotency_key: `studio-fund-${pool._id}-${Date.now()}`,
        note: note.trim(),
      });
      onDone();
    } catch (e) {
      setErr(e.message || "Funding failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
      <div className="text-xs font-semibold text-parchment">
        Fund pool (administrator budget — no student wallet is debited)
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input value={amount} onChange={(e) => setAmount(e.target.value)}
               placeholder="Amount" type="number"
               data-testid={`prize-pools-fund-amount-${pool._id}`}
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
        <input value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="Note (optional)"
               data-testid={`prize-pools-fund-note-${pool._id}`}
               className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={busy} onClick={handleSubmit}
                data-testid={`prize-pools-fund-submit-${pool._id}`}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          <Wallet className="h-3.5 w-3.5" /> {busy ? "Funding…" : "Fund"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Link-to-session form (Speaking Lab funding-source migration) ────────── */
function LinkSessionForm({ pool, onDone, onCancel }) {
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const handleSubmit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await linkPrizePoolToSession(pool._id, sessionId.trim());
      onDone();
    } catch (e) {
      setErr(e.message || "Link failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
      <div className="text-xs font-semibold text-parchment">
        Associate with a Speaking Lab session
      </div>
      <p className="text-[11px] text-faded">
        The Lucky Draw for this session will split THIS pool's live balance instead of summing student entry fees.
      </p>
      <input value={sessionId} onChange={(e) => setSessionId(e.target.value)}
             placeholder="Session ID"
             data-testid={`prize-pools-link-session-input-${pool._id}`}
             className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button disabled={busy} onClick={handleSubmit}
                data-testid={`prize-pools-link-session-submit-${pool._id}`}
                className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
          <Link2 className="h-3.5 w-3.5" /> {busy ? "Linking…" : "Link session"}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-faded hover:text-parchment">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Pool row ─────────────────────────────────────────────────────────────── */
function PoolRow({ pool, onChanged }) {
  const [showLedger, setShowLedger] = useState(false);
  const [transferMode, setTransferMode] = useState(null); // "contribute" | "distribute" | null
  const [showFund, setShowFund] = useState(false);
  const [showLinkSession, setShowLinkSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (fn) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`prize-pools-row-${pool._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-parchment">{pool.name}</span>
          <Badge color="gold">{pool.owner_type}</Badge>
          <Badge color={STATUS_COLOR[pool.status] || "muted"}>{pool.status}</Badge>
          {pool.linked_session_id ? (
            <span className="text-[10px] text-faded/70" data-testid={`prize-pools-linked-session-${pool._id}`}>
              → funding session: {pool.linked_session_id}
            </span>
          ) : (
            <span className="text-[10px] text-faded/50">not linked to a session yet</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button disabled={busy} onClick={() => setShowLedger((v) => !v)}
                  data-testid={`prize-pools-ledger-toggle-${pool._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
            <History className="h-3 w-3" /> Ledger
          </button>
          <button disabled={busy} onClick={() => setShowLinkSession((v) => !v)}
                  data-testid={`prize-pools-link-session-toggle-${pool._id}`}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
            <Link2 className="h-3 w-3" /> Link session
          </button>
          {pool.status === "open" && (
            <button disabled={busy} onClick={() => setShowFund((v) => !v)}
                    data-testid={`prize-pools-fund-toggle-${pool._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              <Wallet className="h-3 w-3" /> Fund
            </button>
          )}
          {pool.status === "open" && (
            <button disabled={busy} onClick={() => setTransferMode((m) => (m === "contribute" ? null : "contribute"))}
                    data-testid={`prize-pools-contribute-toggle-${pool._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Contribute
            </button>
          )}
          {(pool.status === "open" || pool.status === "locked") && (
            <button disabled={busy} onClick={() => setTransferMode((m) => (m === "distribute" ? null : "distribute"))}
                    data-testid={`prize-pools-distribute-toggle-${pool._id}`}
                    className="rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              Distribute
            </button>
          )}
          {pool.status === "open" && (
            <button disabled={busy} onClick={() => run(() => lockPrizePool(pool._id))}
                    data-testid={`prize-pools-lock-${pool._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              <Lock className="h-3 w-3" /> Lock
            </button>
          )}
          {pool.status === "locked" && (
            <button disabled={busy} onClick={() => run(() => unlockPrizePool(pool._id))}
                    data-testid={`prize-pools-unlock-${pool._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              <Unlock className="h-3 w-3" /> Unlock
            </button>
          )}
          {pool.status === "locked" && (
            <button disabled={busy} onClick={() => run(() => settlePrizePool(pool._id))}
                    data-testid={`prize-pools-settle-${pool._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-faded hover:text-parchment hover:bg-white/10">
              <Flag className="h-3 w-3" /> Settle
            </button>
          )}
          {(pool.status === "open" || pool.status === "locked") && (
            <button disabled={busy} onClick={() => run(() => cancelPrizePool(pool._id))}
                    data-testid={`prize-pools-cancel-${pool._id}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-red-400 hover:bg-red-500/10">
              <XCircle className="h-3 w-3" /> Cancel
            </button>
          )}
        </div>
      </div>
      <div className="mt-2">
        <BalancePanel pool={pool} />
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      {showFund && (
        <div className="mt-3">
          <FundForm pool={pool} onDone={() => { setShowFund(false); onChanged(); }}
                    onCancel={() => setShowFund(false)} />
        </div>
      )}
      {showLinkSession && (
        <div className="mt-3">
          <LinkSessionForm pool={pool} onDone={() => { setShowLinkSession(false); onChanged(); }}
                            onCancel={() => setShowLinkSession(false)} />
        </div>
      )}
      {transferMode && (
        <div className="mt-3">
          <TransferForm pool={pool} mode={transferMode}
                        onDone={() => { setTransferMode(null); onChanged(); }}
                        onCancel={() => setTransferMode(null)} />
        </div>
      )}
      {showLedger && (
        <div className="mt-3">
          <LedgerPanel pool={pool} onClose={() => setShowLedger(false)} />
        </div>
      )}
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────────────────── */
export default function PrizePoolStudio() {
  const [pools, setPools] = useState([]);
  const [ownerType, setOwnerType] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listPrizePools({ ownerType: ownerType || undefined, status: status || undefined });
      setPools(data.pools || []);
    } catch (e) {
      setErr(e.message || "Failed to load prize pools.");
    } finally {
      setLoading(false);
    }
  }, [ownerType, status]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-parchment flex items-center gap-2">
            <Coins className="h-5 w-5" /> Prize Pools
          </h2>
          <p className="text-xs text-faded">
            Advanced system view — diagnostics, auditing, ledger inspection and recovery.
            Day-to-day reward configuration lives in Event Templates → Reward Pool, where pools
            are created, funded and linked automatically.
          </p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-faded hover:text-parchment hover:bg-white/10">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <CreateForm onCreated={reload} />

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-faded">
            Owner type
            <input value={ownerType} onChange={(e) => setOwnerType(e.target.value)}
                   list="prize-pools-owner-type-suggestions"
                   placeholder="All owner types"
                   data-testid="prize-pools-owner-type-filter"
                   className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-faded">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}
                    data-testid="prize-pools-status-filter"
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-parchment">
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="locked">Locked</option>
              <option value="settled">Settled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
        </div>
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}

      <div>
        <div className="text-sm font-semibold text-parchment mb-2">Pools</div>
        {loading ? (
          <div className="text-sm text-faded">Loading…</div>
        ) : pools.length === 0 ? (
          <div className="text-sm text-faded" data-testid="prize-pools-empty">
            No prize pools match these filters yet.
          </div>
        ) : (
          <div className="space-y-3">
            {pools.map((p) => (
              <PoolRow key={p._id} pool={p} onChanged={reload} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
