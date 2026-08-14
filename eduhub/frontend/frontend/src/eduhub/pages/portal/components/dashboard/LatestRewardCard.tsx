import { AnimatePresence, motion } from "framer-motion";
import { Gift, Minus, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Sparkle } from "../primitives/Sparkle";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import {
  readLatestReward,
  relativeTime,
  type RewardSnapshot,
} from "../../lib/rewardMemory";
import type { SpendDeltaEvent } from "../../hooks/usePoints";

interface Props {
  studentId: string;
  /** Bumps whenever a new reward is persisted — triggers the entry animation. */
  rewardVersion: number;
  /** Latest spend event — used to neutralise a stale reward card. */
  spendEvent: SpendDeltaEvent | null;
}

/* Inline EN/KM literals — copy.ts must not be modified. */
const NEUTRAL = {
  titleEn: "Balance adjusted",
  titleKm: "ការកែតម្រូវពិន្ទុ",
  subEn: "Points were deducted",
  subKm: "ពិន្ទុត្រូវបានកាត់",
};

export function LatestRewardCard({
  studentId,
  rewardVersion,
  spendEvent,
}: Props) {
  const { t, lang, num } = useLang();
  const reduced = useReducedMotion();
  const [reward, setReward] = useState<RewardSnapshot | null>(() =>
    readLatestReward(studentId),
  );
  const [arriving, setArriving] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const fresh = readLatestReward(studentId);
    setReward(fresh);
    if (fresh && rewardVersion > 0) {
      setArriving(true);
      const to = setTimeout(() => setArriving(false), 1800);
      return () => clearTimeout(to);
    }
  }, [studentId, rewardVersion]);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const ago = useMemo(
    () => (reward ? relativeTime(reward.ts, lang) : ""),
    [reward, lang], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ---------- Neutralisation — spend is newer than the cached reward ------- */
  const isNeutralised = useMemo(() => {
    if (!spendEvent) return false;
    if (!reward) return false;
    return reward.ts < Date.now();
  }, [spendEvent, reward]);

  const accentA = arriving ? "var(--color-good)" : "var(--color-accent-warm)";
  const accentB = arriving ? "var(--color-accent-warm)" : "var(--color-good)";

  /* ---------------- EMPTY STATE ---------------- */
  if (!reward) {
    return (
      <div
        className="relative rounded-2xl border border-dashed px-4 py-3 ink-shadow overflow-hidden"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-line-strong)",
        }}
        data-testid="latest-reward-card-empty"
      >
        <div className="flex items-center gap-3">
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center"
            style={{
              background:
                "color-mix(in oklab, var(--color-accent-warm) 14%, transparent)",
              color: "var(--color-accent-warm)",
            }}
          >
            <Gift className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-ink-mute)]">
              {t("rewardsLabel")}
            </div>
            <div className="text-sm text-[color:var(--color-ink-soft)] truncate">
              {t("noRewardYet")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- NEUTRALISED STATE ---------------- */
  if (isNeutralised) {
    return (
      <motion.div
        key="neutralised"
        initial={{ opacity: 1, filter: "blur(0px)" }}
        animate={{ opacity: 0.65, filter: "blur(0px)" }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative rounded-2xl ink-shadow overflow-hidden"
        data-testid="latest-reward-card-neutralised"
        data-tier={reward.tier}
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-line)",
        }}
      >
        <div className="relative flex items-center gap-3 px-4 py-3.5">
          <div
            className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background:
                "color-mix(in oklab, var(--color-ink-mute) 14%, transparent)",
              color: "var(--color-ink-mute)",
            }}
          >
            <Minus className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="display text-base font-semibold leading-tight"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {lang === "km" ? NEUTRAL.titleKm : NEUTRAL.titleEn}
            </div>
            <div
              className="text-xs mt-0.5"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {lang === "km" ? NEUTRAL.subKm : NEUTRAL.subEn}
            </div>
          </div>
        </div>
        <div
          aria-hidden
          className="absolute left-0 right-0 bottom-0 h-[3px]"
          style={{ background: "var(--color-line)" }}
        />
      </motion.div>
    );
  }

  /* ---------------- FILLED STATE — colourful, immersive ---------------- */
  const message = reward.from
    ? `${reward.from}`
    : lang === "km"
      ? reward.copyKm
      : reward.copy;

  return (
    <motion.div
      initial={false}
      animate={arriving ? { scale: [1, 1.08, 1] } : { scale: 1 }}
      transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-2xl ink-shadow overflow-hidden"
      data-testid="latest-reward-card"
      data-tier={reward.tier}
      data-arriving={arriving}
      style={{
        background: "var(--color-surface)",
        border:
          "1px solid color-mix(in oklab, var(--color-good) 30%, var(--color-line))",
      }}
    >
      {!reduced && (
        <motion.div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-50"
          animate={{ rotate: arriving ? 360 : 360 }}
          transition={{
            repeat: Infinity,
            duration: arriving ? 6 : 28,
            ease: "linear",
          }}
          style={{
            background: `conic-gradient(from 0deg, ${accentA}11, ${accentB}33, ${accentA}11, transparent, ${accentB}33, ${accentA}11)`,
            mixBlendMode: "soft-light",
          }}
        />
      )}

      {!reduced && (
        <motion.div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{
            opacity: arriving ? 1 : [0, 0.6, 0],
            x: arriving ? ["-120%", "120%"] : ["-120%", "120%"],
          }}
          transition={{
            duration: arriving ? 1.4 : 2.6,
            repeat: Infinity,
            repeatDelay: arriving ? 0 : 5,
            ease: "linear",
          }}
          style={{
            background:
              "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%)",
          }}
        />
      )}

      {!reduced && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          {[0, 120, 240].map((deg, i) => (
            <motion.div
              key={i}
              className="absolute top-1/2 left-1/2"
              style={{ transformOrigin: "0 0", color: accentB }}
              initial={{ rotate: deg }}
              animate={{ rotate: deg + 360 }}
              transition={{
                repeat: Infinity,
                duration: arriving ? 3 : 12,
                ease: "linear",
              }}
            >
              <span
                className="absolute"
                style={{
                  transform: `translate(${arriving ? 110 : 96}px, -2px)`,
                }}
              >
                <Sparkle size={arriving ? 14 : 10} color="currentColor" />
              </span>
            </motion.div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {arriving && !reduced && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden>
            {Array.from({ length: 12 }).map((_, i) => {
              const a = (i / 12) * Math.PI * 2;
              const dist = 90 + (i % 3) * 14;
              return (
                <motion.span
                  key={i}
                  className="absolute top-1/2 left-1/2"
                  initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
                  animate={{
                    x: Math.cos(a) * dist,
                    y: Math.sin(a) * dist,
                    opacity: [0, 1, 1, 0],
                    scale: [0.4, 1, 1, 0.6],
                    rotate: [0, 180, 360],
                  }}
                  transition={{ duration: 1.5, delay: i * 0.04 }}
                  style={{ color: accentA }}
                >
                  <Sparkle size={10 + (i % 3) * 3} color="currentColor" />
                </motion.span>
              );
            })}
          </div>
        )}
      </AnimatePresence>

      <div className="relative flex items-center gap-3 px-4 py-3.5">
        <motion.div
          className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0 ink-shadow"
          animate={
            arriving && !reduced
              ? { rotate: [0, -10, 10, -6, 0], scale: [1, 1.15, 1] }
              : { rotate: 0, scale: 1 }
          }
          transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
          style={{
            background: `linear-gradient(135deg, ${accentA}, ${accentB})`,
            color: "var(--color-ink)",
          }}
        >
          <Gift className="h-5 w-5" />
        </motion.div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <motion.span
              className="display tnum text-2xl sm:text-[26px] font-bold leading-none"
              style={{ color: "var(--color-good)" }}
              animate={
                arriving && !reduced
                  ? {
                      textShadow: [
                        "0 0 0 rgba(0,0,0,0)",
                        "0 0 22px color-mix(in oklab, var(--color-good) 65%, transparent)",
                        "0 0 0 rgba(0,0,0,0)",
                      ],
                    }
                  : {}
              }
              transition={{ duration: 1.2 }}
            >
              +
              <AnimatedNumber value={reward.amount} duration={1100} localise />
              <span className="hidden">{num(reward.amount)}</span>
            </motion.span>
            <span
              className="text-[10px] font-bold uppercase tracking-[0.22em] px-2 py-0.5 rounded-full"
              style={{
                background:
                  "color-mix(in oklab, var(--color-good) 16%, transparent)",
                color: "var(--color-good)",
              }}
            >
              {t("rewardsLabel")}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 min-w-0">
            <Sparkles
              className="h-3 w-3 shrink-0"
              style={{ color: accentB }}
            />
            <span className="text-xs text-[color:var(--color-ink-soft)] truncate">
              {message}
            </span>
            <span
              className="text-[11px] mono ml-auto pl-2 shrink-0"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {ago}
            </span>
          </div>
        </div>
      </div>

      <div
        aria-hidden
        className="absolute left-0 right-0 bottom-0 h-[3px]"
        style={{
          background: `linear-gradient(90deg, ${accentA}, ${accentB}, ${accentA})`,
        }}
      />
      {!reduced && (
        <motion.div
          aria-hidden
          className="absolute bottom-0 left-0 h-[3px] w-1/3"
          animate={{ x: ["-100%", "300%"] }}
          transition={{
            repeat: Infinity,
            duration: arriving ? 1.6 : 4.5,
            ease: "linear",
          }}
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent)",
          }}
        />
      )}
    </motion.div>
  );
}