// GamePublic.jsx — public preview at /game.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Sparkles, Trophy, Coins, Lock, ArrowRight, Loader2 } from "lucide-react";
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

  return (
    <div className="px-3 sm:px-5 py-4 max-w-[1080px] mx-auto" data-testid="game-public">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-[0_0_24px_rgba(255,61,166,0.55)]"
            style={{ background: "linear-gradient(135deg, #ffc94d, #ff3da6, #9b5cff)" }}
          >
            <Sparkles className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-iridescent">Lucky Spin</h1>
            <p className="text-xs text-white/55">Spin · Win · Redeem · Public preview</p>
          </div>
        </div>
        <p className="text-sm text-white/70 leading-relaxed mb-5 max-w-2xl">
          Spend points to spin the wheel, unlock the Mystery Vault, and redeem real classroom
          rewards. Sign in with your Student ID to start playing.
        </p>
      </motion.div>

      {/* Top prizes grid */}
      <div className="rounded-2xl border border-aurora-magenta/35 bg-white/[0.04] backdrop-blur-md p-4 sm:p-5 mb-5">
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="h-4 w-4 text-aurora-gold" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-white">Prize Board</h2>
          {cfg?.spinCost != null && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-aurora-gold/15 border border-aurora-gold/40 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-aurora-gold">
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
                className="rounded-xl border border-white/10 bg-black/30 p-3 flex flex-col items-center text-center"
              >
                <div className="text-2xl mb-1">{p.Emoji}</div>
                <div className="text-xs font-semibold text-white truncate w-full">{p.PrizeName}</div>
                <div className="text-[10px] font-bold text-aurora-gold mt-0.5">{p.RewardPoints} pts</div>
              </motion.div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/55">Prize board temporarily unavailable.</p>
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
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
          >
            <h3 className="font-display text-sm font-bold text-aurora-magenta">{s.t}</h3>
            <p className="text-xs text-white/65 mt-1 leading-relaxed">{s.d}</p>
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
        className="rounded-2xl border border-aurora-magenta/40 bg-gradient-to-br from-aurora-magenta/10 to-aurora-gold/10 p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-4"
        data-testid="game-login-nudge"
      >
        <div className="flex-1">
          <h3 className="font-display text-lg font-bold text-white mb-1">Ready to spin?</h3>
          <p className="text-sm text-white/65">Sign in with your Student ID to start earning prizes.</p>
        </div>
        <Link
          to={isAuthenticated ? "/game/play" : "/login?redirect=/game/play"}
          className="inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-[0_8px_22px_-8px_rgba(255,61,166,0.6)]"
          style={{ background: "linear-gradient(135deg, #ffc94d, #ff3da6, #9b5cff)" }}
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
