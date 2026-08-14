import { ArrowDownLeft, ArrowLeft, ArrowUpRight, CheckCircle2, Loader2, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "../primitives/ModalShell";
import { LoadingState } from "../primitives/LoadingState";
import { api } from "../../lib/api";
import type { PointsTransfer, ReceiptData } from "../../types";
import { useLang } from "../../contexts/LanguageContext";
import { requestPointsRefresh, broadcastPointsUpdated } from "../../../../utils/pointsSync";
import { beginCriticalOperation } from "../../../../lib/criticalOperationRegistry";

interface Props {
  open: boolean;
  onClose: () => void;
  studentId: string;
  password: string;
  currentPoints: number;
  onPointsChanged: (next: number) => void;
}

type Stage = "form" | "confirming" | "receipt";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getInitials(name: string): string {
  if (!name) return "·";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + second).toUpperCase().slice(0, 2) || "·";
}

/**
 * Bank-style transfer reference. Strips dashes and colons, then takes
 * the last 8 characters uppercased so receipts always display a short,
 * memorable reference regardless of whether the backend returned a
 * UUID, a fallback composite string, or any other format.
 */
function formatTransferId(raw: string): string {
  if (!raw) return "TX-????????";
  const last8 = raw.replace(/[-:]/g, "").slice(-8).toUpperCase();
  return `TX-${last8 || "????????"}`;
}

function useCountUp(target: number, durationMs = 600): number {
  const [value, setValue] = useState(target);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const from = 0;
    const to = target;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);
  return value;
}

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */

function ReceiverAvatar({ name, size = 64 }: { name: string; size?: number }) {
  const initials = getInitials(name);
  return (
    <div
      data-testid="send-points-receiver-avatar"
      className="rounded-full flex items-center justify-center font-bold display"
      style={{
        width: size,
        height: size,
        background: "var(--color-accent)",
        color: "var(--color-surface)",
        fontSize: Math.round(size * 0.42),
        letterSpacing: "0.04em",
      }}
    >
      {initials}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function SendPointsModal({
  open,
  onClose,
  studentId,
  password,
  currentPoints,
  onPointsChanged,
}: Props) {
  const { t, tpl, num, lang } = useLang();

  /* ----------- shared state ----------- */
  const [stage, setStage] = useState<Stage>("form");
  const [receiverId, setReceiverId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [errorText, setErrorText] = useState<string>("");

  /* ----------- stage 2/3 state ----------- */
  const [receiverName, setReceiverName] = useState<string>("");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [receiptCanClose, setReceiptCanClose] = useState(false);

  /* ----------- recent transfers (preserved) ----------- */
  const [transfers, setTransfers] = useState<PointsTransfer[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);

  const resetAll = () => {
    setStage("form");
    setReceiverId("");
    setAmount("");
    setSubmitting(false);
    setResolving(false);
    setErrorText("");
    setReceiverName("");
    setReceipt(null);
    setReceiptCanClose(false);
  };

  async function loadHistory() {
    setLoadingTx(true);
    try {
      const res = await api.recentTransfers(studentId);
      setTransfers(res?.success && res.history ? res.history : []);
    } catch {
      setTransfers([]);
    } finally {
      setLoadingTx(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setErrorText("");
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, studentId]);

  // Allow the receipt "Done" button to appear after the entrance animation
  // settles (300 ms per spec).
  useEffect(() => {
    if (stage !== "receipt") {
      setReceiptCanClose(false);
      return undefined;
    }
    const timer = setTimeout(() => setReceiptCanClose(true), 300);
    return () => clearTimeout(timer);
  }, [stage]);

  /* ----------- Stage 1: form submit → resolve name → stage 2 ----------- */

  async function handleResolveAndConfirm(e: React.FormEvent) {
    e.preventDefault();
    setErrorText("");
    const amt = parseInt(amount, 10);
    const rid = receiverId.trim();
    if (!rid || rid === studentId) {
      setErrorText(t("enterValidReceiver"));
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setErrorText(t("amountMustBePositive"));
      return;
    }
    if (amt > currentPoints) {
      setErrorText(t("notEnoughPoints"));
      return;
    }
    setResolving(true);
    try {
      const data = await api.studentData(rid);
      const name = (data && typeof data.Name === "string" ? data.Name : "").trim();
      if (!data || data.error || !name) {
        setErrorText(t("receiverNotFound"));
        return;
      }
      setReceiverName(name);
      setStage("confirming");
    } catch {
      setErrorText(t("networkError"));
    } finally {
      setResolving(false);
    }
  }

  /* ----------- Stage 2: confirm & send ----------- */

  async function handleConfirmSend() {
    const amt = parseInt(amount, 10);
    const rid = receiverId.trim();
    setErrorText("");
    setSubmitting(true);
    // A PWA update must never land mid-transfer — see pwaUpdateController.js.
    const endCriticalOp = beginCriticalOperation("send-points");
    try {
      const res = await api.sendPoints({
        id: studentId,
        password,
        receiverId: rid,
        amount: amt,
      });
      if (!res.success) {
        setErrorText(res.msg || t("transferFail"));
        setStage("form");
        return;
      }

      // Push notification — preserved verbatim from the previous submit().
      try {
        const apiBase = process.env.REACT_APP_BACKEND_URL;
        if (apiBase) {
          const cleanReceiver = rid;
          const transferId =
            (res as { transferId?: string }).transferId ||
            `${studentId}:${cleanReceiver}:${amt}:${Date.now()}`;
          void fetch(`${apiBase}/api/push/notify-credit`, {
            method: "POST",
            credentials: "omit",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": transferId,
            },
            body: JSON.stringify({
              senderStudentId: studentId,
              senderPassword: password,
              recipientStudentId: cleanReceiver,
              amount: amt,
              transferId,
            }),
          }).catch(() => {
            /* fire-and-forget — never let push noise break the UX */
          });
        }
      } catch {
        /* ignore — never surface push failures to the sender */
      }

      // Refresh balance and history.
      let newBalance = currentPoints - amt;
      try {
        const p = await api.pointsLogin(studentId, password);
        if (p && p.success && typeof p.points === "number") {
          newBalance = p.points;
          onPointsChanged(p.points);
        } else {
          onPointsChanged(newBalance);
        }
      } catch {
        onPointsChanged(newBalance);
      }

      // Points-sync v1 — broadcast the confirmed new balance and request a
      // global refresh so every sibling view (Library wallet pill, header
      // pill, sidebar, EduTalk balance) updates immediately. AuthContext
      // owns the canonical reconciliation; we just nudge it.
      try { broadcastPointsUpdated(newBalance, "send_points"); } catch { /* noop */ }
      try { requestPointsRefresh("send_points", { amount: amt }); } catch { /* noop */ }

      const transferRaw =
        (res as { transferId?: string }).transferId ||
        `${studentId}:${rid}:${amt}:${Date.now()}`;
      const senderName =
        (res as { senderName?: string }).senderName || studentId;

      setReceipt({
        transferId: transferRaw,
        amount: amt,
        receiverId: rid,
        receiverName,
        senderName,
        senderId: studentId,
        newBalance,
        date: new Date().toISOString(),
      });
      setStage("receipt");
      loadHistory();
    } catch {
      setErrorText(t("networkError"));
      setStage("form");
    } finally {
      setSubmitting(false);
      endCriticalOp();
    }
  }

  function handleDone() {
    resetAll();
    onClose();
  }

  /* ----------- Render ----------- */

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      dismissible={stage === "form"}
      title={t("sendPoints")}
      subtitle={lang === "km" ? "ផ្ទេរពិន្ទុទៅសិស្សម្នាក់ទៀត" : "Transfer points to a classmate"}
      icon={Send}
      testId="send-points-modal"
    >
      <div className="relative p-5 sm:p-6" data-testid="send-points-stage-root">
        {/* keyframes for stage entrance animations */}
        <style>{`
          @keyframes sp-slide-up { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes sp-scale-in  { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
          @keyframes sp-check-pop { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
        `}</style>

        {/* ---------------- Stage 1: form ---------------- */}
        {(stage === "form" || stage === "confirming" || stage === "receipt") && (
          <FormStage
            currentPoints={currentPoints}
            receiverId={receiverId}
            setReceiverId={setReceiverId}
            amount={amount}
            setAmount={setAmount}
            errorText={stage === "form" ? errorText : ""}
            resolving={resolving}
            onSubmit={handleResolveAndConfirm}
            transfers={transfers}
            loadingTx={loadingTx}
            tBundle={{ t, tpl, num, lang }}
          />
        )}

        {/* ---------------- Stage 2: confirming overlay ---------------- */}
        {stage === "confirming" && (
          <ConfirmingOverlay
            receiverId={receiverId.trim()}
            receiverName={receiverName}
            amount={parseInt(amount, 10) || 0}
            currentPoints={currentPoints}
            submitting={submitting}
            onBack={() => { setErrorText(""); setStage("form"); }}
            onCancel={() => { setErrorText(""); setStage("form"); }}
            onConfirm={handleConfirmSend}
            tBundle={{ t, num }}
          />
        )}

        {/* ---------------- Stage 3: receipt overlay ---------------- */}
        {stage === "receipt" && receipt && (
          <ReceiptOverlay
            receipt={receipt}
            canClose={receiptCanClose}
            onDone={handleDone}
            tBundle={{ t, num, lang }}
          />
        )}
      </div>
    </ModalShell>
  );
}

/* ================================================================== */
/* Stage 1 — form (extracted for readability)                          */
/* ================================================================== */

interface FormStageProps {
  currentPoints: number;
  receiverId: string;
  setReceiverId: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  errorText: string;
  resolving: boolean;
  onSubmit: (e: React.FormEvent) => void;
  transfers: PointsTransfer[];
  loadingTx: boolean;
  tBundle: {
    t: ReturnType<typeof useLang>["t"];
    tpl: ReturnType<typeof useLang>["tpl"];
    num: ReturnType<typeof useLang>["num"];
    lang: ReturnType<typeof useLang>["lang"];
  };
}

function FormStage({
  currentPoints, receiverId, setReceiverId, amount, setAmount,
  errorText, resolving, onSubmit, transfers, loadingTx, tBundle,
}: FormStageProps) {
  const { t, num } = tBundle;
  return (
    <>
      <div
        className="rounded-2xl border p-4 mb-5 text-center"
        style={{
          background: "var(--color-surface-2)",
          borderColor: "var(--color-line)",
        }}
      >
        <div className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-ink-mute)]">
          {t("yourBalance")}
        </div>
        <div
          className="display tnum text-3xl font-bold"
          style={{ color: "var(--color-accent)" }}
        >
          {num(currentPoints.toLocaleString("en-US"))}
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" data-testid="send-points-form">
        <div>
          <label className="block text-sm font-semibold text-[color:var(--color-ink)] mb-1.5">
            {t("receiverId")}
          </label>
          <input
            type="text"
            value={receiverId}
            onChange={(e) => setReceiverId(e.target.value)}
            placeholder="e.g., stu002"
            className="w-full px-4 py-3 rounded-xl bg-[color:var(--color-surface-2)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] mono"
            data-testid="receiver-id-input"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-[color:var(--color-ink)] mb-1.5">
            {t("amount")}
          </label>
          <input
            type="number"
            min={1}
            max={currentPoints}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full px-4 py-3 rounded-xl bg-[color:var(--color-surface-2)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] mono"
            data-testid="amount-input"
          />
        </div>

        {errorText && (
          <div
            data-testid="send-points-message"
            className="text-sm font-medium px-3 py-2 rounded-lg border"
            style={{
              background:
                "color-mix(in oklab, var(--color-needs) 12%, var(--color-surface))",
              borderColor:
                "color-mix(in oklab, var(--color-needs) 30%, transparent)",
              color: "var(--color-needs)",
            }}
          >
            {errorText}
          </div>
        )}

        <button
          type="submit"
          disabled={resolving}
          data-testid="send-points-submit-btn"
          className="w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition disabled:opacity-60"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-surface)",
          }}
        >
          {resolving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {t("sending")}
            </>
          ) : (
            <>
              <Send className="h-4 w-4" /> {t("sendPoints")} →
            </>
          )}
        </button>
      </form>

      <div className="mt-6">
        <h4 className="display text-sm font-bold text-[color:var(--color-ink)] mb-3">
          {t("recentTransfers")}
        </h4>
        {loadingTx ? (
          <LoadingState label={t("recentTransfers")} />
        ) : transfers.length === 0 ? (
          <div className="text-center py-4 text-[color:var(--color-ink-mute)] text-sm">
            {t("noTransfers")}
          </div>
        ) : (
          <ul className="space-y-2 max-h-44 overflow-y-auto pr-1">
            {transfers.map((tr, i) => {
              const sent = tr.direction === "sent";
              return (
                <li
                  key={i}
                  className="flex items-center gap-3 rounded-xl border px-3 py-2 bg-[color:var(--color-surface-2)] border-[color:var(--color-line)]"
                >
                  <div
                    className="h-8 w-8 rounded-full flex items-center justify-center"
                    style={{
                      background: sent
                        ? "color-mix(in oklab, var(--color-needs) 16%, transparent)"
                        : "color-mix(in oklab, var(--color-excellent) 16%, transparent)",
                      color: sent ? "var(--color-needs)" : "var(--color-excellent)",
                    }}
                  >
                    {sent ? (
                      <ArrowUpRight className="h-4 w-4" />
                    ) : (
                      <ArrowDownLeft className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1 text-sm">
                    <div className="font-semibold text-[color:var(--color-ink)] mono">
                      {sent ? `→ ${tr.to}` : `← ${tr.from}`}
                    </div>
                    <div className="text-xs text-[color:var(--color-ink-mute)]">
                      {tr.date ? new Date(tr.date).toLocaleString() : ""}
                    </div>
                  </div>
                  <div
                    className="display tnum font-bold text-sm"
                    style={{
                      color: sent
                        ? "var(--color-needs)"
                        : "var(--color-excellent)",
                    }}
                  >
                    {sent ? "−" : "+"}
                    {num(tr.amount)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/* ================================================================== */
/* Stage 2 — confirming overlay                                        */
/* ================================================================== */

interface ConfirmingOverlayProps {
  receiverId: string;
  receiverName: string;
  amount: number;
  currentPoints: number;
  submitting: boolean;
  onBack: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  tBundle: {
    t: ReturnType<typeof useLang>["t"];
    num: ReturnType<typeof useLang>["num"];
  };
}

function ConfirmingOverlay({
  receiverId, receiverName, amount, currentPoints,
  submitting, onBack, onCancel, onConfirm, tBundle,
}: ConfirmingOverlayProps) {
  const { t, num } = tBundle;
  const animatedAmount = useCountUp(amount, 700);
  const balanceAfter = Math.max(0, currentPoints - amount);
  return (
    <div
      data-testid="send-points-confirm-stage"
      className="absolute inset-0 rounded-2xl flex flex-col"
      style={{
        background: "var(--color-surface)",
        animation: "sp-slide-up 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        zIndex: 5,
        padding: "20px 20px 24px",
        overflow: "auto",
      }}
    >
      <div className="flex items-center mb-4">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          data-testid="send-points-back-btn"
          className="inline-flex items-center gap-1 text-sm text-[color:var(--color-ink-mute)] hover:text-[color:var(--color-ink)] disabled:opacity-50"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </button>
      </div>

      <div className="flex flex-col items-center text-center mb-6">
        <ReceiverAvatar name={receiverName} size={72} />
        <div
          className="display text-xl font-bold mt-3"
          style={{ color: "var(--color-ink)" }}
          data-testid="send-points-receiver-name"
        >
          {receiverName}
        </div>
        <div
          className="mono text-xs mt-1"
          style={{ color: "var(--color-ink-mute)" }}
        >
          {receiverId}
        </div>
      </div>

      <div
        className="rounded-2xl border p-5 mb-5"
        style={{
          background: "var(--color-surface-2)",
          borderColor: "var(--color-line)",
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.18em] mb-2"
          style={{ color: "var(--color-ink-mute)" }}
        >
          {t("youAreSending")}
        </div>
        <div
          className="display tnum font-bold flex items-baseline gap-2"
          style={{ color: "var(--color-accent)", fontSize: "2.25rem" }}
          data-testid="send-points-confirm-amount"
        >
          <span aria-hidden="true">✦</span>
          <span>{num(animatedAmount.toLocaleString("en-US"))}</span>
          <span style={{ fontSize: "1rem", opacity: 0.7 }}>pts</span>
        </div>

        <div
          className="mt-4 pt-4 border-t text-sm flex items-center justify-between"
          style={{ borderColor: "var(--color-line)" }}
        >
          <span style={{ color: "var(--color-ink-mute)" }}>
            {t("balanceAfter")}
          </span>
          <span
            className="tnum font-semibold"
            style={{ color: "var(--color-ink)" }}
          >
            {num(currentPoints.toLocaleString("en-US"))} → {num(balanceAfter.toLocaleString("en-US"))} pts
          </span>
        </div>
      </div>

      <div className="mt-auto flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          data-testid="send-points-cancel-btn"
          className="flex-1 py-3 rounded-xl font-semibold border transition disabled:opacity-50"
          style={{
            background: "transparent",
            borderColor: "var(--color-line)",
            color: "var(--color-ink)",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          data-testid="send-points-confirm-btn"
          className="flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition disabled:opacity-60"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-surface)",
          }}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {t("sending")}
            </>
          ) : (
            <>
              {t("confirmTransfer")} →
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Stage 3 — receipt overlay                                           */
/* ================================================================== */

interface ReceiptOverlayProps {
  receipt: ReceiptData;
  canClose: boolean;
  onDone: () => void;
  tBundle: {
    t: ReturnType<typeof useLang>["t"];
    num: ReturnType<typeof useLang>["num"];
    lang: ReturnType<typeof useLang>["lang"];
  };
}

function ReceiptOverlay({ receipt, canClose, onDone, tBundle }: ReceiptOverlayProps) {
  const { t, num, lang } = tBundle;
  const txDisplay = useMemo(() => formatTransferId(receipt.transferId), [receipt.transferId]);
  const dateDisplay = useMemo(() => {
    try {
      const d = new Date(receipt.date);
      return d.toLocaleString(lang === "km" ? "km-KH" : "en-US", {
        year: "numeric", month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return receipt.date;
    }
  }, [receipt.date, lang]);

  return (
    <div
      data-testid="send-points-receipt-stage"
      className="absolute inset-0 rounded-2xl flex flex-col"
      style={{
        background: "var(--color-surface)",
        animation: "sp-scale-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        zIndex: 6,
        padding: "28px 20px 24px",
        overflow: "auto",
      }}
    >
      <div className="flex flex-col items-center text-center mb-5">
        <div
          className="rounded-full flex items-center justify-center"
          style={{
            width: 72, height: 72,
            background: "color-mix(in oklab, var(--color-excellent) 18%, transparent)",
            color: "var(--color-excellent)",
            animation: "sp-check-pop 480ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
          }}
          data-testid="send-points-success-icon"
        >
          <CheckCircle2 className="h-10 w-10" strokeWidth={2.5} />
        </div>
        <div
          className="display text-2xl font-bold mt-3"
          style={{ color: "var(--color-ink)" }}
          data-testid="send-points-success-title"
        >
          {t("sentSuccess")}
        </div>
      </div>

      {/* Receipt card with dashed tear-line + side notches */}
      <div
        className="rounded-2xl border relative overflow-hidden"
        style={{
          background: "var(--color-surface-2)",
          borderColor: "var(--color-line)",
        }}
        data-testid="send-points-receipt-card"
      >
        {/* TOP — receiver + amount */}
        <div className="px-5 pt-5 pb-4 flex items-center gap-4">
          <div className="relative">
            <ReceiverAvatar name={receipt.receiverName} size={48} />
            <div
              className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full flex items-center justify-center"
              style={{
                background: "color-mix(in oklab, var(--color-needs) 90%, var(--color-surface))",
                color: "var(--color-surface)",
              }}
              aria-hidden="true"
            >
              <ArrowUpRight className="h-3 w-3" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="display tnum text-2xl font-bold"
              style={{ color: "var(--color-needs)" }}
              data-testid="send-points-receipt-amount"
            >
              − {num(receipt.amount.toLocaleString("en-US"))} pts
            </div>
            <div
              className="text-sm truncate"
              style={{ color: "var(--color-ink)" }}
            >
              {receipt.receiverName}
            </div>
          </div>
        </div>

        {/* Tear-line separator with side notches */}
        <div className="relative" aria-hidden="true">
          <div
            style={{
              borderTop: "2px dashed var(--color-line)",
              marginLeft: 14,
              marginRight: 14,
            }}
          />
          <span
            style={{
              position: "absolute",
              left: -10,
              top: -10,
              width: 20,
              height: 20,
              background: "var(--color-surface)",
              borderRadius: "50%",
            }}
          />
          <span
            style={{
              position: "absolute",
              right: -10,
              top: -10,
              width: 20,
              height: 20,
              background: "var(--color-surface)",
              borderRadius: "50%",
            }}
          />
        </div>

        {/* BOTTOM — details */}
        <div className="px-5 py-4 space-y-2.5 text-sm">
          <ReceiptRow label={t("transferIdLabel")} value={txDisplay} mono />
          <ReceiptRow label="Date" value={dateDisplay} />
          <ReceiptRow
            label={t("fromLabel")}
            value={`${receipt.senderName} (${receipt.senderId})`}
          />
          <ReceiptRow
            label={t("toLabel")}
            value={`${receipt.receiverName} (${receipt.receiverId})`}
          />
          <ReceiptRow
            label={t("newBalanceLabel")}
            value={`${num(receipt.newBalance.toLocaleString("en-US"))} pts`}
            emphasize
          />
        </div>
      </div>

      <div className="mt-6">
        {canClose ? (
          <button
            type="button"
            onClick={onDone}
            data-testid="send-points-done-btn"
            className="w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-surface)",
            }}
          >
            Done
          </button>
        ) : (
          <div className="h-12" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function ReceiptRow({
  label, value, mono = false, emphasize = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className="text-xs uppercase tracking-[0.12em]"
        style={{ color: "var(--color-ink-mute)" }}
      >
        {label}
      </span>
      <span
        className={`${mono ? "mono" : ""} ${emphasize ? "font-bold" : "font-medium"} text-right truncate`}
        style={{
          color: emphasize ? "var(--color-accent)" : "var(--color-ink)",
          maxWidth: "65%",
        }}
      >
        {value}
      </span>
    </div>
  );
}
