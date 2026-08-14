/**
 * dashboardWorldWiring.test.js — Home Dashboard V4 composition contract.
 *
 * SUPERSEDES the V3 assertions this file used to make (DashboardWorld /
 * ZoneRaft / GlassPane spanning the whole scroll). Phase 3's approved
 * Dashboard Reconstruction Blueprint calls the ambient dark "world" and
 * the approved mockup's flat light layout different rendering models —
 * not restyle variants of one another — so V4 replaces the wrapper
 * entirely instead of reskinning it (see Dashboard.jsx's own header
 * comment for the full reasoning). This file re-asserts the SAME kind of
 * underlying facts against the new flat composition:
 *   • every real-data widget still renders, with the same props;
 *   • the Dashboard Bootstrap + CrossfadeSwap contracts are untouched;
 *   • RC2.9: AnnouncementStrip was explicitly removed and replaced by
 *     ActivityTimeline (own real data source, useNotifications()) — see
 *     Dashboard.jsx's inline comment and ActivityTimeline.jsx's header;
 *   • RC3: ActivityTimeline's large inbox-style feed was itself replaced
 *     by the compact, single-item ActivityPanel, and the section order
 *     was corrected (Learning Progress moved up under Hero) — see
 *     ActivityPanel.jsx's header;
 *   • Hero.jsx and TopEarnerPanel.jsx are NOT imported by this page
 *     anymore (Author Studio's live-preview panels import them directly,
 *     and must keep seeing the untouched originals — see MissionHero.jsx
 *     / MyRankCard.jsx header comments);
 *   • overlays still mount outside the main content column.
 */
import fs from "fs";
import path from "path";

const DASHBOARD = fs.readFileSync(path.join(__dirname, "..", "Dashboard.jsx"), "utf8");

describe("Home Dashboard V4 no longer wraps content in the ambient world", () => {
  test("does not import DashboardWorld/ZoneRaft/GlassPane", () => {
    expect(DASHBOARD).not.toMatch(/from ["']\.\.\/components\/dashboard\/world["']/);
    expect(DASHBOARD).not.toContain("<DashboardWorld>");
    expect(DASHBOARD).not.toContain("<ZoneRaft");
    expect(DASHBOARD).not.toContain("<GlassPane");
  });

  test("does not import Hero.jsx or TopEarnerPanel.jsx directly (Author Studio owns those previews)", () => {
    expect(DASHBOARD).not.toMatch(/import Hero from/);
    expect(DASHBOARD).not.toMatch(/import TopEarnerPanel from/);
  });

  test("uses the new Dashboard-owned presentation components instead", () => {
    expect(DASHBOARD).toMatch(/import MissionHero from ["']\.\.\/components\/dashboard\/MissionHero["']/);
    expect(DASHBOARD).toMatch(/import DashboardHeader from ["']\.\.\/components\/dashboard\/DashboardHeader["']/);
    expect(DASHBOARD).toMatch(/import ContinueLearningShelf from ["']\.\.\/components\/dashboard\/ContinueLearningShelf["']/);
    expect(DASHBOARD).toMatch(/import DiscoveryCard from ["']\.\.\/components\/dashboard\/DiscoveryCard["']/);
    expect(DASHBOARD).toMatch(/import CommunityPulse from ["']\.\.\/components\/dashboard\/CommunityPulse["']/);
    expect(DASHBOARD).toMatch(/import LearningProgress from ["']\.\.\/components\/dashboard\/LearningProgress["']/);
    expect(DASHBOARD).toMatch(/import RecentAchievements from ["']\.\.\/components\/dashboard\/RecentAchievements["']/);
  });
});

// "Read Before You Sign In" — Dashboard.jsx now branches its whole content
// column on `isAuthed`. Split the source at that branch point so the two
// hierarchies (authenticated vs. guest) can be asserted independently
// instead of assuming one single linear flow, which stopped being true the
// moment guest mode got its own reordered, shorter hierarchy.
const authedBranch = DASHBOARD.slice(DASHBOARD.indexOf("isAuthed ? ("), DASHBOARD.indexOf(") : ("));
const guestBranch = DASHBOARD.slice(DASHBOARD.indexOf(") : ("), DASHBOARD.indexOf("      </div>"));

describe("every real-data widget is preserved, with unchanged props", () => {
  test("MissionHero receives the resolved welcome config behind its crossfade, same as Hero.jsx did (both branches)", () => {
    expect(DASHBOARD).toMatch(/<CrossfadeSwap dataKey=\{welcomeKey\}>[\s\S]*?<MissionHero config=\{welcomeExperience\}[\s /]*\/>[\s\S]*?<\/CrossfadeSwap>/);
  });

  test("PromotionPanel keeps its exact prop and crossfade contract, just repositioned", () => {
    expect(DASHBOARD).toMatch(/<PromotionPanel promotionConfig=\{promotionExperience\} \/>/);
    expect(DASHBOARD).toMatch(/<CrossfadeSwap dataKey=\{promotionCrossfadeKey\}>/);
  });

  test("RC2.9/RC3: AnnouncementStrip and ActivityTimeline are gone, ActivityPanel renders in their place", () => {
    expect(DASHBOARD).not.toMatch(/<AnnouncementStrip/);
    expect(DASHBOARD).not.toMatch(/import AnnouncementStrip/);
    expect(DASHBOARD).not.toMatch(/<ActivityTimeline/);
    expect(DASHBOARD).not.toMatch(/import ActivityTimeline/);
    expect(DASHBOARD).toMatch(/import ActivityPanel from ["']\.\.\/components\/dashboard\/ActivityPanel["']/);
    expect(DASHBOARD).toMatch(/<ActivityPanel \/>/);
  });

  test("CathyAssistant is rendered only in the authenticated branch, never for guests", () => {
    expect(authedBranch).toMatch(/<CathyAssistant \/>/);
    expect(guestBranch).not.toMatch(/<CathyAssistant/);
  });

  test("LearningProgress, ContinueLearningShelf, ActivityPanel, RecentAchievements and PromotionPanel are authenticated-only — not mounted at all for a guest (the monetary/personal-data sections)", () => {
    expect(authedBranch).toMatch(/<LearningProgress \/>/);
    expect(authedBranch).toMatch(/<ContinueLearningShelf \/>/);
    expect(authedBranch).toMatch(/<ActivityPanel \/>/);
    expect(authedBranch).toMatch(/<RecentAchievements \/>/);
    expect(authedBranch).toMatch(/<PromotionPanel /);
    expect(guestBranch).not.toMatch(/<LearningProgress/);
    expect(guestBranch).not.toMatch(/<ContinueLearningShelf/);
    expect(guestBranch).not.toMatch(/<ActivityPanel/);
    expect(guestBranch).not.toMatch(/<RecentAchievements/);
    expect(guestBranch).not.toMatch(/<PromotionPanel/);
  });

  test("DiscoveryCard and CommunityPulse render in BOTH branches (public, honestly-empty-capable content)", () => {
    expect(authedBranch).toMatch(/<DiscoveryCard \/>/);
    expect(authedBranch).toMatch(/<CommunityPulse \/>/);
    expect(guestBranch).toMatch(/<DiscoveryCard \/>/);
    expect(guestBranch).toMatch(/<CommunityPulse \/>/);
  });

  test("guest branch mounts PublicLibraryShelf and a compact MissionHero — the 'Read Before You Sign In' entry point", () => {
    expect(DASHBOARD).toMatch(/import PublicLibraryShelf from ["']\.\.\/components\/dashboard\/PublicLibraryShelf["']/);
    expect(guestBranch).toMatch(/<PublicLibraryShelf \/>/);
    expect(guestBranch).toMatch(/<MissionHero config=\{welcomeExperience\} compact \/>/);
    expect(authedBranch).not.toMatch(/<PublicLibraryShelf/);
    expect(authedBranch).toMatch(/<MissionHero config=\{welcomeExperience\} \/>/);
    expect(authedBranch).not.toMatch(/<MissionHero config=\{welcomeExperience\} compact/);
  });

  test("reading order (authenticated): Header -> Mission -> Learning Progress -> Continue Learning -> Discovery -> Community -> Activity Panel -> Achievements -> Promotion", () => {
    const seq = [
      "<DashboardHeader", "<MissionHero ", "<LearningProgress",
      "<ContinueLearningShelf", "<DiscoveryCard", "<CommunityPulse",
      "<ActivityPanel", "<RecentAchievements", "<PromotionPanel ",
    ].map((token) => DASHBOARD.indexOf(token));
    seq.forEach((p) => expect(p).toBeGreaterThan(-1));
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });

  test("reading order (guest): Header -> PublicLibraryShelf -> Mission (compact) -> Discovery -> Community", () => {
    const seq = [
      guestBranch.indexOf("<PublicLibraryShelf"),
      guestBranch.indexOf("<MissionHero "),
      guestBranch.indexOf("<DiscoveryCard"),
      guestBranch.indexOf("<CommunityPulse"),
    ];
    seq.forEach((p) => expect(p).toBeGreaterThan(-1));
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(DASHBOARD.indexOf("<DashboardHeader")).toBeLessThan(DASHBOARD.indexOf("isAuthed ? ("));
  });

  test("overlays still mount outside the main content column", () => {
    const after = DASHBOARD.slice(DASHBOARD.indexOf('data-testid="dashboard-flat-shell"'));
    const shellClose = after.indexOf("</div>\n\n      {/* Overlays");
    expect(shellClose).toBeGreaterThan(-1);
    const afterShell = DASHBOARD.slice(DASHBOARD.indexOf("{/* Overlays"));
    expect(afterShell).toMatch(/<PushOptInPrompt/);
    expect(afterShell).toMatch(/<TuitionReminderOverlay isAuthed=\{isAuthed\} \/>/);
  });
});

describe("protected contracts are untouched", () => {
  test("useDashboardBootstrap itself is still called with no arguments — RC2.9 only stops consuming eduhub/announcement now that AnnouncementStrip is gone", () => {
    expect(DASHBOARD).toMatch(/= useDashboardBootstrap\(\);/);
    expect(DASHBOARD).toMatch(
      /const \{ welcome, promotion, welcomeKey, promotionKey, artworkKey \} = useDashboardBootstrap\(\);/,
    );
  });

  test("the promotion published-vs-legacy fallback rule is unchanged", () => {
    expect(DASHBOARD).toMatch(/const promotionExperience = promotion\.source === "published" \? promotion\.config : null;/);
    expect(DASHBOARD).toMatch(/const promotionCrossfadeKey = promotionExperience \? promotionKey : artworkKey;/);
  });

  test("auth/push hooks are still wired exactly as before", () => {
    expect(DASHBOARD).toMatch(/usePushNotifications\(student\?\.studentId, student\?\.group \|\| student\?\.batch \|\| "default"\)/);
    expect(DASHBOARD).toMatch(/const isAuthed = Boolean\(student\?\.studentId\);/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   Hotfix — bootstrap-window regression (Aug 2026)

   Root cause (confirmed via git-diff audit, not guessed — same class of
   bug found and fixed in GuestAwareGate.jsx, see its header comment for
   the full mechanism): `isAuthed` reads `false` for EVERY visitor — guest
   and already-logged-in student alike — until AuthContext's session-
   restore round-trip resolves (`isBootstrapping`). Home (`/`) is the most-
   visited route in the app, so an authenticated student landing here —
   including every PWA cold-start where the local session cache is empty
   but the server session is still valid — briefly rendered the entire
   guest content column, then had the whole thing torn down and remounted
   the instant bootstrap resolved: LearningProgress/ContinueLearningShelf/
   ActivityPanel/RecentAchievements/PromotionPanel all mount fresh, discard
   any state, and replay their own mount-time work. This pins the fix: the
   branch must be chosen exactly once, after bootstrap settles.
   ═══════════════════════════════════════════════════════════════════════ */
describe("Bootstrap-window hold (prevents the guest/authenticated remount regression)", () => {
  test("destructures isBootstrapping from useAuth()", () => {
    expect(DASHBOARD).toMatch(/const \{ student, isBootstrapping \} = useAuth\(\) \|\| \{\};/);
  });

  test("holds on isBootstrapping BEFORE the isAuthed branch is chosen — neither branch mounts during bootstrap", () => {
    expect(DASHBOARD).toMatch(/\{isBootstrapping \? null : isAuthed \? \(/);
  });

  test("the bootstrap hold sits ahead of both branches in source order", () => {
    const holdIdx = DASHBOARD.indexOf("isBootstrapping ? null : isAuthed ? (");
    const publicShelfIdx = DASHBOARD.indexOf("<PublicLibraryShelf");
    const learningProgressIdx = DASHBOARD.indexOf("<LearningProgress");
    expect(holdIdx).toBeGreaterThan(-1);
    expect(holdIdx).toBeLessThan(publicShelfIdx);
    expect(holdIdx).toBeLessThan(learningProgressIdx);
  });

  test("DashboardHeader still renders unconditionally, ahead of the bootstrap hold (no delay to the page's first element)", () => {
    const headerIdx = DASHBOARD.indexOf("<DashboardHeader");
    const holdIdx = DASHBOARD.indexOf("isBootstrapping ? null : isAuthed ? (");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(holdIdx);
  });
});
