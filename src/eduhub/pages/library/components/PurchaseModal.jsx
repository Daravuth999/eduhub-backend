import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Gem,
  Unlock,
  Sparkles,
  X,
  Check,
  AlertTriangle,
  ShieldCheck,
  Zap,
  Ticket,
  Loader2,
} from "lucide-react";
import { readActiveVoucherCode } from "./VoucherBanner.jsx";

/* Animated number ticker — counts from `from` → `to` smoothly */
function AnimatedNumber({ from, to, duration = 900 }) {
  const [v, setV] = useState(from);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const d = Math.max(0, to - from);
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(from + d * eased * (to < from ? -1 : 1)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to, duration]);
  return <>{v}</>;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Local unlock push — bilingual (Khmer + English) WITH remaining balance.
 *
 * Visual signature MATCHES the existing Author Studio remote push exactly
 * (icons + vibrate pattern from public/sw.js push handler), so students
 * can't tell a local-fired unlock notification apart from a server-sent one.
 *
 * Hard guarantees:
 *   • Local-only. Uses the already-registered service worker's
 *     registration.showNotification() — never calls a push server,
 *     never sends a subscription token, never transmits user data.
 *   • Will NEVER request permission. Fires only if the user already
 *     granted it via the existing VAPID/web-push opt-in flow.
 *   • Never throws. Wrapped in try/catch so any SW or Notification
 *     API failure cannot break the unlock flow.
 *   • Defined at module top-level scope (not inside render) per spec.
 * ────────────────────────────────────────────────────────────────────────── */
async function fireUnlockNotification(book, remainingBalance) {
  const title = book?.title || "សៀវភៅថ្មី · Your new book";
  const bookId = book?.id ?? "x";
  // Format remaining balance as a clean integer-pts string. Falls back to
  // an empty string if balance is unknown so the body line just disappears.
  const balanceLine =
    typeof remainingBalance === "number" && Number.isFinite(remainingBalance)
      ? `Remaining Balance: ${Math.max(0, Math.round(remainingBalance))} pts\n`
      : "";
  const payload = {
    title: "🔓 Unlocked Successfully! · បានដោះសោជោគជ័យ!",
    options: {
      // Body matches the bilingual spec + balance line on top.
      body:
        `${balanceLine}` +
        `«${title}» ត្រៀមរួចរាល់សម្រាប់អាន។\n` +
        `'${title}' is ready to read.`,
      // ── Visual signature must match the Author Studio remote push
      //    (see public/sw.js push handler). Same icon path for both
      //    icon and badge. Same vibrate pattern.
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      vibrate: [200, 100, 200],
      // notificationclick handler in sw.js routes by data.url — same
      // pattern as remote pushes, no SW change needed.
      data: { url: `/library/read/${book?.id ?? ""}` },
      // Tag is invisible to the user; it just makes a re-purchase of the
      // same book replace the previous notification instead of stacking.
      tag: `unlock-${bookId}`,
    },
  };
  try {
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      "serviceWorker" in navigator
    ) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(payload.title, payload.options);
      return;
    }
    // Silent fallback — reuse existing toast utility already imported
    // in this file. None is currently imported here, so we intentionally
    // do nothing (per spec: "If no toast utility exists in the file,
    // simply skip the fallback silently.").
  } catch (e) {
    /* swallow — never break unlock flow */
  }
}

/* ── Coupon validation (calls backend — never trusts frontend calc) ── */
const BACKEND =
  (typeof process !== "undefined" && process.env?.REACT_APP_BACKEND_URL) ||
  "https://eduhub-backend-td3a.onrender.com";

/** Read the student's clean_id from AuthContext sessionStorage (set at login). */
function _getStudentId() {
  try {
    const raw = sessionStorage.getItem("eduhub_student");
    if (!raw) return "";
    const v = JSON.parse(raw);
    return (v?.studentId || v?.clean_id || "").toString().trim();
  } catch {
    return "";
  }
}

async function fetchValidateCoupon({ code, book_slug, original_price }) {
  const student_id = _getStudentId();
  const res = await fetch(
    `${BACKEND}/api/coupons/validate`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, book_slug, original_price, student_id }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export default function PurchaseModal({
  book,
  meta,
  price,
  balance,
  error,
  onCancel,
  onConfirm,
  onFinished,
}) {
  // Coupon state. Reward-kind v1.0.2 — prefill from ?voucher=CODE so a
  // student who tapped "Use Voucher" sees their code already filled in.
  const [couponCode, setCouponCode]         = useState(() => readActiveVoucherCode() || "");
  const [couponResult, setCouponResult]     = useState(null);  // null | { discounted_price, discount_amount, ... }
  const [couponError, setCouponError]       = useState(null);
  const [couponLoading, setCouponLoading]   = useState(false);

  const effectivePrice = couponResult ? couponResult.discounted_price : price;
  const canAfford = balance >= effectivePrice;
  const [phase, setPhase] = useState("idle"); // 'idle' | 'deducting' | 'unlocked' | 'failed'
  const [displayBalance, setDisplayBalance] = useState(balance);
  const confettiRef = useRef(null);

  // External error → show "failed" state
  useEffect(() => {
    if (error) setPhase("failed");
  }, [error]);

  // When unlocked: play celebration ~1.2s, then hand off (parent closes + navigates)
  useEffect(() => {
    if (phase !== "unlocked") return;
    const t = setTimeout(() => onFinished?.(), 1200);
    return () => clearTimeout(t);
  }, [phase, onFinished]);

  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape" && phase === "idle") onCancel();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel, phase]);

  const applyCoupon = async () => {
    const code = couponCode.trim().toUpperCase();
    if (!code) return;
    setCouponError(null);
    setCouponLoading(true);
    try {
      const result = await fetchValidateCoupon({
        code,
        book_slug: book?.slug || "",
        original_price: price,
      });
      setCouponResult(result);
      setCouponCode(result.code);
    } catch (e) {
      setCouponError(e.message || "Invalid coupon code.");
      setCouponResult(null);
    } finally {
      setCouponLoading(false);
    }
  };

  const removeCoupon = () => {
    setCouponCode("");
    setCouponResult(null);
    setCouponError(null);
  };

  // Reward-kind v1.0.2 — if the modal opened with a prefilled voucher code
  // (from ?voucher=CODE) and we have a book to price against, validate it
  // once automatically via the EXISTING backend validate endpoint. This is
  // pure convenience; the student can still edit/remove it. Never auto-runs
  // more than once and never re-runs after a manual remove.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (autoTriedRef.current) return;
    if (phase !== "idle") return;
    if (couponResult || couponLoading) return;
    if (!couponCode || !couponCode.trim()) return;
    if (!book?.slug) return;
    autoTriedRef.current = true;
    applyCoupon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.slug, phase]);

  // eduhub_login_reward_book_vouchers_wallet_hub_v1_0_4:
  //   Retry UX fix. The previous Retry handler called
  //     setPhase("idle"); handleBuy();
  //   which suffered from a React batched-state race — handleBuy()
  //   still observed the stale `phase === "failed"` and bailed out via
  //   its `if (!canAfford || phase !== "idle") return;` guard, so the
  //   first click of "Try again" was silently ignored. The fix here is
  //   surgical: handleBuy accepts an explicit `{ force: true }` option
  //   that bypasses the phase guard, and a dedicated handleRetry
  //   wraps it. The catch branch now lands the modal in "failed" so the
  //   retry UI stays consistent even when the parent's `error` prop
  //   identity does not change between attempts. NO change to the
  //   v1.0.3 blocking redeem contract: purchaseBook() is still only
  //   reached via onConfirm() in LibraryPage.confirmPurchase AFTER the
  //   coupon redeem succeeds (or when no coupon was applied).
  const handleBuy = async ({ force = false } = {}) => {
    if (!canAfford) return;
    if (!force && phase !== "idle") return;
    setPhase("deducting");
    setTimeout(() => setDisplayBalance(balance - effectivePrice), 120);
    try {
      await Promise.resolve(onConfirm?.(couponResult ? couponResult.code : null, effectivePrice));
      // If the parent didn't unmount us because of an error, celebrate then let parent close
      setPhase("unlocked");
      // Local celebratory push — bilingual, includes remaining balance.
      // Silent if not permitted, never throws.
      fireUnlockNotification(book, balance - effectivePrice);
    } catch {
      // Land in "failed" (not "idle") so the modal's retry UI stays
      // visible even when the parent's `error` string is identical to
      // the previous attempt and React bails out of the parent setState
      // (which would prevent the [error]-effect from re-firing).
      setPhase("failed");
    }
  };

  // Dedicated retry path — called from the failed-state "Try again"
  // button. Forces handleBuy past the phase guard so a single click
  // reliably triggers a fresh attempt, no double-click required.
  const handleRetry = () => handleBuy({ force: true });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase === "idle") onCancel();
      }}
      className="fixed inset-0 z-[70] grid place-items-center px-4 bg-black/70 backdrop-blur-md"
      data-testid="purchase-modal"
    >
      <motion.div
        initial={{ scale: 0.88, y: 26, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.92, y: 14, opacity: 0 }}
        transition={{ type: "spring", damping: 22, stiffness: 260 }}
        className="relative w-full max-w-[420px] rounded-3xl overflow-hidden"
        style={{
          background:
            "radial-gradient(130% 110% at 10% 0%, rgba(212,168,67,0.28), transparent 55%), linear-gradient(165deg, #2A1F38 0%, #150F1D 100%)",
          boxShadow:
            "0 40px 100px -20px rgba(0,0,0,0.75), 0 0 0 1px rgba(212,168,67,0.25), inset 0 1px 0 rgba(255,255,255,0.07)",
        }}
      >
        {/* Close */}
        {phase === "idle" && (
          <button
            onClick={onCancel}
            aria-label="Close"
            data-testid="purchase-close"
            className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full text-faded hover:text-parchment hover:bg-white/10 transition"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Confetti surface — only on unlocked */}
        <div ref={confettiRef} className="pointer-events-none absolute inset-0 overflow-hidden">
          <AnimatePresence>
            {phase === "unlocked" && (
              <>
                {Array.from({ length: 22 }).map((_, i) => {
                  const angle = (i * 360) / 22 + Math.random() * 15;
                  const distance = 150 + Math.random() * 120;
                  const dx = Math.cos((angle * Math.PI) / 180) * distance;
                  const dy = Math.sin((angle * Math.PI) / 180) * distance;
                  const hue = ["#FFD700", "#D4A843", "#E97A7A", "#7DA8E0", "#00BFA5"][i % 5];
                  return (
                    <motion.span
                      key={i}
                      initial={{ opacity: 1, x: 0, y: 0, scale: 0 }}
                      animate={{
                        opacity: [1, 1, 0],
                        x: dx,
                        y: dy,
                        scale: [0, 1, 0.8],
                        rotate: Math.random() * 360,
                      }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
                      className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
                      style={{
                        background: hue,
                        boxShadow: `0 0 14px ${hue}`,
                      }}
                    />
                  );
                })}
              </>
            )}
          </AnimatePresence>
        </div>

        <div className="relative p-7 pt-10">
          {/* Cover preview */}
          <div className="flex items-start gap-4 mb-5">
            <motion.div
              initial={{ rotateY: -24, scale: 0.9 }}
              animate={{ rotateY: 0, scale: 1 }}
              transition={{ delay: 0.1, type: "spring", damping: 18 }}
              className="relative flex-none h-[96px] w-[72px] rounded-lg overflow-hidden"
              style={{
                background: meta?.gradient || book?.coverGradient || "linear-gradient(155deg, #3A1B1B, #6A2D2D)",
                boxShadow:
                  "0 14px 28px -10px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08), inset -2px 0 6px -2px rgba(0,0,0,0.5)",
              }}
            >
              <span className="absolute left-0 top-0 h-full w-[4px]" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.5), transparent 50%, rgba(0,0,0,0.5))" }} />
              <span className="absolute inset-0 grid place-items-center text-3xl">
                {book?.coverEmoji || meta?.emoji || "📖"}
              </span>
            </motion.div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.22em] text-faded mb-0.5">Unlock this book</p>
              <h3
                className="font-display text-[20px] leading-tight text-parchment line-clamp-2"
                style={{ fontFamily: '"Playfair Display", Georgia, serif' }}
                data-testid="purchase-title"
              >
                {book?.title}
              </h3>
              {book?.subtitle && (
                <p className="text-[12px] italic text-faded mt-1 line-clamp-2">{book.subtitle}</p>
              )}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {book?.readingMinutes ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-parchment/70 border border-white/5">
                    ⏱ {book.readingMinutes} min
                  </span>
                ) : null}
                {book?.level && (
                  <span className="inline-flex items-center rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-parchment/70 border border-white/5">
                    {book.level}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Price + balance display */}
          <div
            className="rounded-2xl p-4 mb-4 border border-gold/25"
            style={{
              background:
                "linear-gradient(155deg, rgba(212,168,67,0.14) 0%, rgba(255,225,154,0.05) 100%)",
            }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.2em] text-faded mb-1">Price</p>
                <div className="flex items-center gap-2">
                  <motion.div
                    animate={
                      phase === "deducting"
                        ? { rotate: [0, 360], scale: [1, 1.2, 1] }
                        : {}
                    }
                    transition={{ duration: 0.9 }}
                    className="grid h-10 w-10 place-items-center rounded-full"
                    style={{
                      background:
                        "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)",
                      boxShadow:
                        "0 8px 20px rgba(212,168,67,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
                    }}
                  >
                    <Gem className="h-5 w-5 text-ink" />
                  </motion.div>
                  <span
                    className="tabular font-display text-[28px] font-bold leading-none"
                    style={{ color: couponResult ? "#6ee7b7" : "#FFE19A" }}
                    data-testid="purchase-price"
                  >
                    {effectivePrice}
                  </span>
                  {couponResult && (
                    <span className="ml-2 text-[12px] line-through text-faded">{price}</span>
                  )}
                  <span className="text-[11px] uppercase tracking-wider text-faded ml-0.5">pts</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-[0.2em] text-faded mb-1">Your balance</p>
                <p
                  className="tabular font-display text-[22px] font-semibold leading-none"
                  style={{ color: canAfford ? "#B8F3D2" : "#FFAEAE" }}
                  data-testid="purchase-balance"
                >
                  <AnimatedNumber from={balance} to={displayBalance} />
                  <span className="text-[10px] font-normal uppercase tracking-wider opacity-70 ml-1">pts</span>
                </p>
                {!canAfford && (
                  <p className="mt-1 text-[10px] text-[#FFAEAE] uppercase tracking-wider inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Need {price - balance} more
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── Coupon discount box ── */}
          {phase === "idle" && (
            <div className="mb-4">
              {!couponResult ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={couponCode}
                    onChange={e => { setCouponCode(e.target.value.toUpperCase()); setCouponError(null); }}
                    onKeyDown={e => e.key === "Enter" && applyCoupon()}
                    placeholder="Coupon code (optional)"
                    maxLength={24}
                    className="flex-1 rounded-xl border border-white/12 bg-white/5 px-3 py-2 text-[12px] text-parchment placeholder-faded focus:border-gold/40 focus:outline-none transition"
                    data-testid="coupon-input"
                  />
                  <button
                    onClick={applyCoupon}
                    disabled={couponLoading || !couponCode.trim()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-gold/30 bg-gold/10 px-3 py-2 text-[11px] font-bold text-gold hover:bg-gold/20 transition disabled:opacity-40"
                    data-testid="coupon-apply-btn"
                  >
                    {couponLoading
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Ticket className="h-3.5 w-3.5" />}
                    Apply
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between rounded-xl border border-emerald-400/30 bg-emerald-900/20 px-3 py-2">
                  <div className="flex items-center gap-2 text-[12px] text-emerald-300">
                    <Ticket className="h-3.5 w-3.5 flex-none" />
                    <span><b>{couponResult.code}</b> — {couponResult.coupon_type === "percent" ? `${couponResult.coupon_value}%` : `${couponResult.coupon_value} pts`} off · saving {couponResult.discount_amount} pts</span>
                  </div>
                  <button onClick={removeCoupon} className="ml-2 text-faded hover:text-parchment text-[10px]" data-testid="coupon-remove-btn">✕</button>
                </div>
              )}
              {couponError && (
                <p className="mt-1.5 text-[11px] text-red-400 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 flex-none" /> {couponError}
                </p>
              )}
            </div>
          )}

          {/* Reward-kind v1.0.2 — explicit price breakdown after the backend
              has validated the voucher. The discounted price below is the
              backend-validated value (couponResult.discounted_price), never a
              client-side calculation. */}
          {phase === "idle" && couponResult && (
            <div
              className="mb-4 rounded-xl border border-emerald-400/25 bg-emerald-900/15 px-3 py-2.5 text-[12px]"
              data-testid="purchase-price-breakdown"
            >
              <div className="flex items-center justify-between text-parchment/80">
                <span>Original price</span>
                <span className="tabular line-through text-faded">{price} pts</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-emerald-300">
                <span>Voucher discount{couponResult.code ? ` (${couponResult.code})` : ""}</span>
                <span className="tabular">− {couponResult.discount_amount} pts</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-white/10 pt-1.5 font-bold text-parchment">
                <span>You pay</span>
                <span className="tabular text-[#6ee7b7]">{couponResult.discounted_price} pts</span>
              </div>
            </div>
          )}

          {/* Value prop / dopamine hook */}
          {phase === "idle" && canAfford && (
            <>
              <p className="text-[13px] text-parchment/80 leading-relaxed mb-3">
                Spend <span className="font-bold text-gold">{price} pts</span> to unlock
                this book forever. Read at your own pace, bookmark pages, and earn
                points back when you finish it. ✨
              </p>
              <div
                className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-900/25 border border-emerald-400/25 px-3 py-2 text-[11px] text-emerald-200"
                data-testid="purchase-live-badge"
              >
                <ShieldCheck className="h-3.5 w-3.5 flex-none" />
                <span><b>Live deduction</b> — points are debited from your real balance instantly.</span>
              </div>
            </>
          )}
          {phase === "idle" && !canAfford && (
            <>
              <p className="text-[13px] text-parchment/80 leading-relaxed mb-3">
                You're <span className="font-bold text-[#FFAEAE]">{price - balance} pts</span> short.
                Earn more points by spinning the wheel or finishing free lessons — you'll
                be back in no time.
              </p>
              <Link
                to="/game"
                onClick={onCancel}
                data-testid="purchase-topup-link"
                className="mb-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gold/30 bg-walnut/60 px-3 py-2.5 text-[12px] font-bold uppercase tracking-wider text-gold hover:border-gold hover:bg-gold/10 transition-colors"
              >
                <Zap className="h-3.5 w-3.5" />
                Top up at Lucky Spin
              </Link>
            </>
          )}

          {/* Failure panel */}
          {phase === "failed" && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-4 rounded-lg border border-[#FFAEAE]/35 bg-[#3a1e1e]/60 px-3 py-3 text-[12.5px] text-[#FFD5D5]"
              data-testid="purchase-error"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 flex-none mt-0.5 text-[#FFAEAE]" />
                <div>
                  <p className="font-semibold mb-0.5">Couldn't complete the purchase</p>
                  <p className="text-[#FFC7C7] leading-snug">{error || "Please try again in a moment."}</p>
                </div>
              </div>
            </motion.div>
          )}

          {/* Action buttons */}
          {(phase === "idle" || phase === "failed") && (
            <div className="flex gap-2.5">
              <button
                onClick={onCancel}
                data-testid="purchase-cancel"
                className="flex-1 rounded-xl border border-parchment/15 bg-walnut/60 py-3 text-sm font-medium text-parchment hover:border-magenta/40 hover:text-[#FFB7CF] transition-colors"
              >
                {phase === "failed" ? "Close" : "Not now"}
              </button>
              <motion.button
                whileHover={canAfford ? { y: -2, scale: 1.02 } : {}}
                whileTap={canAfford ? { scale: 0.97 } : {}}
                onClick={() => { if (phase === "failed") { handleRetry(); } else { handleBuy(); } }}
                disabled={!canAfford}
                data-testid="purchase-confirm"
                className="flex-[1.4] relative overflow-hidden rounded-xl py-3 text-sm font-bold tracking-wide text-ink transition-transform disabled:cursor-not-allowed"
                style={{
                  background: canAfford
                    ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                    : "linear-gradient(135deg, rgba(212,168,67,0.35), rgba(120,85,30,0.35))",
                  boxShadow: canAfford
                    ? "0 14px 28px rgba(212,168,67,0.45), inset 0 1px 0 rgba(255,255,255,0.65)"
                    : "none",
                  opacity: canAfford ? 1 : 0.55,
                }}
              >
                {canAfford && (
                  <motion.span
                    aria-hidden
                    className="absolute inset-y-0 -left-1/3 w-1/3 pointer-events-none"
                    animate={{ x: ["-20%", "420%"] }}
                    transition={{ duration: 2.4, repeat: Infinity, ease: "linear", repeatDelay: 1 }}
                    style={{
                      background:
                        "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
                      filter: "blur(2px)",
                    }}
                  />
                )}
                <span className="relative inline-flex items-center justify-center gap-2">
                  <Unlock className="h-4 w-4" />
                  {phase === "failed" ? "Try again" : `Unlock for ${effectivePrice} pts`}
                </span>
              </motion.button>
            </div>
          )}

          {/* Deducting spinner */}
          {phase === "deducting" && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center justify-center gap-2 py-3"
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
                className="h-5 w-5 rounded-full border-2 border-gold/30 border-t-gold"
              />
              <span className="text-[13px] uppercase tracking-[0.2em] text-gold font-bold">
                Deducting points…
              </span>
            </motion.div>
          )}

          {/* Unlocked celebration */}
          {phase === "unlocked" && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              transition={{ type: "spring", damping: 12, stiffness: 180 }}
              className="text-center py-2"
              data-testid="purchase-success"
            >
              <motion.div
                animate={{ rotate: [0, -10, 10, -6, 0] }}
                transition={{ duration: 0.6, ease: "easeInOut" }}
                className="mx-auto mb-2 grid h-14 w-14 place-items-center rounded-full"
                style={{
                  background: "linear-gradient(135deg, #B8F3D2 0%, #00BFA5 100%)",
                  boxShadow: "0 18px 40px rgba(0,191,165,0.5)",
                }}
              >
                <Check className="h-8 w-8 text-ink" strokeWidth={3} />
              </motion.div>
              <p className="font-display text-[20px] text-parchment leading-tight">
                Unlocked!
              </p>
              <p className="text-[12px] text-faded mt-1 inline-flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-gold" />
                Opening the book…
              </p>
            </motion.div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
