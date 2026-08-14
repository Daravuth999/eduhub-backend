// MobileBottomNav.jsx — 6-tab bottom bar per redesign spec:
//   Home / Library / Videos / Spin / Portal / AI Assistant.
//
// Video Library tab (standalone product parity) — Aug 2026
// ────────────────────────────────────────────────────────────────────
// Video Library already has a Sidebar entry; this adds the same
// first-class reachability to the bottom bar (grid-cols-5 -> grid-cols-6)
// per the standalone-product direction, placed next to Library since
// both are content-consumption destinations.
//
// AI Assistant Nav (production enhancement) — Aug 2026
// ────────────────────────────────────────────────────────────────────
// "More" (which only opened the Sidebar drawer) was replaced with a
// permanent AI Assistant destination. The Sidebar drawer itself is
// untouched and stays fully reachable via Header.jsx's own menu button
// (`header-menu-btn`, visible below the `lg` breakpoint) — MobileBottomNav
// was never its only trigger.
//
// Part 1 (Portal Auth-Aware Nav fix) — Sep 2026
// ────────────────────────────────────────────────────────────────────
// "My Portal" must open the PRIVATE dashboard (/portal/me) when the
// student is already authenticated, instead of the PUBLIC leaderboard
// landing (/portal).  Logged-out users still get the friendly public
// preview at /portal — they can also tap the deep link and land on
// /login?redirect=/portal/me via ProtectedRoute.
//
// We resolve the destination at click-time so the route reflects the
// most recent auth state (e.g. a fresh login from another tab via the
// AuthContext visibilitychange recheck shipped earlier).
import React from "react";
// Shared layout CSS variable --eduhub-bottom-nav-h (default 64px) is
// defined in src/eduhub/styles/layout-vars.css and is imported once at
// app boot from src/App.js — no duplicate import here.
import { Link, useLocation } from "react-router-dom";
import { Home, Library, Sparkles, GraduationCap, Bot, Clapperboard } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useUnifiedBadges } from "../hooks/useUnifiedBadges";
// VT Pass A — pure active-state helper lives in a standalone, dependency-
// free module so it can be unit-tested directly.
import { isActiveForPath } from "./bottomNavActive";
export { isActiveForPath };  // back-compat re-export for tests

// Items with a static `to` are resolved as-is.  The Portal entry sets a
// `key: "portal"` flag so the renderer can pick /portal vs /portal/me
// based on `isAuthenticated`.  Keeping the structure stable means data-
// testids and active-state highlighting work identically to before.
export const ITEMS = [
  { label: "Home",         icon: Home,           to: "/" },
  { label: "Library",      icon: Library,        to: "/library", badgeModule: "library" },
  { label: "Videos",       icon: Clapperboard,   to: "/video-library" },
  { label: "Spin",         icon: Sparkles,       to: "/game" },
  { label: "Portal",       icon: GraduationCap,  to: "/portal", key: "portal", badgeModule: "wallet" },
  { label: "AI Assistant", icon: Bot,            to: "/assistant" },
];

export default function MobileBottomNav({ hidden = false }) {
  const { pathname } = useLocation();
  const { isAuthenticated } = useAuth();
  const { byModule } = useUnifiedBadges();

  // Part 1 — auth-aware destination for "My Portal".
  // Authenticated → personal dashboard.
  // Not authenticated → login flow that preserves /portal/me as the
  // post-login redirect target (consumed by LoginPage).
  const resolveTo = (it) => {
    if (it.key === "portal") {
      return isAuthenticated ? "/portal/me" : "/login?redirect=/portal/me";
    }
    return it.to;
  };

  // Active-state highlighting. Voice Treasure routes have NO active item
  // (Pass A locked decision); off VT the prefix-match preserves existing
  // behavior including the Portal-tab dual-route highlight. See
  // `isActiveForPath` (exported above) for the pure logic the tests pin.
  const isActive = (it) => isActiveForPath(it, pathname);

  return (
    <nav
      aria-label="Primary"
      aria-hidden={hidden}
      className="eh-bottomnav fixed bottom-0 left-0 right-0 z-[400] lg:hidden backdrop-blur-2xl border-t border-zinc-900/[0.06] dark:border-white/[0.08] grid grid-cols-6 px-1"
      style={{
        // v18 (Premium UI Reconstruction) — glass surface + shadow moved
        // to the theme-aware .eh-bottomnav class (white/92 glass in light,
        // #050010/94 glass in dark). The top accent gradient bar is
        // preserved below.
        WebkitBackdropFilter: "blur(22px) saturate(140%)",
        backdropFilter: "blur(22px) saturate(140%)",
        paddingTop: "0.4rem",
        // v20 (Native Keyboard Behaviour) — slide fully off-screen (not
        // just opacity/visibility) while the on-screen keyboard is open,
        // so it can never be the fixed-position element iOS Safari
        // mis-positions during the keyboard transition, and never
        // intercepts touches meant for the keyboard/composer above it.
        transform: hidden ? "translateY(100%)" : "translateY(0)",
        transition: "transform 220ms cubic-bezier(0.4, 0, 0.2, 1)",
        pointerEvents: hidden ? "none" : "auto",
        // env(safe-area-inset-bottom) keeps the icons floating above
        // the iPhone home indicator on every iPhone model.
        paddingBottom: "max(0.4rem, env(safe-area-inset-bottom))",
        width: "100vw",
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
      data-testid="mobile-bottom-nav"
    >
      <div
        aria-hidden
        className="absolute top-0 left-0 right-0 h-px opacity-70"
        style={{
          background:
            "linear-gradient(90deg, transparent, #00e0ff 20%, #9b5cff 50%, #ff3da6 80%, transparent)",
        }}
      />
      {ITEMS.map((it) => {
        const active = isActive(it);
        const Icon = it.icon;
        const to = resolveTo(it);
        const slug = it.label.toLowerCase().replace(/\s+/g, "-");
        return (
          <Link
            key={it.label}
            to={to}
            data-testid={`mobile-tab-${slug}`}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-xl text-[0.6rem] font-semibold transition-transform duration-150 active:scale-[0.92] ${
              active
                ? "text-[#0E7490] dark:text-aurora-cyan"
                : "text-zinc-600 hover:text-ink dark:text-white/55 dark:hover:text-white"
            }`}
          >
            {active && (
              <>
                {/* Soft halo behind the active icon — native glow */}
                <span
                  aria-hidden
                  className="absolute inset-x-3 inset-y-1 rounded-xl pointer-events-none"
                  style={{
                    background:
                      "radial-gradient(60% 80% at 50% 35%, rgba(0,224,255,0.22) 0%, rgba(155,92,255,0.10) 55%, transparent 80%)",
                  }}
                />
                {/* Top rainbow indicator (kept for continuity with v12). */}
                <span
                  aria-hidden
                  className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full"
                  style={{
                    background: "linear-gradient(90deg, #00e0ff, #9b5cff, #ff3da6)",
                    boxShadow: "0 0 10px rgba(155,92,255,0.7)",
                  }}
                />
              </>
            )}
            <span className="relative inline-block">
              <Icon
                className={`relative w-[18px] h-[18px] ${
                  active ? "drop-shadow-[0_0_6px_rgba(0,224,255,0.85)]" : ""
                }`}
              />
              {it.badgeModule && isAuthenticated && byModule[it.badgeModule] > 0 && (
                <span
                  aria-hidden
                  data-testid={`mobile-tab-badge-${slug}`}
                  className="absolute -top-1 -right-1.5 min-w-[13px] h-[13px] px-[3px] grid place-items-center bg-[#ff5470] text-white text-[0.5rem] font-bold rounded-full"
                >
                  {byModule[it.badgeModule] > 9 ? "9+" : byModule[it.badgeModule]}
                </span>
              )}
            </span>
            <span className="relative">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
