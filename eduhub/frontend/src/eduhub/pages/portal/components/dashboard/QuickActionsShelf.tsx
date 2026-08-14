import { motion } from "framer-motion";
import { BookOpen, Send, Printer, Coins, type LucideIcon } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { SurfaceAccent } from "../primitives/Surface";

interface Props {
  onScoreGuide: () => void;
  onSendPoints: () => void;
  onPrint: () => void;
  onTopUp: () => void;
}

interface Tile {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  accent: SurfaceAccent;
  onClick: () => void;
  testId: string;
}

/**
 * QuickActionsShelf -- Lumio quick-action tiles.
 *
 * Pure presentational shelf wired to the EXACT existing Dashboard
 * handlers (Score Guide modal, Send Points modal, browser print, Top-Up
 * purchase modal). It introduces no new business logic.
 *
 * Layout: 2x2 grid on phones, 4-in-row from sm upward.
 */
export function QuickActionsShelf({
  onScoreGuide,
  onSendPoints,
  onPrint,
  onTopUp,
}: Props) {
  const { t, lang } = useLang();
  const reduced = useReducedMotion();
  const isEn = lang !== "km";

  const tiles: Tile[] = [
    {
      key: "send",
      label: isEn ? "Send Points" : "ផ្ញើពិន្ទុ",
      hint: isEn ? "Transfer to a friend" : "ផ្ញើទៅមិត្ត",
      icon: Send,
      accent: "teal",
      onClick: onSendPoints,
      testId: "portal-quick-action-send-points",
    },
    {
      key: "topup",
      label: isEn ? "Top Up" : "បញ្ចូលពិន្ទុ",
      hint: isEn ? "Add more points" : "បន្ថែមពិន្ទុ",
      icon: Coins,
      accent: "coral",
      onClick: onTopUp,
      testId: "portal-quick-action-top-up",
    },
    {
      key: "score-guide",
      label: t("scoreGuide"),
      hint: isEn ? "Understand scores" : "មគ្គុទ្ទេសក់ពិន្ទុ",
      icon: BookOpen,
      accent: "violet",
      onClick: onScoreGuide,
      testId: "portal-quick-action-score-guide",
    },
    {
      key: "print",
      label: t("print"),
      hint: isEn ? "Save a copy" : "រក្សាទុកចម្លង",
      icon: Printer,
      accent: "teal",
      onClick: onPrint,
      testId: "portal-quick-action-print",
    },
  ];

  return (
    <section data-testid="portal-quick-actions" aria-label="Quick actions">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((tile, i) => {
          const Icon = tile.icon;
          return (
            <motion.button
              key={tile.key}
              type="button"
              onClick={tile.onClick}
              data-testid={tile.testId}
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: reduced ? 0 : i * 0.04 }}
              className="lumio-surface lumio-surface--interactive lumio-focus eduhub-tap text-left p-3.5 flex flex-col gap-2 min-h-[92px]"
              data-accent={tile.accent}
            >
              <span
                className="aurora-icon-badge h-9 w-9"
                data-accent={tile.accent}
                aria-hidden
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight text-[color:var(--color-ink)] truncate">
                  {tile.label}
                </span>
                <span className="block text-[11px] text-[color:var(--color-ink-mute)] truncate">
                  {tile.hint}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}
