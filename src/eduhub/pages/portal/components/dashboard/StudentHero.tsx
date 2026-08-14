import { motion } from "framer-motion";
import { Award, Sparkles, Flame } from "lucide-react";
import type { StudentData } from "../../types";
import {
  avatarUrl,
  isTopPerformer,
  overallScore,
  extractScores,
  getTier,
} from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { Pill } from "../primitives/Pill";
import { Surface } from "../primitives/Surface";
import { LearningCompanionArt } from "../portal-art/QuietLibraryArt";
import { PointsPill } from "./PointsPill";
import type { PointsDeltaEvent, SpendDeltaEvent } from "../../hooks/usePoints";

/**
 * StudentHero -- Lumio hero-first identity + wallet surface.
 *
 * Replaces the old "Wallet" PortalSection + StudentHeader stack as the
 * page-leading hero. It reuses the EXACT same data + the existing
 * <PointsPill /> (so every points animation, send flow, low-balance hint
 * and celebration is preserved verbatim). Only structure / styling is new.
 */
interface Props {
  student: StudentData;
  points: number;
  receiveEvent: PointsDeltaEvent | null;
  onConsumeEvent: () => void;
  spendEvent: SpendDeltaEvent | null;
  onConsumeSpendEvent: () => void;
  previousPoints: number;
  onSendPoints: () => void;
  excellentStreak: number;
}

function greeting(lang: "en" | "km"): string {
  const h = new Date().getHours();
  if (lang === "km") {
    if (h < 12) return "អរុណសួស្តី";
    if (h < 18) return "ទិវាសួស្តី";
    return "សាយណ្ហសួស្តី";
  }
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function StudentHero({
  student,
  points,
  receiveEvent,
  onConsumeEvent,
  spendEvent,
  onConsumeSpendEvent,
  previousPoints,
  onSendPoints,
  excellentStreak,
}: Props) {
  const { t, tpl, num, lang } = useLang();
  const reduced = useReducedMotion();
  const overall = overallScore(extractScores(student));
  const top = isTopPerformer(overall);
  const hasScore = overall > 0;
  const tier = getTier(overall);

  return (
    <motion.section
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }}
      data-testid="portal-student-hero"
    >
      <Surface variant="aurora" accent="teal" className="p-5 sm:p-6">
        {/* Quiet Library companion motif — decorative, behind content. */}
        <LearningCompanionArt
          className="pointer-events-none select-none absolute top-2 right-2 h-24 w-24 sm:h-28 sm:w-28 opacity-90"
          style={{ zIndex: 0 }}
        />
        <div className="relative z-[1] flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
          {/* Identity column */}
          <div className="flex items-center gap-4 sm:gap-5 min-w-0">
            <motion.div
              initial={reduced ? false : { scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.08, type: "spring", damping: 14 }}
              className="relative shrink-0"
            >
              <img
                src={avatarUrl(student.Name)}
                alt={student.Name}
                className="h-16 w-16 sm:h-20 sm:w-20 rounded-2xl object-cover border-4 border-[color:var(--color-surface)] ink-shadow"
              />
              {top && (
                <div
                  aria-hidden
                  data-accent="gold"
                  className="aurora-icon-badge absolute -bottom-1.5 -right-1.5 h-7 w-7"
                >
                  <Award className="h-3.5 w-3.5" />
                </div>
              )}
            </motion.div>

            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-ink-mute)]">
                {greeting(lang)}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <h1
                  className="display text-xl sm:text-2xl font-bold leading-tight text-[color:var(--color-ink)] truncate"
                  data-testid="portal-student-name"
                >
                  {student.Name}
                </h1>
                {top && (
                  <Pill tone="good" filled className="!rounded-full">
                    <Sparkles className="h-3 w-3" /> Top
                  </Pill>
                )}
                {excellentStreak >= 2 && (
                  <Pill
                    tone="warm"
                    filled
                    className="!rounded-full"
                    data-testid="portal-streak-badge"
                  >
                    <Flame className="h-3 w-3" />
                    <span>
                      {tpl(t("excellentStreakTpl"), { n: num(excellentStreak) })}
                    </span>
                  </Pill>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span
                  className="text-xs sm:text-sm text-[color:var(--color-ink-soft)]"
                  data-testid="portal-student-level"
                >
                  ID: <span className="mono font-semibold">{student.StudentID}</span>
                </span>
                {hasScore && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{
                      background: `color-mix(in oklab, ${tier.cssVar} 16%, transparent)`,
                      color: tier.cssVar,
                      border: `1px solid color-mix(in oklab, ${tier.cssVar} 32%, transparent)`,
                    }}
                  >
                    {lang === "km" ? tier.labelKh : tier.label} · {num(overall.toFixed(1))}
                  </span>
                )}
              </div>
              <p className="khmer text-[11px] sm:text-xs text-[color:var(--color-ink-mute)] mt-1">
                {t("welcome")}
              </p>
            </div>
          </div>

          {/* Wallet panel -- reuses the existing PointsPill verbatim. */}
          <div className="w-full lg:w-[380px] lg:shrink-0">
            <PointsPill
              points={points}
              receiveEvent={receiveEvent}
              onConsumeEvent={onConsumeEvent}
              spendEvent={spendEvent}
              onConsumeSpendEvent={onConsumeSpendEvent}
              previousPoints={previousPoints}
              onSend={onSendPoints}
            />
          </div>
        </div>
      </Surface>
    </motion.section>
  );
}
