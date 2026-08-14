/**
 * StudioPage — main Author Studio shell with tabs + auth gate.
 */
import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { motion, MotionConfig, AnimatePresence, useReducedMotion } from "framer-motion";
import { easing, duration, spring } from "../eduhub/styles/tokens/motionTokens";
import StudioCommandPalette from "./StudioCommandPalette";
import StudioHome from "./StudioHome";
import { studioSafeAreaTop } from "./safeArea";
import useWorkflowMemory, { getLastVisitedTab } from "./hooks/useWorkflowMemory";
import { LogIn, LogOut, PenSquare, Sparkles, Upload, Library, Eye, ShieldAlert, Bell, GraduationCap, Tag, CalendarClock, Wallet, Wand2, BrainCircuit, Gift, Bot, Boxes, Gamepad2, Image as ImageIcon, CalendarCheck, Factory, Sunrise, Trophy, Megaphone, PartyPopper, Settings, BookOpen, BellRing, Activity, Radio, Coins, LayoutDashboard, Medal, Receipt, Home as HomeIcon, TrendingUp, MoreHorizontal, X as CloseIcon, Video, ClipboardList } from "lucide-react";
import { StudioAuthProvider, useStudioAuth, useStudioCallback } from "./StudioAuth";
import StudioEditor from "./StudioEditor";
import StudioSmartPaste from "./StudioSmartPaste";
import StudioUpload from "./StudioUpload";
import StudioBrowse from "./StudioBrowse";
import StudioPreview from "./StudioPreview";
import PushStudio from "./PushStudio";
import TeacherStudio from "./TeacherStudio";
import CouponStudio from "./CouponStudio";
import TuitionReminderStudio from "./TuitionReminderStudio";
import ReceiptManagementStudio from "./ReceiptManagementStudio";
import PaymentStudio from "./PaymentStudio";
import AiSceneBuilder from "./AiSceneBuilder";
import AiToolsStudio from "./AiToolsStudio";
import AiAssistantStudio from "./AiAssistantStudio";
import LoginRewardStudio from "./LoginRewardStudio";
import MysteryBoxStudio from "./MysteryBoxStudio";
import LoginMysteryStudio from "./LoginMysteryStudio";
import ReferralConfig from "./ReferralConfig";
import VoiceTreasureStudio from "./VoiceTreasureStudio";
import ArtworkCampaignStudio from "./ArtworkCampaignStudio";
import AttendanceStudio from "./AttendanceStudio";
import AssessmentReviewStudio from "./AssessmentReviewStudio";
import WelcomeExperienceStudio from "./WelcomeExperienceStudio";
import AchievementExperienceStudio from "./AchievementExperienceStudio";
import TrophyAchievementStudio from "./TrophyAchievementStudio";
import PromotionExperienceStudio from "./PromotionExperienceStudio";
// Note: the V3 "Home Dashboard — dashboard_environment" panel
// (DashboardEnvironmentStudio.jsx) was removed from master by a revert
// predating this Dashboard Reconstruction project (see
// docs/implementation/dashboard-reconstruction-handover.md's merge notes)
// — its file no longer exists, so its tab/import are not restored here.
// Dashboard Studio — the scalable framework future Dashboard experience
// types (starting with Today's Discovery) live inside. Generic over
// dashboardExperienceRegistry.js; adding a future type never means adding
// another StudioPage tab.
import DashboardStudio from "./DashboardStudio";
import EventTemplatesStudio from "./EventTemplatesStudio";
import PlatformConfigStudio from "./PlatformConfigStudio";
import QuestionBankStudio from "./QuestionBankStudio";
import NotificationPacksStudio from "./NotificationPacksStudio";
import RuntimeDashboardStudio from "./RuntimeDashboardStudio";
import AnnouncementsStudio from "./AnnouncementsStudio";
import PrizePoolStudio from "./PrizePoolStudio";
import "../eduhub/pages/library/library-theme.css";

// Book Factory (Phase 1) — the FIRST tab to break the eager-import pattern.
// Its bundle is code-split via React.lazy and loads only when the tab is
// actually selected. The lightweight status client is imported statically and
// does NOT pull in the lazy chunk.
import { getStatus as getBookFactoryStatus } from "./bookFactory/bookFactoryApi";
const BookFactoryStudio = lazy(() => import("./bookFactory/BookFactoryStudio"));

// Video Factory — Video Library's production hub. A SIBLING of Book
// Factory under Authors Studio (product direction: "Factories, not parent/
// child"), not nested inside it and not sharing its status-gate — Video
// Library has no partial-readiness Gemini/cover concerns to gate on, so
// unlike Book Factory it is always visible once a Studio session exists,
// matching every other non-Book-Factory tab in this file.
const VideoFactoryStudio = lazy(() => import("./videoFactory/VideoFactoryStudio"));

export default function StudioPage() {
  return (
    <StudioAuthProvider>
      {/* Studio OS Phase 0 — brings /studio inside the same reduced-motion
          scope the rest of the app already gets from App.js's own
          MotionConfig (Studio is a sibling route to AppShell, not nested
          inside it, so it previously had none). Purely additive: every
          Framer Motion animation already in this file (e.g. the loading
          spinner below) now respects prefers-reduced-motion for free. */}
      <MotionConfig reducedMotion="user">
        <StudioInner />
      </MotionConfig>
    </StudioAuthProvider>
  );
}

function StudioInner() {
  useStudioCallback();
  const { user, loading, signIn, signOut } = useStudioAuth();

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center text-parchment"
           style={{ background: "radial-gradient(circle at 30% 20%, #2D1F3E 0%, #0d0a16 75%)" }}
           data-testid="studio-loading">
        <div className="flex flex-col items-center gap-3">
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                      className="h-10 w-10 rounded-full border-2 border-gold/30 border-t-gold" />
          <p className="text-[12px] uppercase tracking-[0.25em] text-faded">Preparing the studio</p>
        </div>
      </div>
    );
  }

  if (!user) return <StudioLogin onSignIn={signIn} />;
  if (!user.is_admin) return <StudioDenied user={user} onSignOut={signOut} />;

  return <StudioDashboard user={user} onSignOut={signOut} />;
}

function StudioLogin({ onSignIn }) {
  return (
    <div className="min-h-screen grid place-items-center px-6 text-parchment"
         style={{ background: "radial-gradient(circle at 30% 20%, #2D1F3E 0%, #0d0a16 75%)" }}
         data-testid="studio-login">
      <div className="max-w-[420px] w-full rounded-3xl border border-gold/25 p-8 text-center"
           style={{ background: "rgba(20,14,32,0.72)", backdropFilter: "blur(10px)" }}>
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl"
             style={{ background: "linear-gradient(150deg, #2D1F3E 0%, #1A1420 100%)", boxShadow: "inset 0 1px 0 rgba(212,168,67,0.18)" }}>
          <PenSquare className="h-6 w-6 text-gold" />
        </div>
        <h1 className="font-display text-2xl mb-1">Author Studio</h1>
        <p className="text-[12px] text-faded mb-6">
          Sign in with Google to create and manage Library content.
        </p>
        <button onClick={onSignIn} data-testid="studio-signin-btn"
                className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3 text-[13px] font-bold uppercase tracking-wider text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
          <LogIn className="h-4 w-4" /> Continue with Google
        </button>
        <p className="mt-4 text-[10.5px] text-faded leading-relaxed">
          Only allow-listed accounts can author books.
          Your session is stored in a secure cookie for 7 days.
        </p>
      </div>
    </div>
  );
}

function StudioDenied({ user, onSignOut }) {
  return (
    <div className="min-h-screen grid place-items-center px-6 text-parchment"
         style={{ background: "radial-gradient(circle at 30% 20%, #2D1F3E 0%, #0d0a16 75%)" }}
         data-testid="studio-denied">
      <div className="max-w-[460px] w-full rounded-3xl border border-red-400/30 p-8"
           style={{ background: "rgba(30,10,20,0.72)", backdropFilter: "blur(10px)" }}>
        <ShieldAlert className="h-7 w-7 text-red-300" />
        <h1 className="font-display text-2xl mt-3 mb-1">Access denied</h1>
        <p className="text-[13px] text-faded mb-5">
          <span className="text-parchment">{user.email}</span> is not on the studio
          admin allowlist. Ask the site owner to add your email to
          <code className="mx-1 text-gold">STUDIO_ADMIN_EMAILS</code>.
        </p>
        <button onClick={onSignOut} data-testid="studio-signout-denied"
                className="inline-flex items-center gap-2 rounded-full border border-parchment/25 bg-walnut/70 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>
    </div>
  );
}

const TABS = [
  { key: "artwork",     label: "Artwork",     Icon: ImageIcon },
  { key: "editor",      label: "Editor",      Icon: PenSquare },
  { key: "smart",       label: "Smart paste", Icon: Sparkles },
  { key: "upload",      label: "Upload",      Icon: Upload },
  { key: "browse",      label: "Browse",      Icon: Library },
  { key: "preview",     label: "Preview",     Icon: Eye },
  { key: "aiscene",     label: "AI Scene",    Icon: Wand2 },
  { key: "aitools",     label: "AI Tools",    Icon: BrainCircuit },
  { key: "aiassistant", label: "AI Assistant", Icon: Bot },
  { key: "push",        label: "Push",        Icon: Bell },
  { key: "teacher",     label: "Students",    Icon: GraduationCap },
  { key: "coupons",     label: "Coupons",     Icon: Tag },
  { key: "rewards",     label: "Login Rewards", Icon: Gift },
  { key: "mysterybox",  label: "Mystery Box",   Icon: Boxes },
  { key: "loginmystery", label: "Login Mystery", Icon: Boxes },
  { key: "tuition",     label: "Tuition",     Icon: CalendarClock },
  { key: "receipts",    label: "Receipts",    Icon: Receipt },
  { key: "payments",    label: "Payments",    Icon: Wallet },
  { key: "referral",    label: "Referral",    Icon: Gift },
  { key: "voicetreasure", label: "Voice Treasure", Icon: Gamepad2 },
  { key: "attendance",   label: "Attendance",     Icon: CalendarCheck },
  { key: "assessments",  label: "Assessment Lab", Icon: ClipboardList },
  { key: "welcomeexp",   label: "Welcome Experience", Icon: Sunrise },
  { key: "achievementexp", label: "Achievement Experience", Icon: Trophy },
  { key: "achievementcenter", label: "Achievement Center", Icon: Medal },
  { key: "promotionexp", label: "Promotion Experience", Icon: Megaphone },
  { key: "dashboardstudio", label: "Dashboard Studio", Icon: LayoutDashboard },
  { key: "eventtemplates", label: "Event Templates", Icon: PartyPopper },
  { key: "platformconfig", label: "Platform Config", Icon: Settings },
  { key: "questionbank", label: "Question Bank", Icon: BookOpen },
  { key: "notificationpacks", label: "Notification Packs", Icon: BellRing },
  { key: "runtimedashboard", label: "Runtime Dashboard", Icon: Activity },
  { key: "announcements", label: "Announcements", Icon: Radio },
  { key: "prizepools", label: "Prize Pools", Icon: Coins },
  { key: "videofactory", label: "Video Factory", Icon: Video },
];

// Studio OS — task-oriented workspaces. Named and GROUPED around what a
// teacher is trying to accomplish and, wherever possible, around real
// shared code/data (see the published Architecture Review's "Information
// Architecture" + "Workflow Evidence" sections) — not around fitting a
// fixed list of names. Every one of the 34 tools above is assigned to
// exactly one workspace here — none invented, none dropped. Each
// workspace's FIRST key is deliberately a tool that's always statically
// available (never the conditional "bookfactory" entry), since clicking a
// workspace nav item jumps straight to it.
//
// Product-polish correction: an earlier pass merged Marketing tools and
// the Experience Configuration Platform family into one "Grow" workspace
// purely to fit a 6-name example list — not because of any real workflow
// or code relationship. They're genuinely different jobs: Marketing tools
// are immediate, outbound ACTIONS (send a push, launch a campaign);
// Experience tools are deliberate, publish-gated visual/motion CONFIGURATION
// of student-facing surfaces, and share real code (HeroArtworkPanel is
// literally imported by three of them; all five share one generic
// CRUD/draft/publish contract — see WelcomeExperienceStudio.jsx,
// AchievementExperienceStudio.jsx, DashboardStudio.jsx). Split back into
// two workspaces so the grouping teaches the real system.
const WORKSPACES = [
  { key: "create", label: "Create", Icon: PenSquare,
    tabs: ["editor", "smart", "upload", "browse", "preview", "aiscene", "questionbank", "bookfactory", "videofactory"] },
  { key: "teach", label: "Teach", Icon: GraduationCap,
    tabs: ["teacher", "attendance", "assessments"] },
  { key: "intelligence", label: "Intelligence", Icon: BrainCircuit,
    tabs: ["aitools", "aiassistant", "voicetreasure"] },
  { key: "grow", label: "Grow", Icon: TrendingUp,
    tabs: ["push", "coupons", "rewards", "mysterybox", "loginmystery", "referral", "artwork", "announcements"] },
  { key: "experience", label: "Experience", Icon: Sunrise,
    tabs: ["welcomeexp", "achievementexp", "achievementcenter", "promotionexp", "dashboardstudio"] },
  { key: "business", label: "Business", Icon: Wallet,
    tabs: ["tuition", "receipts", "payments"] },
  { key: "system", label: "System", Icon: Settings,
    tabs: ["runtimedashboard", "eventtemplates", "notificationpacks", "prizepools", "platformconfig"] },
];

// Reverse lookup (tab key -> workspace key), built once — lets the rail
// stay in sync no matter HOW `tab` changed (a workspace click, a search
// result, a Studio Home card, or one of the pre-existing internal
// `setTab("editor")` handoffs in handleApplyParsed/handleEditFromBrowse/
// handleBookFactoryHandoff, none of which are modified by this feature).
const TAB_TO_WORKSPACE = Object.fromEntries(
  WORKSPACES.flatMap((ws) => ws.tabs.map((key) => [key, ws.key]))
);

// Mobile bottom nav — Teach and Business are the evidence-backed
// daily/live-watched workspaces (Section 00c of the Architecture Review —
// Attendance, Tuition, Payments). Grow is pinned too on the reviewer's
// own explicit instruction that Push Notification must stay one-two-taps
// reachable, even though the wider cadence evidence for Marketing tools
// as a whole is closer to "as-needed" than daily. Experience, Intelligence,
// and System sit in "More" — Experience's own tools are all explicitly
// "never live until Published" (deliberate, infrequent), matching the
// same low-cadence tier as the other two.
// "Create" is deliberately NOT pinned either: its highest-frequency need
// ("continue my draft") is already 0 extra taps via Studio Home, and any
// other frequently-used Create tool surfaces in Home's "Frequent" row via
// workflow memory instead of permanently occupying a primary slot.
const MOBILE_PRIMARY_WORKSPACE_KEYS = ["teach", "grow", "business"];

function StudioDashboard({ user, onSignOut }) {
  // Studio OS — product-polish decision: Home is an OPERATING workspace,
  // not a dashboard you're routed through on every visit. A returning
  // admin resumes exactly where they left off (their last tool), the same
  // way an OS restores your last app — Home is just one more destination
  // they can always reach in one tap, not a forced waypoint every time.
  // Only a genuinely first-ever visit (nothing in workflow memory yet)
  // falls back to Home, replacing the old hardcoded "editor" default —
  // per the Architecture Review, the teacher's actual reason for opening
  // Studio today should decide where they land, and on a first visit
  // there's no history to go on, so the command center is the honest
  // default rather than guessing a specific tool.
  // Final audit fix — getLastVisitedTab() reads raw localStorage; two real
  // bugs if trusted blindly: (1) "bookfactory" is remote-flag-gated
  // (bfStatus.visible starts false and resolves async) — resuming straight
  // into it landed on a blank panel whenever the flag was off or hadn't
  // resolved yet on this load; (2) any other stale/unrecognized value
  // (e.g. a tab removed in a future refactor) landed on a permanently
  // blank content area with no matching `{tab === ...}` block at all. Only
  // resume into a tab that is unconditionally real today (a member of the
  // static TABS list); anything else falls back to Home, the same honest
  // "no history to go on" default already used for first-ever visits.
  const [tab, setTab] = useState(() => {
    const last = getLastVisitedTab();
    return last && TABS.some((t) => t.key === last) ? last : "home";
  });
  const [activeBook, setActiveBook] = useState(null); // loaded from browse
  const [editorSeed, setEditorSeed] = useState(null); // passed into Editor to override state
  const [previewBook, setPreviewBook] = useState(null);
  // Final audit fix — seeded from the ACTUAL initial `tab` (not a hardcoded
  // "create") so a resumed session lands on its correct workspace's tool
  // row from the very first paint. Previously this was hardcoded to
  // "create" and only corrected by the sync effect below after mount,
  // which caused a one-frame flash of the wrong workspace's tool pills
  // whenever a resumed tab belonged to any other workspace.
  const [activeWorkspace, setActiveWorkspace] = useState(() => TAB_TO_WORKSPACE[tab] || "create");
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const memory = useWorkflowMemory();
  const prefersReducedMotion = useReducedMotion();

  // Book Factory status — fetched exactly once on mount, non-blocking and
  // fail-closed. The shell renders immediately regardless of the outcome; the
  // tab appears only after the backend reports visible:true.
  const [bfStatus, setBfStatus] = useState({
    visible: false, enabled: false, geminiEnabled: false,
    coverEnabled: false, coverProviderReady: false, coverStorageReady: false,
    narrationEnabled: false, conversationAudioEnabled: false, directPublishEnabled: false,
    premiumInteractionsEnabled: false,
  });
  const editorRef = useRef(null);
  const [editorDirty, setEditorDirty] = useState(false);
  // §HIGH 8: on-demand snapshot of the Editor draft captured when LEAVING the
  // Editor tab, so the current draft stays downloadable after the Editor
  // unmounts (e.g. while the Book Factory tab is active).
  const lastEditorSnapshotRef = useRef(null); // { draft, dirty }

  useEffect(() => {
    let cancelled = false;
    getBookFactoryStatus().then((s) => { if (!cancelled) setBfStatus(s || { visible: false, enabled: false }); });
    return () => { cancelled = true; };
  }, []);

  // Studio OS — keeps the workspace rail/bottom-nav in sync with `tab`
  // regardless of HOW it changed (a workspace click, a search result, a
  // Studio Home card, or one of the existing internal `setTab("editor")`
  // handoffs below — none of which this effect touches), and records the
  // visit for workflow memory (Recent/Frequent on Studio Home). Read-only
  // observation of `tab` — never influences draft/snapshot/auth logic.
  useEffect(() => {
    const ws = TAB_TO_WORKSPACE[tab];
    if (ws) setActiveWorkspace(ws);
    memory.recordVisit(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // §HIGH 8: controlled tab change — snapshot the Editor draft on the way out.
  const handleTabChange = (nextTab) => {
    if (tab === "editor" && tab !== nextTab && editorRef.current?.exportCurrentDraft) {
      const draft = editorRef.current.exportCurrentDraft();
      if (draft) lastEditorSnapshotRef.current = { draft, dirty: editorDirty };
    }
    setTab(nextTab);
  };

  const handleApplyParsed = ({ chapters, mode }) => {
    // merge into current draft held by Editor via editorSeed (always a dirty seed)
    lastEditorSnapshotRef.current = null; // §HIGH 8: seed replaced → drop stale snapshot
    setEditorSeed((prev) => {
      const base = prev || activeBook || readDraft() || makeBlankBook();
      if (mode === "replace") return { ...base, chapters, _seedDirty: true };
      return { ...base, chapters: [...(base.chapters || []), ...chapters], _seedDirty: true };
    });
    setTab("editor");
  };

  const handleEditFromBrowse = (book) => {
    lastEditorSnapshotRef.current = null; // §HIGH 8: seed replaced
    setActiveBook(book);
    setEditorSeed(book);
    setTab("editor");
  };

  const handlePreviewFromEditor = (book) => {
    // §PHASE E3: all Editor tab exits go through handleTabChange so the draft
    // snapshot is captured before the tab changes.
    setPreviewBook(book);
    handleTabChange("preview");
  };

  // Book Factory handoff — seed the Editor with the generated draft as a DIRTY
  // seed. The confirmation against an unsaved Editor draft is surfaced inside
  // the handoff UI (which receives editorDirty) before this is ever called.
  const handleBookFactoryHandoff = (book) => {
    lastEditorSnapshotRef.current = null; // §HIGH 8: Editor seed is being replaced
    setEditorSeed({ ...book, _seedDirty: true });
    setTab("editor");
  };

  // §HIGH 8: download the CURRENT Editor draft on demand — from the live Editor
  // ref if mounted, otherwise from the last on-demand snapshot captured when
  // leaving the Editor tab (an independent clone; never the live object).
  const handleDownloadCurrentDraft = () => {
    const live = editorRef.current?.exportCurrentDraft?.();
    const draft = live || lastEditorSnapshotRef.current?.draft;
    if (!draft) return;
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.title || "current-draft"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const tabs = bfStatus.visible
    ? [...TABS, { key: "bookfactory", label: "Book Factory", Icon: Factory }]
    : TABS;
  const tabByKey = Object.fromEntries(tabs.map((t) => [t.key, t]));
  const toolsForWorkspace = (wsKey) =>
    (WORKSPACES.find((w) => w.key === wsKey)?.tabs || []).map((k) => tabByKey[k]).filter(Boolean);

  // Studio Home's "Continue working" card — the SAME draft source the
  // Editor tab itself already falls back to (editorSeed, then the
  // existing studio_draft_v1 localStorage key via readDraft()). Read-only;
  // never writes, never seeds anything.
  const currentDraft = editorSeed || readDraft();
  const draftSummary = currentDraft
    ? { title: currentDraft.title, chapterCount: currentDraft.chapters?.length }
    : null;

  const renderTabPill = ({ key, label, Icon }) => {
    const active = tab === key;
    return (
      <button key={key} onClick={() => handleTabChange(key)}
              data-testid={`studio-tab-${key}`}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
              style={{
                background: active
                  ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                  : "rgba(45,31,62,0.65)",
                color: active ? "#1a1420" : "#F4E5C1",
                border: active ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
                boxShadow: active ? "0 6px 14px rgba(212,168,67,0.35)" : "none",
              }}>
        <Icon className="h-3 w-3" /> {label}
      </button>
    );
  };

  const goWorkspace = (wsKey) => {
    const ws = WORKSPACES.find((w) => w.key === wsKey);
    if (!ws) return;
    setMobileMoreOpen(false);
    handleTabChange(ws.tabs[0]);
  };

  const primaryMobileWorkspaces = WORKSPACES.filter((w) => MOBILE_PRIMARY_WORKSPACE_KEYS.includes(w.key));
  const overflowMobileWorkspaces = WORKSPACES.filter((w) => !MOBILE_PRIMARY_WORKSPACE_KEYS.includes(w.key));

  return (
    <div className="min-h-screen text-parchment"
         style={{ background: "radial-gradient(circle at 20% 0%, #2D1F3E 0%, #0d0a16 70%)" }}
         data-testid="studio-dashboard">
      {/* iOS safe-area fix: Author Studio renders full-bleed outside AppShell
          (own OAuth), so this header never inherited AppShell's Header.jsx
          safe-area handling and rendered flush under the Dynamic Island /
          notch / status bar on iPhone — the root-level bug across every
          Author Studio page, not just the two production overlays. Applied
          on the <header> itself (not the inner max-width div) so the
          background bar extends behind the inset while the content below
          clears it, matching Header.jsx's own pattern. */}
      <header className="border-b border-white/5 backdrop-blur"
              style={{ background: "rgba(15,10,22,0.7)", paddingTop: studioSafeAreaTop(0) }}>
        <div className="max-w-[1100px] mx-auto flex items-center gap-3 px-4 sm:px-6 py-3">
          <PenSquare className="h-5 w-5 text-gold" />
          <h1 className="font-display text-[17px]">Author Studio</h1>
          <span className="text-[11px] text-faded">Dynamic CMS · live preview · versioned saves</span>
          <div className="flex-1" />
          {/* Studio OS Phase 0 — universal search over the same `tabs` array
              rendered below; navigates via the same handleTabChange every
              existing pill button already calls. */}
          <StudioCommandPalette tabs={tabs} onSelect={handleTabChange} />
          <span className="hidden sm:inline-block text-[12px] text-parchment/90 truncate max-w-[220px]">{user.email}</span>
          <button onClick={onSignOut} data-testid="studio-signout-btn"
                  className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-5 sm:flex sm:gap-6 pb-24 sm:pb-5">
        {/* Desktop workspace rail — every workspace always visible, no
            overflow needed at this width. Hidden on mobile in favor of the
            bottom nav below. */}
        <aside className="hidden sm:block w-[168px] flex-shrink-0" data-testid="studio-workspace-rail">
          <button onClick={() => handleTabChange("home")} data-testid="studio-workspace-home"
                  className="w-full flex items-center gap-2 rounded-xl px-3 py-2 mb-1 text-[12.5px] font-bold text-left transition-colors duration-150 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4A843]"
                  style={{ background: tab === "home" ? "rgba(212,168,67,0.14)" : "transparent",
                           color: tab === "home" ? "#FFE19A" : "#F4E5C1" }}>
            <HomeIcon className="h-3.5 w-3.5" /> Home
          </button>
          <div className="my-2 border-t border-white/5" />
          {WORKSPACES.map((ws) => {
            const active = activeWorkspace === ws.key && tab !== "home";
            return (
              <button key={ws.key} onClick={() => goWorkspace(ws.key)}
                      data-testid={`studio-workspace-${ws.key}`}
                      className="w-full flex items-center gap-2 rounded-xl px-3 py-2 mb-1 text-[12.5px] font-semibold text-left transition-colors duration-150 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4A843]"
                      style={{ background: active ? "rgba(45,31,62,0.9)" : "transparent",
                               color: active ? "#FFE19A" : "#F4E5C1" }}>
                <ws.Icon className="h-3.5 w-3.5" /> {ws.label}
              </button>
            );
          })}
        </aside>

        <div className="flex-1 min-w-0">
          {/* Every workspace's tool row stays mounted at ALL times (only
              CSS-hidden when not the active workspace, or when Home itself
              is showing) — every `data-testid="studio-tab-${key}"` button
              must always be reachable, including from tests that jump
              straight to a tab (e.g. Book Factory handoff) without first
              opening its workspace or leaving Home. */}
          {WORKSPACES.map((ws) => (
            <nav key={ws.key}
                 className={`flex flex-wrap gap-1.5 mb-5 ${tab !== "home" && activeWorkspace === ws.key ? "" : "hidden"}`}
                 data-testid={`studio-workspace-tools-${ws.key}`}>
              {toolsForWorkspace(ws.key).map(renderTabPill)}
            </nav>
          ))}

          {/* Final audit fix — this was previously wrapped in AnimatePresence
              with an `exit` animation. Every OTHER tab below unmounts the
              instant `tab` changes (no exit animation of its own), but
              AnimatePresence keeps Home mounted and fading out for the full
              ~350ms transition. Since these are normal-flow siblings (not
              absolutely positioned / cross-faded), the result was a real
              visible bug: navigating away from Home showed the fading Home
              content and the newly-mounted next panel stacked together for
              a third of a second on every single navigation. Home now only
              animates its ENTRANCE (mounts fresh, plays initial->animate,
              then unmounts instantly like every other tab) — still feels
              alive every time you land on it, with none of the overlap. */}
          {tab === "home" && (
            <motion.div key="home"
                        initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={prefersReducedMotion ? { duration: duration.instant } : { duration: duration.fast, ease: easing.premiumEaseOut }}>
              <StudioHome tabs={tabs} onNavigate={handleTabChange} memory={memory} draftSummary={draftSummary} />
            </motion.div>
          )}

        {tab === "editor" && (
          <StudioEditor ref={editorRef}
                        initialBook={editorSeed}
                        onSaved={() => { /* maybe toast */ }}
                        onPreview={handlePreviewFromEditor}
                        onDirtyChange={setEditorDirty} />
        )}
        {tab === "smart"   && <StudioSmartPaste onApply={handleApplyParsed} />}
        {tab === "upload"  && <StudioUpload onApply={handleApplyParsed} />}
        {tab === "browse"  && <StudioBrowse onEdit={handleEditFromBrowse} onPreview={setPreviewBook} />}
        {tab === "preview" && <StudioPreview book={previewBook || editorSeed || readDraft()} />}
        {tab === "aiscene" && <AiSceneBuilder />}
        {tab === "aitools" && <AiToolsStudio />}
        {tab === "aiassistant" && <AiAssistantStudio />}
        {tab === "push"    && <PushStudio />}
        {tab === "teacher" && <TeacherStudio />}
        {tab === "coupons" && <CouponStudio />}
        {tab === "rewards" && <LoginRewardStudio />}
        {tab === "mysterybox" && <MysteryBoxStudio />}
        {tab === "loginmystery" && <LoginMysteryStudio />}
        {tab === "tuition"   && <TuitionReminderStudio />}
        {tab === "receipts"  && <ReceiptManagementStudio />}
        {tab === "payments"  && <PaymentStudio />}
        {tab === "referral"  && <ReferralConfig />}
        {tab === "voicetreasure" && <VoiceTreasureStudio />}
        {tab === "artwork"     && <ArtworkCampaignStudio />}
        {tab === "attendance"  && <AttendanceStudio />}
        {tab === "assessments" && <AssessmentReviewStudio />}
        {tab === "welcomeexp"  && <WelcomeExperienceStudio />}
        {tab === "achievementexp" && <AchievementExperienceStudio />}
        {tab === "achievementcenter" && <TrophyAchievementStudio />}
        {tab === "promotionexp" && <PromotionExperienceStudio />}
        {tab === "dashboardstudio" && <DashboardStudio />}
        {tab === "eventtemplates" && <EventTemplatesStudio />}
        {tab === "platformconfig" && <PlatformConfigStudio />}
        {tab === "questionbank" && <QuestionBankStudio />}
        {tab === "notificationpacks" && <NotificationPacksStudio />}
        {tab === "runtimedashboard" && <RuntimeDashboardStudio />}
        {tab === "announcements" && <AnnouncementsStudio />}
        {tab === "prizepools" && <PrizePoolStudio />}
        {tab === "bookfactory" && bfStatus.visible && (
          <Suspense fallback={<div data-testid="bf-lazy-loading" className="text-faded text-[12px]">Loading Book Factory…</div>}>
            <BookFactoryStudio enabled={bfStatus.enabled}
                               geminiEnabled={bfStatus.geminiEnabled}
                               coverEnabled={bfStatus.coverEnabled}
                               narrationEnabled={bfStatus.narrationEnabled}
                               conversationAudioEnabled={bfStatus.conversationAudioEnabled}
                               directPublishEnabled={bfStatus.directPublishEnabled}
                               editorDirty={editorDirty}
                               adminIdentity={user.email}
                               onHandoff={handleBookFactoryHandoff}
                               onDownloadCurrentDraft={handleDownloadCurrentDraft} />
          </Suspense>
        )}
        {tab === "videofactory" && (
          <Suspense fallback={<div data-testid="vf-lazy-loading" className="text-faded text-[12px]">Loading Video Factory…</div>}>
            <VideoFactoryStudio />
          </Suspense>
        )}
        </div>
      </div>

      {/* Mobile bottom nav — Home + the 3 workspaces the evidence supports
          as daily/live-watched (Section 00c/00d of the Architecture
          Review), reachable in exactly one tap from the bottom half of the
          screen; everything else is one more tap via "More". */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-[90] flex items-stretch border-t border-white/10"
           style={{ background: "rgba(15,10,22,0.94)", backdropFilter: "blur(14px)", paddingBottom: "env(safe-area-inset-bottom)" }}
           data-testid="studio-mobile-nav">
        <motion.button onClick={() => { setMobileMoreOpen(false); handleTabChange("home"); }}
                whileTap={prefersReducedMotion ? undefined : { scale: 0.9 }}
                transition={spring.tap}
                data-testid="studio-mobile-nav-home"
                className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[9.5px] font-bold uppercase tracking-wide transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#D4A843]"
                style={{ color: tab === "home" ? "#FFE19A" : "#8B7355" }}>
          <HomeIcon className="h-4 w-4" /> Home
        </motion.button>
        {primaryMobileWorkspaces.map((ws) => (
          <motion.button key={ws.key} onClick={() => goWorkspace(ws.key)}
                  whileTap={prefersReducedMotion ? undefined : { scale: 0.9 }}
                  transition={spring.tap}
                  data-testid={`studio-mobile-nav-${ws.key}`}
                  className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[9.5px] font-bold uppercase tracking-wide transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#D4A843]"
                  style={{ color: activeWorkspace === ws.key && tab !== "home" ? "#FFE19A" : "#8B7355" }}>
            <ws.Icon className="h-4 w-4" /> {ws.label}
          </motion.button>
        ))}
        <motion.button onClick={() => setMobileMoreOpen((v) => !v)}
                whileTap={prefersReducedMotion ? undefined : { scale: 0.9 }}
                transition={spring.tap}
                data-testid="studio-mobile-nav-more"
                className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[9.5px] font-bold uppercase tracking-wide transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#D4A843]"
                style={{ color: mobileMoreOpen || overflowMobileWorkspaces.some((w) => w.key === activeWorkspace && tab !== "home") ? "#FFE19A" : "#8B7355" }}>
          <MoreHorizontal className="h-4 w-4" /> More
        </motion.button>
      </nav>

      {/* Interaction-language polish: the Architecture Review proposed
          easing.standardEaseOut/duration.base for exactly this "drawer/sheet
          slide" interaction. AnimatePresence here is safe for the same reason
          as the Home wrapper above — this sheet is Studio OS's own chrome,
          never a protected panel. */}
      <AnimatePresence>
        {mobileMoreOpen && (
          <motion.div
            key="mobile-more-sheet"
            className="sm:hidden fixed inset-0 z-[95] flex items-end"
            data-testid="studio-mobile-more-sheet"
            initial="closed"
            animate="open"
            exit="closed"
          >
            <motion.div
              className="absolute inset-0 bg-black/60"
              onClick={() => setMobileMoreOpen(false)}
              variants={{ open: { opacity: 1 }, closed: { opacity: 0 } }}
              transition={prefersReducedMotion ? { duration: duration.instant } : { duration: duration.base, ease: easing.standardEaseOut }}
            />
            <motion.div
              className="relative w-full rounded-t-3xl border-t border-gold/25 p-4"
              style={{ background: "rgba(20,14,32,0.98)", paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}
              variants={{ open: { y: 0, opacity: 1 }, closed: { y: prefersReducedMotion ? 0 : 24, opacity: prefersReducedMotion ? 1 : 0 } }}
              transition={prefersReducedMotion ? { duration: duration.instant } : { duration: duration.base, ease: easing.standardEaseOut }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-faded">More workspaces</span>
                <button onClick={() => setMobileMoreOpen(false)} aria-label="Close" data-testid="studio-mobile-more-close"
                        className="rounded-full p-1 transition-colors duration-150 hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4A843]">
                  <CloseIcon className="h-4 w-4 text-faded" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {overflowMobileWorkspaces.map((ws) => (
                  <motion.button key={ws.key} onClick={() => goWorkspace(ws.key)}
                          whileTap={prefersReducedMotion ? undefined : { scale: 0.94 }}
                          transition={spring.tap}
                          data-testid={`studio-mobile-more-${ws.key}`}
                          className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-white/10 py-3.5 text-[11px] font-bold transition-colors duration-150 hover:bg-white/[0.06] hover:border-gold/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4A843]">
                    <ws.Icon className="h-4 w-4 text-gold" /> {ws.label}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function readDraft() {
  try {
    const raw = localStorage.getItem("studio_draft_v1");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function makeBlankBook() {
  return {
    title: "Untitled",
    section: "story",
    coverEmoji: "📖",
    coverGradient: "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)",
    accent: "#D4A843",
    readingMinutes: 6,
    format: "blocks",
    chapters: [],
  };
}
