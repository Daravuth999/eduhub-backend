import { ArrowDownLeft, ArrowUpRight, Loader2, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { ModalShell } from "../primitives/ModalShell";
import { LoadingState } from "../primitives/LoadingState";
import { api } from "../../lib/api";
import type { PointsTransfer } from "../../types";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  open: boolean;
  onClose: () => void;
  studentId: string;
  password: string;
  currentPoints: number;
  onPointsChanged: (next: number) => void;
}

export function SendPointsModal({
  open,
  onClose,
  studentId,
  password,
  currentPoints,
  onPointsChanged,
}: Props) {
  const { t, tpl, num, lang } = useLang();
  const [receiverId, setReceiverId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [transfers, setTransfers] = useState<PointsTransfer[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);

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
    setMsg(null);
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, studentId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const amt = parseInt(amount, 10);
    if (!receiverId.trim() || receiverId.trim() === studentId) {
      setMsg({ ok: false, text: t("enterValidReceiver") });
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg({ ok: false, text: t("amountMustBePositive") });
      return;
    }
    if (amt > currentPoints) {
      setMsg({ ok: false, text: t("notEnoughPoints") });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.sendPoints({
        id: studentId,
        password,
        receiverId: receiverId.trim(),
        amount: amt,
      });
      if (res.success) {
        setMsg({
          ok: true,
          text:
            res.msg ?? tpl(t("transferOk"), { amount: amt, to: receiverId.trim() }),
        });
        setReceiverId("");
        setAmount("");
        // Refresh balance + history
        try {
          const p = await api.pointsLogin(studentId, password);
          if (p && p.success && typeof p.points === "number")
            onPointsChanged(p.points);
        } catch {
          /* ignore */
        }
        loadHistory();
      } else {
        setMsg({ ok: false, text: res.msg || t("transferFail") });
      }
    } catch {
      setMsg({ ok: false, text: t("networkError") });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t("sendPoints")}
      subtitle={lang === "km" ? "ផ្ទេរពិន្ទុទៅសិស្សម្នាក់ទៀត" : "Transfer points to a classmate"}
      icon={Send}
      testId="send-points-modal"
    >
      <div className="p-5 sm:p-6">
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

        <form onSubmit={submit} className="space-y-4" data-testid="send-points-form">
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

          {msg && (
            <div
              data-testid="send-points-message"
              className="text-sm font-medium px-3 py-2 rounded-lg border"
              style={{
                background: msg.ok
                  ? "color-mix(in oklab, var(--color-excellent) 12%, var(--color-surface))"
                  : "color-mix(in oklab, var(--color-needs) 12%, var(--color-surface))",
                borderColor: msg.ok
                  ? "color-mix(in oklab, var(--color-excellent) 30%, transparent)"
                  : "color-mix(in oklab, var(--color-needs) 30%, transparent)",
                color: msg.ok ? "var(--color-excellent)" : "var(--color-needs)",
              }}
            >
              {msg.text}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            data-testid="send-points-submit-btn"
            className="w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition disabled:opacity-60"
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
                <Send className="h-4 w-4" /> {t("sendPoints")}
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
      </div>
    </ModalShell>
  );
}
