import {
  BookOpen,
  Languages,
  Moon,
  Printer,
  Sun,
  Settings2,
  LogOut,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "../../hooks/useTheme";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  onScoreGuide: () => void;
  onPrint: () => void;
  onLogout: () => void;
  /** Hide print + logout on the login screen. */
  variant?: "login" | "dashboard";
}

export function TopBar({ onScoreGuide, onPrint, onLogout, variant = "dashboard" }: Props) {
  const { theme, mode, cycleMode } = useTheme();
  const { t, lang, toggle: toggleLang } = useLang();
  // Theme control mirrors the global 3-state ThemeToggle (auto/light/dark)
  // and routes every change through the global controller (themeAuto).
  const themeLabel =
    mode === "auto"
      ? `Theme: Auto (${theme === "light" ? "Light" : "Dark"})`
      : mode === "light"
        ? "Theme: Light"
        : "Theme: Dark";
  const ThemeIcon = mode === "auto" ? Settings2 : theme === "light" ? Sun : Moon;

  return (
    <div className="no-print sticky top-0 z-30 backdrop-blur-md bg-[color:var(--color-bg)]/80 border-b border-[color:var(--color-line)]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="aurora-icon-badge h-9 w-9">
            <BookOpen className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <div className="display font-bold text-[15px] text-[color:var(--color-ink)]">
              {t("brandName")}
            </div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-ink-soft)]">
              {t("brandTag")}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <IconButton
            aria-label="Toggle language"
            onClick={toggleLang}
            data-testid="lang-toggle"
            title={lang === "en" ? "ភាសាខ្មែរ" : "English"}
          >
            <Languages className="h-4 w-4" />
            <span className="ml-1 text-[11px] font-bold uppercase tracking-wider">
              {lang === "en" ? "ខ្មែរ" : "EN"}
            </span>
          </IconButton>

          <IconButton
            aria-label={themeLabel}
            title={themeLabel}
            onClick={cycleMode}
            data-testid="theme-toggle"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={`${mode}-${theme}`}
                initial={{ rotate: -60, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: 60, opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <ThemeIcon className="h-4 w-4" />
              </motion.span>
            </AnimatePresence>
          </IconButton>

          {variant === "dashboard" && (
            <>
              <IconButton
                onClick={onScoreGuide}
                data-testid="score-guide-btn"
                aria-label={t("scoreGuide")}
              >
                <BookOpen className="h-4 w-4" />
                <span className="ml-1.5 text-[12px] font-semibold hidden sm:inline">
                  {t("scoreGuide")}
                </span>
              </IconButton>

              <IconButton
                onClick={onPrint}
                data-testid="print-btn"
                aria-label={t("print")}
              >
                <Printer className="h-4 w-4" />
                <span className="ml-1.5 text-[12px] font-semibold hidden md:inline">
                  {t("print")}
                </span>
              </IconButton>

              <IconButton
                onClick={onLogout}
                data-testid="logout-btn"
                aria-label={t("logout")}
              >
                <LogOut className="h-4 w-4" />
                <span className="ml-1.5 text-[12px] font-semibold hidden sm:inline">
                  {t("logout")}
                </span>
              </IconButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      className="h-9 px-2.5 rounded-full flex items-center justify-center text-[color:var(--color-ink)] border border-transparent transition-all active:scale-[0.96] hover:text-white hover:border-transparent hover:[background:var(--gradient-teal)] hover:shadow-[var(--glow-teal)]"
      style={{ transitionProperty: "background, color, border-color, box-shadow, transform" }}
      {...rest}
    >
      {children}
    </button>
  );
}
