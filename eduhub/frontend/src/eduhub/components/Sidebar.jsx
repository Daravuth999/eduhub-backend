// Sidebar.jsx — v6: dropped all third-party iframe links (Live Sessions,
//   Rewards Shop, Dictionary, Attendance, Practical Class, Play & Earn).
//   Sidebar now only lists native in-app destinations.
//
// v13 (Premium Native Shell, Jan-2026)
// ────────────────────────────────────────────────────────────────────
//   • Brand header now respects env(safe-area-inset-top) so the EduHub
//     logo never collides with the iPhone status bar / dynamic island.
//   • Footer (instructor / student profile + Sign In / Sign Out) now
//     respects env(safe-area-inset-bottom) so the action button is
//     never cut off by the iPhone home indicator.
//   • New "Help & Support" section just above the footer:
//       – Single row, professional native-app look.
//       – Inline TelegramGlyph SVG (no PNG / emoji).
//       – Uses the REAL existing Telegram link from the codebase
//         (https://t.me/alita995). No fake link is invented.
//   • The aggressive floating Telegram popup (TelegramFab) is no
//     longer mounted by App.js — this Sidebar row is its new home.
//
// v14 (Premium Sidebar Polish, Milestone 5 follow-up)
// ────────────────────────────────────────────────────────────────────
//   • Replaced the generic GraduationCap-in-a-box brand mark with the
//     REAL, already-in-use DYLogo component (src/eduhub/auth/premium/
//     DYLogo.jsx — the same mark shown on the login screen) rather than
//     drawing a new one.
//   • Removed the aurora cyan/violet/magenta gradients, neon glows, and
//     rainbow edge-strip — replaced with a single restrained gold accent
//     (matching the Profile page's own premium language) applied
//     sparingly, plus neutral surfaces/typography. No new routes, no
//     logic changes, no testid renames — every existing consumer
//     (tests, App.js) keeps working unmodified.
//   • Active nav state now uses a Framer Motion layoutId so the
//     highlight SLIDES between items instead of popping — the same
//     shared-layout technique Linear/Arc's sidebars use.
//   • whileTap press feedback added to every interactive row.
import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Bot, FlaskConical, Sparkles, GraduationCap,
  Library, X, LogIn, LogOut, LifeBuoy, CalendarCheck, ChevronRight, Clapperboard,
  ClipboardList,
} from "lucide-react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useAuth } from "../context/AuthContext";
import { useUnifiedBadges } from "../hooks/useUnifiedBadges";
import useAssessmentBadge from "../pages/assessments/useAssessmentBadge";
import TelegramGlyph from "./icons/TelegramGlyph";
import DYLogo from "../auth/premium/DYLogo";
import { playUiSound } from "../audio/uiSoundEngine";

// Real Telegram support destination preserved from the previous
// header / floating-popup implementation. If the deployment needs a
// different handle, change this single constant — no other files
// reference the literal URL.
const TELEGRAM_SUPPORT_URL = "https://t.me/alita995";

// Premium neutral + gold palette (v14) — matches the Profile page's own
// design language. Deliberately restrained: one accent color, used
// sparingly, no gradients/glows.
const GOLD = "#D4A843";
const GOLD_SOFT_BG = "rgba(212,168,67,0.09)";
const GOLD_SOFT_BORDER = "rgba(212,168,67,0.22)";
const EASE_NATIVE = [0.32, 0.72, 0, 1]; // iOS-sheet-style ease, used app-wide for this drawer

const ICONS = {
  LayoutDashboard, Sparkles, GraduationCap, Library, Bot, FlaskConical, CalendarCheck, Clapperboard,
  ClipboardList,
};

// Internal app routes — no iframes, all native React pages.
//
// Part 1 (Portal Auth-Aware Nav fix) — the My Portal entry now carries
// a `key: "portal"` flag.  At render time we swap the destination so an
// authenticated student lands on /portal/me (the private evaluation
// dashboard) instead of the public leaderboard at /portal.  Logged-out
// students go through /login with /portal/me as the post-login redirect.
const INTERNAL_NAV = [
  { label: "Dashboard",         to: "/",           icon: "LayoutDashboard" },
  { label: "Classroom Library", to: "/library",    icon: "Library" },
  { label: "Video Library",     to: "/video-library", icon: "Clapperboard" },
  { label: "Assessments",       to: "/assessments", icon: "ClipboardList" },
  { label: "My Portal",         to: "/portal",     icon: "GraduationCap", key: "portal" },
  { label: "Lucky Spin",        to: "/game",       icon: "Sparkles" },
  { label: "Attendance",        to: "/attendance", icon: "CalendarCheck" },
];

// Native AI / test tools (require login).
const PROTECTED_NAV = [
  { label: "AI Assistant", to: "/assistant",  icon: "Bot",          badge: "AI" },
  { label: "System Test",  to: "/systemtest", icon: "FlaskConical", badge: "Live" },
];

function NavLinkItem({ label, to, icon, badge, unreadCount, onClick, layoutGroup }) {
  const Icon = ICONS[icon] || LayoutDashboard;
  const { pathname } = useLocation();
  const active = to === "/"
    ? pathname === "/"
    : pathname === to || pathname.startsWith(to + "/");

  return (
    <Link
      to={to}
      onClick={(e) => { playUiSound("click"); onClick?.(e); }}
      className="group relative flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[0.83rem] font-medium"
      data-testid={`sidebar-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {active && (
        <motion.span
          layoutId={`sidebar-active-pill-${layoutGroup}`}
          transition={{ type: "spring", stiffness: 420, damping: 38 }}
          aria-hidden
          className="absolute inset-0 rounded-[10px]"
          style={{ background: GOLD_SOFT_BG, border: `1px solid ${GOLD_SOFT_BORDER}` }}
        />
      )}
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[60%] rounded-r-[3px]"
          style={{ background: GOLD }}
        />
      )}
      <motion.span
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.12 }}
        className="relative flex items-center gap-2.5 flex-1 min-w-0 motion-reduce:!transform-none"
      >
        <Icon
          className="w-[16px] h-[16px] shrink-0 transition-colors duration-150"
          style={{ color: active ? GOLD : undefined }}
        />
        <span
          className={`truncate transition-colors duration-150 ${active ? "text-ink dark:text-white" : "text-zinc-600 group-hover:text-ink dark:text-white/55 dark:group-hover:text-white"}`}
        >
          {label}
        </span>
        {badge && (
          <span
            className="ml-auto text-[0.6rem] font-bold px-1.5 py-[2px] rounded-full uppercase tracking-wide"
            style={{ background: "rgba(212,168,67,0.14)", color: GOLD }}
          >
            {badge}
          </span>
        )}
        {!badge && unreadCount > 0 && (
          <span
            className="ml-auto min-w-[16px] h-[16px] px-1 grid place-items-center bg-[#ff5470] text-white text-[0.58rem] font-bold rounded-full"
            data-testid={`sidebar-badge-${label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </motion.span>
    </Link>
  );
}

// Which unified-badge module each internal nav route reflects. Only routes
// with a real, server-backed category mapping (useUnifiedBadges.js) get a
// dot — no guessing for routes with no corresponding category today.
const NAV_BADGE_MODULE = {
  "/library": "library",
  "/portal": "wallet",
  "/attendance": "attendance",
};

export default function Sidebar({ open, onClose, instructorName = "Daravuth Yon" }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const { isAuthenticated, student, logout } = useAuth();
  const { byModule } = useUnifiedBadges();
  // Real, server-backed pending-assessment count (see the hook's own
  // header for why this is separate from useUnifiedBadges) — the ONE
  // thing that turns the Assessments row's badge on or off.
  const { pendingCount: pendingAssessmentCount } = useAssessmentBadge();
  const initials = (student?.name || instructorName)
    .split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  // Drawer open/close sound — only the actual mobile drawer transition
  // (desktop's rail is always visible, so `open` toggling there isn't a
  // real "opening" event). Tracks the previous value so the sound never
  // fires on initial mount, only on genuine open<->close transitions.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (isDesktop) { prevOpenRef.current = open; return; }
    if (prevOpenRef.current !== open) {
      playUiSound(open ? "drawer_open" : "drawer_close");
      prevOpenRef.current = open;
    }
  }, [open, isDesktop]);

  return (
    <>
      <AnimatePresence>
        {open && !isDesktop && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/65 backdrop-blur-[4px] z-[290]"
            aria-hidden
          />
        )}
      </AnimatePresence>

      <motion.aside
        initial={false}
        animate={{ x: isDesktop || open ? 0 : "-100%" }}
        transition={{ duration: 0.32, ease: EASE_NATIVE }}
        className="fixed top-0 left-0 bottom-0 z-[300] w-[256px] backdrop-blur-2xl border-r border-zinc-900/[0.08] dark:border-white/[0.08] flex flex-col overflow-y-auto"
        style={{
          background: "var(--shell-glass-strong)",
          // v13 — extend drawer chrome under the iPhone status bar /
          // notch and above the home indicator so glow/blur looks
          // continuous and nothing inside is ever clipped.
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        data-testid="sidebar"
      >
        {/* Brand */}
        <div className="px-[18px] py-5 border-b border-zinc-900/[0.08] dark:border-white/[0.08] flex items-center gap-3">
          <Link to="/" onClick={onClose} className="flex items-center gap-3 min-w-0">
            <DYLogo size={36} alt="EduHub" testID="sidebar-brand-logo" className="rounded-[10px] shrink-0" />
            <div className="min-w-0">
              <div className="font-display text-[1.05rem] font-extrabold tracking-tight truncate text-ink dark:text-white">EduHub</div>
              <div className="text-[0.66rem] text-zinc-600 dark:text-white/45 mt-[1px] truncate">Unified Portal</div>
            </div>
          </Link>
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={onClose}
            className="ml-auto lg:hidden w-7 h-7 rounded-md flex items-center justify-center text-zinc-600 hover:text-ink hover:bg-zinc-900/[0.05] dark:text-white/60 dark:hover:text-white dark:hover:bg-white/[0.06]"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </motion.button>
        </div>

        {/* Main nav */}
        <div className="px-3 pt-4">
          <div className="text-[0.62rem] font-bold tracking-[0.14em] uppercase text-zinc-500 dark:text-white/25 px-2 mb-1.5">Main</div>
          <div className="flex flex-col gap-[2px]">
            {INTERNAL_NAV.map((it) => {
              // Part 1 — auth-aware destination for My Portal.  Every
              // other entry passes through unchanged.
              const to =
                it.key === "portal"
                  ? (isAuthenticated ? "/portal/me" : "/login?redirect=/portal/me")
                  : it.to;
              const badgeModule = NAV_BADGE_MODULE[it.to];
              const unreadCount = it.to === "/assessments"
                ? (isAuthenticated ? pendingAssessmentCount : 0)
                : (isAuthenticated && badgeModule ? byModule[badgeModule] : 0);
              return (
                <NavLinkItem
                  key={it.label}
                  {...it}
                  to={to}
                  layoutGroup="main"
                  unreadCount={unreadCount}
                  onClick={onClose}
                />
              );
            })}
          </div>
        </div>

        {/* Tools (auth-gated) */}
        {isAuthenticated && (
          <div className="px-3 pt-4">
            <div className="text-[0.62rem] font-bold tracking-[0.14em] uppercase text-zinc-500 dark:text-white/25 px-2 mb-1.5">
              Smart Tools
            </div>
            <div className="flex flex-col gap-[2px]">
              {PROTECTED_NAV.map((it) => (
                <NavLinkItem key={it.label} {...it} layoutGroup="tools" onClick={onClose} />
              ))}
            </div>
          </div>
        )}

        {/* v13 — Help & Support
              Premium, non-intrusive home for Telegram support after the
              auto-opening floating popup (TelegramFab) was retired. The
              link/destination is the REAL existing Telegram handle used
              elsewhere in the app — nothing is invented. */}
        <div className="px-3 pt-4">
          <div className="text-[0.62rem] font-bold tracking-[0.14em] uppercase text-zinc-500 dark:text-white/25 px-2 mb-1.5">
            Help &amp; Support
          </div>
          <motion.a
            whileTap={{ scale: 0.98 }}
            href={TELEGRAM_SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            data-testid="sidebar-telegram-support"
            className="group flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-[0.83rem] font-medium text-zinc-700 hover:text-ink dark:text-white/75 dark:hover:text-white border border-zinc-900/[0.08] dark:border-white/[0.08] bg-zinc-900/[0.02] hover:bg-zinc-900/[0.05] dark:bg-white/[0.025] dark:hover:bg-white/[0.06] transition-colors duration-150"
          >
            <span className="shrink-0 grid place-items-center w-9 h-9 rounded-full" style={{ background: "rgba(91,208,255,0.10)", border: "1px solid rgba(91,208,255,0.28)" }}>
              <TelegramGlyph size={20} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[0.83rem] font-semibold text-ink dark:text-white/90 truncate">
                Telegram Support
              </span>
              <span className="block text-[0.66rem] text-zinc-600 dark:text-white/45 truncate">
                Message your instructor
              </span>
            </span>
            <LifeBuoy className="w-3.5 h-3.5 text-zinc-400 dark:text-white/30 group-hover:text-[#D4A843] transition-colors" />
          </motion.a>
        </div>

        {/* Footer — instructor or student */}
        <div className="mt-auto px-3 py-3.5 border-t border-zinc-900/[0.08] dark:border-white/[0.08] space-y-2">
          {isAuthenticated && student ? (
            <>
              <motion.div whileTap={{ scale: 0.98 }}>
                <Link
                  to="/profile"
                  onClick={(e) => { playUiSound("profile_open"); onClose?.(e); }}
                  data-testid="sidebar-profile-link"
                  aria-label="Open Profile and Settings"
                  className="group flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-colors duration-200 motion-reduce:transition-none"
                  style={{
                    background: "rgba(212,168,67,0.05)",
                    borderColor: "rgba(212,168,67,0.20)",
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-[0.78rem] font-extrabold shrink-0 transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                    style={{
                      background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                      color: "#1a1420",
                      boxShadow: "0 3px 10px rgba(212,168,67,0.4)",
                    }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.8rem] font-semibold truncate" data-testid="sidebar-student-name">
                      {student.name || student.studentId}
                    </div>
                    <div className="text-[0.67rem] text-zinc-600 dark:text-white/45 truncate">
                      {student.portalData?.["Class Group"] || student.portalData?.ClassGroup || "Student"}
                    </div>
                  </div>
                  <ChevronRight
                    className="w-4 h-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                    style={{ color: "rgba(212,168,67,0.6)" }}
                    aria-hidden="true"
                  />
                </Link>
              </motion.div>
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => { onClose?.(); logout(); }}
                data-testid="sidebar-logout-btn"
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[0.78rem] font-semibold text-[#BE185D] dark:text-[#ff7fb8] hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.05] transition-colors duration-150"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </motion.button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-zinc-900/[0.08] dark:border-white/[0.08]" style={{ background: "rgb(var(--bgfx-line, 39 39 42) / 0.04)" }}>
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-[0.78rem] font-extrabold shrink-0" style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)", color: "#1a1420" }}>
                  {(instructorName.split(" ").map(p => p[0]).slice(0, 2).join("") || "DY").toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[0.8rem] font-semibold truncate">{instructorName}</div>
                  <div className="text-[0.67rem] text-zinc-600 dark:text-white/40">Instructor</div>
                </div>
              </div>
              <motion.div whileTap={{ scale: 0.98 }}>
                <Link
                  to="/login"
                  onClick={onClose}
                  data-testid="sidebar-login-btn"
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[0.78rem] font-semibold"
                  style={{ background: "rgba(212,168,67,0.14)", color: GOLD, border: `1px solid ${GOLD_SOFT_BORDER}` }}
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Student Login →</span>
                </Link>
              </motion.div>
            </>
          )}
        </div>
      </motion.aside>
    </>
  );
}
