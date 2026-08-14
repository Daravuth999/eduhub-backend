import { motion } from "framer-motion";
import type { Scores, CriterionKey } from "../../types";
import { CRITERIA } from "../../config/sections";
import { CriterionCard } from "./CriterionCard";
import { ScrollShelf } from "../primitives/ScrollShelf";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  scores: Scores;
  improvedByCriterion: Record<string, number>;
  onSelect: (key: CriterionKey) => void;
}

/**
 * Criteria layout:
 *   • mobile  → horizontal scroll-snap shelf (your spec)
 *   • desktop → 3-column grid
 */
export function CriteriaShelf({ scores, improvedByCriterion, onSelect }: Props) {
  const { t } = useLang();
  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.15 }}
    >
      <div className="flex items-baseline justify-between mb-4 px-1">
        <div>
          <h2 className="display text-xl font-bold text-[color:var(--color-ink)]">
            {t("perfByCriterion")}
          </h2>
          <p className="khmer text-sm text-[color:var(--color-ink-soft)]">
            លទ្ធផលតាមលក្ខណៈវិនិច្ឆ័យ
          </p>
        </div>
      </div>

      {/* Mobile: snap shelf */}
      <div className="md:hidden">
        <ScrollShelf ariaLabel="Criteria">
          {CRITERIA.map((c, i) => (
            <div key={c.key} className="w-[78%] sm:w-[60%] shrink-0">
              <CriterionCard
                config={c}
                score={scores[c.key]}
                delay={i * 0.06}
                improvement={improvedByCriterion[c.key]}
                onClick={() => onSelect(c.key)}
              />
            </div>
          ))}
        </ScrollShelf>
      </div>

      {/* Desktop: 3-col grid */}
      <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {CRITERIA.map((c, i) => (
          <CriterionCard
            key={c.key}
            config={c}
            score={scores[c.key]}
            delay={i * 0.06}
            improvement={improvedByCriterion[c.key]}
            onClick={() => onSelect(c.key)}
          />
        ))}
      </div>
    </motion.section>
  );
}
