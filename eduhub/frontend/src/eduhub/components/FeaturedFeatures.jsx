// FeaturedFeatures.jsx — 2 large hero cards (My Portal + Lucky Spin)
//   showing live preview data from each feature's own backend.
import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { GraduationCap, Sparkles, Lock, ArrowRight, Loader2, Trophy, Coins } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getSlotConfig } from "../pages/game/lib/api";

function FeatureSkeleton() {
  return (
    <div className="absolute inset-0 skeleton" aria-hidden />
  );
}

const PortalCard = memo(function PortalCard() {
  const { isAuthenticated, student } = useAuth();
  const personal = isAuthenticated ? "/portal/me" : "/login?redirect=/portal/me";

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.05 }}
      whileHover={{ y: -6 }}
      className="group relative overflow-hidden rounded-3xl border border-aurora-cyan/35 bg-white/[0.04] backdrop-blur-xl p-5 sm:p-6"
      data-testid="featured-portal"
    >
      <div className="absolute -top-20 -right-20 h-56 w-56 rounded-full bg-aurora-cyan/15 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-20 -left-10 h-44 w-44 rounded-full bg-aurora-violet/15 blur-3xl pointer-events-none" />

      <div className="relative flex items-center gap-3 mb-4">
        <div className="h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-[0_0_24px_rgba(0,224,255,0.5)]"
          style={{ background: "linear-gradient(135deg, #00e0ff, #9b5cff)" }}>
          <GraduationCap className="h-6 w-6" />
        </div>
        <div>
          <h3 className="font-display text-xl font-bold text-white">My Portal</h3>
          <p className="text-xs text-white/55">Monthly evaluation · Points · Feedback</p>
        </div>
      </div>

      <p className="relative text-sm text-white/70 leading-relaxed mb-4">
        Your personal evaluation dashboard — pronunciation, intonation, communication scores,
        teacher comments, points balance, and tuition reminders.
      </p>

      <div className="relative grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-xl bg-black/30 border border-white/10 p-2.5 text-center">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Criteria</div>
          <div className="font-display text-lg font-bold text-aurora-cyan">6</div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/10 p-2.5 text-center">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Live</div>
          <div className="font-display text-lg font-bold text-aurora-lime">12s</div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/10 p-2.5 text-center">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Lang</div>
          <div className="font-display text-lg font-bold text-aurora-magenta">EN/KH</div>
        </div>
      </div>

      <div className="relative flex items-center gap-2 flex-wrap">
        <Link
          to="/portal"
          data-testid="featured-portal-explore"
          className="inline-flex items-center gap-1.5 rounded-full border border-aurora-cyan/40 bg-aurora-cyan/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-aurora-cyan hover:bg-aurora-cyan/20 transition"
        >
          Explore <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          to={personal}
          data-testid="featured-portal-personal"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-[0_8px_22px_-8px_rgba(0,224,255,0.6)] transition hover:scale-[1.03]"
          style={{ background: "linear-gradient(135deg, #00e0ff, #9b5cff)" }}
        >
          {isAuthenticated ? (
            <>View My Dashboard <ArrowRight className="h-3.5 w-3.5" /></>
          ) : (
            <><Lock className="h-3.5 w-3.5" /> Login to access</>
          )}
        </Link>
      </div>
    </motion.div>
  );
});

const SpinCard = memo(function SpinCard() {
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

  const personal = isAuthenticated ? "/game/play" : "/login?redirect=/game/play";
  const top = cfg?.prizes?.[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15 }}
      whileHover={{ y: -6 }}
      className="group relative overflow-hidden rounded-3xl border border-aurora-magenta/40 bg-white/[0.04] backdrop-blur-xl p-5 sm:p-6 min-h-[300px]"
      data-testid="featured-game"
    >
      {loading && <FeatureSkeleton />}
      <div className="absolute -top-20 -right-20 h-56 w-56 rounded-full bg-aurora-magenta/15 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-16 -left-10 h-40 w-40 rounded-full bg-aurora-gold/15 blur-3xl pointer-events-none" />

      <div className="relative flex items-center gap-3 mb-4">
        <div className="h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-[0_0_24px_rgba(255,61,166,0.55)]"
          style={{ background: "linear-gradient(135deg, #ffc94d, #ff3da6, #9b5cff)" }}>
          <Sparkles className="h-6 w-6" />
        </div>
        <div>
          <h3 className="font-display text-xl font-bold text-white">Lucky Spin</h3>
          <p className="text-xs text-white/55">Spin · Win · Redeem real rewards</p>
        </div>
      </div>

      <p className="relative text-sm text-white/70 leading-relaxed mb-4">
        Spend points to spin the wheel, unlock the Mystery Vault, win prizes, and redeem
        real classroom rewards from the Reward Vault.
      </p>

      <div className="relative grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-xl bg-black/30 border border-white/10 p-2.5 text-center">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold flex items-center justify-center gap-1">
            <Trophy className="h-2.5 w-2.5 text-aurora-gold" /> Top
          </div>
          <div className="font-display text-sm font-bold text-aurora-gold truncate">
            {top ? `${top.Emoji ?? ""} ${top.PrizeName}` : <Loader2 className="h-3.5 w-3.5 animate-spin mx-auto" />}
          </div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/10 p-2.5 text-center">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold flex items-center justify-center gap-1">
            <Coins className="h-2.5 w-2.5 text-aurora-magenta" /> Cost
          </div>
          <div className="font-display text-lg font-bold text-aurora-magenta">
            {cfg?.spinCost ?? "—"}
          </div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/10 p-2.5 text-center">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Prizes</div>
          <div className="font-display text-lg font-bold text-aurora-violet">
            {cfg?.prizes?.length ?? "—"}
          </div>
        </div>
      </div>

      <div className="relative flex items-center gap-2 flex-wrap">
        <Link
          to="/game"
          data-testid="featured-game-explore"
          className="inline-flex items-center gap-1.5 rounded-full border border-aurora-magenta/40 bg-aurora-magenta/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-aurora-magenta hover:bg-aurora-magenta/20 transition"
        >
          Explore <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          to={personal}
          data-testid="featured-game-personal"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-[0_8px_22px_-8px_rgba(255,61,166,0.6)] transition hover:scale-[1.03]"
          style={{ background: "linear-gradient(135deg, #ffc94d, #ff3da6, #9b5cff)" }}
        >
          {isAuthenticated ? (
            <>Play Now <ArrowRight className="h-3.5 w-3.5" /></>
          ) : (
            <><Lock className="h-3.5 w-3.5" /> Login to play</>
          )}
        </Link>
      </div>
    </motion.div>
  );
});

export default function FeaturedFeatures() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 mb-5 sm:mb-6" data-testid="featured-features">
      <PortalCard />
      <SpinCard />
    </div>
  );
}
