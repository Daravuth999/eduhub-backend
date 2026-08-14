// GamePublic.jsx — v14 (Premium Readability Surgery, Feb 2026)
//
// Same readability fix as PortalPublic: every text node now adapts to
// the active [data-theme] via CSS variables. Slot config fetch, winners
// ticker, login redirect, and all data-testid hooks are byte-identical.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Sparkles, Trophy, Coins, Lock, ArrowRight } from "lucide-react";
import { getSlotConfig } from "./lib/api";
import { WinnersTicker } from "./components/WinnersTicker";
import { useAuth } from "../../context/AuthContext";

const PUBLIC_WINNERS = [
  "Snack Voucher - 2 days ago - -50pts",
  "School Pen - 1 day ago - -30pts",
  "Reward Sticker - 3h ago - -20pts",
  "Movie Night - 6h ago - -120pts",
  "Coffee Coupon - yesterday - -80pts",
];

export default function GamePublic() {
  const { isAuthenticated } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getSlotConfig()
      .then((c) => !cancelled && setCfg(c))
      .catch(() => !cancelled && setCfg(null))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // v14 — palette tokens
  const ink     = "rgb(var(--bgfx-ink))";
  const inkMute = "rgb(var(--bgfx-ink-mute))";
  const cardBg  = "rgb(var(--bgfx-card))";
  const cardBdr = "rgb(var(--bgfx-line) / 0.10)";

  return (
    <div
      className="px-3 sm:px-5 py-4 max-w-[1080px] mx-auto"
      style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
      data-testid="game-public"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center text-white"
            style={{
              background: "linear-gradient(135deg, #ffc94d, #ff3da6, #9b5cff)",
              boxShadow: "0 8px 22px rgba(255,61,166,0.35)",
            }}
          >
            <Sparkles className="h-6 w-6" />
          </div>
          <div>
            <h1
              className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight"
              style={{ color: ink, letterSpacing: "-0.01em" }}
            >
              Lucky Spin
            </h1>
            <p className="text-xs font-semibold" style={{ color: inkMute }}>
              Spin · Win · Redeem · Public preview
            </p>
          </div>
        </div>
        <p
          className="text-[15px] leading-relaxed mb-5 max-w-2xl"
          style={{ color: inkMute }}
        >
          Spend points to spin the wheel, unlock the Mystery Vault, and redeem real classroom
          rewards. Sign in with your Student ID to start playing.
        </p>
      </motion.div>

      {/* Top prizes grid */}
      <div
        className="rounded-2xl p-4 sm:p-5 mb-5"
        style={{
          background: cardBg,
          border: `1px solid ${cardBdr}`,
          boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
        }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="h-4 w-4" style={{ color: "rgb(var(--bgfx-accent-warm))" }} />
          <h2
            className="font-display text-sm font-extrabold uppercase tracking-[0.14em]"
            style={{ color: ink }}
          >
            Prize Board
          </h2>
          {cfg?.spinCost != null && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background: "rgb(var(--bgfx-accent-warm) / 0.16)",
                border: "1px solid rgb(var(--bgfx-accent-warm) / 0.45)",
                color: "rgb(var(--bgfx-accent-warm))",
              }}
            >
              <Coins className="h-3 w-3" /> {cfg.spinCost} pts / spin
            </span>
          )}
        </div>
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 rounded-xl skeleton" />
            ))}
          </div>
        ) : cfg?.prizes?.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {cfg.prizes.map((p, i) => (
              <motion.div
                key={p.PrizeName + i}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="rounded-xl p-3 flex flex-col items-center text-center"
                style={{
                  background: "rgb(var(--bgfx-line) / 0.05)",
                  border: `1px solid ${cardBdr}`,
                }}
              >
                <div className="text-2xl mb-1">{p.Emoji}</div>
                <div
                  className="text-xs font-semibold truncate w-full"
                  style={{ color: ink }}
                >
                  {p.PrizeName}
                </div>
                <div
                  className="text-[10px] font-bold mt-0.5"
                  style={{ color: "rgb(var(--bgfx-accent-warm))" }}
                >
                  {p.RewardPoints} pts
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: inkMute }}>
            Prize board temporarily unavailable.
          </p>
        )}
      </div>

      {/* How it works */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 mb-5">
        {[
          { t: "1. Earn Points", d: "Score well in class evaluations to grow your balance." },
          { t: "2. Spin the Wheel", d: "Each spin costs points; the Mystery Vault appears every 5th spin." },
          { t: "3. Redeem Rewards", d: "Convert winnings into real classroom prizes from the Reward Vault." },
        ].map((s, i) => (
          <motion.div
            key={s.t}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            className="rounded-xl p-4"
            style={{
              background: cardBg,
              border: `1px solid ${cardBdr}`,
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            <h3
              className="font-display text-sm font-extrabold tracking-tight"
              style={{ color: "rgb(var(--bgfx-accent))" }}
            >
              {s.t}
            </h3>
            <p
              className="text-[13px] mt-1.5 leading-relaxed"
              style={{ color: inkMute }}
            >
              {s.d}
            </p>
          </motion.div>
        ))}
      </div>

      {/* Winners ticker */}
      <div className="mb-5">
        <WinnersTicker history={PUBLIC_WINNERS} />
      </div>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-4"
        style={{
          background:
            "linear-gradient(135deg, rgb(var(--bgfx-accent-warm) / 0.12), rgb(var(--bgfx-accent) / 0.10))",
          border: "1px solid rgb(var(--bgfx-accent-warm) / 0.40)",
        }}
        data-testid="game-login-nudge"
      >
        <div className="flex-1">
          <h3
            className="font-display text-lg font-extrabold mb-1"
            style={{ color: ink }}
          >
            Ready to spin?
          </h3>
          <p className="text-sm" style={{ color: inkMute }}>
            Sign in with your Student ID to start earning prizes.
          </p>
        </div>
        <Link
          to={isAuthenticated ? "/game/play" : "/login?redirect=/game/play"}
          className="inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white"
          style={{
            background: "linear-gradient(135deg, #ffc94d, #ff3da6, #9b5cff)",
            boxShadow: "0 8px 22px -8px rgba(255,61,166,0.6)",
          }}
          data-testid="game-login-cta"
        >
          {isAuthenticated ? (
            <>Play Now <ArrowRight className="h-3.5 w-3.5" /></>
          ) : (
            <><Lock className="h-3.5 w-3.5" /> Login to play <ArrowRight className="h-3.5 w-3.5" /></>
          )}
        </Link>
      </motion.div>
    </div>
  );
}
