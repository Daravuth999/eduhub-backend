import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ClipboardList } from "lucide-react";
import type { ReactNode } from "react";
import { getTier } from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { Surface } from "../primitives/Surface";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overall: number;
  children: ReactNode;
}

/**
 * MonthlyReviewExpander -- Lumio collapsible wrapper for the full Monthly
 * Review surfaces (MonthlyPerformance, CriteriaShelf, OverallScore,
 * FeedbackTriad, Comments, PerformanceChart).
 *
 * COLLAPSED BY DEFAULT (per spec). It only adds the collapse chrome; the
 * children (existing evaluation components) are rendered verbatim with no
 * data/logic changes. The "See full review" CTA in PerformanceGlance lifts
 * `open` to true and scrolls to this section via the
 * data-portal-section="Monthly Review" anchor.
 */
export function MonthlyReviewExpander({
  open,
  onOpenChange,
  overall,
  children,
}: Props) {
  const { lang } = useLang();
  const reduced = useReducedMotion();
  const isEn = lang !== "km";
  const tier = getTier(overall);
  const hasScore = overall > 0;

  return (
    <Surface
      variant="solid"
      accent="violet"
      topStrip
      data-portal-section="Monthly Review"
      data-testid="monthly-review-expander"
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        data-testid="monthly-review-toggle"
        className="lumio-focus w-full flex items-center gap-3 p-4 sm:p-5 text-left"
      >
        <span
          className="aurora-icon-badge h-10 w-10 shrink-0"
          data-accent="violet"
          aria-hidden
        >
          <ClipboardList className="h-[18px] w-[18px]" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block lumio-eyebrow">
            {isEn ? "Monthly Review" : "ការវាយតម្លៃប្រចាំខែ"}
          </span>
          <span className="block display text-base font-bold leading-tight text-[color:var(--color-ink)]">
            {isEn ? "Full evaluation & feedback" : "ការវាយតម្លៃ និងមតិពេញលេញ"}
          </span>
        </span>
        {hasScore && (
          <span
            className="hidden sm:inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold shrink-0"
            style={{
              background: `color-mix(in oklab, ${tier.cssVar} 16%, transparent)`,
              color: tier.cssVar,
              border: `1px solid color-mix(in oklab, ${tier.cssVar} 30%, transparent)`,
            }}
          >
            {isEn ? tier.label : tier.labelKh}
          </span>
        )}
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
          className="shrink-0 text-[color:var(--color-ink-soft)]"
          aria-hidden
        >
          <ChevronDown className="h-5 w-5" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="monthly-review-content"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ overflow: "hidden" }}
            data-testid="monthly-review-content"
          >
            <div className="px-4 sm:px-5 pb-5 pt-4 space-y-5 border-t border-[color:var(--color-line)]">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Surface>
  );
}
