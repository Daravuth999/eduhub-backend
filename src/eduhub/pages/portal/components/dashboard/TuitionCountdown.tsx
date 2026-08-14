import { motion } from "framer-motion";
import { CalendarClock, Hourglass } from "lucide-react";
import { ProgressBar } from "../primitives/ProgressBar";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { Pill } from "../primitives/Pill";
import { useLang } from "../../contexts/LanguageContext";
import { formatDate } from "../../lib/scoring";

interface Props {
  daysLeft: number | null;
  dueDate?: string;
  amount?: number;
  status?: string;
}

/**
 * The "impressive" days-remaining card that lives inside StudentHeader's
 * tuition row. Three modes:
 *   • >14 days → calm (big editorial numeral, no urgency)
 *   • 8-14 days → heads-up (amber accent + thin ring)
 *   • ≤7 / <0 → handled by PaymentBanner (this returns a compact paid/due note)
 */
export function TuitionCountdown({ daysLeft, dueDate, amount, status }: Props) {
  const { t, num } = useLang();
  const lower = (status || "").toLowerCase();

  // Paid / pending → simple status row, no countdown.
  if (lower === "paid" || lower === "pending" || daysLeft == null) {
    return (
      <div
        className="flex items-center gap-3 rounded-2xl border px-4 py-3 ink-shadow"
        style={{
          borderColor: "var(--color-line)",
          background: "var(--color-surface)",
        }}
        data-testid="tuition-status-card"
      >
        <Pill
          tone={lower === "paid" ? "excellent" : "good"}
          size="md"
          filled
          className="!rounded-full"
        >
          {lower === "paid" ? t("tuitionPaid") : t("tuitionPending")}
        </Pill>
        <div className="text-xs text-[color:var(--color-ink-soft)]">
          {dueDate && (
            <>
              {t("duePrefix")} {formatDate(dueDate)}
              {amount !== undefined && <> · ${Number(amount).toFixed(2)}</>}
            </>
          )}
        </div>
      </div>
    );
  }

  // Overdue → handled by PaymentBanner; here render a compact note for parity.
  if (daysLeft < 0) {
    return (
      <div
        className="rounded-2xl border px-4 py-3 ink-shadow"
        style={{
          borderColor: "color-mix(in oklab, var(--color-needs) 35%, transparent)",
          background: "color-mix(in oklab, var(--color-needs) 8%, var(--color-surface))",
        }}
      >
        <div
          className="display text-base font-bold"
          style={{ color: "var(--color-needs)" }}
        >
          {t("tuitionOverdue")}
        </div>
      </div>
    );
  }

  const isHeadsUp = daysLeft <= 14;
  const isSoon = daysLeft <= 7; // soon → urgent banner already covers; show shrinking ring here
  const accent = isHeadsUp ? "var(--color-good)" : "var(--color-accent)";
  const rangeMax = isSoon ? 14 : isHeadsUp ? 21 : 30;
  const pct = Math.min(100, (daysLeft / rangeMax) * 100);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="rounded-2xl border px-4 py-4 ink-shadow"
      style={{
        background: isHeadsUp
          ? "color-mix(in oklab, var(--color-good) 8%, var(--color-surface))"
          : "var(--color-surface)",
        borderColor: isHeadsUp
          ? "color-mix(in oklab, var(--color-good) 30%, transparent)"
          : "var(--color-line)",
      }}
      data-testid="tuition-countdown"
    >
      <div className="flex items-center gap-4">
        {/* Big numeral inside an aurora gradient tile */}
        <div
          data-accent={isHeadsUp ? "gold" : "teal"}
          className="aurora-icon-badge relative h-16 w-16 shrink-0 !rounded-2xl"
        >
          <span
            className="display tnum text-3xl font-bold leading-none text-white drop-shadow-sm"
            data-testid="tuition-days-number"
          >
            <AnimatedNumber value={daysLeft} duration={1000} localise />
          </span>
          {isHeadsUp && (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-2xl"
              animate={{ boxShadow: [
                `0 0 0 0px color-mix(in oklab, ${accent} 0%, transparent)`,
                `0 0 0 8px color-mix(in oklab, ${accent} 30%, transparent)`,
                `0 0 0 0px color-mix(in oklab, ${accent} 0%, transparent)`,
              ] }}
              transition={{ duration: 3.6, repeat: Infinity }}
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isHeadsUp ? (
              <Hourglass className="h-3.5 w-3.5" style={{ color: accent }} />
            ) : (
              <CalendarClock
                className="h-3.5 w-3.5"
                style={{ color: accent }}
              />
            )}
            <span
              className="text-xs font-bold uppercase tracking-wider"
              style={{ color: accent }}
            >
              {isHeadsUp ? t("daysHeadsUp") : t("daysUntilTuition")}
            </span>
          </div>
          <div className="text-sm text-[color:var(--color-ink-soft)] mt-0.5">
            {dueDate && (
              <>
                {t("duePrefix")} {formatDate(dueDate)}
              </>
            )}
            {amount !== undefined && <> · ${Number(amount).toFixed(2)}</>}
          </div>
          <div className="mt-2">
            <ProgressBar
              value={pct}
              color={accent}
              shimmer={isHeadsUp}
              height={6}
            />
          </div>
        </div>
      </div>
      <span className="sr-only">
        {num(daysLeft)} days remaining until next tuition payment.
      </span>
    </motion.div>
  );
}
