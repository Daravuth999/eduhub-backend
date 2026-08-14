import { motion } from "framer-motion";
import { Tag } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  studentId: string;
  onApplied: (newAmount: number, percent: number) => void;
}

export function CouponForm({ studentId, onApplied }: Props) {
  const { t } = useLang();
  const [coupon, setCoupon] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    if (!coupon.trim()) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await api.validateCoupon(coupon.trim(), studentId);
      if (res.success && res.newAmount !== undefined && res.discountPercent !== undefined) {
        setMsg({
          ok: true,
          text: `${res.discountPercent}% off · $${res.newAmount.toFixed(2)}`,
        });
        onApplied(res.newAmount, res.discountPercent);
        setCoupon("");
      } else {
        setMsg({ ok: false, text: res.message || t("couponInvalid") });
      }
    } catch {
      setMsg({ ok: false, text: t("couponNetworkError") });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-t border-[color:var(--color-line)] pt-4 mt-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 text-[color:var(--color-ink)] font-semibold text-sm">
          <Tag className="h-4 w-4" /> {t("haveCoupon")}
        </div>
        <div className="flex-1 flex gap-2">
          <input
            type="text"
            value={coupon}
            onChange={(e) => setCoupon(e.target.value.toUpperCase())}
            placeholder={t("enterCode")}
            data-testid="coupon-input"
            className="flex-1 px-4 py-2.5 rounded-xl bg-[color:var(--color-surface-2)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-mute)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] uppercase tracking-wider text-sm font-semibold mono"
          />
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={apply}
            disabled={loading || !coupon.trim()}
            data-testid="coupon-apply-btn"
            className="px-5 py-2.5 rounded-xl text-[color:var(--color-surface)] font-semibold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--color-accent)" }}
          >
            {loading ? t("checking") : t("apply")}
          </motion.button>
        </div>
      </div>
      {msg && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          data-testid="coupon-message"
          className="mt-3 text-sm font-medium px-3 py-2 rounded-lg border"
          style={{
            background: msg.ok
              ? "color-mix(in oklab, var(--color-excellent) 12%, var(--color-surface))"
              : "color-mix(in oklab, var(--color-needs) 12%, var(--color-surface))",
            borderColor: msg.ok
              ? "color-mix(in oklab, var(--color-excellent) 35%, transparent)"
              : "color-mix(in oklab, var(--color-needs) 35%, transparent)",
            color: msg.ok ? "var(--color-excellent)" : "var(--color-needs)",
          }}
        >
          {msg.text}
        </motion.div>
      )}
    </div>
  );
}
