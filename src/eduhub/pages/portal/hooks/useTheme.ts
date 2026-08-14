import { useCallback, useEffect, useState } from "react";
import {
  getThemeMode,
  setThemePreference,
} from "../../../lib/themeAuto";

export type Theme = "light" | "dark";
export type ThemeMode = "auto" | "light" | "dark";

/**
 * useTheme — thin adapter over the GLOBAL EduHub theme controller
 * (src/eduhub/lib/themeAuto.js).
 *
 * The portal does NOT own a competing theme source. `eduhub.themeMode`
 * (managed by themeAuto) is the single source of truth. This hook only:
 *   • READS the resolved theme from <html> (kept in sync by
 *     startThemeAuto: focus / visibilitychange / 30-min reapply), and
 *   • WRITES exclusively through setThemePreference().
 *
 * It never writes on mount, never pins a portal default, preserves the
 * "auto" mode, and adds no competing focus/visibility listener — it uses
 * a passive MutationObserver on <html> so the returned values stay in
 * sync no matter who changed the theme (global ThemeToggle, system
 * change, focus reapply, or the portal's own toggle).
 *
 * Public contract (back-compat preserved): { theme, toggle, setTheme }.
 * Added for full mode support: { mode, cycleMode, setMode }.
 */
function readActiveTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  // themeAuto applies the resolved theme via the `.dark` class + data-theme.
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const m = getThemeMode();
  return m === "light" || m === "dark" ? m : "auto";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readActiveTheme);
  const [mode, setModeState] = useState<ThemeMode>(readMode);

  useEffect(() => {
    const sync = () => {
      setThemeState(readActiveTheme());
      setModeState(readMode());
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  // Three-state cycle, mirroring the global ThemeToggle: auto → light → dark.
  const cycleMode = useCallback(() => {
    const current = readMode();
    const next: ThemeMode =
      current === "auto" ? "light" : current === "light" ? "dark" : "auto";
    setThemePreference(next);
  }, []);

  // Back-compat: explicit light/dark toggle. Still routed through the
  // global controller (sets an explicit preference).
  const toggle = useCallback(() => {
    setThemePreference(readActiveTheme() === "dark" ? "light" : "dark");
  }, []);

  const setTheme = useCallback((t: Theme) => setThemePreference(t), []);
  const setMode = useCallback((m: ThemeMode) => setThemePreference(m), []);

  return { theme, mode, toggle, cycleMode, setTheme, setMode };
}
