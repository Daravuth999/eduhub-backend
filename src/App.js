// App.js — unified app shell. v6 (2026-01) removes all iframe-embedded
//   third-party features and replaces them with two new native pages:
//     /systemtest → IELTS Speaking Test (native)
//     /assistant  → AI English Tutor (native, with perf upgrades)
// v7 (2026-01) — Bell Ring Onboarding. Protected progression routes are
//   wrapped in <RequireBellRing> which overlays a bilingual permission
//   gate when Notification.permission !== 'granted'. The Home route (/)
//   remains always accessible and shows <BellRingNagCard> as the safe
//   escape valve. Author Studio (/studio) is intentionally excluded.
// v7.0.1 (2026-01-15) — Path-fix to match deployed repo layout where
//   BellRingGate.jsx + BellRingNagCard.jsx live inside a nested
//   bellring/bellring/ folder. RequireBellRing.jsx stays at
//   bellring/RequireBellRing.jsx. No file moves required — only two
//   import paths adjusted in this file + one in RequireBellRing.jsx.
// v9.6 (2026-02) — RealtimeSyncBridge mounted next to the existing
//   PointsCreditPushBridge. Renders nothing; receives EDUHUB_PUSH_SYNC
//   messages from the v1.4 service worker and wakes every existing
//   poller (AuthContext restriction watchdog, useStudentData, usePoints,
//   AuthContext.refreshPoints) the instant a push arrives — eliminating
//   the 12-15s state-lag that the audit identified. Includes a 20s
//   safety-net poll for long-term reliability when SW messages don't
//   land (Safari ITP, throttled background tabs, etc).
import { lazy, Suspense, useState } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import "@/App.css";
import "./eduhub/styles/layout-vars.css";

import BackgroundFx from "./eduhub/components/BackgroundFx";
import ScrollProgress from "./eduhub/components/ScrollProgress";
import Sidebar from "./eduhub/components/Sidebar";
import Header from "./eduhub/components/Header";
import Footer from "./eduhub/components/Footer";
// v13 (Premium Native Shell, Jan-2026) — TelegramFab removed from the app
// shell. The intrusive auto-opening floating popup was replaced by a
// professional "Help & Support" entry inside the Sidebar (mobile) and a
// premium Telegram SVG button inside the Header (desktop). Both reuse
// the same real Telegram link (https://t.me/alita995). The TelegramFab
// component file is intentionally left on disk for rollback safety.
import MobileBottomNav from "./eduhub/components/MobileBottomNav";
import useVisualViewportKeyboard from "./eduhub/hooks/useVisualViewportKeyboard";
// v20 — on-device diagnostic panel for the keyboard-behaviour
// investigation. Renders nothing unless the URL has ?kbdebug=1 — see
// KeyboardDebugOverlay.jsx for what it shows and why.
import KeyboardDebugOverlay from "./eduhub/components/KeyboardDebugOverlay";
import ScrollToTop from "./eduhub/components/ScrollToTop";
import ProtectedRoute from "./eduhub/components/ProtectedRoute";
import GuestAwareGate from "./eduhub/components/GuestAwareGate";
import RestrictionGuard from "./eduhub/components/RestrictionGuard";
import AnnouncementPopup from "./eduhub/components/AnnouncementPopup";
// v11.0 — Login Reward Campaign popup. Renders only after a confirmed
// student session, only when a backend-active campaign matches eligibility,
// and only once per (claim/dismiss-mode) cycle. Silent on API failure so
// dashboard/library/KHQR/EduTalk/Premium AI are never blocked.
import LoginRewardPopup from "./eduhub/components/LoginRewardPopup";
// v12.0 — Login Mystery Box Rewards. Premium 4-box mystery reward popup.
// Backend-authoritative: outcomes are locked server-side at /status time
// and only the selected box is credited at /select time. Silent on
// failure so dashboard/library/EduTalk/Premium AI are never blocked.
import LoginMysteryBoxPopup from "./eduhub/components/LoginMysteryBoxPopup";
// v8.4 — Cover-image prefetcher. Renders nothing; warms the browser
// (and SW) cache with every book cover the moment a student is
// authenticated, so the Library is image-ready when they arrive.
import CoverPrefetcher from "./eduhub/components/CoverPrefetcher";
import SoundUnlockProvider from "./eduhub/audio/SoundUnlockProvider";
// v9.5 — Points-Credit Push bridge. Renders nothing; watches the
// `myportal-latest-reward:{studentId}` localStorage key (written by
// usePoints) and fires /api/push/notify-credit so any non-P2P credit
// (teacher reward, game bonus, manual sheet edit) still wakes the
// recipient's phone. The P2P primary path is handled at the sender
// inside SendPointsModal — see src/eduhub/pages/portal/components/
// modals/SendPointsModal.tsx success branch.
import PointsCreditPushBridge from "./eduhub/components/PointsCreditPushBridge";
// v9.6 — RealtimeSyncBridge (audit fix). Listens for SW push messages
// + provides safety-net polling so points credits and account
// restrictions reflect in the live app the moment the OS notification
// fires — no more 12-15s lag, no manual refresh required.
import RealtimeSyncBridge from "./eduhub/components/RealtimeSyncBridge";
// v10.0 — StatusEnforcer (MongoDB-authoritative status guard). Polls the
// new /api/student/status/{id} endpoint every 3 s and nudges the existing
// AuthContext restriction watchdog the instant the backend flips a
// student to restricted / suspended / deactivated. Renders no UI.
import StatusEnforcer from "./eduhub/components/StatusEnforcer";
// Issue 2 fix — the Reader route has no error boundary anywhere above it
// (it renders outside AppShell). A single render-time exception (bad
// chapter data, a chunk-load failure, a pagination edge case) previously
// unmounted the whole tree with nothing to catch it, showing a blank
// page. Purely additive: wraps the route only, never touches
// ReaderPage/ChapterBlocks/AudioPlayer internals, never clears session.
import ReaderErrorBoundary from "./eduhub/pages/library/reader/ReaderErrorBoundary";
// Production-readiness audit fix: neither Video Library route had an error
// boundary above it — same reasoning/pattern as ReaderErrorBoundary above.
import VideoLibraryErrorBoundary from "./eduhub/pages/videoLibrary/VideoLibraryErrorBoundary";
// v1.3 (2026-05-23) — Smart Top-Up modal trigger. Watches route + balance
// and intelligently opens the premium Top-Up modal when a student is on a
// points-locked page (/library, /game, /assistant, /portal) with low PTS.
// Anti-spam: once per session, 7-day snooze after 3 dismissals, 800 ms
// grace after route change, manual button path unaffected. Renders no UI.
import SmartTopUpTrigger from "./eduhub/components/topup/SmartTopUpTrigger";
import PwaInstallProvider from "./eduhub/components/pwa/PwaInstallProvider";
import { AuthProvider } from "./eduhub/context/AuthContext";
// Activity Center™ — global notification state + realtime WS bridge, plus
// the slide-down ActivityDrawer opened from the header bell.
import { NotificationProvider } from "./eduhub/context/NotificationContext";
import ActivityDrawer from "./eduhub/components/activity/ActivityDrawer";
import AppBadgeSync from "./eduhub/components/activity/AppBadgeSync";
import { LanguageProvider } from "./eduhub/pages/portal/contexts/LanguageContext";

// v7 — Bell Ring onboarding (local-only, does NOT touch sw.js / VAPID / backend)
// NOTE: BellRingNagCard sits inside the nested bellring/bellring/ folder
//       in the current repo; RequireBellRing is at bellring/ root.
import RequireBellRing from "./eduhub/components/bellring/RequireBellRing";
import BellRingNagCard from "./eduhub/components/bellring/bellring/BellRingNagCard";
// Referral System v1 - lead-capture modal triggered by ?ref=<code>.
import ReferralLeadModal from "./eduhub/components/ReferralLeadModal";

// Lazy page-level components (Section 11 — performance)
const Dashboard      = lazy(() => import("./eduhub/pages/Dashboard"));
const LoginPage      = lazy(() => import("./eduhub/pages/LoginPage"));
const PortalPublic   = lazy(() => import("./eduhub/pages/portal/PortalPublic"));
const PortalMe       = lazy(() => import("./eduhub/pages/portal/PortalMe"));
const GamePublic     = lazy(() => import("./eduhub/pages/game/GamePublic"));
const GamePlay       = lazy(() => import("./eduhub/pages/game/GamePlay"));
const LibraryPage    = lazy(() => import("./eduhub/pages/library/LibraryPage"));
const ReaderPage     = lazy(() => import("./eduhub/pages/library/reader/ReaderPage"));
// Video Library — architecturally independent product per explicit product
// direction, never nested inside Books Library. The dashboard renders
// inside AppShell (same chrome every other feature page uses); the watch
// page renders OUTSIDE AppShell for a focused viewing surface, exactly
// mirroring /library/read/:slug's reasoning for ReaderPage below.
const VideoLibraryDashboard = lazy(() => import("./eduhub/pages/videoLibrary/VideoLibraryDashboard"));
const VideoLessonPlayer     = lazy(() => import("./eduhub/pages/videoLibrary/VideoLessonPlayer"));
// AI Assessment / Quiz Submission Lab — student worksheet-photo submission
// flow. Renders inside AppShell like every other feature page (no focused
// distraction-free surface needed, unlike the video watch page above).
const AssessmentsListPage = lazy(() => import("./eduhub/pages/assessments/AssessmentsListPage"));
const Assistant      = lazy(() => import("./eduhub/pages/assistant/Assistant"));
const VoiceTreasure  = lazy(() => import("./eduhub/pages/game/voice-treasure"));
const SystemTest     = lazy(() => import("./eduhub/pages/systemtest/SystemTest"));
const EventsPage     = lazy(() => import("./eduhub/pages/portal/EventsPage"));
const StudentProfilePage = lazy(() => import("./eduhub/pages/profile/StudentProfilePage"));
// v12 — Author Studio removed from app per spec (teacher-only, lives outside)
const StudioPage = lazy(() => import("./studio/StudioPage"));
const ConstellationView = lazy(() => import("./eduhub/pages/attendance/ConstellationView"));
const StudentCheckIn    = lazy(() => import("./eduhub/pages/attendance/StudentCheckIn"));
// TEMPORARY — installed-PWA stale-version investigation. Unprotected,
// diagnostic-only. Remove this import + its <Route> once the root cause is
// confirmed and fixed — see src/eduhub/lib/__pwaDiag.js.
const PwaDebugPage      = lazy(() => import("./eduhub/pages/PwaDebugPage"));
const RxpDemoPage       = lazy(() => import("./eduhub/pages/RxpDemoPage"));

function PageSkeleton() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="h-32 w-72 rounded-2xl skeleton border border-aurora-violet/30" />
    </div>
  );
}

function AppShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // v15 (EduHub Lumio): the portal owns its own slim app bar, so the
  // global Header (and desktop Footer) are hidden ONLY on /portal/me.
  // Sidebar (desktop) + MobileBottomNav still provide app navigation.
  const { pathname } = useLocation();
  const isPortalMe = pathname.startsWith("/portal/me");
  // v20 (Native Keyboard Behaviour) — the fixed bottom nav has nothing
  // useful to show once the on-screen keyboard covers that part of the
  // screen, and hiding it removes one more `position: fixed` element
  // iOS Safari could otherwise mis-position during the keyboard
  // transition. Root-level so any current or future chat-style screen
  // benefits automatically, not just the AI Assistant.
  const isKeyboardOpen = useVisualViewportKeyboard();
  return (
    // v18 — MotionConfig reducedMotion="user" gives every Framer Motion
    // animation in the shell a reduced-motion variant for free (transform
    // animations are skipped for users with prefers-reduced-motion).
    // text-ink/dark:text-white replaces the old always-white default so
    // light theme copy measures AA against the #FAFAFA body.
    <MotionConfig reducedMotion="user">
    <div className="App min-h-screen text-ink dark:text-white antialiased" style={{ overflowX: "hidden" }}>
      <ScrollProgress />
      <BackgroundFx />
      <div className="relative z-10 flex min-h-screen">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} instructorName="Daravuth Yon" />
        <div
          // v13 (Premium Native Shell) — bottom padding now factors in
          // env(safe-area-inset-bottom) so the last card on every page
          // can scroll above the bottom nav AND the iPhone home
          // indicator. lg keeps pb-0 because the bottom nav is hidden
          // on desktop. minWidth/overflowX preserved verbatim.
          // v19 — bottom padding now reads the SAME --eduhub-bottom-nav-h
          // variable every other consumer in the app already uses
          // (Assistant.jsx, VTStage.css, portal-theme.css,
          // StickyComposer.jsx) instead of a hardcoded 68px literal that
          // had silently drifted 4px from the real, shared 64px value —
          // this is exactly the kind of mismatch that lets content sit
          // partly under the fixed nav. This is a pure value fix, no
          // positioning/overflow mechanics touched.
          className="flex-1 flex flex-col min-h-screen lg:ml-[256px] pb-[calc(var(--eduhub-bottom-nav-h,64px)+env(safe-area-inset-bottom))] lg:pb-0"
          style={{ minWidth: 0, overflowX: "hidden" }}
        >
          {!isPortalMe && <Header onMenuClick={() => setSidebarOpen(true)} />}
          {isPortalMe ? (
            // Full-bleed portal surface. The portal manages its own width,
            // padding, and slim PortalAppBar. text-ink overrides the shell's
            // default text-white so cream-mode copy stays legible. Uses a div
            // (not <main>) because the portal's PageShell provides <main>.
            <div
              className="flex-1 w-full text-[color:var(--color-ink)]"
              style={{ overflowX: "hidden" }}
              data-testid="main-content"
            >
              {children}
            </div>
          ) : (
            <main
              // v16 (Premium Persistent Header) — Header is now
              // `position: fixed` (see Header.jsx for why), so it no longer
              // occupies space in normal flow. pt-3/sm:pt-5 here used to be
              // the ONLY thing separating the header from the first card;
              // now it must also reserve the header's own rendered height
              // (published live as --eduhub-header-h, since it varies with
              // the iOS safe-area inset) on top of that same breathing
              // room — same visual gap as before, just measured from the
              // top of the fixed header instead of from y=0.
              className="flex-1 w-full max-w-[1080px] mx-auto px-3 sm:px-5 pt-[calc(var(--eduhub-header-h,60px)+0.75rem)] sm:pt-[calc(var(--eduhub-header-h,60px)+1.25rem)] pb-8 sm:pb-10"
              style={{ overflowX: "hidden" }}
              data-testid="main-content"
            >
              {children}
            </main>
          )}
          {/* v14 — Footer hidden on mobile authenticated app shell.
              MobileBottomNav owns the bottom band on phones, so the
              marketing footer was creating an awkward credit strip
              sandwiched between the page content and the nav. Desktop
              keeps the full footer because MobileBottomNav is lg:hidden.
              v15 — also hidden on /portal/me (the portal has its own footer). */}
          {!isPortalMe && (
            <div className="hidden lg:block">
              <Footer />
            </div>
          )}
        </div>
      </div>
      {/* v14 — Suppress the global ScrollToTop floating button on /assistant
              so it can never visually overlap the fixed sticky composer
              dock on mobile. Every other route keeps the button. */}
      <ScrollToTopExceptAssistant />
      {/* v13 — <TelegramFab /> removed from the app shell.
              Replaced by:
                • Header: inline premium Telegram SVG (sm+)
                • Sidebar: Help & Support section with the same real link
              No other Telegram behaviour, link, or destination changes. */}
      <MobileBottomNav hidden={isKeyboardOpen} />
      <KeyboardDebugOverlay />
    </div>
    </MotionConfig>
  );
}

function ScrollToTopExceptAssistant() {
  const { pathname } = useLocation();
  // Hide the global floating scroll-to-top button on routes that own a
  // scroll-to-top control themselves. /portal/me renders its own Lumio FAB,
  // so showing the global one too would produce two overlapping controls.
  if (
    pathname &&
    (pathname.startsWith("/assistant") || pathname.startsWith("/portal/me"))
  )
    return null;
  return <ScrollToTop />;
}


// --------------------------------------------------------------------------
// Referral System v1 - parse ?ref=<code> from window.location and decide
// whether to show the lead modal. Suppressed when the visitor is already
// authenticated (presence of the student session cookie) to prevent
// self-referral. Reads sessionStorage to avoid re-prompting after dismiss.
// --------------------------------------------------------------------------
function useReferralCodeFromUrl() {
  const [code, setCode] = useState(null);
  if (typeof window !== "undefined" && code === null) {
    try {
      const url = new URL(window.location.href);
      const raw = (url.searchParams.get("ref") || "").trim().toUpperCase();
      if (raw && /^[A-Z0-9]{4,16}$/.test(raw)) {
        const dismissed = (() => {
          try { return sessionStorage.getItem("eduhub_referral_lead_dismissed_v1"); } catch { return null; }
        })();
        const loggedIn = (() => {
          try {
            const c = document.cookie || "";
            return /(?:^|;\s*)student_session=/.test(c);
          } catch { return false; }
        })();
        if (!dismissed && !loggedIn) {
          // Defer state update to the next tick to avoid render-time setState.
          setTimeout(() => setCode(raw), 0);
        }
      }
    } catch {}
  }
  return [code, () => setCode(null)];
}


function ReferralLeadModalMount() {
  const [code, clear] = useReferralCodeFromUrl();
  if (!code) return null;
  return <ReferralLeadModal code={code} onClose={clear} />;
}

export default function App() {
  return (
    <AuthProvider>
      {/* Premium UI Sound System — wires the one-time iOS/mobile audio
          unlock on the first real user gesture, app-wide. Renders no UI. */}
      <SoundUnlockProvider />
      {/* v8.4 — Background cover preloader. Mounts inside AuthProvider so
          it can read auth state. Renders no UI. Triggers once per logged-in
          identity per page lifetime, throttled to 4 concurrent fetches. */}
      <CoverPrefetcher />
      {/* v9.5 — Points-Credit Push bridge (recipient-side fallback). Lives
          here so it observes the auth state for every route, not just
          /portal/me. Renders no UI. Bails silently if push permission is
          not granted. Server-side dedupe in /api/push/notify-credit
          ensures a P2P transfer surfaces exactly ONE notification — the
          sender's modal already pushed; this bridge handles teacher
          rewards, game bonuses, and manual sheet edits. */}
      <PointsCreditPushBridge />
      {/* v9.6 — RealtimeSyncBridge (audit fix · realtime restriction +
          points propagation). Listens for EDUHUB_PUSH_SYNC messages from
          the v1.4 service worker and synthesises a visibilitychange so
          every existing poller (AuthContext restriction watchdog,
          useStudentData, usePoints) refreshes immediately. Also calls
          AuthContext.refreshPoints() so non-Portal screens (Sidebar,
          Header wallet pill, Library) update too. Includes a 20 s
          safety-net poll for long-term reliability. Renders no UI. */}
      <RealtimeSyncBridge />
      {/* v10.0 — StatusEnforcer. Polls /api/student/status/{id} every 3 s
          (when visible). On a non-active status it nudges AuthContext via
          a synthetic visibilitychange so its existing watchdog re-reads
          the GAS mirror and lights up the RestrictionGuard overlay. For
          suspended / deactivated it also force-logouts after a 6 s grace
          period as a backstop. Renders no UI. */}
      <StatusEnforcer />
      {/* v1.3 — Smart Top-Up modal trigger (route + balance aware). */}
      <SmartTopUpTrigger />
      <LanguageProvider>
        <NotificationProvider>
        <PwaInstallProvider>
        <Routes>
          {/* /login renders WITHOUT the standard shell */}
          <Route
            path="/login"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <LoginPage />
              </Suspense>
            }
          />
          {/* /studio — full-bleed Author Studio (own Google OAuth) */}
<Route
  path="/studio"
  element={
    <Suspense fallback={<PageSkeleton />}>
      <StudioPage />
    </Suspense>
  }
/>

          {/* v7.0.2 (2026-01) — Library Reader route restored.
              The 3D book reader renders OUTSIDE AppShell for a focused,
              distraction-free reading surface (no sidebar/header). This
              route was accidentally dropped during the v7 Bell Ring
              merge, which caused every book click to fall through to the
              catch-all `*` route and redirect students to the Dashboard.
              ProtectedRoute matched /library; RequireBellRing was NOT
              re-applied here because students must already pass it at
              /library to reach this URL.
              Guest reading experience — GuestAwareGate now decides whether
              ProtectedRoute/RequireBellRing apply at all: an authenticated
              student gets the exact nesting above, unchanged; a guest
              reaches ReaderPage directly. ReaderPage itself (not this
              route) decides how much of a non-free-tier book is visible —
              see its guestLocked branch. */}
          <Route
            path="/library/read/:slug"
            element={
              <ReaderErrorBoundary>
                <Suspense fallback={<PageSkeleton />}>
                  <GuestAwareGate><ReaderPage /></GuestAwareGate>
                </Suspense>
              </ReaderErrorBoundary>
            }
          />

          {/* Video Library watch page — outside AppShell for a focused,
              distraction-free viewing surface, matching /library/read/:slug's
              reasoning exactly. No guest mode: unlike Books, Video Library
              was not asked to support a guest preview experience. */}
          <Route
            path="/video-library/watch/:lessonId"
            element={
              <ProtectedRoute>
                <VideoLibraryErrorBoundary>
                  <Suspense fallback={<PageSkeleton />}>
                    <VideoLessonPlayer />
                  </Suspense>
                </VideoLibraryErrorBoundary>
              </ProtectedRoute>
            }
          />

          {/* All other routes share the AppShell */}
          <Route
            path="/*"
            element={
              <AppShell>
                <Suspense fallback={<PageSkeleton />}>
                  <Routes>
                    {/* Home — always accessible. BellRingNagCard renders here. */}
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/portal" element={<PortalPublic />} />
                    <Route
                      path="/portal/me"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><PortalMe /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/profile"
                      element={
                        <ProtectedRoute><StudentProfilePage /></ProtectedRoute>
                      }
                    />
                    <Route path="/game" element={<GamePublic />} />
                    <Route
                      path="/events"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><EventsPage /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/game/voice-treasure/*"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><VoiceTreasure /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/game/play"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><GamePlay /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    {/* Guest reading experience — /library is now the
                        public discovery surface (see GuestAwareGate). An
                        authenticated student gets the exact
                        ProtectedRoute/RequireBellRing nesting as before. */}
                    <Route
                      path="/library"
                      element={
                        <GuestAwareGate><LibraryPage /></GuestAwareGate>
                      }
                    />
                    {/* Video Library — its own standalone destination, a
                        sibling of Books Library under the Learning
                        ecosystem, never mounted beside/inside it. */}
                    <Route
                      path="/video-library"
                      element={
                        <ProtectedRoute>
                          <VideoLibraryErrorBoundary>
                            <RequireBellRing><VideoLibraryDashboard /></RequireBellRing>
                          </VideoLibraryErrorBoundary>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/assessments"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><AssessmentsListPage /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/assistant"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><Assistant /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    {/* TEMPORARY diagnostic route — see __pwaDiag.js */}
                    <Route path="/__pwa-debug" element={<PwaDebugPage />} />
                    {/* Reward Experience Engine verification harness (presentation only) */}
                    <Route path="/__rxp-demo" element={<RxpDemoPage />} />
                    <Route
                      path="/systemtest"
                      element={
                        <ProtectedRoute>
                          <RequireBellRing><SystemTest /></RequireBellRing>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/attendance"
                      element={
                        <ProtectedRoute><RequireBellRing><ConstellationView /></RequireBellRing></ProtectedRoute>
                      }
                    />
                    <Route
                      path="/attendance/j/:slug"
                      element={<StudentCheckIn />}
                    />
                    <Route path="*" element={<Dashboard />} />
                  </Routes>
                </Suspense>
              </AppShell>
            }
          />
        </Routes>
        {/* App-wide restriction guard — overlays every route the moment
            AuthContext sees Restriction=TRUE for the logged-in student. */}
        <RestrictionGuard />
        {/* v7.9.10 — Smart bilingual announcement popup. Renders ONCE per
            browser session as soon as the live config has messages. */}
        <AnnouncementPopup />
        {/* v11.0 — Login Reward Campaign popup. Backend-authoritative; only
            shows when /api/rewards/login-campaigns/active returns a campaign
            the student is eligible for. Fully fail-safe: silent on error. */}
        <LoginRewardPopup />
        {/* v12.0 — Login Mystery Box Rewards. Backend-authoritative; only
            shows when /api/student/login-mystery/status returns an active
            eligible campaign. Fully fail-safe: silent on error. */}
        <LoginMysteryBoxPopup />
        {/* v7 — Bell Ring nag card. Renders only on "/" when permission
            is not yet granted. Clicking it opens the BellRingGate overlay. */}
        <BellRingNagCard />
        {/* Referral System v1 - lead-capture modal (no public signup). */}
        <ReferralLeadModalMount />
        {/* Activity Center™ — slide-down drawer (opens from the header bell). */}
        <ActivityDrawer />
        {/* Unified badge platform — syncs the OS Home Screen app icon badge
            (Badging API) to the same unread total the bell/drawer show.
            Renders nothing; no-ops on unsupported browsers/platforms. */}
        <AppBadgeSync />
        </PwaInstallProvider>
        </NotificationProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
