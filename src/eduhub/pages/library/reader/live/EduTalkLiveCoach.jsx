/**
 * EduTalkLiveCoach.jsx — student-facing "EduTalk Live Coach".
 *
 * A NEW, isolated real-time speaking-practice launcher mounted inside the
 * Library Reader, clearly SEPARATE from:
 *   • the existing purple EduTalk assistant button (text/audio)
 *   • the black book-narration audio player
 *
 * Flow: mic permission → start session (points reserved on the backend) →
 * WebSocket voice bridge (backend ⇄ Gemini Live) → report card. The backend
 * is the single source of truth for billing; this component only displays
 * state and sends user actions. The Gemini key is never seen here.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { MessageCircle, X } from "lucide-react";
import { useAuth } from "../../../../context/AuthContext";
import {
  getLiveConfig,
  startLiveSession,
  endLiveSession,
  buildWsUrl,
  claimRewardOffer,
  getActiveRewardOffer,
  getRewardStatus,
  getTopupNudgeReport,
  reportTopupNudgeVisibility,
} from "../../../../lib/edutalkLiveApi";
import { startMicCapture, createAudioPlayer } from "./liveAudio";
import { registerActiveSession, unregisterActiveSession } from "../../../../lib/activeSessionRegistry";
// Bug fix — starting a Live Coach session previously left the book's
// narration audio (a fully separate player) running, so the student
// heard both the book narrator and the Gemini coach talking at once.
// Read-only pause/resume of the EXISTING book player — no new audio
// engine, no change to the book player's own controls/UI.
import { useBookAudio } from "../AudioPlayerContext";
import LiveCoachStartCard from "./LiveCoachStartCard";
import LiveCoachCouponCard from "./LiveCoachCouponCard";
import LiveVoiceOrb from "./LiveVoiceOrb";
import LiveTranscriptPanel from "./LiveTranscriptPanel";
import LiveCoachReportCard from "./LiveCoachReportCard";
import LiveCoachRewardPanel from "./LiveCoachRewardPanel";
import LiveCoachRewardReveal from "./LiveCoachRewardReveal";
import {
  initialRewardState,
  applyRewardEvent,
  applyRecoveredOffer,
  shouldSendClaimOnTap,
  composeRevealPayload,
  decideNextPoll,
  createRewardPollController,
  createAnnounceRetryController,
} from "./liveCoachRewardLogic";
import {
  createStatusPollController,
  shouldKeepPollingStatus,
  statusFromRestClaimOutcome,
  statusFromWsClaimFailed,
  normalizeWsClaimFailedOutcome,
  normalizeAuthoritativeClaimOutcome,
  reconcileStatusRevision,
} from "./liveCoachRewardPanelLogic";
import "./liveCoach.css";
import "./liveCoachReward.css";
import "./liveCoachRewardPanel.css";

// ── Phase 1 Smart Top-Up Nudge (additive) ──────────────────────────────────
// Renders ONLY in phase === "start" and phase === "report" (never "live").
// Reuses the SINGLE shared PointsPurchaseModal and the EXISTING top-up
// snooze/dismissal storage from useTopUpAffordance.js (coordination with the
// app-level SmartTopUpTrigger).
import LiveCoachTopUpNudge from "./LiveCoachTopUpNudge";
import {
  selectModePreview,
  settledBalanceToApply,
  buildEffectiveStartDecision,
  buildEffectiveReportDecision,
} from "./liveCoachTopupNudgeLogic";
import {
  markTopUpAutoShown,
  pickRecommendedPackage,
} from "../../../../components/topup/useTopUpAffordance";
// Phase 0B — EduTalk-Live-Coach-ONLY snooze (separate per-student keys; the
// shared app-wide snooze in useTopUpAffordance.js is left byte-for-byte
// unchanged and is NOT imported for the pill any more).
import {
  isEduTalkTopUpSnoozed,
  recordEduTalkTopUpDismiss,
} from "./liveCoachTopupSnooze";
// Phase 0A — pure attempt-scoped greeting lifecycle controller + drain timeouts.
import {
  createGreetingController,
  GREETING_TIMEOUTS,
} from "./liveCoachGreetingState";
// V2 Bug 2 — pure greeting-audio suppression decision (stale/cancelled greeting
// audio is dropped before enqueue; normal interaction audio is never blocked).
import { shouldSuppressGreetingAudio } from "./liveCoachAudioGate";

const TopUpPointsModal = lazy(() =>
  import("../../../portal/components/dashboard/PointsPurchaseModal")
);
const TOPUP_BACKEND = process.env.REACT_APP_BACKEND_URL || "";
// Issue 3 fix — bound how long a dead WebSocket may sit in "reconnecting"
// before ws.onerror force-finalizes via the same REST path ws.onclose
// already uses. onclose normally follows onerror within milliseconds, so
// this rarely fires; it only bounds the rare case it doesn't.
const WS_ERROR_GRACE_MS = 5_000;
// Re-audit hardening — caps how many utterance-level transcript blocks are
// kept in memory/rendered by LiveTranscriptPanel. Far above what any
// normal session produces; only protects a pathological long-running
// session from unbounded growth.
const MAX_TRANSCRIPT_LINES = 400;

function resolvePassword(student) {
  if (!student) return "";
  if (student.password) return String(student.password);
  const pd = student.portalData || {};
  return String(pd.Password ?? pd.password ?? "");
}

// P0 fix — same root cause as EduTalkPanel.jsx (see that file's studentRef
// comment for the full write-up): AuthContext's persistent profile cache
// strips the password before writing to storage, and a separate async
// effect re-hydrates it shortly after every refresh/PWA reopen. Reading
// `password` at the top of the component is a snapshot — this gives the
// in-flight hydration a bounded window to land (via a live ref, since this
// runs inside a plain async function outside the render cycle) instead of
// silently sending an empty password to the backend.
// P1 Phase C audit — this recursive setTimeout has no unmount guard, but
// deliberately so: it is bounded to timeoutMs (~4s max, 16 ticks) and
// self-terminates either way, and the rest of startSession() (the
// getUserMedia probe, the startLiveSession REST call) has never had an
// unmount guard either — this file consistently trusts React 18's
// setState-after-unmount no-op rather than tracking mounted state, so a
// one-off guard here would be inconsistent without fixing the whole
// function. Confirmed no listener/subscription is created — just a
// chained timer that resolves and stops.
function _waitForPassword(studentRef, timeoutMs = 4000, intervalMs = 250) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const pw = resolvePassword(studentRef.current);
      if (pw) return resolve(pw);
      if (Date.now() >= deadline) return resolve("");
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
function resolveBalance(student) {
  const raw = student?.portalPoints ?? student?.points;
  const n = Number(raw);
  if (raw == null || Number.isNaN(n)) return null;
  return Math.round(n);
}

export default function EduTalkLiveCoach({
  bookSlug = "",
  bookTitle = "",
  bookTier = "free",
  chapterIdx = null,
  chapterTitle = "",
  visibleText = "",
  // Reading Hub (P1) — same additive, opt-in pair as EduTalkPanel.jsx's
  // hideOwnFab/onFabState. Suppresses only this file's own independently-
  // positioned idle trigger; the overlay/sheet session UI, WebSocket
  // lifecycle, and mic/audio handling below are completely untouched.
  hideOwnFab = false,
  onFabState,
}) {
  const { isAuthenticated, student, setBalance } = useAuth();
  // P0 fix — live mirror of `student` for _waitForPassword (see that
  // helper's comment above). Mutated directly during render, matching this
  // file's own established ref-mirror style (see bookAudioRef just below).
  const studentRef = useRef(student);
  studentRef.current = student;
  // Bug fix — book/coach audio overlap. `bookAudio` (the context value
  // object) changes identity on every currentTime tick while narration is
  // playing, so it is cached into a ref rather than depended on by any
  // useCallback — depending on it directly would recreate cleanup() on
  // every tick and re-run the unmount-effect constantly.
  const bookAudio = useBookAudio();
  const bookAudioRef = useRef(bookAudio);
  bookAudioRef.current = bookAudio;
  // True only while WE paused book audio for this session (never true if
  // the student had already paused it themselves) — read at start, used
  // to decide whether to resume it once the session ends.
  const bookAudioWasPlayingRef = useRef(false);
  const [config, setConfig] = useState(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState("start"); // start | live | report
  // Reading Hub (P1) — setOpen/setPhase are stable useState setters, so
  // (unlike EduTalkPanel's onOpen, which closes over session state) this
  // can be defined directly, no ref-bridge needed.
  const openViaHub = useCallback(() => { setOpen(true); setPhase("start"); }, []);
  const [selectedMode, setSelectedMode] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // v1.5 — student-chosen explanation language. Khmer is the default
  // because the overwhelming majority of EduHub students are Khmer
  // speakers. Persisted to localStorage so the choice survives a page
  // refresh, but the source-of-truth for any given session is what we
  // SEND in the start payload. The backend then bakes the rule into
  // the system instruction.
  const [explainLang, setExplainLang] = useState(() => {
    try {
      const v = (localStorage.getItem("edutalk_live_explain_lang") || "km")
        .trim()
        .toLowerCase();
      return v === "en" ? "en" : "km";
    } catch {
      return "km";
    }
  });
  useEffect(() => {
    try { localStorage.setItem("edutalk_live_explain_lang", explainLang); }
    catch { /* private mode */ }
  }, [explainLang]);

  const [orbState, setOrbState] = useState("listening");
  const [level, setLevel] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [connection, setConnection] = useState("connecting");
  const [transcript, setTranscript] = useState([]);
  const [report, setReport] = useState(null);
  const [pointsCharged, setPointsCharged] = useState(0);
  const [refundState, setRefundState] = useState(null);

  // ── Phase 1 Smart Top-Up Nudge state (additive). topupFinalization holds
  // the Stage 3 finalization the REPORT pill renders from. The modal is a
  // SINGLE instance guarded by topUpModalOpen (repeated-click protection).
  const [topupFinalization, setTopupFinalization] = useState(null);
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);
  const [topupPackages, setTopupPackages] = useState([]);
  // BUG 3 hardening — the pill itself previously had no dismiss control of
  // its own; a student could only make it go away by opening the points
  // purchase modal first (its close button was the only path that ever
  // recorded a dismissal). This flag lets a direct pill-dismiss hide it
  // for the rest of THIS session (a genuinely new session/mount is the
  // "meaningful trigger" the pill is allowed to reappear on) without
  // waiting for the existing 3-dismissals-in-7-days snooze escalation,
  // which still accumulates normally underneath via the same
  // recordEduTalkTopUpDismiss ledger the modal's close already uses.
  const [pillDismissedThisVisit, setPillDismissedThisVisit] = useState(false);

  // ── Phase 1 SURPRISE REWARDS — single source of truth: the tested
  // pure reducer in ``liveCoachRewardLogic.js``. The component no
  // longer carries a divergent inline state machine; every backend WS
  // event is funnelled through ``applyRewardEvent`` so the unit-tested
  // logic IS the logic that runs in production.
  const sessionRef = useRef(null);
  const rewardReducer = useCallback(
    (state, action) => {
      switch (action.kind) {
        case "event":
          return applyRewardEvent(
            state, action.event,
            sessionRef.current?.session_id || "",
          );
        case "claim_start":
          return { ...state, claiming: true, error: "" };
        case "claim_local_confirm":
          // Mirror a REST-fallback success through the same reducer so
          // ``claimedOfferIds`` stays the dedup source of truth.
          return applyRewardEvent(
            state,
            {
              type: "reward_claim_confirmed",
              offer_id: action.offer_id,
              session_id:
                sessionRef.current?.session_id || state.offer?.session_id,
              reward_type: action.reward_type,
              reward_amount: action.reward_amount,
              reward_summary: action.reward_summary,
              confirmed_message: action.confirmed_message,
            },
            sessionRef.current?.session_id || "",
          );
        case "claim_local_failed":
          return { ...state, claiming: false, error: action.reason || "" };
        case "recovered":
          // Blocker E — authoritative active-offer recovery funnelled
          // through the SAME shared helper (no divergent inline machine).
          return applyRecoveredOffer(
            state, action.recovered,
            sessionRef.current?.session_id || "",
          );
        case "close_reveal":
          return { ...state, revealOpen: false };
        case "reset":
          return initialRewardState;
        default:
          return state;
      }
    },
    [],
  );
  const [rewardState, dispatchReward] = useReducer(
    rewardReducer, initialRewardState);
  // Keep rewardStateRef in sync so polling callbacks read the latest
  // claim status without depending on stale closure values.
  useEffect(() => { rewardStateRef.current = rewardState; }, [rewardState]);
  const {
    result: rewardResult,
    revealOpen: rewardRevealOpen,
    confirmedMessage: rewardConfirmedMessage,
    error: rewardError,
  } = rewardState;

  const reducedMotion = useMemo(() => {
    try {
      return window.matchMedia
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }, []);

  const wsRef = useRef(null);
  const stopMicRef = useRef(null);
  const armMicRef = useRef(null);
  const micArmedRef = useRef(false);
  const greetingTimerRef = useRef(null);
  const playerRef = useRef(null);
  const timerRef = useRef(null);
  const endingRef = useRef(false);
  const fallbackRef = useRef(null);
  // Re-audit fix — the topup-finalization retry inside finishToReport()
  // previously used a bare setTimeout(..., 800) that was never stored
  // anywhere and never cleared by cleanup(). If the component unmounted
  // (navigation away from the report) or a brand-new session started
  // within that 800ms window, the stale retry would still fire later and
  // call setTopupFinalization/setBalance against whatever state existed
  // by then — a stale-write risk into a NEW session's state, or a
  // React "state update on unmounted component" warning. Tracked in a
  // ref so cleanup() can clear it like every other timer in this file.
  const topupRetryTimerRef = useRef(null);
  // Issue 3 fix — bounded safety net for ws.onerror. No real reconnect is
  // attempted (the backend finalizes the whole live/Gemini bridge the
  // moment its own socket closes, so a resumed WebSocket could never
  // rejoin the same Gemini session). onclose almost always follows
  // onerror within milliseconds and already finalizes via restEnd; this
  // timer only fires in the rare case onclose never arrives, so a dead
  // socket can never leave the student staring at a "Reconnecting…"
  // promise indefinitely while the mic/timer keep running against it.
  const wsErrorGraceTimerRef = useRef(null);
  // ── Phase 0A — attempt-scoped greeting lifecycle. The pure controller owns
  // the arm decision; the component owns sockets/timers/mic. Every ws.onopen
  // bumps the controller's connection generation, invalidating prior attempts,
  // timers, queue waiters and callbacks.
  const greetingControllerRef = useRef(null);
  if (greetingControllerRef.current === null) {
    greetingControllerRef.current = createGreetingController();
  }
  const greetingConnGenRef = useRef(0);
  const greetingWatchdogsRef = useRef({
    request: null, firstAudio: null, turnComplete: null, drain: null,
  });
  const greetingDrainTokenRef = useRef(0);
  const greetingAwaitCancelAckRef = useRef(false);
  // V2 Bug 2 — legacy greeting quarantine. Active while UNTAGGED late greeting
  // audio must be suppressed after a greeting fallback/failure; cleared at the
  // first generic greeting turn boundary, socket replacement, or explicit
  // backend skip/failure completion. Never suppresses normal interaction audio.
  const greetingLegacyQuarantineRef = useRef(false);
  // Phase 0B — config refresh staleness guard + last-fetch timestamp.
  const lastConfigFetchRef = useRef(0);
  const configRefreshingRef = useRef(false);
  // Phase 0B — visibility-decision dedup so one stable decision is reported per
  // relevant start/report state (never on every render).
  const lastVisibilityKeyRef = useRef("");
  // Correction 2 (final) — bounded active-offer recovery polling is owned
  // by the SHARED production controller (``createRewardPollController`` in
  // liveCoachRewardLogic.js). The same factory is exercised directly by
  // the behavioural Jest suite, so the code under test IS the code that
  // ships — there is no separately reconstructed imitation of the gate.
  const recoverRef = useRef(null);           // latest recover fn (ws.onopen)
  const rewardPollControllerRef = useRef(null);
  if (rewardPollControllerRef.current === null) {
    rewardPollControllerRef.current = createRewardPollController({
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (id) => clearTimeout(id),
      now: () => Date.now(),
      // Execute exactly one recovery request; ``recoverActiveOffer``
      // always settles the controller when it finishes.
      execute: () => { recoverRef.current?.(); },
    });
  }
  // Correction 1 (final) — set of offer_ids whose delayed-confirmed Gemini
  // congratulations the BACKEND has acknowledged as delivered (or already
  // delivered) over the live WebSocket. We add an id ONLY after that ack,
  // never before delivery is proven — so a transient send failure or an
  // unavailable socket stays retryable on the next recovery / reconnect.
  const rewardConfirmedAnnouncedRef = useRef(new Set());
  // Correction B (final) — SEPARATE bounded announcement-delivery retry
  // controller (``createAnnounceRetryController``). The reward poll resolves
  // the WALLET and stops at granted; the delayed Gemini congratulations may
  // still need bounded retries (in_progress / inject_failed / lost ack on a
  // temporarily-unavailable socket). The component instantiates the SAME
  // production helper the behavioural Jest suite drives, and its ``send``
  // callback performs the one live-WebSocket announcement send.
  const announceRetryControllerRef = useRef(null);
  if (announceRetryControllerRef.current === null) {
    announceRetryControllerRef.current = createAnnounceRetryController({
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (id) => clearTimeout(id),
      now: () => Date.now(),
      send: (offerId, sessionId) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: "announce_confirmed_reward",
            offer_id: offerId,
            session_id: sessionId,
          }));
        }
        // If the socket is unavailable the send is a no-op; the controller's
        // bounded timer keeps the announcement retryable (and a reconnect
        // resumes it) — we NEVER fabricate delivery.
      },
    });
  }
  // Latest reward UI state mirror — read inside polling callbacks so the
  // resilience decisions reflect the current claim status without re-
  // creating the recover callback on every render.
  const rewardStateRef = useRef(initialRewardState);

  // Hotfix v1 — PERSISTENT PANEL: backend-truth reward STATUS plus a bounded,
  // single-flight status poll controller (separate from the offer-recovery
  // and announcement-retry controllers). It guarantees AT MOST one timer and
  // one in-flight status request per session and is cancelled on unmount /
  // session change. The exact same factory is unit-tested in the Jest suite.
  const [rewardStatus, setRewardStatus] = useState(null);
  const statusFetchRef = useRef(null);
  // v5 Blocker 2 — monotonically increasing claim-truth REVISION barrier. It is
  // bumped whenever an authoritative claim outcome (REST or WebSocket
  // unavailable/disabled) supersedes the panel status locally, so a status
  // response that was already in flight cannot overwrite the newer truth with
  // stale data; the superseded response instead queues one coalesced refresh.
  const statusRevisionRef = useRef(0);
  const statusPollControllerRef = useRef(null);
  if (statusPollControllerRef.current === null) {
    statusPollControllerRef.current = createStatusPollController({
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (id) => clearTimeout(id),
      execute: (token) => { statusFetchRef.current?.(token); },
      intervalMs: 5000,
    });
  }

  const password = useMemo(() => resolvePassword(student), [student]);
  const balance = useMemo(() => resolveBalance(student), [student]);

  // ── Phase 0B — reusable config loader. Refreshed when auth first becomes
  // available, when the overlay is open and the component enters phase
  // "start", and when the last successful fetch is older than 30s. Preserves
  // the selected mode when still available, else picks the first mode. Guarded
  // against a render loop via lastConfigFetchRef + configRefreshingRef.
  const CONFIG_STALE_MS = 30000;
  const refreshLiveConfig = useCallback(async (opts = {}) => {
    if (!isAuthenticated) return;
    if (configRefreshingRef.current) return;
    const now = Date.now();
    if (!opts.force && now - lastConfigFetchRef.current < CONFIG_STALE_MS) return;
    configRefreshingRef.current = true;
    try {
      const c = await getLiveConfig();
      lastConfigFetchRef.current = Date.now();
      setConfig(c);
      setSelectedMode((cur) => {
        const keys = (c?.modes || []).map((m) => m.key);
        if (cur && keys.includes(cur)) return cur;     // keep if still available
        return keys.length ? keys[0] : cur;            // else first mode
      });
    } catch {
      setConfig((prev) => prev || { available: false });
    } finally {
      configRefreshingRef.current = false;
    }
  }, [isAuthenticated]);

  // First load when authentication becomes available.
  useEffect(() => {
    if (!isAuthenticated) return;
    refreshLiveConfig({ force: true });
  }, [isAuthenticated, refreshLiveConfig]);

  // Phase 0B — refresh when the overlay is open AND the component enters the
  // "start" phase (respects the 30s staleness guard inside refreshLiveConfig,
  // so this cannot create a render loop).
  useEffect(() => {
    if (open && phase === "start") refreshLiveConfig();
  }, [open, phase, refreshLiveConfig]);

  const freeTrialAvailable = useMemo(() => {
    // AUTHORITATIVE: the backend computes per-student trial eligibility and
    // returns `free_trial_available`. The UI must not guess — it only mirrors
    // the backend's decision so "Start free trial" can never be shown to a
    // student who has already used their trial.
    return !!(config && config.free_trial_available);
  }, [config]);

  // ====================================================================== //
  // Phase 1 Smart Top-Up Nudge — derived view state (start/report only).    //
  // The pill never renders during phase === "live". The frontend NEVER       //
  // recomputes balance-minus-cost: it only reads the backend per-mode        //
  // preview (start) and the Stage 3 finalization (report).                   //
  // ====================================================================== //
  const nudgeEnabled = !!(config && config.topup_nudge_enabled);
  const topupStudentId =
    student?.studentId || student?.clean_id || student?.cleanId || "";
  // Phase 0B — EduTalk-Live-Coach-ONLY per-student snooze. The shared app-wide
  // snooze (useTopUpAffordance.js) is deliberately NOT consulted here so one
  // student's EduTalk dismissals can never suppress another student's pill on a
  // shared device, and the general app-wide popup behaviour stays unchanged.
  const topupSnoozed = isEduTalkTopUpSnoozed(topupStudentId);
  const modePreview = useMemo(
    () => selectModePreview(
      config && config.topup_nudge_previews_by_mode, selectedMode),
    [config, selectedMode]
  );
  // Client-side fallback preview when backend preview is balance-gated
  const clientFallbackPreview = useMemo(() => {
    const selectedModeObj =
      (config && config.modes ? config.modes : []).find(
        (m) => m.key === selectedMode);
    if (
      modePreview?.reason !== "balance_unavailable_for_preview" ||
      !config?.topup_nudge_enabled ||
      // v2.2 blocker fix: never bypass the weekly-cap gate. When the backend
      // preview is balance-gated, the per-mode preview carries no
      // ``weekly_cap_available`` field — so the client fallback MUST consult
      // the top-level ``topup_nudge_cap_available`` flag exposed by the
      // student config endpoint. If the cap is unavailable/exhausted, the
      // pill stays suppressed (preserving server-side cap enforcement).
      config?.topup_nudge_cap_available !== true ||
      typeof balance !== "number" ||
      !selectedModeObj?.cost_points
    ) return null;
    const threshold = config?.topup_nudge_threshold ?? 15;
    const projected = balance - selectedModeObj.cost_points;
    return { enabled: true, eligible: projected <= threshold };
  }, [modePreview, config, balance, selectedMode]);
  // V2 Bug 4 — ONE effective start decision drives BOTH the rendered pill and
  // the visibility log (including the client display-snapshot fallback), so the
  // shown pill and the reported decision can never diverge.
  const effectiveStartDecision = useMemo(
    () => buildEffectiveStartDecision({
      enabled: nudgeEnabled,
      snoozed: topupSnoozed,
      preview: modePreview,
      clientFallback: clientFallbackPreview,
      capReason: config?.topup_nudge_cap_reason,
    }),
    [nudgeEnabled, topupSnoozed, modePreview, clientFallbackPreview, config]
  );
  const showStartPill = effectiveStartDecision.pill_shown;
  // Client-side fallback finalization when the backend could not read the
  // settled balance (Bug 1b root cause: the authoritative GAS balance needs a
  // password that is deliberately never stored at finalize). Triggers ONLY on
  // reason "wallet_unavailable" so the backend's weekly-cap / threshold /
  // refund decisions are preserved for every other reason. Display-only: it
  // creates NO authorization and shows no fabricated balance figure.
  const clientFallbackFinalization = useMemo(() => {
    if (
      topupFinalization?.reason !== "wallet_unavailable" ||
      !config?.topup_nudge_enabled ||
      typeof balance !== "number"
    ) return null;
    const threshold = config?.topup_nudge_threshold ?? 15;
    const charged = typeof pointsCharged === "number" ? pointsCharged : 0;
    const projected = balance - charged;
    return { report_eligible: projected <= threshold, settlement_reason: "client_estimate" };
  }, [topupFinalization, config, balance, pointsCharged]);
  // V2 Bug 4 — ONE effective report decision drives BOTH the rendered pill and
  // the visibility log (including the client display-snapshot fallback).
  const effectiveReportDecision = useMemo(
    () => buildEffectiveReportDecision({
      enabled: nudgeEnabled,
      snoozed: topupSnoozed,
      finalization: topupFinalization,
      clientFallback: clientFallbackFinalization,
    }),
    [nudgeEnabled, topupSnoozed, topupFinalization, clientFallbackFinalization]
  );
  const showReportPill = effectiveReportDecision.pill_shown;
  // Section 8 — recommended package via the EXISTING helper (never a literal).
  const topupRecommendedId = useMemo(
    () => (pickRecommendedPackage(topupPackages) || {})._id,
    [topupPackages]
  );

  // ── Phase 0B / V2 Bug 4 — bounded, deduplicated visibility-decision
  // reporting. The reported decision is the SAME effective decision object used
  // to render the pill (start/report), so the actual render and the visibility
  // POST can never use two different data sources. Internal diagnostic strings
  // are NEVER displayed to students.
  const visibilityDecision = useMemo(() => {
    if (phase === "start") {
      return { phase: "start", ...effectiveStartDecision };
    }
    if (phase === "report") {
      return { phase: "report", ...effectiveReportDecision };
    }
    return null;
  }, [phase, effectiveStartDecision, effectiveReportDecision]);

  useEffect(() => {
    if (!nudgeEnabled || !visibilityDecision) return;
    const sid = sessionRef.current?.session_id || "";
    const key = [
      visibilityDecision.phase, visibilityDecision.pill_shown,
      visibilityDecision.reason, visibilityDecision.balance_source,
      selectedMode, sid,
    ].join("|");
    if (lastVisibilityKeyRef.current === key) return; // dedup per stable state
    lastVisibilityKeyRef.current = key;
    reportTopupNudgeVisibility({
      phase: visibilityDecision.phase,
      session_id: sid || undefined,
      mode: selectedMode || undefined,
      pill_shown: !!visibilityDecision.pill_shown,
      reason: visibilityDecision.reason,
      balance_source: visibilityDecision.balance_source,
      client_event_id: `${key}:${Date.now()}`.slice(0, 120),
    }).catch(() => { /* diagnostics only — never affect the session UX */ });
  }, [visibilityDecision, nudgeEnabled, selectedMode]);

  // Lazy-load packages once a nudge becomes relevant (cheap; browser-cached).
  useEffect(() => {
    if (!(showStartPill || showReportPill)) return;
    if (topupPackages.length > 0) return;
    let alive = true;
    fetch(`${TOPUP_BACKEND}/api/payments/packages/public`, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : { packages: [] }))
      .then((d) => {
        if (alive) setTopupPackages((d?.packages || []).filter((p) => p.active));
      })
      .catch(() => { /* manual modal path can refetch */ });
    return () => { alive = false; };
  }, [showStartPill, showReportPill, topupPackages.length]);

  // Open the SINGLE shared PointsPurchaseModal. Guarded so repeated clicks
  // never stack instances, and stamps the shared "auto-shown" marker so the
  // app-level SmartTopUpTrigger will not ALSO open a second modal.
  const openTopUpModal = useCallback(() => {
    setTopUpModalOpen((cur) => {
      if (cur) return cur;
      markTopUpAutoShown();
      return true;
    });
  }, []);
  const closeTopUpModal = useCallback(() => {
    setTopUpModalOpen(false);
    // Phase 0B — feed the EduTalk-Live-Coach-ONLY per-student snooze ledger.
    // The shared app-wide dismissal log is intentionally NOT written here so
    // the general app-wide popup behaviour stays unchanged.
    recordEduTalkTopUpDismiss(topupStudentId);
  }, [topupStudentId]);
  // BUG 3 hardening — dismiss the PILL directly, without requiring the
  // student to open the modal first. Records into the same snooze ledger
  // as closeTopUpModal (so 3 dismissals via either path still escalate to
  // the 7-day snooze), plus an immediate this-session hide.
  const dismissTopUpPill = useCallback(() => {
    setPillDismissedThisVisit(true);
    recordEduTalkTopUpDismiss(topupStudentId);
  }, [topupStudentId]);
  const creditedTopUpModal = useCallback(() => {
    setTopUpModalOpen(false); // modal refreshes balance via its own bridge
  }, []);

  const cleanup = useCallback(() => {
    // Issue 4 fix — always clear the active-session flag on any teardown
    // path (unmount, explicit end, error). Safe/idempotent even if this
    // particular session never reached "live" (unregister on a session_id
    // that was never registered, or a null id, is a no-op).
    if (sessionRef.current?.session_id) {
      unregisterActiveSession(sessionRef.current.session_id);
    }
    // Re-audit hygiene fix — every OTHER ref below self-nulls right where
    // it's used; sessionRef didn't (only closeAll() nulled it, after
    // calling cleanup()). Safe here: finishToReport captures session_id
    // into a local `sid` BEFORE calling cleanup().
    sessionRef.current = null;
    // Bug fix — resume the book's narration audio, but ONLY if WE paused
    // it when this session started (never true if the student had
    // already paused it themselves, or if it was already resumed by one
    // of startSession's own early-failure branches). Safe/idempotent on
    // every teardown path (unmount, explicit end, WS drop, error).
    if (bookAudioWasPlayingRef.current) {
      bookAudioWasPlayingRef.current = false;
      try { bookAudioRef.current?.play?.(); } catch { /* noop */ }
    }
    try { stopMicRef.current?.(); } catch { /* noop */ }
    stopMicRef.current = null;
    try { wsRef.current?.close(); } catch { /* noop */ }
    wsRef.current = null;
    try { playerRef.current?.close(); } catch { /* noop */ }
    playerRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (fallbackRef.current) clearTimeout(fallbackRef.current);
    fallbackRef.current = null;
    if (topupRetryTimerRef.current) clearTimeout(topupRetryTimerRef.current);
    topupRetryTimerRef.current = null;
    if (wsErrorGraceTimerRef.current) clearTimeout(wsErrorGraceTimerRef.current);
    wsErrorGraceTimerRef.current = null;
    if (greetingTimerRef.current) clearTimeout(greetingTimerRef.current);
    greetingTimerRef.current = null;
    // ── Phase 0A — clear all greeting watchdogs and invalidate the greeting
    // controller so no stale timer/callback from a prior attempt can arm mic.
    const wd = greetingWatchdogsRef.current;
    Object.keys(wd).forEach((k) => { if (wd[k]) { clearTimeout(wd[k]); wd[k] = null; } });
    try { greetingControllerRef.current?.cleanup(); } catch { /* noop */ }
    micArmedRef.current = false;
    // V2 Bug 2 — clear the legacy greeting quarantine on teardown.
    greetingLegacyQuarantineRef.current = false;
    // ── Correction 2 — cancel any in-flight reward recovery polling so a
    // closed/unmounted session never keeps polling or attaches a stale
    // offer. The controller clears its timer + bounded budget + cycle.
    rewardPollControllerRef.current?.cancel();
    // Correction B — cancel any in-flight announcement-delivery retries on
    // session change / unmount so a closed session never keeps announcing.
    announceRetryControllerRef.current?.cancel();
    // Hotfix v1 — cancel the persistent reward-status poll (clears its single
    // timer + in-flight flag) and drop the last status on close so a NEW
    // session never inherits a stale panel state.
    statusPollControllerRef.current?.cancel();
    setRewardStatus(null);
    rewardConfirmedAnnouncedRef.current = new Set();
    // ── Phase 1 SURPRISE REWARDS — clear any pending reward UI on close.
    dispatchReward({ kind: "reset" });
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  // ── Blocker E + Correction B — active-offer recovery + RESILIENT
  // bounded polling. Recovers the authoritative offer for the CURRENT
  // authenticated session on connect / reconnect, rejects stale
  // responses after a session change, polls ONLY non-final states with
  // capped exponential backoff, prevents overlapping requests, and
  // stops on granted / terminal / expired.
  //
  // Resilience invariants (Correction B):
  //   * a transient request rejection or temporary offer:null response
  //     while the local claim is still unresolved must NOT terminate
  //     the bounded loop — the next bounded poll is rescheduled;
  //   * repeated pending events for the SAME offer must NOT reset the
  //     bounded attempt counter (only a genuinely new offer / claim
  //     cycle resets it) so the loop remains bounded;
  //   * granted / terminal / expired stop polling immediately;
  //   * a session change cancels the loop;
  //   * unmount cancels the loop;
  //   * pending / unknown never reveal success.
  const recoverActiveOffer = useCallback(async () => {
    const ctrl = rewardPollControllerRef.current;
    const s = sessionRef.current;
    if (!s || !s.session_id) { ctrl.settle({ schedule: false }); return; }
    const sidAtRequest = s.session_id;
    let outcome = "stale";
    let recoveredOffer = null;
    try {
      const data = await getActiveRewardOffer(sidAtRequest);
      // Stale-response guard: ignore if the session changed/closed while
      // the request was in flight.
      if (!sessionRef.current
        || sessionRef.current.session_id !== sidAtRequest) {
        outcome = "stale";
      } else {
        const recovered = data && data.offer;
        if (recovered) {
          recoveredOffer = recovered;
          outcome = "recovered";
          dispatchReward({ kind: "recovered", recovered });
          // Correction 1 (final) — when bounded polling discovers an
          // authoritative ``granted`` / ``confirmed`` offer AFTER an
          // earlier pending claim, ARM the bounded announcement-delivery
          // retry controller (Correction B). It sends one
          // ``announce_confirmed_reward`` over the ALREADY-OPEN live coach
          // WebSocket and retries ONLY retryable acknowledgements
          // (in_progress / inject_failed / lost ack) with bounded backoff,
          // stopping on delivered / authoritative already_delivered /
          // permanent rejection / exhaustion / cancel. The visual reveal is
          // independent (driven by the ``recovered`` dispatch above) and is
          // never repeated by this loop.
          //
          // We do NOT add the offer to the "announced" set here — only the
          // backend's ``reward_announce_ack`` with durable evidence
          // (delivered / already_delivered), handled in ``onWsMessage``,
          // marks it complete. A duplicate granted for the same offer does
          // not reset the bounded budget; a reconnect resumes an undelivered
          // announcement.
          const recState = recovered && recovered.state;
          const recOfferId = recovered && recovered.offer_id;
          if ((recState === "granted" || recState === "confirmed")
              && recOfferId
              && !rewardConfirmedAnnouncedRef.current.has(recOfferId)) {
            announceRetryControllerRef.current.start(recOfferId, sidAtRequest);
          }
        } else {
          // Temporary empty response — DO NOT reveal success, DO NOT
          // dispatch a misleading terminal/local-failure state.
          // Resilience-decide below handles whether to keep polling.
          outcome = "empty";
        }
      }
    } catch {
      outcome = "error";
    }
    // Resilience decision — pure helper consumed by both this production
    // loop AND the behavioural Jest tests.
    const decision = decideNextPoll({
      outcome,
      recovered: recoveredOffer,
      prevState: rewardStateRef.current,
    });
    if (!decision.schedule && outcome === "recovered" && recoveredOffer) {
      // Terminal / granted / claimable — cycle ends.
      ctrl.endCycle();
    }
    // Clear in-flight + (re)arm the next bounded poll if warranted. The
    // controller owns the timer-starvation gate and the bounded budget.
    ctrl.settle(decision);
  }, []);
  useEffect(() => { recoverRef.current = recoverActiveOffer; }, [recoverActiveOffer]);

  // v2 Blocker 2 — generation-safe status fetch. The controller passes the
  // active generation `token`; a stale response (the session changed/closed
  // while the request was in flight) is ignored two ways: the session-id guard
  // below AND `settle(token, …)` which the controller drops if the token is
  // stale. The controller enforces one timer + one in-flight request, and we
  // keep polling only while the backend reports a non-final state. Eligibility
  // is NEVER inferred from Gemini praise or local counters.
  const fetchRewardStatus = useCallback(async (token) => {
    const ctrl = statusPollControllerRef.current;
    const s = sessionRef.current;
    if (!s || !s.session_id) { ctrl.settle(token, false); return; }
    const sidAtRequest = s.session_id;
    // v5 Blocker 2 — capture the claim-truth revision barrier at dispatch so a
    // newer authoritative claim outcome that lands while this request is in
    // flight cannot be clobbered by this (now-stale) response.
    const revAtRequest = statusRevisionRef.current;
    let keepGoing = false;
    let queueRefresh = false;
    try {
      const data = await getRewardStatus(sidAtRequest);
      if (sessionRef.current
        && sessionRef.current.session_id === sidAtRequest && data) {
        keepGoing = shouldKeepPollingStatus(data.state);
        const { apply, queueRefresh: qr } = reconcileStatusRevision(
          revAtRequest, statusRevisionRef.current);
        if (apply) {
          setRewardStatus(data);
        } else {
          // A newer same-session claim truth landed while this request was in
          // flight — drop the stale status and queue exactly one coalesced
          // refresh (below, after settle) so the panel re-syncs without ever
          // overwriting the newer truth.
          queueRefresh = qr;
        }
      }
    } catch {
      keepGoing = true; // transient network error — keep the bounded loop alive
    }
    ctrl.settle(token, keepGoing);
    // v5 Blocker 2 — queue the single refresh AFTER settle (the controller is no
    // longer in flight) so ``poke`` begins one fresh request without overlap.
    if (queueRefresh) ctrl.poke();
  }, []);
  useEffect(() => {
    statusFetchRef.current = fetchRewardStatus;
  }, [fetchRewardStatus]);

  // Correction 2 — arm a (possibly new) bounded poll cycle through the
  // shared production controller. The controller routes the budget reset
  // through ``shouldResetPollBudget`` so repeated pending events for the
  // SAME offer cannot turn the loop into an effectively unbounded stream.
  const armResilientPollCycle = useCallback((stateHint, offerId) => {
    rewardPollControllerRef.current.armCycle(stateHint, offerId || null);
  }, []);

  const finishToReport = useCallback(
    (rep, charged, refundState) => {
      const sid = sessionRef.current?.session_id || null;
      cleanup();
      setReport(rep || null);
      if (charged != null) setPointsCharged(charged);
      setRefundState(refundState || null);
      setPhase("report");
      // ── Phase 1 Smart Top-Up Nudge — fetch the Stage 3 FINALIZATION the
      // report pill renders from, and refresh the displayed balance from the
      // SETTLED value via the existing AuthContext callback. The report pill
      // never uses Stage 1/Stage 2 numbers or the session-start balance.
      setTopupFinalization(null);
      if (sid && config && config.topup_nudge_enabled) {
        const applyFinalization = (r) => {
          const fin = r && r.finalization;
          setTopupFinalization(fin || null);
          const settled = settledBalanceToApply(fin);
          if (settled != null && typeof setBalance === "function") {
            setBalance(settled);
          }
          return fin;
        };
        getTopupNudgeReport(sid)
          .then((r) => {
            const fin = applyFinalization(r);
            // Finalization is written before the report is shown; retry once
            // defensively if it is not yet visible.
            if (!fin) {
              if (topupRetryTimerRef.current) clearTimeout(topupRetryTimerRef.current);
              topupRetryTimerRef.current = setTimeout(() => {
                topupRetryTimerRef.current = null;
                getTopupNudgeReport(sid).then(applyFinalization).catch(() => {});
              }, 800);
            }
          })
          .catch(() => { /* pill simply stays hidden */ });
      }
    },
    [cleanup, config, setBalance]
  );

  // REST fallback to guarantee finalization + report even if the WS drops.
  const restEnd = useCallback(
    async (reason) => {
      const s = sessionRef.current;
      if (!s) return;
      try {
        const res = await endLiveSession({
          session_id: s.session_id,
          reason,
          transcript,
        });
        finishToReport(
          res?.report,
          res?.session?.final_charged ?? s.cost_points,
          res?.session?.refund_state
        );
      } catch {
        finishToReport(null, 0, null);
      }
    },
    [transcript, finishToReport]
  );

  const handleEnd = useCallback(
    (reason = "client_end") => {
      if (endingRef.current) return;
      endingRef.current = true;
      try { stopMicRef.current?.(); } catch { /* noop */ }
      // Ask the backend bridge to finalize + send the report frame, passing
      // the REAL end reason so the backend can decide completed vs cancelled
      // vs failed (and apply the min_useful_seconds refund rule).
      try {
        wsRef.current?.send(JSON.stringify({ type: "end", reason }));
      } catch { /* noop */ }
      // Fallback: if no report frame arrives, finalize via REST.
      fallbackRef.current = setTimeout(() => restEnd(reason), 7000);
    },
    [restEnd]
  );

  // ── Phase 0A — greeting lifecycle helpers. Lazy-initialised ONCE (the same
  // pattern this file uses for its reward controllers). They only close over
  // stable refs + module constants, so they never go stale across renders. The
  // pure controller (greetingControllerRef) owns the arm decision; these
  // helpers translate that into socket frames, watchdog timers, and mic arming.
  const gHelpersRef = useRef(null);
  if (gHelpersRef.current === null) {
    const nowIso = () => new Date().toISOString();
    const sendWs = (obj) => {
      try {
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      } catch { /* noop */ }
    };
    const clearWd = (name) => {
      const wd = greetingWatchdogsRef.current;
      if (wd[name]) { clearTimeout(wd[name]); wd[name] = null; }
    };
    const clearAllWd = () =>
      ["request", "firstAudio", "turnComplete", "drain"].forEach(clearWd);
    const startWd = (name, ms, fn) => {
      clearWd(name);
      greetingWatchdogsRef.current[name] = setTimeout(fn, ms);
    };
    const armMic = async (trigger) => {
      // V3 item 2 — truthful + correctly-attributed mic acknowledgement.
      // Capture the attempt id and connection generation AT INVOCATION so a
      // generation/attempt change while ``startMicCapture`` is pending cannot
      // cause a stale generation's mic-arm completion to be attributed to a
      // newer generation. ``mic_armed`` is sent ONLY when all three are true:
      //   1. ``startMicCapture`` actually succeeded (stop handle installed),
      //   2. the captured attempt id is STILL the controller's current id,
      //   3. the captured connection generation is STILL the current one.
      // On failure OR on staleness, NO ack is sent. The existing mic-failure
      // path inside ``armMicRef.current`` (``setError`` +
      // ``handleEnd("mic_failed")``) keeps unchanged user-facing failure /
      // session-end / refund behaviour.
      const aid = greetingControllerRef.current?.getAttemptId();
      const capturedGen = greetingConnGenRef.current;
      let ok = micArmedRef.current; // already-armed counts as success
      if (!micArmedRef.current && typeof armMicRef.current === "function") {
        const res = await armMicRef.current(); // returns { ok: bool }
        ok = !!(res && res.ok);
      }
      if (!ok) return;
      // Re-check both staleness signals AFTER the async mic activation has
      // settled. A generation bump or attempt-id change while we were awaiting
      // means this ack would be attributed to the wrong (newer) generation.
      if (aid !== greetingControllerRef.current?.getAttemptId()) return;
      if (capturedGen !== greetingConnGenRef.current) return;
      sendWs({ type: "greeting_client_ack", value: "mic_armed",
        greeting_attempt_id: aid, trigger, client_ts: nowIso() });
    };
    const onDrained = (attemptId, gen) => {
      const res = greetingControllerRef.current?.onPlaybackDrained(
        { attemptId, connectionGeneration: gen });
      if (res && res.armMic) {
        clearAllWd();
        sendWs({ type: "greeting_client_ack", value: "playback_complete",
          greeting_attempt_id: attemptId, trigger: "queue_drained",
          client_ts: nowIso() });
        armMic("playback_complete");
      }
    };
    const fallback = (reason, genArg) => {
      const ctrl = greetingControllerRef.current;
      if (!ctrl) return;
      // V2 Bug 1 — use the generation CAPTURED when this watchdog/closure was
      // created, never `greetingConnGenRef.current` read at execution time, so
      // a timer created by generation N can never masquerade as generation N+1.
      const gen = genArg != null ? genArg : greetingConnGenRef.current;
      const res = ctrl.requestFallback({ reason, connectionGeneration: gen });
      if (res.stale || res.ignored) return;
      clearAllWd();
      greetingAwaitCancelAckRef.current = !!res.awaitCancelAck;
      // V2 Bug 2 — open the legacy greeting quarantine ONLY for a non-
      // authoritative (legacy / untagged) fallback. Authoritative attempts tag
      // their audio, so the attempt-id rules suppress stale greeting audio and
      // normal interaction audio is never blocked.
      greetingLegacyQuarantineRef.current = !res.awaitCancelAck;
      // Tell the (new) backend we are falling back so it can suppress remaining
      // greeting audio and return greeting_state=cancelled.
      sendWs({ type: "greeting_client_ack", value: "fallback_requested",
        greeting_attempt_id: res.attemptId, reason, client_ts: nowIso() });
      // Cancel local greeting playback FIRST — a timeout must never open the
      // mic over still-playing greeting audio.
      try { playerRef.current?.cancelPendingPlayback(); } catch { /* noop */ }
      const c2 = ctrl.onPlaybackCancelled(
        { attemptId: res.attemptId, connectionGeneration: gen });
      // Legacy path arms now; new backend waits for greeting_state=cancelled.
      if (c2 && c2.armMic) armMic("controlled_fallback");
    };
    const onTurnComplete = (attemptId, genArg) => {
      const ctrl = greetingControllerRef.current;
      if (!ctrl) return;
      const gen = genArg != null ? genArg : greetingConnGenRef.current;
      const res = ctrl.onTurnComplete({ attemptId, connectionGeneration: gen });
      if (res.accepted && res.armDrainWait) {
        clearWd("turnComplete");
        clearWd("firstAudio");
        const token = ++greetingDrainTokenRef.current;
        const aid = res.attemptId;
        try {
          playerRef.current?.beginDrainWait(token, () => onDrained(aid, gen));
        } catch { /* noop */ }
        startWd("drain", GREETING_TIMEOUTS.GREETING_PLAYBACK_DRAIN_TIMEOUT_MS,
          () => fallback("playback_drain_timeout", gen));
      }
    };
    const onCancelledAck = (attemptId, genArg) => {
      const ctrl = greetingControllerRef.current;
      if (!ctrl) return;
      const gen = genArg != null ? genArg : greetingConnGenRef.current;
      const res = ctrl.onCancelledAck(
        { attemptId, connectionGeneration: gen });
      if (res && res.armMic) armMic("controlled_fallback");
    };
    gHelpersRef.current = {
      sendWs, clearWd, clearAllWd, startWd, armMic, onDrained, fallback,
      onTurnComplete, onCancelledAck,
    };
  }

  const onWsMessage = useCallback(
    (ev, capturedGen, socket) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const g = gHelpersRef.current;
      const ctrl = greetingControllerRef.current;
      // V2 Bug 1 / Bug 2 — use the socket generation CAPTURED when THIS socket's
      // onmessage handler was created. A frame delivered by an old socket can
      // never read the live ref and masquerade as the current generation.
      const gen = capturedGen != null ? capturedGen : greetingConnGenRef.current;
      // V3 item 1 — combined generation + socket-identity guard. A frame is
      // STALE (and must perform NO side effect) when EITHER its captured
      // connection generation does not equal the current generation OR the
      // emitting socket is no longer ``wsRef.current``. Generation alone misses
      // a same-generation-but-replaced socket; socket identity alone misses a
      // generation bump on the same socket instance. Helper used per-case at
      // every location currently performing a side effect before staleness was
      // checked.
      const isStale = () =>
        gen !== greetingConnGenRef.current
        || (socket != null && socket !== wsRef.current);
      switch (msg.type) {
        case "ready": {
          // V3 item 1 — reject a stale ready before any side effect (was
          // starting the request watchdog without any guard).
          if (isStale()) break;
          setConnection("connected");
          setPhase("live");
          // Issue 4 fix — tell the shared active-session registry a paid
          // session is now in progress, so StatusEnforcer's hard-logout
          // backstop and RestrictionGuard's auto-signout countdown both
          // defer instead of yanking the student out mid-conversation.
          // Cleared unconditionally in cleanup() below (unmount, explicit
          // end, or any other teardown path all route through it).
          if (sessionRef.current?.session_id) {
            registerActiveSession(sessionRef.current.session_id);
          }
          // V2 Bug 1 — START the greeting-request watchdog ONLY after backend
          // `ready` (never in ws.onopen). Capture this socket's generation so a
          // stale-generation timeout can never fire as the current generation.
          g.startWd("request", GREETING_TIMEOUTS.GREETING_REQUEST_TIMEOUT_MS,
            () => g.fallback("request_timeout", gen));
          break;
        }
        case "coach_greeting_sent": {
          // ── Phase 0A — legacy compatibility frame. Treated ONLY as
          // `requested`; it must NEVER arm the microphone.
          // V3 item 1 — reject a stale frame before any side effect (was
          // clearing the request watchdog unconditionally).
          if (isStale()) break;
          const r = ctrl?.onLegacyGreetingSent({
            attemptId: msg.greeting_attempt_id,
            connectionGeneration: gen });
          g.clearWd("request");
          if (r && !r.stale && !r.ignored) {
            g.startWd("firstAudio",
              GREETING_TIMEOUTS.GREETING_FIRST_AUDIO_TIMEOUT_MS,
              () => g.fallback("first_audio_timeout", gen));
          }
          break;
        }
        case "greeting_state": {
          const aid = msg.greeting_attempt_id;
          switch (msg.value) {
            case "requested": {
              // V3 item 1 — capture the controller result and gate the
              // watchdog clear/start on it being non-stale and non-ignored
              // (was calling clearWd / startWd unconditionally).
              if (isStale()) break;
              const r = ctrl?.onServerRequested({
                attemptId: aid, connectionGeneration: gen });
              if (r && (r.stale || r.ignored)) break;
              g.clearWd("request");
              g.startWd("firstAudio",
                GREETING_TIMEOUTS.GREETING_FIRST_AUDIO_TIMEOUT_MS,
                () => g.fallback("first_audio_timeout", gen));
              break;
            }
            case "skipped": {
              // ── V2 Bug 6 — authoritative reconnect skip. The backend proved a
              // prior attempt was acknowledged complete (mic_armed /
              // playback_complete). Adopt the authoritative attempt id, cancel
              // ALL greeting watchdogs (the `skipped` frame must never fall
              // through to a request-timeout), flush any pending greeting
              // playback, clear the legacy quarantine, and arm the mic EXACTLY
              // ONCE through the explicit skip path — never via a timeout. A
              // stale skipped frame from an old generation can never arm.
              const r = ctrl?.onSkipped({ attemptId: aid, connectionGeneration: gen });
              if (r && r.stale) break;
              g.clearAllWd();
              greetingLegacyQuarantineRef.current = false;
              try { playerRef.current?.cancelPendingPlayback(); } catch { /* noop */ }
              if (r && r.armMic) g.armMic("skip");
              break;
            }
            case "first_audio": {
              const r = ctrl?.onFirstAudio({ attemptId: aid, connectionGeneration: gen });
              if (r && !r.stale && !r.ignored) {
                g.clearWd("firstAudio");
                g.startWd("turnComplete",
                  GREETING_TIMEOUTS.GREETING_TURN_COMPLETE_TIMEOUT_MS,
                  () => g.fallback("turn_complete_timeout", gen));
              }
              break;
            }
            case "turn_complete":
              g.onTurnComplete(aid, gen);
              break;
            case "failed": {
              // V3 item 1 — capture the controller result and gate the
              // watchdog clear calls on it being non-stale and non-ignored
              // (was calling clearWd unconditionally on the next two lines).
              if (isStale()) break;
              const r = ctrl?.onFailed({ attemptId: aid, reason: msg.reason,
                connectionGeneration: gen });
              if (r && (r.stale || r.ignored)) break;
              g.clearWd("request");
              g.clearWd("firstAudio");
              if (r && r.needPlaybackCancel) {
                try { playerRef.current?.cancelPendingPlayback(); } catch { /* noop */ }
                const c2 = ctrl?.onPlaybackCancelled({ attemptId: aid, connectionGeneration: gen });
                if (c2 && c2.armMic) g.armMic("controlled_fallback");
              }
              break;
            }
            case "cancelled":
              g.onCancelledAck(aid, gen);
              break;
            default:
              break;
          }
          break;
        }
        case "state": {
          // During a pending greeting, a generic backend state=listening may
          // still arrive at the original wire timing; the frontend must NOT
          // expose live listening/mic-active state until the greeting gate (or
          // controlled fallback) completes.
          const st = ctrl?.getState();
          const greetingPending = !!(st && !st.micArmed && !st.cancelled
            && st.status !== "idle" && st.status !== "armed");
          if (greetingPending && msg.value === "listening") break;
          setOrbState(msg.value || "listening");
          break;
        }
        case "audio": {
          // ── V2 Bug 2 — suppress only STALE/CANCELLED greeting audio before
          // enqueue (never normal interaction audio). The pure helper decides
          // using the captured socket generation, the active attempt id, the
          // frame's attempt id, and the legacy quarantine flag.
          const stA = ctrl?.getState();
          const suppress = shouldSuppressGreetingAudio({
            status: stA?.status,
            cancelled: !!stA?.cancelled,
            skipped: !!stA?.skipped,
            micArmed: !!stA?.micArmed,
            activeAttemptId: stA?.attemptId,
            frameAttemptId: msg.greeting_attempt_id,
            legacyQuarantineActive: greetingLegacyQuarantineRef.current,
            capturedConnectionGeneration: gen,
            activeConnectionGeneration: ctrl?.getGeneration?.(),
          });
          if (suppress) break;
          try {
            playerRef.current?.enqueue(msg.data);
          } catch (e) {
            // Surface decode/playback errors instead of silently swallowing them.
            console.error("[EduTalk] audio enqueue error:", e);
            break;
          }
          setOrbState("speaking");
          // Greeting first-audio detection. An authoritative tagged frame OR
          // (legacy) untagged audio while the greeting is pending belongs to
          // the active attempt.
          const st = ctrl?.getState();
          if (st && !st.micArmed && !st.cancelled && !st.firstAudioSeen
              && (st.status === "requested" || st.status === "first_audio")) {
            const r = ctrl.onFirstAudio({ attemptId: msg.greeting_attempt_id,
              connectionGeneration: gen });
            if (r && !r.stale && !r.ignored) {
              g.clearWd("firstAudio");
              g.startWd("turnComplete",
                GREETING_TIMEOUTS.GREETING_TURN_COMPLETE_TIMEOUT_MS,
                () => g.fallback("turn_complete_timeout", gen));
            }
          }
          break;
        }
        case "transcript":
          // v1.5 — coalesce streaming token fragments into readable
          // utterance-level blocks.
          //
          // Gemini Live streams short token deltas (e.g. "SAID", "from",
          // "to try", "the first", "line?"). The previous handler pushed
          // each delta as its own entry, producing a transcript made of
          // tiny one-word fragments. Now we append the delta to the
          // LAST open entry IF it shares the same role and the role's
          // turn has not closed yet (open=true). On a role change or
          // after a turn_complete (open=false) we start a new entry.
          setTranscript((t) => {
            const cleanText = String(msg.text || "");
            if (!cleanText) return t;
            const last = t[t.length - 1];
            if (last && last.role === msg.role && last.open !== false) {
              // Smart join: avoid double spaces, attach punctuation
              // tightly, and preserve trailing space inside a delta.
              const prev = last.text || "";
              let joiner = "";
              const endsWithSpace = /\s$/.test(prev);
              const startsWithSpace = /^\s/.test(cleanText);
              const startsWithPunct = /^[.,!?;:…)\]]/.test(cleanText);
              if (!endsWithSpace && !startsWithSpace && !startsWithPunct && prev.length > 0) {
                joiner = " ";
              }
              const merged = { ...last, text: prev + joiner + cleanText };
              return [...t.slice(0, -1), merged];
            }
            // Close the previous role's open entry on a role change.
            const closed = last ? [...t.slice(0, -1), { ...last, open: false }] : t;
            const next = [...closed, { role: msg.role, text: cleanText, open: true }];
            // Re-audit hardening — LiveTranscriptPanel renders every entry
            // via a plain .map() with no virtualization/cap, and this array
            // previously grew for the entire session with no bound. Cap it
            // to the most recent MAX_TRANSCRIPT_LINES utterance blocks (drop
            // the OLDEST, keep the newest — this is a live scrolling feed,
            // unlike the backend's report transcript which keeps the
            // earliest entries for report content). Ordinary sessions never
            // reach anywhere near this many utterance-level blocks.
            return next.length > MAX_TRANSCRIPT_LINES
              ? next.slice(next.length - MAX_TRANSCRIPT_LINES)
              : next;
          });
          break;
        case "turn_complete":
          // V3 item 1 — reject a stale turn_complete frame before any side
          // effect (was clearing the legacy quarantine flag unconditionally).
          if (isStale()) break;
          setOrbState("listening");
          // v1.5 — close the last open transcript entry so the next
          // delta from the SAME role starts a new readable block.
          setTranscript((t) => {
            if (t.length === 0) return t;
            const last = t[t.length - 1];
            if (last.open === false) return t;
            return [...t.slice(0, -1), { ...last, open: false }];
          });
          // ── Phase 0A — legacy-compatible greeting boundary. The FIRST generic
          // turn_complete while the greeting is still pending is the greeting
          // turn boundary (an explicit greeting_state=turn_complete is
          // authoritative; receiving both is idempotent in the controller).
          {
            // V2 Bug 2 — the first generic greeting turn boundary ENDS the
            // legacy greeting quarantine (untagged late greeting audio window).
            // V3 item 1 — only the current generation/socket may clear it
            // (guarded by isStale() above).
            greetingLegacyQuarantineRef.current = false;
            const st = ctrl?.getState();
            if (st && !st.micArmed && !st.turnCompleteSeen && !st.cancelled) {
              g.onTurnComplete(ctrl.getAttemptId(), gen);
            }
          }
          break;
        case "time_up":
          handleEnd("time_up");
          break;
        case "report":
          if (fallbackRef.current) clearTimeout(fallbackRef.current);
          finishToReport(
            msg.report,
            msg.charged != null ? msg.charged : sessionRef.current?.cost_points,
            msg.refund_state
          );
          break;
        case "closed":
          // If a report was already shown this is a no-op.
          break;
        // ── Phase 1 corrected SURPRISE REWARDS — backend-driven events.
        // Every reward event flows through the tested pure reducer
        // (``applyRewardEvent``). That reducer applies STRICT
        // session-bound filtering: an offer event with a missing or
        // mismatched session_id is rejected before mounting a button.
        case "reward_offer_available":
        case "reward_claim_pending":
        case "reward_claim_confirmed":
        case "reward_claim_failed":
          dispatchReward({ kind: "event", event: msg });
          // v5 Blocker 1 — an authoritative WebSocket ``reward_claim_failed``
          // carrying ``unavailable``/``disabled`` means a gate closed between
          // offer and claim. Mirror the REST path: IMMEDIATELY reflect a
          // non-clickable status for THIS session (clear the displayed offer id;
          // the server offer is preserved) so the panel cannot be tapped again
          // before the next poll. v5 Blocker 2 — bump the revision barrier
          // BEFORE the coalesced refresh below so the queued status request
          // reads the new revision and a status response already in flight can
          // never overwrite this truth with stale data. A non-authoritative
          // failure leaves the helper returning null and keeps the ordinary
          // retryable behaviour unchanged.
          // v7 — unified authoritative claim-outcome normalization. The
          // backend may carry the decisive lifecycle value in ``msg.state``
          // (future payload) OR ``msg.reason`` (current production shape:
          // ``{ type: "reward_claim_failed", offer_id, reason }``). The SINGLE
          // canonical normalizer maps every recognized alias to one of
          // unavailable / disabled / claiming / expired / terminal. For any
          // recognized outcome we bump the revision barrier BEFORE the
          // coalesced refresh, IMMEDIATELY set the canonical non-clickable
          // status for THIS session (the server offer is preserved), and clear
          // the local claiming flag ONLY when the canonical state is not
          // "claiming". An in-flight/unresolved (claiming) outcome keeps the
          // spinner truthful and blocks a second claim. A non-authoritative
          // failure normalizes to null and keeps the ordinary retryable path.
          if (msg.type === "reward_claim_failed") {
            const wsClaimOutcome = normalizeWsClaimFailedOutcome(msg);
            if (wsClaimOutcome) {
              statusRevisionRef.current += 1;
              setRewardStatus((prev) =>
                statusFromWsClaimFailed(
                  prev, msg, sessionRef.current?.session_id) || prev);
              if (wsClaimOutcome === "claiming") {
                // Keep the spinner active for an unresolved/in-flight outcome.
                dispatchReward({
                  kind: "event",
                  event: {
                    type: "reward_claim_pending",
                    offer_id: msg.offer_id,
                    session_id: sessionRef.current?.session_id,
                  },
                });
              } else {
                dispatchReward({ kind: "claim_local_failed", reason: "" });
              }
            }
          }
          // Hotfix v1 — refresh the persistent panel status promptly after any
          // authoritative reward event (coalesced into the single in-flight
          // slot; never stacks a second request).
          statusPollControllerRef.current?.poke();
          // Blocker C — start immediate bounded polling on any
          // unresolved WebSocket reward state. ``reward_claim_pending``
          // (with or without ``persistent: true``) AND any
          // ``reward_claim_failed`` whose reason normalizes to a still-
          // unresolved confirmation state (retryable/unknown) must
          // trigger a poll. Granted / terminal / expired do NOT start
          // a new loop — the shared controller ignores non-pollable
          // hints via ``isPollableRecoveredState``.
          if (
            msg.type === "reward_claim_pending"
            || (msg.type === "reward_claim_failed"
                && (normalizeWsClaimFailedOutcome(msg) === "claiming"
                    || /confirming/i.test(String(msg.reason || ""))))
          ) {
            // v7 — start bounded polling only for an unresolved/in-flight
            // outcome (canonical "claiming") or an explicit pending event.
            // Terminal / expired / unavailable / disabled do NOT start a loop.
            armResilientPollCycle(
              "pending_confirmation", msg.offer_id || null);
          }
          break;
        case "reward_announce_ack":
          // Correction B (final) — feed the backend acknowledgement into the
          // bounded announcement-delivery retry controller. It schedules a
          // bounded retry for retryable acks (in_progress / inject_failed /
          // lost ack) and stops on delivered / authoritative already_delivered
          // / permanent rejection / exhaustion. The offer is marked locally
          // completed ONLY on DURABLE delivery evidence (delivered or
          // already_delivered) — never for in_progress / inject_failed /
          // retryable / socket_unavailable. The visual reveal is independent
          // of this ack and is never affected.
          announceRetryControllerRef.current.onAck(msg);
          if (msg.offer_id && (msg.delivered || msg.already_delivered)) {
            rewardConfirmedAnnouncedRef.current.add(msg.offer_id);
          }
          break;
        case "error":
          setError(`Live Coach error: ${msg.reason || "unknown"}`);
          // Backend auto-refunds failed sessions; just surface the report.
          if (!endingRef.current) restEnd("ws_error");
          break;
        default:
          break;
      }
    },
    [handleEnd, finishToReport, restEnd, armResilientPollCycle]
  );

  const startSession = useCallback(async () => {
    setError("");
    setStarting(true);
    setTranscript([]);
    setReport(null);
    endingRef.current = false;

    // Bug fix — pause the book's narration audio (a fully separate
    // player) the instant Start is tapped, so it never plays over the
    // coach. Only ever resumed later if WE were the one who paused it
    // (bookAudioWasPlayingRef) — a student who had already paused the
    // book themselves never gets it auto-resumed.
    bookAudioWasPlayingRef.current = !!bookAudioRef.current?.playing;
    if (bookAudioWasPlayingRef.current) {
      try { bookAudioRef.current.pause(); } catch { /* noop */ }
    }

    // iOS/mobile audio unlock — AudioContext.resume() must be called in
    // the synchronous part of the user-gesture handler, before any await.
    // On iOS Safari, calling resume() after an await silently fails and the
    // context stays suspended: audio frames are enqueued via src.start() but
    // never play until a real user gesture (e.g. a tap) unlocks the context.
    // Moving creation + resume here keeps both within the synchronous
    // gesture stack of the "Start" button click.
    const player = createAudioPlayer();
    player.setOnSpeaking((sp) => setOrbState(sp ? "speaking" : "listening"));
    playerRef.current = player;
    player.resume();

    // 1. Mic permission BEFORE any charge.
    let micStop;
    try {
      // We start capture only after the WS is ready; here we just probe
      // permission so the student is never charged on a denied mic.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      try { playerRef.current?.close(); } catch { /* noop */ }
      playerRef.current = null;
      setStarting(false);
      setError(
        "Microphone permission is needed. Please allow microphone access in your browser, then try again."
      );
      // Bug fix — the session never actually started; resume the book's
      // narration audio if we were the one who paused it above.
      if (bookAudioWasPlayingRef.current) {
        bookAudioWasPlayingRef.current = false;
        try { bookAudioRef.current?.play?.(); } catch { /* noop */ }
      }
      return;
    }

    // P0 fix — give AuthContext's GAS re-hydration a bounded window to
    // land if `password` wasn't resolved yet at render time (see
    // _waitForPassword's comment above). Cheap: resolves immediately via
    // the ref in the already-common case where it's already there.
    const resolvedStartPassword = password || (await _waitForPassword(studentRef));
    if (!resolvedStartPassword) {
      try { playerRef.current?.close(); } catch { /* noop */ }
      playerRef.current = null;
      setStarting(false);
      setError("Please refresh and log in again to use EduTalk Live Coach.");
      if (bookAudioWasPlayingRef.current) {
        bookAudioWasPlayingRef.current = false;
        try { bookAudioRef.current?.play?.(); } catch { /* noop */ }
      }
      return;
    }

    // 2. Reserve the session on the backend (points reserved here).
    let res;
    try {
      res = await startLiveSession({
        mode: selectedMode,
        password: resolvedStartPassword,
        book_slug: bookSlug,
        book_title: bookTitle,
        book_tier: bookTier,
        chapter_idx: chapterIdx,
        chapter_title: chapterTitle,
        current_paragraph: (visibleText || "").slice(0, 1800),
        // v1.5 — Khmer-Guided English Practice.
        // explain_language drives the coach's explanation language;
        // practice sentences + the student's answers always stay
        // English (enforced server-side in the system instruction).
        // points_balance_hint is DISPLAY-ONLY for the greeting and is
        // never read by billing — sending a wrong value here cannot
        // affect debits or refunds.
        explain_language: explainLang === "en" ? "en" : "km",
        points_balance_hint: typeof balance === "number" ? balance : null,
        client_idempotency_key: `${bookSlug}:${selectedMode}:${Date.now()}`,
      });
    } catch (e) {
      try { playerRef.current?.close(); } catch { /* noop */ }
      playerRef.current = null;
      setStarting(false);
      setError(e?.message || "Could not start the session.");
      // Bug fix — the session never actually started; resume the book's
      // narration audio if we were the one who paused it above.
      if (bookAudioWasPlayingRef.current) {
        bookAudioWasPlayingRef.current = false;
        try { bookAudioRef.current?.play?.(); } catch { /* noop */ }
      }
      return;
    }

    sessionRef.current = res;
    setPointsCharged(res.cost_points || 0);
    setRemaining(res.duration_seconds || 0);
    setConnection("connecting");
    setPhase("live");
    // BUG 1 hardening — register as an active session THE MOMENT the UI
    // shows "live" (the student has already been charged at this point),
    // not only once the WebSocket's "ready" frame arrives further below.
    // Previously there was a real window — REST success to WS ready —
    // during which the UI looked started but hasActiveSession() was still
    // false, so a chapter/page change in that window could remount this
    // component (via ReaderPage's liveCoachKeyRef guard, which itself only
    // pins once hasActiveSession() is true) and silently tear down a paid
    // session before it ever got a chance to connect. Idempotent, and the
    // "ready" handler below still calls it too (harmless, same session id).
    if (res.session_id) {
      registerActiveSession(res.session_id);
    }

    // 3. Audio player already created above (iOS gesture unlock requires it
    //    before the first await — do not move back below the API calls).

    // 4. Open the WebSocket bridge.
    const url = buildWsUrl(res.ws_path, res.ws_token);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStarting(false);

    // ── Session identity tracking — used by Finding 1 to detect a
    // truly new live session vs an ordinary reconnect of the same one.
    const liveSessionIdAtOpen = sessionRef.current?.session_id || null;
    // V2 Bug 1/2 — the generation captured for THIS socket's message handler.
    // Set inside ws.onopen (which always fires before any message), so every
    // frame this socket delivers is evaluated against the generation it was
    // created with — never a later live-ref value.
    let capturedGen = null;
    ws.onopen = async () => {
      player.resume();
      // ── Correction 2 + Correction 1 — recover the authoritative active
      // offer for THIS session on connect / reconnect. Only a genuinely
      // new live session may reset the bounded budget; an ordinary
      // WebSocket reconnect for the SAME live session preserves attempts
      // so a flaky network can never make the bounded loop effectively
      // unbounded. ``requestImmediate`` runs one recovery WITHOUT
      // consuming attempt budget (and re-sends any still-unacknowledged
      // delayed-confirmed announcement over this fresh connection).
      rewardPollControllerRef.current.onSessionOpen(liveSessionIdAtOpen);
      rewardPollControllerRef.current.requestImmediate();
      // Hotfix v1 — begin (or resume) the persistent reward-status poll for
      // THIS session. Recovers the panel's tracking/progressing/eligible/
      // claiming/confirmed truth on connect AND reconnect; bounded + single-
      // flight. ``start()`` runs one immediate status fetch.
      statusPollControllerRef.current.start();
      // Correction B — resume any undelivered announcement on reconnect
      // (within its bounded budget). No-op if the announcement is already
      // delivered/rejected/exhausted or none is in flight.
      announceRetryControllerRef.current.requestImmediate();
      // ── Phase 0A — every ws.onopen starts a NEW connection generation and a
      // fresh pending greeting slot, invalidating any prior attempt, timers,
      // queue waiter, and callbacks. No timer/callback from a previous
      // generation may arm the mic.
      gHelpersRef.current.clearAllWd();
      micArmedRef.current = false;
      const greetingOpen = greetingControllerRef.current.onConnectionOpen();
      greetingConnGenRef.current = greetingOpen.connectionGeneration;
      capturedGen = greetingOpen.connectionGeneration;
      // V2 Bug 2 — socket replacement ends any prior legacy greeting quarantine.
      greetingLegacyQuarantineRef.current = false;
      // Defer mic capture until the greeting gate (or controlled fallback)
      // completes. Arming earlier streams audio that Gemini treats as a
      // barge-in and suppresses the greeting turn. Store the arming closure
      // (it captures THIS socket) to be invoked later by the greeting
      // controller's arm decision.
      armMicRef.current = async () => {
        // V3 item 2 — return an explicit ``{ ok }`` result so the caller can
        // decide whether to send the ``mic_armed`` ack. No silent success on
        // failure: a failed ``startMicCapture`` returns ``{ ok: false }`` and
        // the existing session-end/refund path (``handleEnd("mic_failed")``)
        // runs exactly as today. ``startMicCapture``'s own signature is
        // unchanged.
        if (micArmedRef.current) return { ok: true };   // idempotent
        micArmedRef.current = true;
        try {
          micStop = await startMicCapture(
            (b64) => {
              try {
                ws.readyState === 1 &&
                  ws.send(JSON.stringify({ type: "audio", data: b64 }));
              } catch { /* noop */ }
            },
            (lvl) => setLevel(lvl)
          );
          stopMicRef.current = micStop;
          return { ok: true };
        } catch {
          micArmedRef.current = false;
          setError("Could not access the microphone audio stream.");
          handleEnd("mic_failed");
          return { ok: false };
        }
      };
      // V2 Bug 1 — the greeting-REQUEST watchdog is NO LONGER started here.
      // A socket that opens but never receives backend `ready` must NOT arm the
      // mic or fire a greeting request timeout. The request watchdog is started
      // ONLY in the `ready` message handler (with this socket's captured
      // generation), and `skipped`/`failed`/`requested` cancel it there.
    };
    ws.onmessage = (ev) => onWsMessage(ev, capturedGen, ws);
    ws.onerror = () => {
      // V3 item 1 — only the CURRENT socket may change connection state. An
      // ``onerror`` from a stale/replaced socket must not flip the UI back
      // to ``reconnecting`` over the live socket.
      if (ws !== wsRef.current) return;
      setConnection("reconnecting");
      // Issue 3 fix — no real reconnect is attempted (the backend finalizes
      // the whole live/Gemini bridge the moment its own socket closes, so a
      // resumed WebSocket could never rejoin the same Gemini session).
      // ws.onclose almost always follows within milliseconds and already
      // finalizes via restEnd below; this bounded timer only guards the
      // rare case onclose never arrives, so the mic/timer can never keep
      // running indefinitely against a dead socket.
      if (wsErrorGraceTimerRef.current) clearTimeout(wsErrorGraceTimerRef.current);
      wsErrorGraceTimerRef.current = setTimeout(() => {
        wsErrorGraceTimerRef.current = null;
        if (ws !== wsRef.current) return;
        if (endingRef.current || phaseRef.current === "report") return;
        restEnd("ws_error_timeout");
      }, WS_ERROR_GRACE_MS);
    };
    ws.onclose = () => {
      // V3 item 1 — only the CURRENT socket may finalize the session. A
      // late ``onclose`` from a stale/replaced socket must not call
      // ``restEnd`` (which would refund/charge over the live session).
      if (ws !== wsRef.current) return;
      if (wsErrorGraceTimerRef.current) {
        clearTimeout(wsErrorGraceTimerRef.current);
        wsErrorGraceTimerRef.current = null;
      }
      // If the session ended cleanly we already moved to report; otherwise
      // finalize via REST so points are refunded/charged correctly.
      if (!endingRef.current && phaseRef.current !== "report") {
        restEnd("ws_close");
      }
    };

    // 5. Countdown timer.
    timerRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          handleEnd("time_up");
          return 0;
        }
        return r - 1;
      });
    }, 1000);
  }, [
    selectedMode, password, bookSlug, bookTitle, bookTier, chapterIdx,
    chapterTitle, visibleText, onWsMessage, handleEnd, restEnd,
    balance, explainLang,
  ]);

  // Track latest phase for the ws.onclose closure.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // BUG 2 hardening — a backgrounded/foregrounded tab is one of the most
  // common real-world triggers for a browser to suspend the playback
  // AudioContext (liveAudio.js's own onstatechange listener already
  // reacts to that directly; this is defense-in-depth so recovery isn't
  // solely dependent on the browser firing that event promptly). Only
  // acts during an active live session — never touches anything before
  // "live" or after the session has ended.
  // P0-2 fix — this used to resume ONLY the playback player. The mic
  // CAPTURE context is exposed to exactly the same browser-suspend risk
  // (liveAudio.js's own comments already draw this parallel), but had no
  // second line of defense here, unlike playback — a plausible real cause
  // of "listening becomes unreliable" reports for sessions that survive a
  // background/foreground cycle (screen lock, app switch, notification).
  // stopMicRef.current is still just the stop() function everywhere else
  // (backward compatible); .resume is an additive property (see liveAudio.js).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && phaseRef.current === "live") {
        playerRef.current?.resume();
        stopMicRef.current?.resume?.();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ── Phase 1 SURPRISE REWARDS — claim handler. Tries the WebSocket
  // path first (instant feedback through the same active bridge); on
  // any WS failure falls back to the REST claim route which calls the
  // SAME backend claim service. Duplicate taps are debounced via the
  // rewardClaiming flag but the underlying service is idempotent
  // regardless of the client.
  const claimReward = useCallback(
    async (offerId) => {
      // ``shouldSendClaimOnTap`` is the unit-tested guard against
      // duplicate taps and re-claims of already-confirmed offers.
      if (!shouldSendClaimOnTap(rewardState, offerId)) return;
      dispatchReward({ kind: "claim_start" });
      let sentViaWs = false;
      try {
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "claim_reward", offer_id: offerId }));
          sentViaWs = true;
        }
      } catch {
        sentViaWs = false;
      }
      if (sentViaWs) {
        // Backend will emit reward_claim_confirmed / pending / failed.
        return;
      }
      try {
        const data = await claimRewardOffer(offerId);
        // A successful REST claim may surface as either "confirmed" (live
        // claim service) or "granted" (authoritative recovery of an already
        // finalized grant). Both must open the SAME deduplicated reveal the
        // WebSocket path uses via ``claim_local_confirm``.
        if (data && (data.state === "granted" || data.state === "confirmed")) {
          dispatchReward({
            kind: "claim_local_confirm",
            offer_id: offerId,
            reward_type: data.reward_type,
            reward_amount: data.reward_amount,
            reward_summary: data.reward_summary
              || (data.result && data.result.reward_summary),
            confirmed_message: data.confirmed_message,
          });
        } else {
          // v7 — unified authoritative claim-outcome normalization for the REST
          // path, delegating to the SAME canonical mapping the WebSocket path
          // uses. ``data.state`` resolves to one of unavailable / disabled /
          // claiming / expired / terminal. Each recognized outcome bumps the
          // revision barrier BEFORE the coalesced refresh and IMMEDIATELY sets
          // the canonical non-clickable status for THIS session; the local
          // claiming flag is cleared ONLY when the canonical state is not
          // "claiming". A claiming (in-flight/unresolved) outcome keeps the
          // spinner, blocks a second claim, and arms bounded polling so the
          // student is never left waiting indefinitely. The server offer is
          // preserved server-side, so a later ``eligible`` status restores the
          // same unexpired offer. An unrecognized state (internal_error /
          // network / arbitrary) keeps the ordinary retryable-failure path and
          // never fabricates an authoritative lifecycle state.
          const restClaimOutcome =
            normalizeAuthoritativeClaimOutcome(data && data.state);
          if (restClaimOutcome) {
            statusRevisionRef.current += 1;
            setRewardStatus((prev) =>
              statusFromRestClaimOutcome(
                prev, data, sessionRef.current?.session_id) || prev);
            if (restClaimOutcome === "claiming") {
              dispatchReward({
                kind: "event",
                event: {
                  type: "reward_claim_pending",
                  offer_id: offerId,
                  session_id: sessionRef.current?.session_id,
                },
              });
              armResilientPollCycle("pending_confirmation", offerId);
            } else {
              dispatchReward({ kind: "claim_local_failed", reason: "" });
            }
            statusPollControllerRef.current?.poke();
          } else {
            dispatchReward({
              kind: "claim_local_failed",
              reason: "That surprise could not be confirmed.",
            });
          }
        }
      } catch (e) {
        dispatchReward({
          kind: "claim_local_failed",
          reason: (e && e.message) || "Network error",
        });
      }
    },
    [rewardState, armResilientPollCycle],
  );

  const closeAll = useCallback(() => {
    cleanup();
    setOpen(false);
    setPhase("start");
    setTranscript([]);
    setReport(null);
    setRefundState(null);
    setError("");
    sessionRef.current = null;
    endingRef.current = false;
    // Reset the per-session reward reveal state on close so a NEW
    // session never inherits a stale reveal or result. Going through
    // the reducer keeps the dedup ``claimedOfferIds`` source-of-truth.
    dispatchReward({ kind: "reset" });
  }, [cleanup]);

  // Reading Hub (P1) — read-only state notification, additive. Placed
  // before the render guards below (hooks must run in the same order
  // every render); reports visible:false once unavailable so a host
  // holding a stale "visible" state knows to drop its own row.
  useEffect(() => {
    if (!onFabState) return;
    const available = isAuthenticated && !!config?.available;
    if (!available) {
      onFabState({ visible: false });
      return;
    }
    onFabState({ visible: !open, label: "Live Coach", onOpen: openViaHub });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFabState, isAuthenticated, config, open]);

  // ── Render guards ──────────────────────────────────────────────────────
  if (!isAuthenticated) return null;
  if (!config) return null;
  if (!config.available) {
    // Feature off / Gemini not configured → no launcher, no crash.
    return null;
  }

  return (
    <>
      {/* Launcher — visually distinct (cyan) from the purple EduTalk button.
          Reading Hub (P1) — hideOwnFab additionally suppresses it when a
          host is providing an equivalent trigger via onFabState; the
          overlay/session UI below (and everything it drives — WebSocket,
          mic, billing) is completely unaffected. */}
      {!hideOwnFab && (
      <button
        type="button"
        className="etlc-fab"
        onClick={() => { setOpen(true); setPhase("start"); }}
        data-testid="live-coach-fab"
      >
        <span className="etlc-fab__pulse" />
        <MessageCircle size={16} />
        Live Coach
      </button>
      )}

      {open && (
        <div className="etlc-overlay" data-testid="live-coach-overlay">
          <div className="etlc-sheet">
            <div className="etlc-head">
              <div className="etlc-brand">
                <span className="etlc-brand__badge"><MessageCircle size={20} /></span>
                <div>
                  <div className="etlc-title">EduTalk Live Coach</div>
                  <div className="etlc-sub">
                    {config.beta ? "BETA · " : ""}Your private speaking coach
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="etlc-x"
                onClick={phase === "live" ? () => handleEnd("client_cancel") : closeAll}
                data-testid="live-coach-close"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {phase === "start" && (
              <>
                <LiveCoachStartCard
                  modes={config.modes || []}
                  selectedMode={selectedMode}
                  onSelectMode={setSelectedMode}
                  balance={balance}
                  starting={starting}
                  error={error}
                  freeTrialAvailable={freeTrialAvailable}
                  onStart={startSession}
                  explainLang={explainLang}
                  onExplainLangChange={setExplainLang}
                  couponSlot={(
                    <LiveCoachCouponCard
                      enabled={!!(config && config.couponRedemptionEnabled)}
                      onRedeemed={(amount) => {
                        if (typeof setBalance === "function" && typeof amount === "number") {
                          setBalance((balance || 0) + amount);
                        }
                      }}
                    />
                  )}
                />
                {showStartPill && !pillDismissedThisVisit && (
                  <LiveCoachTopUpNudge
                    variant="start"
                    preview={clientFallbackPreview ?? modePreview}
                    onTopUp={openTopUpModal}
                    onDismiss={dismissTopUpPill}
                    disabled={topUpModalOpen}
                  />
                )}
              </>
            )}

            {phase === "live" && (
              <>
                <LiveVoiceOrb
                  state={orbState}
                  level={level}
                  remaining={remaining}
                  connection={connection}
                />
                {error && <div className="etlc-error">{error}</div>}
                {rewardError && (
                  <div
                    className="etlc-error"
                    data-testid="live-coach-reward-err"
                  >
                    {rewardError}
                  </div>
                )}
                <LiveTranscriptPanel lines={transcript} />
                {/* Hotfix v1 — PERSISTENT, backend-truth-driven Surprise
                    Reward panel. Replaces the previously fully-hidden button:
                    it stays visible (locked → progressing → eligible →
                    claiming → confirmed) whenever Coach Rewards is operational
                    for this session. Placed below the transcript and ABOVE the
                    End session button; never reveals the reward amount before a
                    confirmed claim, and never interferes with mic / Gemini
                    audio / timer / WebSocket / End session. The immersive
                    confirmed reveal remains owned by LiveCoachRewardReveal. */}
                {!rewardRevealOpen && (
                  <LiveCoachRewardPanel
                    status={rewardStatus}
                    reward={rewardState}
                    reducedMotion={reducedMotion}
                    onClaim={claimReward}
                  />
                )}
                <button
                  type="button"
                  className="etlc-btn etlc-btn--danger etlc-btn--end-premium"
                  onClick={() => handleEnd("client_end")}
                  data-testid="live-end-btn"
                  aria-label="End live coaching session"
                >
                  <span className="etlc-end-ico" aria-hidden="true" />
                  <span>End session</span>
                </button>
                <LiveCoachRewardReveal
                  open={rewardRevealOpen}
                  result={rewardResult}
                  message={
                    composeRevealPayload(rewardResult, rewardConfirmedMessage)?.message
                    || "Practice streak reward — you earned this through strong practice!"
                  }
                  reducedMotion={reducedMotion}
                  onContinue={() => dispatchReward({ kind: "close_reveal" })}
                />
              </>
            )}

            {phase === "report" && (
              <>
                <LiveCoachReportCard
                  report={report}
                  pointsCharged={pointsCharged}
                  refundState={refundState}
                  explainLang={explainLang}
                  onClose={closeAll}
                  onPracticeAgain={() => { setPhase("start"); setError(""); }}
                />
                {showReportPill && !pillDismissedThisVisit && (
                  <LiveCoachTopUpNudge
                    variant="report"
                    finalization={clientFallbackFinalization ?? topupFinalization}
                    onTopUp={openTopUpModal}
                    onDismiss={dismissTopUpPill}
                    disabled={topUpModalOpen}
                  />
                )}
              </>
            )}

            {/* Phase 1 Smart Top-Up Nudge — the SINGLE shared modal instance.
                Rendered only outside phase === "live" and only while open
                (repeated-click protection lives in openTopUpModal). */}
            {topUpModalOpen && phase !== "live" && (
              <Suspense fallback={null}>
                <TopUpPointsModal
                  studentId={topupStudentId}
                  onClose={closeTopUpModal}
                  onCredited={creditedTopUpModal}
                  triggerReason="library"
                  currentBalance={balance}
                  recommendedPackageId={topupRecommendedId}
                />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </>
  );
}
