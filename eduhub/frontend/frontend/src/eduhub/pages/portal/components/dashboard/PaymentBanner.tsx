import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, X } from "lucide-react";
import { useState } from "react";
import type { StudentData } from "../../types";
import { daysUntil, formatDate } from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  student: StudentData;
}

/**
 * Top-of-page banner.
 * • Overdue (status 'unpaid') → rose strong banner
 * • Due in ≤7 days → amber soft banner
 * • Otherwise → null (the calm TuitionCountdown takes over inside StudentHeader)
 */
export function PaymentBanner({ student }: Props) {
  const { t, num } = useLang();
  const [dismissed, setDismissed] = useState(false);
  const status = (student.TuitionStatus || "").toLowerCase();
  const days = daysUntil(student.NextDueDate);

  const showOverdue = status === "unpaid";
  const showSoon = !showOverdue && days !== null && days >= 0 && days <= 7;
  if (dismissed || (!showOverdue && !showSoon)) return null;

  const overdue = showOverdue;
  const config = overdue
    ? {
        bg: "var(--color-needs)",
        title: t("tuitionOverdue"),
        message:
          (student.PaymentAmount
            ? `$${Number(student.PaymentAmount).toFixed(2)} · `
            : "") + (student.NextDueDate ? formatDate(student.NextDueDate) : ""),
      }
    : {
        bg: "var(--color-good)",
        title: t("paymentDueSoon"),
        message: `${formatDate(student.NextDueDate)} · ${num(days ?? 0)} ${
          days === 1 ? "day" : "days"
        }${
          student.PaymentAmount
            ? ` · $${Number(student.PaymentAmount).toFixed(2)}`
            : ""
        }`,
      };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -16 }}
        className="relative overflow-hidden rounded-2xl"
        style={{
          background: config.bg,
          color: "var(--color-surface)",
        }}
        data-testid="payment-banner"
      >
        <span aria-hidden className="absolute inset-0 sweep opacity-30" />
        <div className="relative flex items-center gap-3 px-5 py-3.5">
          <div className="h-9 w-9 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center shrink-0">
            <AlertCircle className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="display font-bold leading-tight">{config.title}</div>
            <p className="text-sm text-white/95 mt-0.5 truncate">
              {config.message}
            </p>
          </div>
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            data-testid="payment-banner-close"
            className="h-8 w-8 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
