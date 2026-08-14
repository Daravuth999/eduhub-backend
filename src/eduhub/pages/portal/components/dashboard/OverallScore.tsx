import { motion } from "framer-motion";
import { Target } from "lucide-react";
import type { Scores } from "../../types";
import { overallScore, getTier } from "../../lib/scoring";
import { Card } from "../primitives/Card";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface Props {
  scores: Scores;
}

export function OverallScore({ scores }: Props) {
  const { t } = useLang();
  const reduced = useReducedMotion();
  const overall = overallScore(scores);
  const tier = getTier(overall);
  const radius = 78;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.min(overall, 10) / 10) * circumference;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
    >
      <Card className="p-6 sm:p-8 flex flex-col sm:flex-row items-center gap-6">
        <div className="relative shrink-0">
          <svg width="200" height="200" className="-rotate-90">
            <circle
              cx="100"
              cy="100"
              r={radius}
              fill="none"
              strokeWidth="14"
              stroke="var(--color-line)"
            />
            <motion.circle
              cx="100"
              cy="100"
              r={radius}
              fill="none"
              strokeWidth="14"
              strokeLinecap="round"
              stroke={tier.hex}
              initial={{ strokeDasharray: `0 ${circumference}` }}
              animate={{ strokeDasharray: `${dash} ${circumference}` }}
              transition={{
                duration: reduced ? 0 : 1.6,
                ease: [0.22, 1, 0.36, 1],
                delay: reduced ? 0 : 0.3,
              }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div
              className="display text-5xl font-bold leading-none"
              style={{ color: tier.cssVar }}
              data-testid="overall-score-value"
            >
              <AnimatedNumber value={overall} decimals={1} duration={1500} localise />
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-mute)] mt-1.5 mono">
              {t("outOfTen")}
            </div>
          </div>
        </div>

        <div className="flex-1 text-center sm:text-left">
          <div className="flex items-center justify-center sm:justify-start gap-2.5 mb-2">
            <div
              className="h-9 w-9 rounded-xl flex items-center justify-center text-[color:var(--color-surface)]"
              style={{ background: "var(--color-accent)" }}
            >
              <Target className="h-4.5 w-4.5" />
            </div>
            <h2 className="display text-xl font-bold text-[color:var(--color-ink)]">
              {t("overallScoreTitle")}
            </h2>
          </div>
          <p className="khmer text-sm text-[color:var(--color-ink-mute)] mb-3">
            ពិន្ទុសរុប
          </p>
          <div
            className="inline-block px-3.5 py-1.5 rounded-full text-sm font-bold ink-shadow"
            style={{
              background: tier.hex,
              color: "var(--color-surface)",
            }}
          >
            {tier.label} · <span className="khmer font-semibold">{tier.labelKh}</span>
          </div>
          <p className="text-sm text-[color:var(--color-ink-soft)] mt-3 max-w-md">
            {t("overallExplain")}
          </p>
        </div>
      </Card>
    </motion.div>
  );
}
