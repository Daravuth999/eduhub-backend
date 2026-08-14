import { AnimatePresence, motion } from "framer-motion";
import { WifiOff, RefreshCw } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  online: boolean;
  onRetry: () => void;
}

export function ConnectionBanner({ online, onRetry }: Props) {
  const { t } = useLang();
  return (
    <AnimatePresence>
      {!online && (
        <motion.div
          initial={{ y: -50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -50, opacity: 0 }}
          className="no-print fixed top-0 left-0 right-0 z-40 flex justify-center pt-3 px-4"
          data-testid="connection-banner"
        >
          <div
            className="flex items-center gap-2.5 rounded-full px-4 py-2 text-sm font-semibold ink-shadow border"
            style={{
              background: "var(--color-needs)",
              color: "var(--color-surface)",
              borderColor: "color-mix(in oklab, var(--color-needs) 60%, transparent)",
            }}
          >
            <WifiOff className="h-4 w-4" />
            {t("connectionIssue")}
            <button
              onClick={onRetry}
              data-testid="connection-retry"
              className="ml-2 inline-flex items-center gap-1 rounded-full bg-white/20 hover:bg-white/30 transition px-2.5 py-1 text-[12px] uppercase tracking-wider"
            >
              <RefreshCw className="h-3 w-3" /> {t("retry")}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
