import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  X,
  Gift,
  Coins,
  ArrowRight,
  Sparkles,
  AlertTriangle,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import type { Reward } from "../lib/shopApi";

interface RedeemConfirmModalProps {
  reward: Reward;
  currentPoints: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function CountdownNumber({
  from,
  to,
  className,
}: {
  from: number;
  to: number;
  className?: string;
}) {
  const [n, setN] = useState(from);
  const fromRef = useRef(from);
  useEffect(() => {
    const start = performance.now();
    const duration = 600;
    const a = fromRef.current;
    const b = to;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setN(Math.round(a + (b - a) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = b;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <span className={className}>{n}</span>;
}

export function RedeemConfirmModal({
  reward,
  currentPoints,
  busy,
  onCancel,
  onConfirm,
}: RedeemConfirmModalProps) {
  const stock = Number(reward.Stock ?? 0);
  const remaining = currentPoints - reward.PointCost;
  const canAfford = remaining >= 0;
  const inStock = stock > 0;
  const blocked = !canAfford || !inStock;

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <motion.div
      key="redeem-confirm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onCancel()}
      className="fixed inset-0 z-[260] flex items-center justify-center bg-[rgba(11,5,32,0.85)] px-4 backdrop-blur-md"
      data-testid="redeem-confirm-modal"
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.85, y: 30, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: "spring", stiffness: 280, damping: 24 }}
        className="glass-strong relative w-full max-w-md overflow-hidden rounded-3xl shadow-[0_25px_60px_rgba(0,0,0,0.55)]"
      >
        {/* Top animated ring */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px]"
          style={{
            background:
              "linear-gradient(90deg, transparent, #FFD85C, #FF4081, #13C2C2, #FFD85C, transparent)",
            backgroundSize: "200% 100%",
          }}
          animate={{ backgroundPositionX: ["0%", "200%"] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "linear" }}
        />

        {/* Background flare */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-10 -z-10 rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle at 30% 30%, rgba(255,216,92,0.35), transparent 60%), radial-gradient(circle at 70% 70%, rgba(255,64,129,0.35), transparent 60%)",
          }}
          animate={{ opacity: [0.4, 0.8, 0.4] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />

        <button
          onClick={onCancel}
          disabled={busy}
          className="absolute right-3 top-3 z-10 rounded-full p-2 text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          aria-label="Close"
          data-testid="redeem-confirm-close"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="px-6 pb-6 pt-7 sm:px-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <motion.div
              initial={{ scale: 0.6, rotate: -10 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 14 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl shadow-[0_8px_25px_rgba(255,64,129,0.45)]"
              style={{
                background: "linear-gradient(135deg, #FF4081, #D81B60)",
              }}
            >
              <Gift className="h-8 w-8 text-white" />
            </motion.div>
            <div>
              <h2 className="text-lg font-extrabold tracking-wider text-gradient-gold sm:text-xl">
                CONFIRM REDEMPTION
              </h2>
              <p className="mt-1 text-xs text-white/60">
                Review the details before spending your points.
              </p>
            </div>
          </div>

          {/* Reward preview */}
          <div className="mt-5 flex items-center gap-3 rounded-2xl border border-white/10 bg-black/35 p-3">
            <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-black/40">
              {reward.Image ? (
                <img
                  src={reward.Image}
                  alt={reward.ItemName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Sparkles className="h-7 w-7 text-[#FFD85C]/70" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-white">
                {reward.ItemName}
              </div>
              {reward.Description && (
                <div className="line-clamp-2 text-[11px] leading-tight text-white/55">
                  {reward.Description}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2 text-[10px]">
                <span className="rounded-full bg-[#FFD85C]/15 px-2 py-0.5 font-bold text-[#FFD85C]">
                  {reward.PointCost} pts
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-bold ${
                    inStock
                      ? "bg-[#13C2C2]/15 text-[#13C2C2]"
                      : "bg-[#FF4081]/15 text-[#FF4081]"
                  }`}
                >
                  {inStock ? `${stock} in stock` : "Sold out"}
                </span>
              </div>
            </div>
          </div>

          {/* Points calculator */}
          <div className="mt-4 grid grid-cols-3 items-center gap-2 rounded-2xl border border-white/10 bg-black/35 p-3 text-center">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-white/50">
                Current
              </div>
              <div className="mt-0.5 flex items-center justify-center gap-1 text-base font-bold text-white">
                <Coins className="h-3.5 w-3.5 text-[#FFD85C]" />
                {currentPoints}
              </div>
            </div>
            <div className="flex flex-col items-center justify-center">
              <ArrowRight className="h-4 w-4 text-white/40" />
              <div className="mt-1 text-[10px] font-bold text-[#FF4081]">
                −{reward.PointCost}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-wider text-white/50">
                Remaining
              </div>
              <motion.div
                key={`rem-${reward.ItemName}`}
                animate={{
                  textShadow: canAfford
                    ? [
                        "0 0 0px rgba(19,194,194,0)",
                        "0 0 14px rgba(19,194,194,0.65)",
                        "0 0 0px rgba(19,194,194,0)",
                      ]
                    : [
                        "0 0 0px rgba(255,64,129,0)",
                        "0 0 14px rgba(255,64,129,0.65)",
                        "0 0 0px rgba(255,64,129,0)",
                      ],
                }}
                transition={{ duration: 2, repeat: Infinity }}
                className={`mt-0.5 flex items-center justify-center gap-1 text-base font-extrabold ${
                  canAfford ? "text-[#13C2C2]" : "text-[#FF4081]"
                }`}
              >
                <Coins className="h-3.5 w-3.5" />
                <CountdownNumber from={currentPoints} to={remaining} />
              </motion.div>
            </div>
          </div>

          {/* Block reason */}
          {blocked && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#FF4081]/30 bg-[#FF4081]/10 px-3 py-2 text-xs text-[#FFB0CC]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#FF4081]" />
              <span>
                {!inStock
                  ? "This reward is currently sold out."
                  : `You need ${Math.abs(remaining)} more point${Math.abs(remaining) !== 1 ? "s" : ""} to redeem this reward.`}
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="mt-5 grid grid-cols-2 gap-2">
            <motion.button
              whileHover={!busy ? { scale: 1.02 } : undefined}
              whileTap={!busy ? { scale: 0.97 } : undefined}
              onClick={onCancel}
              disabled={busy}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/10 disabled:opacity-50"
              data-testid="redeem-confirm-cancel"
            >
              Cancel
            </motion.button>
            <motion.button
              whileHover={!blocked && !busy ? { scale: 1.04 } : undefined}
              whileTap={!blocked && !busy ? { scale: 0.96 } : undefined}
              onClick={onConfirm}
              disabled={blocked || busy}
              className="flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white shadow-[0_8px_25px_rgba(255,64,129,0.5)] transition disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              style={{
                background: blocked
                  ? "linear-gradient(135deg, #555, #777)"
                  : "linear-gradient(135deg, #FF4081, #D81B60)",
              }}
              data-testid="redeem-confirm-submit"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Redeeming…
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  Confirm Redeem
                </>
              )}
            </motion.button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
