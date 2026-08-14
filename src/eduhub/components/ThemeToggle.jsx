import React, { useEffect, useState } from "react";
import { Sun, Moon, Globe2 } from "lucide-react";
import {
  setThemePreference,
  getThemeMode,
  getActiveTheme,
} from "../lib/themeAuto";
import { playUiSound } from "../audio/uiSoundEngine";

/**
 * ThemeToggle — three-state Auto/Light/Dark toggle (v17).
 *
 *   Auto · Cambodia (default) — follows Asia/Phnom_Penh local time
 *                               (06:00–18:00 light, otherwise dark).
 *   Light                     — forces ivory parchment palette.
 *   Dark                      — forces deep-ink palette.
 *
 * Backward-compatible: a stored "auto-cambodia" preference from
 * v16 is treated identically to "auto".
 */
export default function ThemeToggle({ className = "" }) {
  const normalize = (m) => (m === "auto-cambodia" ? "auto" : m);
  const [mode, setMode] = useState(normalize(getThemeMode()));
  const [active, setActive] = useState(getActiveTheme());

  useEffect(() => {
    const tick = () => setActive(getActiveTheme());
    const obs = new MutationObserver(tick);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  const cycle = () => {
    playUiSound("toggle");
    const next = mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
    setMode(next);
    setThemePreference(next);
  };

  const Icon = mode === "auto" ? Globe2 : active === "light" ? Sun : Moon;
  const label =
    mode === "auto"
      ? `Auto · Cambodia (${active === "light" ? "Light" : "Dark"})`
      : mode === "light"
        ? "Light mode"
        : "Dark mode";

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      data-testid="theme-toggle-button"
      data-theme-mode={mode}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors ${className}`}
      style={{
        background: "rgb(var(--bgfx-card))",
        color: "rgb(var(--bgfx-ink))",
        border: "1px solid rgb(var(--bgfx-line) / 0.12)",
      }}
    >
      <Icon className="h-4.5 w-4.5" />
    </button>
  );
}
