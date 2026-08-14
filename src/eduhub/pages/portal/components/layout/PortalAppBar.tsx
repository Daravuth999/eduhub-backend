import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Languages,
  Moon,
  Sun,
  Settings2,
  Printer,
  LogOut,
  MoreHorizontal,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "../../hooks/useTheme";
import { useLang } from "../../contexts/LanguageContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
// Unified badge platform — the SAME Activity Center bell used in the global
// Header, reused as-is (not rebuilt) so /portal/me isn't the one route in
// the app with zero visibility into unread activity. It reads/writes the
// same NotificationContext/ActivityDrawer state as everywhere else — no
// second bell, no second unread count.
import NotificationBell from "../../../../components/activity/NotificationBell";

interface Props {
  onScoreGuide: () => void;
  onPrint: () => void;
  onLogout: () => void;
  /** Optional contextual label shown centre on >= md (e.g. month/cohort). */
  contextLabel?: string;
}

/**
 * PortalAppBar -- the single slim app bar for /portal/me (Lumio).
 *
 * Replaces the legacy TopBar. The global app <Header /> is hidden on this
 * route (see App.js), so this is the ONLY top bar. It reuses the exact
 * same handlers (Score Guide / Print / Logout) and the portal's own
 * useTheme + useLang, so behaviour is identical -- only the structure and
 * styling change.
 */
export function PortalAppBar({ onScoreGuide, onPrint, onLogout, contextLabel }: Props) {
  const { theme, mode, cycleMode } = useTheme();
  const { t, lang, toggle: toggleLang } = useLang();
  const reduced = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Theme control mirrors the global 3-state ThemeToggle (auto/light/dark)
  // and routes every change through the global controller (themeAuto).
  const themeLabel =
    mode === "auto"
      ? `Theme: Auto (${theme === "light" ? "Light" : "Dark"})`
      : mode === "light"
        ? "Theme: Light"
        : "Theme: Dark";
  const ThemeIcon = mode === "auto" ? Settings2 : theme === "light" ? Sun : Moon;

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  return (
    <header
      className="lumio-appbar no-print sticky top-0 z-[var(--z-appbar)]"
      data-testid="portal-app-bar"
    >
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <div
          className="flex items-center justify-between gap-2"
          style={{ height: "var(--portal-appbar-h)" }}
        >
          {/* Brand */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="aurora-icon-badge h-9 w-9 shrink-0">
              <BookOpen className="h-4 w-4" />
            </div>
            <div className="leading-tight min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="display font-bold text-[15px] text-[color:var(--color-ink)] truncate">
                  {t("brandName")}
                </span>
                <span className="hidden sm:inline-flex shrink-0">
                  <span className="lumio-pill" aria-hidden>
                    Lumio
                  </span>
                </span>
              </div>
              <div className="hidden sm:block text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-ink-soft)] truncate">
                {t("brandTag")}
              </div>
            </div>
          </div>

          {contextLabel ? (
            <div className="hidden md:block text-xs font-semibold text-[color:var(--color-ink-soft)] truncate">
              {contextLabel}
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex items-center gap-1">
            <NotificationBell />
            <AppBarButton
              onClick={toggleLang}
              data-testid="portal-language-toggle"
              aria-label="Toggle language"
              title={lang === "en" ? "ភាសាខ្មែរ" : "English"}
            >
              <Languages className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline text-[11px] font-bold uppercase tracking-wider">
                {lang === "en" ? "ខ្មែរ" : "EN"}
              </span>
            </AppBarButton>

            <AppBarButton
              onClick={cycleMode}
              data-testid="portal-theme-toggle"
              aria-label={themeLabel}
              title={themeLabel}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={`${mode}-${theme}`}
                  initial={reduced ? false : { rotate: -50, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={reduced ? undefined : { rotate: 50, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="inline-flex"
                >
                  <ThemeIcon className="h-4 w-4" />
                </motion.span>
              </AnimatePresence>
            </AppBarButton>

            {/* Secondary actions: inline on sm+, overflow menu on mobile */}
            <div className="hidden sm:flex items-center gap-1">
              <AppBarButton
                onClick={onScoreGuide}
                data-testid="portal-score-guide-button"
                aria-label={t("scoreGuide")}
              >
                <BookOpen className="h-4 w-4" />
                <span className="ml-1.5 text-[12px] font-semibold hidden md:inline">
                  {t("scoreGuide")}
                </span>
              </AppBarButton>
              <AppBarButton
                onClick={onPrint}
                data-testid="portal-print-button"
                aria-label={t("print")}
              >
                <Printer className="h-4 w-4" />
                <span className="ml-1.5 text-[12px] font-semibold hidden lg:inline">
                  {t("print")}
                </span>
              </AppBarButton>
              <AppBarButton
                onClick={onLogout}
                data-testid="portal-logout-button"
                aria-label={t("logout")}
              >
                <LogOut className="h-4 w-4" />
                <span className="ml-1.5 text-[12px] font-semibold hidden lg:inline">
                  {t("logout")}
                </span>
              </AppBarButton>
            </div>

            <div className="sm:hidden relative" ref={menuRef}>
              <AppBarButton
                onClick={() => setMenuOpen((o) => !o)}
                data-testid="portal-appbar-overflow-menu"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <MoreHorizontal className="h-4 w-4" />
              </AppBarButton>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    initial={reduced ? false : { opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduced ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.16 }}
                    role="menu"
                    className="absolute right-0 mt-2 w-44 p-1.5 rounded-2xl z-[var(--z-popover)] lumio-menu"
                  >
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        onScoreGuide();
                      }}
                      icon={<BookOpen className="h-4 w-4" />}
                      label={t("scoreGuide")}
                      testId="portal-menu-score-guide"
                    />
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        onPrint();
                      }}
                      icon={<Printer className="h-4 w-4" />}
                      label={t("print")}
                      testId="portal-menu-print"
                    />
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        onLogout();
                      }}
                      icon={<LogOut className="h-4 w-4" />}
                      label={t("logout")}
                      testId="portal-menu-logout"
                      danger
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function AppBarButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="lumio-appbar-btn lumio-focus eduhub-tap inline-flex items-center justify-center h-11 min-w-[44px] px-2.5 rounded-full text-[color:var(--color-ink)]"
      {...rest}
    >
      {children}
    </button>
  );
}

function MenuItem({
  onClick,
  icon,
  label,
  testId,
  danger,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testId: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      data-testid={testId}
      className="lumio-focus w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-left transition-colors"
      style={{ color: danger ? "var(--color-needs)" : "var(--color-ink)" }}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
