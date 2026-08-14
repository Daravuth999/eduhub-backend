import { motion } from "framer-motion";
import { ArrowUp } from "lucide-react";
import { Card } from "../primitives/Card";
import { ProgressBar } from "../primitives/ProgressBar";
import { AnimatedNumber } from "../primitives/AnimatedNumber";
import { Pill } from "../primitives/Pill";
import { Sparkle } from "../primitives/Sparkle";
import { getTier } from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";
import type { CriterionConfig } from "../../config/sections";

interface Props {
  config: CriterionConfig;
  score: number;
  delay?: number;
  improvement?: number;
  onClick?: () => void;
}

export function CriterionCard({
  config,
  score,
  delay = 0,
  improvement,
  onClick,
}: Props) {
  const { t, num } = useLang();
  const tier = getTier(score);
  const pct = Math.min(100, (score / 10) * 100);
  const Icon = config.icon;
  const improved = improvement !== undefined && improvement >= 1;

  return (
    <motion.button
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      data-testid={`criterion-card-${config.key}`}
      className="w-full text-left"
    >
      <Card
        className="relative p-5 h-full cursor-pointer overflow-hidden snap-start"
        accentEdge={tier.cssVar}
      >
        {/* Decorative tier glow corner */}
        <div
          aria-hidden
          className="absolute -top-12 -right-12 h-32 w-32 rounded-full opacity-15 pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${tier.hex}, transparent 70%)`,
          }}
        />
        <div className="flex items-start justify-between mb-3">
          <div
            data-accent={
              tier.label?.toLowerCase().includes("excellent")
                ? "green"
                : tier.label?.toLowerCase().includes("good")
                ? "gold"
                : "rose"
            }
            className="aurora-icon-badge h-11 w-11"
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="text-right">
            <div
              className="display tnum text-3xl font-bold leading-none text-[color:var(--color-ink)]"
              data-testid={`score-${config.key}`}
            >
              <AnimatedNumber value={score} decimals={1} duration={1100} localise />
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-mute)] mt-0.5 mono">
              / 10
            </div>
          </div>
        </div>

        <h3 className="display text-base font-bold text-[color:var(--color-ink)]">
          {config.label}
        </h3>
        <p className="khmer text-xs text-[color:var(--color-ink-mute)] mb-3">
          {config.labelKh}
        </p>

        <ProgressBar value={pct} color={tier.hex} delay={delay + 0.15} height={6} />

        <div className="flex items-center justify-between mt-3">
          <span
            className="text-[11px] font-bold uppercase tracking-wider"
            style={{ color: tier.cssVar }}
          >
            {tier.label}
          </span>
          {improved && (
            <Pill tone="excellent" filled className="!rounded-full">
              <Sparkle size={10} color="var(--color-surface)" />
              <ArrowUp className="h-3 w-3" />
              {t("improvedPill")} +{num((improvement ?? 0).toFixed(1))}
            </Pill>
          )}
        </div>
      </Card>
    </motion.button>
  );
}
