/**
 * PerformanceGlance.tsx -- My Portal Premium Reconstruction v1
 *
 * A compact, premium "where am I this month?" snapshot card placed
 * directly under the Wallet Hero. Its job is to hook student curiosity
 * in under one second so they keep scrolling.
 *
 * HONESTY CONTRACT (mandatory)
 *   - This card NEVER fabricates scores, streaks, or improvement chips.
 *   - It reads only data that is already loaded into Dashboard.tsx by
 *     the existing hooks (useStudentData -> Scores,
 *     useTopPerformerCelebration -> excellentStreak / improvedByCriterion).
 *   - If the student has no real evaluation data yet (overall === 0 and
 *     no scores), the card renders an honest "Your first review will
 *     appear here" empty state. It does NOT show a fake 0/10.
 *   - The CTA scrolls to the existing Monthly Review section (section
 *     anchor: data-portal-section="Monthly Review"). No navigation,
 *     no new route.
 *
 * Tokenised to fit the dark-glass design language already established
 * by LatestRewardCard (premium Apple-glass surface). No new colours.
 */
import { motion } from "framer-motion";
import { Flame, Sparkles, TrendingUp, ChevronRight, Trophy } from "lucide-react";
import { useMemo } from "react";
import type { Scores, CriterionKey } from "../../types";
import { getTier } from "../../lib/scoring";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { ScoreRing } from "../primitives/ScoreRing";
import { useLang } from "../../contexts/LanguageContext";

const CRITERION_LABELS: Record<CriterionKey, { en: string; km: string }> = {
  pronunciation: { en: "Pronunciation", km: "ការបញ្ចេញសំឡេង" },
  intonation:    { en: "Intonation",    km: "សំនៀង" },
  communication: { en: "Communication", km: "ការប្រាស្រ័យ" },
  participation: { en: "Participation", km: "ការចូលរួម" },
  risingFalling: { en: "Rising & Falling", km: "ការងើប/ធ្លាក់" },
  linkingSounds: { en: "Linking Sounds",   km: "សំឡេងភ្ជាប់" },
};

interface Props {
  scores: Scores;
  overall: number;
  excellentStreak: number;
  improvedByCriterion: Record<string, number>;
  /** Optional click handler. If omitted, the CTA scrolls to the
   *  Monthly Review section by [data-portal-section] anchor. */
  onSeeFullReview?: () => void;
}

export function PerformanceGlance({
  scores,
  overall,
  excellentStreak,
  improvedByCriterion,
  onSeeFullReview,
}: Props) {
  const { t, lang, num } = useLang();
  const isEn = lang !== "km";

  const topCriterion = useMemo<CriterionKey | null>(() => {
    const entries = Object.entries(scores) as [CriterionKey, number][];
    const filtered = entries.filter(([, v]) => v > 0);
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => b[1] - a[1]);
    return filtered[0][0];
  }, [scores]);

  const mostImproved = useMemo<CriterionKey | null>(() => {
    const entries = Object.entries(improvedByCriterion || {});
    const positive = entries.filter(
      ([, v]) => typeof v === "number" && (v as number) > 0,
    ) as [string, number][];
    if (positive.length === 0) return null;
    positive.sort((a, b) => b[1] - a[1]);
    const key = positive[0][0] as CriterionKey;
    return CRITERION_LABELS[key] ? key : null;
  }, [improvedByCriterion]);

  const hasRealData =
    overall > 0 && Object.values(scores).some((v) => v > 0);

  const handleSeeFullReview = () => {
    if (onSeeFullReview) {
      onSeeFullReview();
      return;
    }
    if (typeof document !== "undefined") {
      const target = document.querySelector(
        '[data-portal-section="Monthly Review"]',
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  };

  /* ---------- Empty state -- honest, no fake numbers ---------- */
  if (!hasRealData) {
    return (
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl overflow-hidden border px-5 py-5"
        style={{
          background:
            "linear-gradient(180deg, " +
            "color-mix(in oklab, var(--color-surface) 78%, transparent) 0%, " +
            "color-mix(in oklab, var(--color-surface-2) 86%, transparent) 100%)",
          borderColor:
            "color-mix(in oklab, var(--color-line-strong) 70%, transparent)",
          backdropFilter: "blur(18px) saturate(160%)",
          WebkitBackdropFilter: "blur(18px) saturate(160%)",
        }}
        data-testid="performance-glance-empty"
      >
        <div className="flex items-center gap-3">
          <div
            className="h-11 w-11 rounded-2xl flex items-center justify-center shrink-0"
            style={{
              background:
                "color-mix(in oklab, var(--color-accent) 12%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            <TrendingUp className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {isEn ? "Performance" : "ការសិក្សា"}
            </div>
            <div
              className="display text-base font-semibold leading-snug"
              style={{ color: "var(--color-ink)" }}
            >
              {isEn
                ? "Your first review will appear here"
                : "ការវាយតម្លៃលើកដំបូងនឹងបង្ហាញនៅទីនេះ"}
            </div>
            <div
              className="text-[11px] mt-0.5"
              style={{ color: "var(--color-ink-mute)" }}
            >
              {isEn
                ? "Keep attending class. Scores arrive after your next evaluation."
                : "បន្តចូលរៀន។ ពិន្ទុនឹងបង្ហាញបន្ទាប់ពីការវាយតម្លៃលើកក្រោយ។"}
            </div>
          </div>
        </div>
      </motion.section>
    );
  }

  const tier = getTier(overall);
  const heroLabel = isEn ? tier.label : tier.labelKh;
  const tierKey = (tier.label || "").toLowerCase();
  const ringTone: "excellent" | "good" | "needs" = tierKey.includes("excellent")
    ? "excellent"
    : tierKey.includes("good")
      ? "good"
      : "needs";

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="lumio-surface lumio-surface--strip relative p-5 sm:p-6"
      data-accent="violet"
      data-testid="performance-glance"
    >
      <div className="flex items-center gap-5 sm:gap-6">
        <ScoreRing
          value={overall}
          max={10}
          size={118}
          tone={ringTone}
          centerLabel={
            <AnimatedNumber value={overall} decimals={1} duration={1200} localise />
          }
          caption={isEn ? "out of 10" : "ក្នុង ១០"}
          data-testid="performance-glance-overall"
        />

        <div className="flex-1 min-w-0">
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--color-ink-mute)" }}
          >
            {isEn ? "Performance glance" : "ការសិក្សាប្រចាំខែ"}
          </div>
          <div
            className="mt-1 display text-lg font-bold leading-tight"
            style={{ color: tier.cssVar }}
            data-testid="performance-glance-tier"
          >
            {heroLabel}
            {!isEn && (
              <span
                className="block text-[10px] tracking-[0.18em] mt-0.5 opacity-80"
                style={{ color: "var(--color-ink-mute)" }}
              >
                {tier.label}
              </span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2" data-testid="performance-glance-chips">
            {excellentStreak >= 2 && (
              <Chip
                icon={<Flame className="h-3 w-3" />}
                text={
                  isEn
                    ? `${num(excellentStreak)}-month streak`
                    : `${num(excellentStreak)}ខែជាប់ៗ`
                }
                tone="warm"
                testid="glance-streak-chip"
              />
            )}
            {topCriterion && (
              <Chip
                icon={<Trophy className="h-3 w-3" />}
                text={
                  isEn
                    ? `Top: ${CRITERION_LABELS[topCriterion].en}`
                    : `ខ្លាំង៖ ${CRITERION_LABELS[topCriterion].km}`
                }
                tone="good"
                testid="glance-top-chip"
              />
            )}
            {mostImproved && (
              <Chip
                icon={<Sparkles className="h-3 w-3" />}
                text={
                  isEn
                    ? `Improving: ${CRITERION_LABELS[mostImproved].en}`
                    : `កំពុងរីកចម្រើន៖ ${CRITERION_LABELS[mostImproved].km}`
                }
                tone="accent"
                testid="glance-improving-chip"
              />
            )}
          </div>

          <button
            type="button"
            onClick={handleSeeFullReview}
            data-testid="performance-glance-cta"
            className="lumio-focus mt-3 inline-flex items-center gap-1 text-xs font-semibold transition-opacity hover:opacity-80"
            style={{ color: "var(--color-accent)" }}
          >
            {isEn ? "See full review" : "មើលការវាយតម្លៃពេញលេញ"}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <span className="sr-only">
        {isEn
          ? `Overall score ${overall.toFixed(1)} out of 10. Tier: ${tier.label}.`
          : t("monthlyPerformance")}
      </span>
    </motion.section>
  );
}

function Chip({
  icon,
  text,
  tone,
  testid,
}: {
  icon: React.ReactNode;
  text: string;
  tone: "warm" | "good" | "accent";
  testid: string;
}) {
  const colorVar =
    tone === "warm"
      ? "var(--color-accent-warm)"
      : tone === "good"
        ? "var(--color-good)"
        : "var(--color-accent)";
  return (
    <span
      data-testid={testid}
      className="inline-flex items-center gap-1 rounded-full text-[11px] font-semibold px-2.5 py-1"
      style={{
        background: `color-mix(in oklab, ${colorVar} 14%, transparent)`,
        color: colorVar,
        border: `1px solid color-mix(in oklab, ${colorVar} 30%, transparent)`,
      }}
    >
      {icon}
      {text}
    </span>
  );
}

export default PerformanceGlance;
