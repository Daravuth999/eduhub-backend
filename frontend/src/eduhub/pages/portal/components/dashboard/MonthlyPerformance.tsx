import { motion } from "framer-motion";
import { TrendingUp, Calendar } from "lucide-react";
import type { Scores } from "../../types";
import { overallScore, getTier } from "../../lib/scoring";
import { Card } from "../primitives/Card";
import { ProgressBar } from "../primitives/ProgressBar";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  scores: Scores;
}

export function MonthlyPerformance({ scores }: Props) {
  const { t, lang } = useLang();
  const overall = overallScore(scores);
  const tier = getTier(overall);
  const pct = Math.min(100, (overall / 10) * 100);

  const month = new Date().toLocaleDateString(lang === "km" ? "km-KH" : "en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
    >
      <Card className="p-5 sm:p-7">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2.5">
            <div
              className="h-9 w-9 rounded-xl flex items-center justify-center text-[color:var(--color-surface)]"
              style={{ background: "var(--color-accent)" }}
            >
              <TrendingUp className="h-4 w-4" />
            </div>
            <div>
              <h2 className="display text-lg font-bold text-[color:var(--color-ink)]">
                {t("monthlyPerformance")}
              </h2>
              <p className="khmer text-xs text-[color:var(--color-ink-mute)]">
                លទ្ធផលប្រចាំខែ
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-[color:var(--color-ink-soft)]">
            <Calendar className="h-4 w-4" /> {month}
          </div>
        </div>

        <div className="flex items-end justify-between mb-3">
          <div>
            <div
              className="display text-5xl font-bold leading-none"
              style={{ color: tier.cssVar }}
              data-testid="monthly-overall"
            >
              <AnimatedNumber value={overall} decimals={1} duration={1400} localise />
              <span className="text-2xl text-[color:var(--color-ink-mute)] font-semibold ml-1">
                / 10
              </span>
            </div>
            <div
              className="text-sm font-bold mt-1.5 uppercase tracking-wider"
              style={{ color: tier.cssVar }}
            >
              {tier.label} · <span className="khmer">{tier.labelKh}</span>
            </div>
          </div>
          <div className="text-right text-xs text-[color:var(--color-ink-mute)] max-w-[140px]">
            Average of 6 criteria
          </div>
        </div>

        <ProgressBar value={pct} color={tier.hex} delay={0.2} height={10} />
        <div className="flex justify-between text-[11px] text-[color:var(--color-ink-mute)] mt-1.5 mono">
          <span>0</span>
          <span>5</span>
          <span>10</span>
        </div>
      </Card>
    </motion.div>
  );
}
