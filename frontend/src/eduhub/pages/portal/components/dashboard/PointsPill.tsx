import { AnimatePresence, motion } from "framer-motion";
import { Send, ArrowDown } from "lucide-react";
import { useEffect, useMemo } from "react";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { Sparkle } from "../primitives/Sparkle";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type {
  PointsDeltaEvent,
  SpendDeltaEvent,
} from "../../hooks/usePoints";
import {
  celebrateBigPoints,
  celebrateHugePoints,
} from "../../lib/celebrate";
import type { CopyKey } from "../../config/copy";

interface Props {
  points: number;
  receiveEvent: PointsDeltaEvent | null;
  onConsumeEvent: () => void;
  spendEvent: SpendDeltaEvent | null;
  onConsumeSpendEvent: () => void;
  previousPoints: number;
  onSend: () => void;
}

const ANON_KEYS: CopyKey[] = [
  "pointsAnon1",
  "pointsAnon2",
  "pointsAnon3",
  "pointsAnon4",
  "pointsAnon5",
];

const TIER_DURATION_MS: Record<PointsDeltaEvent["tier"], number> = {
  tiny: 1500,
  nice: 4000,
  big: 5000,
  huge: 6500,
};

/* -------------------------------------------------------------------------- */
/*  Mini progress ring — sits in the icon slot                                */
/* -------------------------------------------------------------------------- */
const RING_RADIUS = 16;
const RING_STROKE = 3;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
const RING_VIEWBOX = (RING_RADIUS + RING_STROKE) * 2;
const MAX_POINTS = 2000;

type FillBand = "high" | "mid" | "low" | "critical";

function bandFor(pct: number): FillBand {
  if (pct < 0.1) return "critical";
  if (pct < 0.3) return "low";
  if (pct < 0.6) return "mid";
  return "high";
}

function bandColor(band: FillBand): string {
  if (band === "high") return "var(--color-excellent)";
  if (band === "mid") return "var(--color-good)";
  return "var(--color-needs)";
}

/* Inline EN/KM literals — copy.ts must not be modified. */
const SPEND_WHILE_AWAY = {
  en: "Points spent while you were away",
  km: "ពិន្ទុត្រូវបានចំណាយពេលអ្នកមិននៅ",
};
const LOW_BALANCE_HINT = {
  en: "Running low — earn more in class!",
  km: "ពិន្ទុជិតអស់ — រកបន្ថែមក្នុងថ្នាក់!",
};
const FROM_LABEL = { en: "from", km: "ពី" };
const BEFORE_LABEL = { en: "before", km: "មុន" };

export function PointsPill({
  points,
  receiveEvent,
  onConsumeEvent,
  spendEvent,
  onConsumeSpendEvent,
  previousPoints,
  onSend,
}: Props) {
  const { t, tpl, num, lang } = useLang();
  const reduced = useReducedMotion();

  /* Receive copy — unchanged from prior version. */
  const message = useMemo(() => {
    if (!receiveEvent) return "";
    if (receiveEvent.whileAway) {
      return tpl(t("pointsWelcomeBackTpl"), { amount: receiveEvent.amount });
    }
    if (receiveEvent.from) {
      return tpl(t("pointsReceivedFromTpl"), {
        from: receiveEvent.from,
        amount: receiveEvent.amount,
      });
    }
    const key = ANON_KEYS[receiveEvent.id % ANON_KEYS.length];
    return tpl(t(key), { amount: receiveEvent.amount });
  }, [receiveEvent, t, tpl]);

  /* Confetti for big / huge. */
  useEffect(() => {
    if (!receiveEvent) return;
    if (receiveEvent.tier === "big") celebrateBigPoints();
    if (receiveEvent.tier === "huge") celebrateHugePoints();
    const ms = TIER_DURATION_MS[receiveEvent.tier];
    const timer = setTimeout(onConsumeEvent, ms);
    return () => clearTimeout(timer);
  }, [receiveEvent, onConsumeEvent]);

  /* Auto-dismiss spend badge. */
  useEffect(() => {
    if (!spendEvent) return;
    const ms = TIER_DURATION_MS[spendEvent.tier];
    const timer = setTimeout(onConsumeSpendEvent, ms);
    return () => clearTimeout(timer);
  }, [spendEvent, onConsumeSpendEvent]);

  const tier = receiveEvent?.tier ?? null;
  const showRing = tier === "nice" || tier === "big" || tier === "huge";
  const showParticles = tier === "big" || tier === "huge";
  const numberGlow = tier === "big" || tier === "huge";

  /* Ring fill / colour / pulse. */
  const safePoints = Math.max(0, points);
  const pct = Math.min(1, safePoints / MAX_POINTS);
  const band = bandFor(pct);
  const ringColor = bandColor(band);
  const dashOffset = RING_CIRC * (1 - pct);

  const pulseDuration =
    band === "critical" ? 0.8 : band === "low" ? 1.6 : 0;
  const ringPulse =
    pulseDuration > 0 && !reduced
      ? {
          opacity: [1, 0.5, 1],
          transition: {
            duration: pulseDuration,
            repeat: Infinity,
            ease: "easeInOut" as const,
          },
        }
      : { opacity: 1 };

  /* Subtitle state. */
  const subtitleText = (() => {
    if (receiveEvent) {
      return `↑ ${lang === "km" ? FROM_LABEL.km : FROM_LABEL.en} ${num(previousPoints)}`;
    }
    if (spendEvent) {
      return `↓ ${lang === "km" ? FROM_LABEL.km : FROM_LABEL.en} ${num(previousPoints)}`;
    }
    return `━ ${num(previousPoints)} ${lang === "km" ? BEFORE_LABEL.km : BEFORE_LABEL.en}`;
  })();
  const subtitleColor = receiveEvent
    ? "var(--color-excellent)"
    : spendEvent
      ? "var(--color-needs)"
      : "var(--color-ink-mute)";

  const showLowHint =
    safePoints < 100 && !receiveEvent && !spendEvent;

  const spendMessage = (() => {
    if (!spendEvent) return "";
    if (spendEvent.whileAway) {
      return lang === "km" ? SPEND_WHILE_AWAY.km : SPEND_WHILE_AWAY.en;
    }
    return "";
  })();

  const spendBadgeColor =
    spendEvent && (spendEvent.tier === "big" || spendEvent.tier === "huge")
      ? "var(--color-needs)"
      : "var(--color-good)";

  return (
    <div className="relative">
      <div
        className="rounded-2xl px-4 py-3 ink-shadow relative overflow-visible"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-surface)",
        }}
        data-testid="points-pill"
      >
        {/* ───────── Landscape row: ring · text column · send ───────── */}
        <div className="flex items-center gap-3">
          {/* Mini progress ring (replaces wallet icon slot) */}
          <div
            className="relative h-11 w-11 shrink-0 rounded-xl flex items-center justify-center backdrop-blur"
            style={{ background: "rgba(255,255,255,0.12)" }}
          >
            <svg
              width={RING_VIEWBOX}
              height={RING_VIEWBOX}
              viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}
              aria-hidden
            >
              <circle
                cx={RING_VIEWBOX / 2}
                cy={RING_VIEWBOX / 2}
                r={RING_RADIUS}
                fill="none"
                stroke="rgba(255,255,255,0.25)"
                strokeWidth={RING_STROKE}
              />
              <motion.circle
                cx={RING_VIEWBOX / 2}
                cy={RING_VIEWBOX / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={ringColor}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={RING_CIRC}
                strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${RING_VIEWBOX / 2} ${RING_VIEWBOX / 2})`}
                style={{
                  transition:
                    "stroke-dashoffset 800ms ease-in-out, stroke 600ms ease-in-out",
                }}
                animate={ringPulse}
                data-testid="orb-progress-ring"
                data-band={band}
              />
            </svg>

            {/* Tier glow ring (nice/big/huge receive) */}
            <AnimatePresence>
              {showRing && (
                <motion.span
                  key={"glow-" + receiveEvent?.id}
                  aria-hidden
                  initial={{ opacity: 0.55, scale: 1 }}
                  animate={{ opacity: 0, scale: tier === "huge" ? 1.4 : 1.2 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: 1.4,
                    repeat: tier === "huge" ? 3 : tier === "big" ? 2 : 1,
                  }}
                  className="absolute inset-0 rounded-xl pointer-events-none"
                  style={{
                    boxShadow:
                      "0 0 0 3px color-mix(in oklab, var(--color-accent-warm) 65%, transparent)",
                  }}
                />
              )}
            </AnimatePresence>

            {/* Sparkles emanate from the ring on big/huge receive */}
            <AnimatePresence>
              {showParticles && receiveEvent && (
                <SparkleBurst
                  id={receiveEvent.id}
                  count={tier === "huge" ? 14 : 8}
                />
              )}
            </AnimatePresence>
          </div>

          {/* Text column */}
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] opacity-80">
              {t("pointsBalance")}
            </div>
            <motion.div
              className="display text-2xl font-bold leading-tight relative inline-block tnum"
              data-testid="points-balance"
              animate={
                numberGlow
                  ? {
                      textShadow: [
                        "0 0 0px rgba(255,255,255,0)",
                        "0 0 18px rgba(255,255,255,0.85)",
                        "0 0 0px rgba(255,255,255,0)",
                      ],
                      scale: [1, 1.08, 1],
                    }
                  : tier === "tiny" || tier === "nice"
                    ? { scale: [1, 1.04, 1] }
                    : { scale: 1 }
              }
              transition={{ duration: 0.9 }}
            >
              <AnimatedNumber value={points} duration={1300} localise />
            </motion.div>

            {/* Subtitle */}
            <div className="h-4 mt-0.5 leading-none">
              <AnimatePresence mode="wait">
                <motion.div
                  key={subtitleText}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.25 }}
                  className="text-[11px] font-semibold tnum whitespace-nowrap"
                  style={{ color: subtitleColor }}
                  data-testid="points-subtitle"
                >
                  {subtitleText}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Send button (unchanged) */}
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={onSend}
            data-testid="send-points-open-btn"
            className="h-10 px-3.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition shrink-0"
            style={{
              background: "var(--color-surface)",
              color: "var(--color-accent)",
            }}
          >
            <Send className="h-4 w-4" /> {t("send")}
          </motion.button>
        </div>

        {/* Low-balance hint row (inside the pill, below the main row) */}
        <AnimatePresence>
          {showLowHint && (
            <motion.div
              key="low-balance-hint"
              initial={{ opacity: 0, y: 4, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -4, height: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div
                className="mt-2.5 text-[11px] font-semibold text-center px-3 py-1 rounded-full"
                style={{
                  background:
                    "color-mix(in oklab, var(--color-needs) 20%, rgba(255,255,255,0.08))",
                  color: "var(--color-surface)",
                  border:
                    "1px solid color-mix(in oklab, var(--color-needs) 60%, transparent)",
                }}
                data-testid="low-balance-hint"
              >
                {lang === "km" ? LOW_BALANCE_HINT.km : LOW_BALANCE_HINT.en}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ───────── Receive +N badge (floats UP) ───────── */}
      <AnimatePresence>
        {receiveEvent && (
          <motion.div
            key={"flash-" + receiveEvent.id}
            initial={{ opacity: 0, y: 6, scale: 0.6 }}
            animate={{ opacity: 1, y: -28, scale: 1 }}
            exit={{ opacity: 0, y: -56, scale: 0.9 }}
            transition={{ type: "spring", damping: 14, stiffness: 220 }}
            className="absolute right-2 -top-2 z-20 origin-bottom-right pointer-events-none"
            data-testid="points-received-badge"
            data-tier={tier}
            title={message}
          >
            <div
              className="relative flex items-center gap-1 rounded-full px-2.5 py-1 ink-shadow-lg whitespace-nowrap"
              style={{
                background:
                  tier === "huge" || tier === "big"
                    ? "var(--color-good)"
                    : "var(--color-accent-warm)",
                color: "var(--color-ink)",
              }}
            >
              <Sparkle size={12} color="var(--color-ink)" />
              <span className="display font-bold tnum text-sm">
                +{num(receiveEvent.amount)}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ───────── Spend -N badge (floats DOWN) ───────── */}
      <AnimatePresence>
        {spendEvent && (
          <motion.div
            key={"spend-" + spendEvent.id}
            initial={{ opacity: 0, y: 6, scale: 0.6 }}
            animate={{ opacity: 1, y: 28, scale: 1 }}
            exit={{ opacity: 0, y: 56, scale: 0.9 }}
            transition={{ type: "spring", damping: 14, stiffness: 220 }}
            className="absolute right-2 -bottom-2 z-20 origin-top-right pointer-events-none"
            data-testid="points-spent-badge"
            data-tier={spendEvent.tier}
            title={spendMessage}
          >
            <div
              className="relative flex items-center gap-1 rounded-full px-2.5 py-1 ink-shadow-lg whitespace-nowrap"
              style={{
                background: spendBadgeColor,
                color: "var(--color-surface)",
              }}
            >
              <ArrowDown className="h-3 w-3" />
              <span className="display font-bold tnum text-sm">
                −{num(spendEvent.amount)}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ───────── Huge-tier centre toast ───────── */}
      <AnimatePresence>
        {tier === "huge" && receiveEvent && (
          <motion.div
            key={"huge-" + receiveEvent.id}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ type: "spring", damping: 14, stiffness: 180 }}
            className="no-print fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
            data-testid="huge-points-celebration"
          >
            <div
              className="rounded-3xl px-8 py-6 ink-shadow-lg text-center"
              style={{
                background: "var(--color-surface)",
                border: "2px solid var(--color-good)",
              }}
            >
              <div
                className="display text-4xl font-bold tnum"
                style={{ color: "var(--color-accent)" }}
              >
                {tpl(
                  t(
                    receiveEvent.whileAway
                      ? "pointsWelcomeBackTitle"
                      : "pointsHugeTitle",
                  ),
                  { amount: num(receiveEvent.amount) },
                )}
              </div>
              <div className="mt-1.5 text-sm text-[color:var(--color-ink-soft)]">
                {t(
                  receiveEvent.whileAway
                    ? "pointsWelcomeBackSub"
                    : "pointsHugeSub",
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Decorative radial sparkle burst — used by big/huge tiers.                 */
/* -------------------------------------------------------------------------- */

function SparkleBurst({ id, count }: { id: number; count: number }) {
  const sparkles = Array.from({ length: count }).map((_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const distance = 60 + (i % 3) * 14;
    return {
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      delay: i * 0.04,
      size: 10 + (i % 4) * 3,
    };
  });
  return (
    <div
      key={"burst-" + id}
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      {sparkles.map((s, i) => (
        <motion.span
          key={i}
          className="absolute"
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
          animate={{
            x: s.x,
            y: s.y,
            opacity: [0, 1, 1, 0],
            scale: [0.4, 1, 1, 0.6],
            rotate: [0, 90, 180],
          }}
          transition={{
            duration: 1.4,
            delay: s.delay,
            ease: [0.22, 1, 0.36, 1],
          }}
          style={{ color: "var(--color-good)" }}
        >
          <Sparkle size={s.size} color="currentColor" />
        </motion.span>
      ))}
    </div>
  );
}
