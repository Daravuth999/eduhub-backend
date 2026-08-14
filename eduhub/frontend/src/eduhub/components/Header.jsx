// Header.jsx — sticky header; shows Login button when public, student + Logout when authed.
//
// v13 (Premium Native Shell, Jan-2026)
// ────────────────────────────────────────────────────────────────────
// The compact Telegram support icon (sm+ only) is now rendered with a
// premium inline SVG (TelegramGlyph) instead of the generic lucide
// "Send" plane. The destination, target, and behaviour are unchanged
// (real link https://t.me/alita995 — preserved verbatim from previous
// versions). No additional dependency is added.
//
// Mobile-sized viewports (<sm) still hide this entry because students
// reach Telegram support from the side-drawer Help & Support row,
// which is the new non-intrusive home for Telegram support after the
// auto-opening floating popup was retired.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, LogIn, LogOut, User } from "lucide-react";
import { useAuth } from "../context/AuthContext";
// Activity Center™ — realtime notification bell (opens the ActivityDrawer).
// This is now the ONLY visible notification entry point in the header — the
// old PushNotificationBell toggle was removed to avoid showing two
// notification-looking buttons side by side. PushNotificationBell.jsx and
// its usePushNotifications hook are untouched and left on disk (same
// rollback-safety convention as TelegramFab below): push subscription,
// permission state, and the mandatory BellRingGate onboarding flow (which
// uses its own separate useBellRingPermission hook) are completely
// unaffected by this UI-only change.
import NotificationBell from "./activity/NotificationBell";
import InstallButton from "./pwa/InstallButton";
import { usePwaInstallContext } from "./pwa/PwaInstallProvider";
// v10 — Heat Surgery: auto day/night toggle
import ThemeToggle from "./ThemeToggle";
import TelegramGlyph from "./icons/TelegramGlyph";
// VT Pass A — pure title resolver lives in a standalone, dependency-free
// module so it can be unit-tested without mocking router / icons / auth.
import { TITLES, VT_PREFIX, resolveTitle } from "./headerTitle";
export { VT_PREFIX, resolveTitle };  // back-compat re-exports for tests

export default function Header({ onMenuClick }) {
  const { pathname } = useLocation();
  const { isAuthenticated, student, logout } = useAuth();
  const pwa = usePwaInstallContext();
  const title = resolveTitle(pathname);

  // v16 (Premium Persistent Header) — was `position: sticky`, but several
  // ancestors (.App, the content flex-col wrapper) set `overflowX: "hidden"`
  // for mobile anti-bounce, which per the CSS Overflow spec silently
  // upgrades their `overflow-y` to `auto` too — turning them into
  // additional scroll containers. With more than one ancestor capable of
  // scrolling, `position: sticky`'s "nearest scrolling ancestor" can
  // resolve inconsistently across browsers/devices, which is exactly the
  // "header scrolls away" behaviour reported on-device. `position: fixed`
  // sits outside that ambiguity entirely — it only cares about the nearest
  // ancestor with a transform/filter/will-change (none exists here,
  // confirmed) and otherwise pins to the true viewport unconditionally.
  // headerRef + ResizeObserver publish the header's real rendered height
  // (which varies with the iOS safe-area inset) as --eduhub-header-h so
  // AppShell's <main> can reserve exactly that much space — no magic
  // numbers, no gap, no overlap, and it self-corrects on rotation.
  const headerRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const publish = () => {
      document.documentElement.style.setProperty(
        "--eduhub-header-h",
        `${el.getBoundingClientRect().height}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Passive, rAF-throttled — fires at most once per frame, never blocks
    // the scroll gesture itself. window.scrollY is the primary signal;
    // documentElement/body scrollTop are read too since this app forces
    // overflow-x:hidden on several ancestors, which can make either one
    // the "actual" scrolling element depending on browser/version.
    let ticking = false;
    const read = () => {
      const y = Math.max(
        window.scrollY || 0,
        document.documentElement.scrollTop || 0,
        document.body.scrollTop || 0,
      );
      setScrolled(y > 6);
      ticking = false;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  return (
    <header
      ref={headerRef}
      // v8.2 — `min-h-[60px]` (was h-[60px]) so the header can grow under
      // the iOS notch / Android status bar in PWA mode without squashing
      // the buttons. paddingTop adds the safe-area inset; on devices
      // without an inset env() resolves to 0 and the header is identical.
      // v16 — fixed (was sticky, see comment above) + a subtle "scrolled"
      // treatment (stronger background opacity, deeper blur, visible
      // shadow) that eases in/out over 250ms, matching premium native app
      // chrome. Colors, spacing, icons and button positions are unchanged.
      className={[
        "fixed top-0 left-0 right-0 lg:left-[256px] z-[200]",
        "min-h-[60px] flex items-center gap-2.5 px-3 sm:px-5",
        "transition-[background-color,backdrop-filter,box-shadow,border-color] duration-[250ms] ease-out",
        scrolled
          ? "backdrop-blur-2xl border-b border-zinc-900/10 dark:border-white/[0.14] shadow-[0_8px_24px_rgba(13,10,20,0.08)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
          : "backdrop-blur-xl border-b border-zinc-900/[0.06] dark:border-white/[0.08]",
      ].join(" ")}
      style={{
        background: scrolled ? "var(--shell-glass-strong)" : "var(--shell-glass)",
        paddingTop: "max(0px, env(safe-area-inset-top))",
        paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
        paddingRight: "max(0.75rem, env(safe-area-inset-right))",
      }}
      data-testid="eduhub-header"
    >
      <div
        aria-hidden
        className="absolute bottom-0 left-0 right-0 h-px opacity-60"
        style={{ background: "linear-gradient(90deg, transparent, #00e0ff 25%, #9b5cff 55%, #ff3da6 80%, transparent)" }}
      />
      <button
        onClick={onMenuClick}
        aria-label="Menu"
        data-testid="header-menu-btn"
        className="lg:hidden w-[34px] h-[34px] rounded-[9px] bg-zinc-900/[0.04] dark:bg-white/[0.05] border border-aurora-violet/30 flex items-center justify-center text-ink dark:text-white hover:bg-aurora-violet/15 hover:border-aurora-violet/60 transition-[background-color,border-color]"
      >
        <Menu className="w-4 h-4" />
      </button>

      <span className="font-display font-bold text-base tracking-tight text-iridescent" data-testid="header-title">
        {title}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        <InstallButton
          canInstall={pwa.canInstall}
          isIos={pwa.isIos}
          isInstalled={pwa.isInstalled}
          onInstall={pwa.promptInstall}
          onIosRequest={pwa.openIosModal}
          compact
        />
        <a
          href="https://t.me/alita995"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Telegram support"
          data-testid="header-telegram-link"
          className="hidden sm:inline-flex w-[34px] h-[34px] rounded-[10px] items-center justify-center transition-transform hover:scale-105 active:scale-95"
          style={{
            background: "rgba(91,208,255,0.10)",
            border: "1px solid rgba(91,208,255,0.32)",
            boxShadow: "0 0 12px rgba(42,169,240,0.18)",
          }}
        >
          <TelegramGlyph size={20} />
        </a>

        {isAuthenticated ? (
          <div className="flex items-center gap-1.5">
            {/* 🔔 Activity Center bell — the ONLY visible notification
                entry point in the header. PushNotificationBell (browser-push
                opt-in toggle) was removed from view here — see the import
                comment above for why the underlying push system is
                unaffected. */}
            <NotificationBell />
            <div
              data-testid="header-student-pill"
              className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-[0.78rem] font-semibold bg-aurora-violet/10 border border-aurora-violet/30 text-ink dark:text-white"
            >
              <User className="w-3.5 h-3.5 text-[#0E7490] dark:text-aurora-cyan" />
              <span className="truncate max-w-[120px]">{student?.name || student?.studentId}</span>
            </div>
            <button
              onClick={logout}
              data-testid="header-logout-btn"
              aria-label="Sign out"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[0.78rem] font-semibold bg-aurora-magenta/10 border border-aurora-magenta/40 text-[#BE185D] dark:text-aurora-magenta hover:bg-aurora-magenta/20 transition-[background-color]"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Sign Out</span>
            </button>
          </div>
        ) : (
          <Link
            to="/login"
            data-testid="header-login-btn"
            className="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-full text-[0.78rem] font-semibold bg-aurora-cyan/10 border border-aurora-cyan/40 text-[#0E7490] dark:text-aurora-cyan hover:bg-aurora-cyan/20 hover:shadow-[0_0_14px_rgba(0,224,255,0.5)] transition-[background-color,box-shadow]"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Student Login →</span>
          </Link>
        )}
      </div>
    </header>
  );
}
