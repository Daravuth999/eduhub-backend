import { AnimatePresence, motion } from "framer-motion";
import { Trophy } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  show: boolean;
  onDismiss: () => void;
}

export function TopPerformerToast({ show, onDismiss }: Props) {
  const { t } = useLang();
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -30, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.95 }}
          transition={{ type: "spring", damping: 18, stiffness: 200 }}
          className="no-print fixed left-1/2 -translate-x-1/2 top-20 z-40 w-[92%] max-w-md"
          data-testid="top-performer-toast"
        >
          <div
            className="flex items-center gap-3 rounded-2xl px-4 py-3 ink-shadow-lg"
            style={{
              background: "var(--color-good)",
              color: "var(--color-ink)",
              borderLeft: "6px solid var(--color-accent-warm)",
            }}
          >
            <div className="h-10 w-10 rounded-xl bg-white/30 backdrop-blur flex items-center justify-center">
              <Trophy className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="display font-bold text-sm">
                {t("topPerformerToast")}
              </div>
              <div className="text-xs opacity-85 mt-0.5">{t("topPerformerSub")}</div>
            </div>
            <button
              onClick={onDismiss}
              aria-label="Dismiss"
              className="text-xs font-bold px-2 py-1 rounded hover:bg-white/30 transition"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
