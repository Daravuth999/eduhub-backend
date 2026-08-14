import { AnimatePresence, motion } from "framer-motion";
import { X, BookOpen } from "lucide-react";
import type { CriterionKey } from "../../types";
import { CRITERIA } from "../../config/sections";
import { getTier } from "../../lib/scoring";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  selectedKey: CriterionKey | null;
  score: number | null;
  onClose: () => void;
}

/**
 * Slides up from the bottom on mobile, drops in on desktop. Explains what the
 * criterion measures and what the student's current tier means.
 */
export function CriterionDetailDrawer({ selectedKey, score, onClose }: Props) {
  const { t, lang } = useLang();
  const config = selectedKey ? CRITERIA.find((c) => c.key === selectedKey) : null;
  const tier = score !== null ? getTier(score) : null;

  return (
    <AnimatePresence>
      {config && tier && score !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 bg-[color:var(--color-ink)]/55 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          data-testid="criterion-drawer"
        >
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 220 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg overflow-hidden rounded-t-3xl sm:rounded-3xl bg-[color:var(--color-surface)] border border-[color:var(--color-line-strong)] ink-shadow-lg"
          >
            <div
              className="flex items-center gap-3 px-5 py-4 text-[color:var(--color-surface)]"
              style={{ background: tier.cssVar }}
            >
              <div className="h-9 w-9 rounded-xl bg-white/20 flex items-center justify-center">
                <config.icon className="h-4.5 w-4.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="display font-bold leading-tight">
                  {config.label}
                </div>
                <div className="khmer text-xs opacity-85">{config.labelKh}</div>
              </div>
              <button
                onClick={onClose}
                aria-label={t("closeBtn")}
                className="h-8 w-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-5">
              <div className="flex items-baseline gap-3 mb-4">
                <div
                  className="display tnum text-5xl font-bold leading-none"
                  style={{ color: tier.cssVar }}
                >
                  {score.toFixed(1)}
                </div>
                <div
                  className="text-sm font-bold uppercase tracking-wider"
                  style={{ color: tier.cssVar }}
                >
                  {tier.label} · <span className="khmer">{tier.labelKh}</span>
                </div>
              </div>

              <div className="flex items-start gap-2.5 mb-4">
                <BookOpen className="h-4 w-4 mt-0.5 text-[color:var(--color-ink-soft)] shrink-0" />
                <p className="text-sm text-[color:var(--color-ink)] leading-relaxed">
                  {lang === "km" ? config.descriptionKh : config.description}
                </p>
              </div>

              <button
                onClick={onClose}
                data-testid="criterion-drawer-close"
                className="w-full py-3 rounded-xl font-semibold text-[color:var(--color-surface)]"
                style={{ background: "var(--color-accent)" }}
              >
                {t("closeBtn")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
