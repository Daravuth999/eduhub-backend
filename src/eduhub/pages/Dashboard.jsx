// Dashboard.jsx — public landing (/).
//
// Home Dashboard V4 — Phase 3 reconstruction (flat, mobile-first, matches
// the approved mockup). Replaces the V3 "One Floating Learning World"
// (DashboardWorld/ZoneRaft/GlassPane — one continuous dark ambient canvas)
// with a plain stacked-card layout, per the approved Dashboard
// Reconstruction Blueprint §2: the ambient world and the mockup's flat
// light cards are different rendering models, not restyle variants of
// each other, so this is the one deliberate "replace" in the whole
// reconstruction. `components/dashboard/world/` is left on disk unused
// (same rollback-safety convention this codebase already uses for
// HomeTodayZone.jsx). Note: the V3-era `DashboardEnvironmentStudio.jsx`
// Author Studio panel (which had rendered `EnvironmentCanvas` directly,
// independent of this page) was already removed from master by a revert
// predating this project — its absence is unrelated to this reconstruction.
//
// PRESENTATION-ONLY reconstruction: every data source is the exact hook
// it was before (useDashboardBootstrap, useAttendance, useAuth,
// usePushNotifications, the Experience Config Platform). Two components
// this page used to render directly — Hero.jsx and TopEarnerPanel.jsx —
// are LEFT UNTOUCHED because Author Studio's WelcomeExperienceStudio and
// AchievementExperienceStudio import them directly for live preview;
// restyling them in place would silently change Author Studio's own UI,
// which is out of scope here. New sibling components (MissionHero,
// MyRankCard) read the identical resolved config/hook data instead.
//
// "Today's Discovery" (DiscoveryCard.jsx) is a NEW `daily_discovery`
// experienceType on the existing Experience Config Platform — required
// zero platform changes (an unregistered type already falls back to the
// generic empty default, same as `promotional_banner`). It renders
// nothing until a real config is published; Author Studio has no panel
// for it yet (explicitly scoped as the next Dashboard-related task).
//
// "Recent Achievements" (RecentAchievements.jsx) reuses the SAME
// useNotifications() feed LiveActivityStrip/CathyAssistant already read,
// filtered to the notification system's existing `priority==="achievement"`
// value (already a first-class field, already styled in activityTheme.js)
// — not a new subsystem. Whether the backend ever actually emits that
// priority could not be verified from this frontend-only repo; the
// component simply renders nothing if it never does, same as every other
// real-data-only widget here.
//
// Still NOT present: a live "N students studying now" count — no such
// capability is verified to exist anywhere in this codebase or its
// (inaccessible-from-here) backend, and nothing analogous to extend.
//
// LottieTileGrid / LibraryShowcase are retired from THIS page only (their
// routes remain fully reachable via the bottom nav + Sidebar, unchanged);
// both files are left on disk, unused, for rollback safety.
import MissionHero from "../components/dashboard/MissionHero";
import DashboardHeader from "../components/dashboard/DashboardHeader";
import ActivityPanel from "../components/dashboard/ActivityPanel";
import ContinueLearningShelf from "../components/dashboard/ContinueLearningShelf";
import DiscoveryCard from "../components/dashboard/DiscoveryCard";
import CommunityPulse from "../components/dashboard/CommunityPulse";
import LearningProgress from "../components/dashboard/LearningProgress";
import AssessmentPendingCard from "../components/dashboard/AssessmentPendingCard";
import RecentAchievements from "../components/dashboard/RecentAchievements";
import CrossfadeSwap from "../components/dashboard/CrossfadeSwap";
import PublicLibraryShelf from "../components/dashboard/PublicLibraryShelf";

import { motion } from "framer-motion";
import useDashboardBootstrap from "../hooks/useDashboardBootstrap";
import usePushNotifications from "../hooks/usePushNotifications";
import { useAuth } from "../context/AuthContext";
import { sectionRhythm } from "../styles/tokens/designTokens";
import { easing, duration, stagger } from "../styles/tokens/motionTokens";
import PushOptInPrompt from "../components/PushOptInPrompt";
// Promotion Experience Studio (Phase 1-5) — PromotionPanel falls back to
// rendering ArtworkCarousel/ArtworkDefaultHero internally (unchanged)
// whenever no promotional_banner config has been published yet. Reused
// completely as-is per the blueprint (§2: "Keep unchanged") — only its
// position in the page moves, to match the mockup's bottom-of-page
// "Top Up Bonus" placement.
import PromotionPanel from "../components/PromotionPanel";
// Tuition Reminder Overlay — shown when student is authed and tuition is overdue/due-soon.
import TuitionReminderOverlay from "./portal/components/dashboard/TuitionReminderOverlay";
// Activity Center™ — Cathy assistant surface (real events only, unchanged).
import CathyAssistant from "../components/activity/CathyAssistant";

// Section rhythm — the platform's named vertical-gap scale
// (designTokens.sectionRhythm), applied here at the ZONE WRAPPER level per
// that token file's own documented contract ("a zone wrapper uses BETWEEN
// its children — never a child's own margin"). Replaces the ad hoc
// mt-3/mt-5 Tailwind values this page used to scatter across its child
// components; each child component now owns zero top margin of its own.
// RC2.5 Motion System — §11 Page Load Experience: each top-level Dashboard
// section fades/settles in slightly after the one before it (Header ->
// Hero -> Announcement -> Continue Learning -> Discovery -> Community ->
// Achievements -> Promotion), via `index`. A single one-shot entrance per
// section, not a loop — no ongoing performance cost, no
// useAmbientActive() gating needed (that hook is for continuous ambient
// effects; this is a normal framer-motion mount animation, already
// covered by the shell's MotionConfig reducedMotion="user").
function Section({ rhythm = "primary", index = 0, className = "", children }) {
  return (
    <motion.div
      className={className}
      style={{ marginTop: `${sectionRhythm[rhythm]}rem` }}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.base, delay: index * stagger.section, ease: easing.premiumEaseOut }}
    >
      {children}
    </motion.div>
  );
}

export default function Dashboard() {
  // Dashboard Bootstrap — coordinates all five startup resources (Welcome
  // Experience, Artwork Campaign, Activity Feed, Announcements,
  // Notification summary). The hook itself is UNCHANGED by RC2.9 (still
  // fetches/coordinates all five internally) — this page simply no longer
  // consumes the `eduhub`/`announcement` resources now that
  // AnnouncementStrip has been removed (RC2.9 §1) in favor of
  // ActivityTimeline, which reads useNotifications() directly instead.
  const { welcome, promotion, welcomeKey, promotionKey, artworkKey } = useDashboardBootstrap();
  const welcomeExperience = welcome.config;
  // promotional_banner has no entry in experienceDefaults.js, so
  // promotion.config is ALWAYS a truthy (but empty) object even when
  // nothing has been published — only hand PromotionPanel a config once
  // the resolver confirms it's actually published.
  const promotionExperience = promotion.source === "published" ? promotion.config : null;
  const promotionCrossfadeKey = promotionExperience ? promotionKey : artworkKey;
  const { student, isBootstrapping } = useAuth() || {};
  usePushNotifications(student?.studentId, student?.group || student?.batch || "default");
  const isAuthed = Boolean(student?.studentId);

  return (
    <>
      <div className="max-w-lg mx-auto pb-6" data-testid="dashboard-flat-shell">
        {/* Choreography index 0 — entrance only, no top margin (Header is
            the page's first element; it owns its own pt-3/pb-1 padding). */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.base, ease: easing.premiumEaseOut }}
        >
          <DashboardHeader />
        </motion.div>

        {/* HOTFIX (Aug 2026) — bootstrap-window regression, root-caused via
            direct git-diff audit (same class of bug as GuestAwareGate.jsx,
            see its header comment for the full mechanism). `isAuthed` reads
            `false` for EVERY visitor — guest and already-logged-in student
            alike — until AuthContext's mount-time session-restore round-trip
            resolves (`isBootstrapping`). This is the single most-visited
            route in the app (Home), so an authenticated student landing
            here — including every PWA cold-start where the local session
            cache is empty but the server session is still valid — briefly
            rendered the ENTIRE guest content column (PublicLibraryShelf,
            compact MissionHero, no Learning Progress/Continue Learning/
            Activity/Achievements/Promotion) and then had the WHOLE thing
            torn down and remounted the instant bootstrap resolved. From the
            student's perspective this looked exactly like "I got logged
            out" / "I became a guest" for a moment, discarded any in-flight
            state, and replayed every section's own mount-time work.
            Holding briefly here (matching ProtectedRoute.jsx's own
            established convention) costs a true guest nothing extra — the
            bootstrap window resolves quickly with no session to find either
            way — and guarantees the eventual branch is chosen exactly once. */}
        {isBootstrapping ? null : isAuthed ? (
          <>
            <Section rhythm="tight" index={1}>
              <CrossfadeSwap dataKey={welcomeKey}>
                <MissionHero config={welcomeExperience} />
              </CrossfadeSwap>
            </Section>

            <CathyAssistant />

            {/* RC3 §2 — Learning Progress moves up directly under Hero, per
                the corrected information hierarchy ("How am I doing?" answered
                immediately, not buried below a large activity feed). */}
            <Section rhythm="primary" index={2}><LearningProgress /></Section>

            {/* "What do I need to do today?" — the Dashboard's contextual
                shortcut into the Assessment Lab; the Sidebar's own
                "Assessments" entry answers "Where are my tests?" instead
                (see the discoverability directive this pairs with).
                Renders nothing when there's no pending assessment. */}
            <Section rhythm="tight" index={2}><AssessmentPendingCard /></Section>

            <Section rhythm="primary" index={3}><ContinueLearningShelf /></Section>

            <Section rhythm="primary" index={4}><DiscoveryCard /></Section>

            <Section rhythm="primary" index={5}><CommunityPulse /></Section>

            {/* RC3 §1 — ActivityPanel replaces ActivityTimeline.jsx's large
                inbox-style feed with a compact, single-item rotating preview;
                see that file's own header for the full reasoning. Moved down
                in the hierarchy per RC3 §2 (no longer the dominant section). */}
            <Section rhythm="primary" index={6}><ActivityPanel /></Section>

            <Section rhythm="primary" index={7}><RecentAchievements /></Section>

            <Section rhythm="pause" index={8} className="px-4">
              <CrossfadeSwap dataKey={promotionCrossfadeKey}>
                <PromotionPanel promotionConfig={promotionExperience} />
              </CrossfadeSwap>
            </Section>
          </>
        ) : (
          <>
            {/* "Read Before You Sign In" — a guest's Home is a fast on-ramp
                into a real, free book, not a feed describing the platform.
                A real book shelf leads; the identity hero is demoted to a
                slim secondary strip (tight rhythm, no dominant top billing);
                Discovery/Community stay as secondary, honestly-empty-capable
                touches. LearningProgress/ContinueLearningShelf/ActivityPanel/
                RecentAchievements are all authenticated-only (they already
                render nothing for a guest) and PromotionPanel carries a
                monetary CTA a guest can't act on — none of the five are
                mounted at all for a guest, rather than mounting them to
                render null. */}
            <Section rhythm="primary" index={1}>
              <PublicLibraryShelf />
            </Section>

            <Section rhythm="tight" index={2}>
              <CrossfadeSwap dataKey={welcomeKey}>
                <MissionHero config={welcomeExperience} compact />
              </CrossfadeSwap>
            </Section>

            <Section rhythm="primary" index={3}><DiscoveryCard /></Section>

            <Section rhythm="primary" index={4}><CommunityPulse /></Section>
          </>
        )}
      </div>

      {/* Overlays keep their existing behaviour — viewport-level, not
          page-level. */}
      {isAuthed && (
        <PushOptInPrompt
          studentId={student.studentId}
          group={student.group || student.batch}
        />
      )}

      {/* Tuition reminder — slides in from bottom when overdue or due ≤7 days */}
      <TuitionReminderOverlay isAuthed={isAuthed} />
    </>
  );
}
