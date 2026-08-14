/**
 * EduTalkPanel.jsx — Phase 2A — Reader-side EduTalk launcher + chat panel.
 *
 * Production-readiness pass v2 (changes vs v1):
 *   - Issue 1 FIX: start modal now shows student_id, content-mode pill,
 *     chapter title (when present), zero-cost-friendly copy, "—" balance
 *     fallback, and never displays NaN/null/undefined.
 *   - Issue 2 FIX: when a session is completed OR the server returns 410
 *     (expired), the panel renders an inline "Continuation card" with an
 *     explicit confirm button. No page reload. No auto-charge. After a
 *     successful new session, local messages reset to the new greeting.
 *   - Section 4: colour-coded reply counter, 503 graceful inline error,
 *     loading spinner on start button, ARIA labels, zero-cost flow,
 *     content-mode pill badge.
 *
 * Hard rules (unchanged):
 *   - Does NOT touch PremiumAiAction logic or any Phase 1 state.
 *   - Does NOT persist the student password — only reads it from AuthContext.
 *   - Uses /api auth (Bearer + credentials:"include").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Mic,
  Send,
  Sparkles,
  Square,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "../../../context/AuthContext";
import PointsGateModal from "./PointsGateModal";

/* eslint-disable no-undef */
const API_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */
const STUDENT_LS_KEY = "student_session_token";

function _studentBearer() {
  try {
    const t = localStorage.getItem(STUDENT_LS_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function _apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ..._studentBearer() },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* server sent non-JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function _apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    credentials: "include",
    headers: { ..._studentBearer() },
  });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

/* ============================================================ */
/*  Adaptive language helpers (v1)                              */
/* ============================================================ */

/**
 * Detect if a string contains Khmer characters (U+1780–U+17FF).
 * Used for mode-aware voice button labelling without prop threading.
 */
function _hasKhmerChars(text) { return /[\u1780-\u17FF]/.test(String(text || "")); }

const SUGGESTED_CHIPS = [
  { label: "Summarize this page", message: "Please summarize this page in 3 short sentences." },
  { label: "Explain difficult words", message: "What are the difficult words on this page and what do they mean?" },
  { label: "Ask me questions", message: "Ask me 2 reflection questions about this page." },
  { label: "Role-play with me", message: "Let's role-play this. You start." },
  { label: "Help me speak about this", message: "Help me speak 3 short English sentences about this page." },
];

const CHAPTER_KEY_PREFIX = "edutalk:resume:";

function _chapterStorageKey(bookSlug, chapterIdx) {
  return `${CHAPTER_KEY_PREFIX}${bookSlug || ""}|${Number.isFinite(chapterIdx) ? chapterIdx : 0}`;
}

/* Content-mode → readable pill mapping (Section 4G) */
const CONTENT_MODE_LABEL = {
  story: { icon: "📖", text: "Story" },
  conversation: { icon: "💬", text: "Conversation" },
  exercise: { icon: "✏️", text: "Exercise" },
  vocabulary: { icon: "📚", text: "Vocabulary" },
  general_reading: { icon: "📄", text: "Reading" },
};

// v2.2 — bulletproof mode pill lookup.  Any unexpected / null / undefined
// mode value falls back to a safe "Reading" label.  Both `icon` and `text`
// are explicitly guaranteed strings so JSX never tries to render undefined.
function _modePill(mode) {
  const key = typeof mode === "string" ? mode : "";
  const found = CONTENT_MODE_LABEL[key];
  const safe = found && typeof found === "object" ? found : null;
  return {
    icon: (safe && typeof safe.icon === "string" && safe.icon) || "📄",
    text: (safe && typeof safe.text === "string" && safe.text) || "Reading",
  };
}

/* ============================================================ */
/*  Phase 3 helpers                                              */
/* ============================================================ */

// Phase 3 + v1.1: build student_context payload from AuthContext.student.portalData.
//
// PRIVACY CONTRACT (enforced here, also re-enforced server-side by
// Pydantic's `extra="ignore"` on StudentContext):
//   ✅ ALLOWED out:
//        - 6 baseline criteria (Pronunciation, Intonation, Communication,
//          Participation, Rising & Falling, Linking Sounds)
//        - 7 v1.1 alias criteria when the GAS sheet exposes them
//          (Reading, Vocabulary, Grammar, Listening, Confidence,
//           Comprehension, Fluency) — each clamped to a numeric 0..10
//        - 3 teacher-note text fields trimmed to 400 chars
//          (Strength, Weakness, Improvement)
//   ❌ EXCLUDED — never sent to backend/Gemini:
//        - Password, Phone*, TuitionStatus, LastPaymentDate, NextDueDate,
//          PaymentAmount, Restriction*, RestrictionMessage, RestrictionReason,
//          admin/disciplinary notes, the full raw portalData blob
//
// If portalData is missing or every field is empty we return `null` so the
// caller omits `student_context` from the start payload entirely — the
// backend then falls back to the legacy (non-personalised) greeting.
function _buildStudentContext(student) {
  const pd = student?.portalData || {};
  const num = (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (v) => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s ? s.slice(0, 400) : undefined;
  };
  // Read a numeric criterion by trying several common header spellings
  // (proper-case, camelCase, lowercase, snake_case) so the same code path
  // works whether the GAS sheet uses "Reading", "reading",
  // "Reading Comprehension", or "reading_comprehension".  We never read
  // anything outside this explicit whitelist — that's the privacy contract.
  const pick = (...keys) => {
    for (const k of keys) {
      const v = pd[k];
      const n = num(v);
      if (n !== undefined) return n;
    }
    return undefined;
  };
  const ctx = {
    // Baseline criteria (always present in the GAS sheet today).
    pronunciation:  pick("Pronunciation", "pronunciation"),
    intonation:     pick("Intonation", "intonation"),
    communication:  pick("Communication", "communication"),
    participation:  pick("Participation", "participation"),
    rising_falling: pick("Rising & Falling", "RisingFalling", "rising_falling"),
    linking_sounds: pick("Linking Sounds", "LinkingSounds", "linking_sounds"),
    // v1.1 alias criteria — opt-in.  Only forwarded when the GAS sheet
    // actually carries them; otherwise stays `undefined` and is stripped
    // from the payload before send.  Adding them here is purely additive:
    // the backend's StudentContext model declares them as Optional, and
    // the alias-aware criteria table only mentions a label if the
    // matching score is non-empty.
    reading:        pick("Reading", "reading", "Reading Comprehension"),
    vocabulary:     pick("Vocabulary", "vocabulary"),
    grammar:        pick("Grammar", "grammar"),
    listening:      pick("Listening", "listening"),
    confidence:     pick("Confidence", "confidence"),
    comprehension:  pick("Comprehension", "comprehension"),
    fluency:        pick("Fluency", "fluency"),
    // Teacher-note text fields — trimmed and capped at 400 chars.
    strength:    str(pd.Strength),
    weakness:    str(pd.Weakness),
    improvement: str(pd.Improvement),
  };
  // Drop undefined keys so the backend never sees them.  This is what
  // makes "send only what is present" guarantee in the privacy contract
  // mechanical, not just documented.
  const out = {};
  Object.keys(ctx).forEach((k) => {
    if (ctx[k] !== undefined) out[k] = ctx[k];
  });
  return Object.keys(out).length > 0 ? out : null;
}

// Phase 3: localStorage key prefix for "dismissed promotion banners".
const PROMO_DISMISS_PREFIX = "edutalk:promo_dismiss:";

/* ============================================================ */
/*  Part 2 — Smart Top-Up Trigger Guard (sessionStorage-only)    */
/* ============================================================ */
//
// All anti-spam state lives in sessionStorage so it resets cleanly on tab
// close.  No Mongo writes, no localStorage — by design (see problem
// statement Part 2: "Use sessionStorage only for this phase").
//
// State per scope key (student_id|book_slug|session_id):
//   { lastShownAt, shownCount, dismissCount, suppressedUntil }
//
// The reader calls `requestOpen(reason)`; the guard either:
//   • allows the prompt (returns true and persists lastShownAt/shownCount)
//   • blocks it silently (cooldown / dismiss-cap / max-per-session / etc)
//
const _TOPUP_GUARD_PREFIX = "edutalk:topup_guard:v1:";

function _topupGuardKey(scope) {
  const s = scope || {};
  return (
    _TOPUP_GUARD_PREFIX +
    [s.studentId || "", s.bookSlug || "", s.sessionId || ""].join("|")
  );
}

function _readGuardState(scope) {
  try {
    const raw = sessionStorage.getItem(_topupGuardKey(scope));
    if (!raw) return { lastShownAt: 0, shownCount: 0, dismissCount: 0, suppressedUntil: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { lastShownAt: 0, shownCount: 0, dismissCount: 0, suppressedUntil: 0 };
    }
    return {
      lastShownAt:     Number(parsed.lastShownAt)     || 0,
      shownCount:      Number(parsed.shownCount)      || 0,
      dismissCount:    Number(parsed.dismissCount)    || 0,
      suppressedUntil: Number(parsed.suppressedUntil) || 0,
    };
  } catch {
    return { lastShownAt: 0, shownCount: 0, dismissCount: 0, suppressedUntil: 0 };
  }
}

function _writeGuardState(scope, state) {
  try {
    sessionStorage.setItem(_topupGuardKey(scope), JSON.stringify(state || {}));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

/**
 * Smart top-up trigger guard hook.
 *
 *   const guard = useTopUpTriggerGuard({ scope, cfg, isAudioPlaying, isAnotherModalOpen, isInFlight });
 *   if (guard.canOpen("low_balance")) {
 *     guard.markOpened();
 *     openModal();
 *   }
 *
 * `canOpen()` is intentionally a *predicate* (no side effects) so callers
 * can pre-check before deciding to mutate UI state.  `markOpened()`,
 * `markDismissed()` and `markSuppressed(ms)` persist the audit trail.
 *
 * The hook respects every safeguard from Part 2:
 *   - cooldown (cfg.topup_cooldown_seconds)
 *   - max per session  (cfg.topup_max_per_session)
 *   - dismiss cap      (cfg.topup_dismiss_cap_per_session)
 *   - audio playing    (cfg.topup_respect_audio_playing)
 *   - another modal open / in-flight request
 *   - 3-second suppress window after a successful top-up (markSuppressed)
 */
function useTopUpTriggerGuard({
  scope,
  cfg,
  isAudioPlaying,
  isAnotherModalOpen,
  isInFlight,
}) {
  const cooldownMs = Math.max(0, Number(cfg?.topup_cooldown_seconds ?? 180) * 1000);
  const maxPerSession = Math.max(1, Number(cfg?.topup_max_per_session ?? 3));
  const dismissCap = Math.max(1, Number(cfg?.topup_dismiss_cap_per_session ?? 2));
  const respectAudio = cfg?.topup_respect_audio_playing !== false;

  const canOpen = (reason) => {
    // Cached replay must never trigger a prompt — by spec.
    if (reason === "cached_replay") return false;
    // External hard guards.
    if (isAnotherModalOpen) return false;
    if (isInFlight) return false;
    if (respectAudio && isAudioPlaying) return false;

    const st = _readGuardState(scope);
    const now = Date.now();
    if (st.suppressedUntil && now < st.suppressedUntil) return false;
    if (st.shownCount >= maxPerSession) return false;
    if (st.dismissCount >= dismissCap) return false;
    if (st.lastShownAt && (now - st.lastShownAt) < cooldownMs) return false;

    return true;
  };

  const markOpened = () => {
    const st = _readGuardState(scope);
    _writeGuardState(scope, {
      ...st,
      lastShownAt: Date.now(),
      shownCount: st.shownCount + 1,
    });
  };

  const markDismissed = () => {
    const st = _readGuardState(scope);
    _writeGuardState(scope, { ...st, dismissCount: st.dismissCount + 1 });
  };

  /** Suppress prompts for `ms` milliseconds (e.g. 3s after a top-up). */
  const markSuppressed = (ms) => {
    const st = _readGuardState(scope);
    _writeGuardState(scope, {
      ...st,
      suppressedUntil: Date.now() + Math.max(0, Number(ms) || 0),
    });
  };

  return { canOpen, markOpened, markDismissed, markSuppressed };
}

function _isPromoDismissed(promoId) {
  if (!promoId) return false;
  try {
    return localStorage.getItem(PROMO_DISMISS_PREFIX + promoId) === "1";
  } catch {
    return false;
  }
}

function _dismissPromo(promoId) {
  if (!promoId) return;
  try {
    localStorage.setItem(PROMO_DISMISS_PREFIX + promoId, "1");
  } catch {
    /* noop */
  }
}

/* Reply-counter colour map (Section 4A) */
function _counterColour(remaining) {
  const n = Number(remaining);
  if (!Number.isFinite(n) || n <= 0) return "#f87171"; // red
  if (n === 1) return "#f97316"; // orange
  if (n === 2) return "#fbbf24"; // amber
  return "#4ade80"; // green (>=3)
}

/* Balance display guard (Section 4B) */
function _displayBalance(student) {
  const raw = student?.portalPoints ?? student?.points;
  const n = Number(raw);
  if (raw === null || raw === undefined || Number.isNaN(n)) return null;
  // Round to nearest integer — GAS sometimes returns floating point values
  // like 87.0300000000002 due to Google Sheets float arithmetic.
  return Math.round(n);
}

/* Pure password resolver — shared by the render-time useMemo and the P0
 * hydration-wait helper below so both read the identical field priority. */
function _resolvePassword(studentObj) {
  if (!studentObj) return "";
  if (studentObj.password) return String(studentObj.password);
  const pd = studentObj.portalData || {};
  return String(pd.Password ?? pd.password ?? "");
}

/* P0 fix — see the studentRef comment in the component for the full root
 * cause. AuthContext's GAS re-hydration effect is ALREADY in flight
 * whenever a fresh `student` has no password; this just gives it a bounded
 * window to land before treating the gap as a real "not logged in" state.
 * Polls a ref (not React state) because this runs inside a plain async
 * function, outside the render cycle. */
function _waitForPassword(studentRef, timeoutMs = 4000, intervalMs = 250) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const pw = _resolvePassword(studentRef.current);
      if (pw) return resolve(pw);
      if (Date.now() >= deadline) return resolve("");
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/* ============================================================ */
/*  Public component — EduTalkLauncher                          */
/* ============================================================ */
export default function EduTalkLauncher({
  bookSlug,
  bookTitle,
  chapterIdx,
  chapterTitle,
  pageIdx,
  visibleText,
  // Reading Hub (P1) — both additive, both default to today's exact
  // behavior. hideOwnFab lets a host (ReadingHub) suppress this
  // component's own independently-positioned floating trigger without
  // touching anything else — the confirm/chat/error overlay UI, session
  // logic, networking, and pricing below are completely untouched; only
  // whether the small idle button renders itself changes. onFabState is a
  // read-only notification (never a control channel) so the host can
  // render an equivalent trigger row — tapping it still calls the exact
  // same onOpen() this component always used.
  hideOwnFab = false,
  onFabState,
}) {
  const { student, isAuthenticated, portalPoints } = useAuth();
  // P0 fix — "EduTalk could not start / please refresh and log in again"
  // for a genuinely authenticated student. Root cause: AuthContext.jsx's
  // 30-day persistent profile cache deliberately strips `password`/
  // `portalData.Password` before writing to storage (stripSensitive()) —
  // by design, for security. On EVERY page refresh / PWA reopen, `student`
  // is first seeded from that stripped cache (no password), and a SEPARATE
  // async effect (AuthContext's v11.4 GAS re-hydration) re-fetches the real
  // password from the Sheet shortly after. Nothing that only needs
  // `isAuthenticated`/`studentId`/points (Reader, balance, Dashboard) is
  // affected by this gap, so the rest of the PWA looks fully logged in —
  // but EduTalk's session-start payload requires the password, and this
  // component had no way to see that hydration was still in flight, so a
  // tap during that window hard-failed with a technically-true-but-
  // misleading "log in again" message even though nothing was ever lost.
  // Fix: mirror the live `student` value into a ref (same pattern
  // AuthContext.jsx itself uses — v7.9.8 studentRef) so `_doStart` can
  // wait a bounded amount of time for the in-flight hydration to land
  // instead of failing the instant it's tapped during that window.
  const studentRef = useRef(student);
  useEffect(() => { studentRef.current = student; }, [student]);
  // Reading Hub (P1) — onOpen is defined later (after this component's
  // early-return guards), but hooks must run in the same order every
  // render, so the notification effect below (which must sit BEFORE those
  // guards) can't reference it directly. A ref bridges the gap: it's
  // pointed at the real onOpen once render reaches that point (a plain
  // assignment right before the JSX return, not a hook, so it's fine that
  // it only happens on renders that get that far — those are exactly the
  // renders where there's anything to open).
  const onOpenRef = useRef(null);
  const openViaHub = useCallback(() => { onOpenRef.current?.(); }, []);
  const [config, setConfig] = useState(null); // {enabled, session_cost, reply_limit, display_text, ...}
  const [phase, setPhase] = useState("idle"); // idle | confirm | loading | chat | error
  const [session, setSession] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [insufficient, setInsufficient] = useState(null);
  const [starting, setStarting] = useState(false); // Section 4E: loading state on start button
  const [continueState, setContinueState] = useState(null);
  // continueState shape (Issue 2 + Section 4D):
  //   { kind: "completed" | "expired" }  → triggers ContinuationCard

  // v1.2 — Mystery Box EduTalk pass availability (read-only badge).
  // Tiny COUNTS-ONLY payload (no entitlement IDs, no titles, no
  // eligibility lists) — see /api/student/edutalk-passes/summary in
  // mystery_box_tools.py. Reader simply shows a "1 Pass Available"
  // chip when count > 0 so the student understands why the next
  // session is free. Backend handles the actual consumption.
  const [passSummary, setPassSummary] = useState({
    edutalk_session: 0,
    edutalk_voice: 0,
    has_any: false,
  });

  // Phase 3 state ------------------------------------------------------------
  const [bookTier, setBookTier] = useState("");   // resolved tier of this book
  const [activeBanners, setActiveBanners] = useState([]); // banner promos
  const [gateOpen, setGateOpen] = useState(false);
  const [gateContext, setGateContext] = useState(null);
  // gateContext shape:
  //   { feature: "start" | "voice",
  //     requiredPoints: n, balance: n,
  //     label: "Start EduTalk" | "Voice Reply",
  //     onResume: () => void }
  // ------------------------------------------------------------------------

  // ── Part 2 — Smart Top-Up Triggers (sessionStorage anti-spam) ───────────
  // The guard is owned by the launcher so every trigger reason shares one
  // cooldown / max-per-session / dismiss-cap state across the chat panel
  // and the launcher pill.  `markDismissed()` runs whenever the gate is
  // closed without resolving the top-up.
  const _topupScope = useMemo(
    () => ({
      studentId: student?.studentId || "",
      bookSlug: bookSlug || "",
      sessionId: session?.session_id || "",
    }),
    [student?.studentId, bookSlug, session?.session_id],
  );
  // Audio-playing signal — derived best-effort from the document's media
  // elements without taking a hard dep on AudioPlayerContext (kept
  // surgical per the no-touch list).
  const _isAudioPlaying = () => {
    try {
      const els = document.querySelectorAll("audio,video");
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el && !el.paused && !el.ended && el.currentTime > 0) return true;
      }
    } catch {
      /* noop */
    }
    return false;
  };
  const _topupGuard = useTopUpTriggerGuard({
    scope: _topupScope,
    cfg: config || {},
    isAudioPlaying: _isAudioPlaying(),
    isAnotherModalOpen: gateOpen || phase !== "idle" && phase !== "chat",
    isInFlight: starting,
  });
  const _topupGuardRef = useRef(_topupGuard);
  useEffect(() => { _topupGuardRef.current = _topupGuard; });
  // Wrap setGateOpen so a "user closed without paying" always counts as a
  // dismissal — but only if no top-up landed during the visit.  The
  // PointsGateModal raises onResume when the balance becomes sufficient;
  // in that flow setGateOpen(false) is preceded by the resume callback so
  // we use a ref to suppress the dismiss bookkeeping in that single case.
  const _topupResolvedRef = useRef(false);
  const closeGate = useCallback(() => {
    setGateOpen(false);
    if (!_topupResolvedRef.current) {
      try { _topupGuardRef.current?.markDismissed(); } catch { /* noop */ }
    }
    _topupResolvedRef.current = false;
  }, []);
  // ──────────────────────────────────────────────────────────────────────

  const balanceNum = _displayBalance(student);
  const resolvedPassword = useMemo(() => _resolvePassword(student), [student]);
  const hasPassword = !!resolvedPassword;

  // Fetch student-safe EduTalk config once per session.
  // PHASE 3: prefer the tier-aware /book-config endpoint when bookSlug is
  // known. Falls back to the old /config endpoint so deployments with the
  // backend not-yet-upgraded still work. The book's tier is resolved by a
  // light public lookup against the existing /api/books/{slug} endpoint.
  useEffect(() => {
    if (!isAuthenticated || !student?.studentId) return;
    let cancelled = false;

    async function loadConfig() {
      // 1) Resolve book.tier (cheap public read — no auth needed).
      let resolvedTier = "";
      if (bookSlug) {
        try {
          const bookRes = await fetch(
            `${API_BASE}/api/books/${encodeURIComponent(bookSlug)}`,
            { credentials: "include" },
          );
          if (bookRes.ok) {
            const bdata = await bookRes.json();
            resolvedTier = String(
              (bdata && (bdata.tier || (bdata.book && bdata.book.tier))) || "",
            ).toLowerCase();
          }
        } catch {
          /* ignore — tier remains "" → backend treats as "free" */
        }
      }
      if (cancelled) return;
      setBookTier(resolvedTier);

      // 2) Tier-aware config + active promotion banners (Phase 3).
      if (bookSlug) {
        try {
          const tierCfg = await _apiGet(
            `/api/student/edutalk/book-config?book_slug=${encodeURIComponent(
              bookSlug,
            )}&tier=${encodeURIComponent(resolvedTier)}`,
          );
          if (!cancelled && tierCfg && tierCfg.success && tierCfg.config) {
            setConfig({
              ...tierCfg.config,
              // Mirror legacy keys so the rest of this file keeps working
              // without refactoring its `config.enabled`/`session_cost`/etc.
              // reads.
              enabled: tierCfg.config.enabled,
              session_cost: tierCfg.config.session_cost,
              reply_limit: tierCfg.config.reply_limit,
              display_text: tierCfg.config.display_text,
              promotions: tierCfg.promotions || {},
            });
            const banners = Array.isArray(tierCfg.banners) ? tierCfg.banners : [];
            setActiveBanners(
              banners.filter((b) => !_isPromoDismissed(b.promo_id)),
            );
            return;
          }
        } catch {
          /* fall through to legacy endpoint */
        }
      }

      // 3) Legacy fallback — keeps Phase 2A behaviour intact when
      // Phase 3 endpoints are not yet deployed.
      try {
        const d = await _apiGet("/api/student/edutalk/config");
        if (!cancelled && d) setConfig(d);
      } catch {
        /* silent — feature simply hides */
      }
    }

    loadConfig();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, student?.studentId, bookSlug]);

  // v1.2 — Fetch the EduTalk-Pass summary so the ConfirmCard can show
  // "🎟 1 Pass Available" before the student spends points. Reads
  // counts only, no IDs. 404 (route absent on legacy backends) and
  // any other error degrades silently — no badge is shown.
  useEffect(() => {
    if (!isAuthenticated || !student?.studentId) {
      setPassSummary({ edutalk_session: 0, edutalk_voice: 0, has_any: false });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const qs = bookSlug
          ? `?book_slug=${encodeURIComponent(bookSlug)}`
          : "";
        const res = await fetch(
          `${API_BASE}/api/student/edutalk-passes/summary${qs}`,
          {
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              ..._studentBearer(),
            },
          },
        );
        if (!res.ok) {
          if (!cancelled) {
            setPassSummary({ edutalk_session: 0, edutalk_voice: 0, has_any: false });
          }
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setPassSummary({
          edutalk_session: Number(data?.edutalk_session || 0),
          edutalk_voice: Number(data?.edutalk_voice || 0),
          has_any: Boolean(data?.has_any),
        });
      } catch {
        if (!cancelled) {
          setPassSummary({ edutalk_session: 0, edutalk_voice: 0, has_any: false });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, student?.studentId, bookSlug]);

  // Auto-resume an existing active session for this chapter, if any.
  //
  // ───────────────────────────────────────────────────────────────────────
  // BUGFIX (Part 1 — Resumed EduTalk session loses audio buttons)
  // ───────────────────────────────────────────────────────────────────────
  // Before this fix, the resume-hydration setSession() call below stripped
  // voice_reply_enabled, voice_cost, and greeting_language from the server
  // response.  The ChatPanel reads `voiceEnabled={!!session.voice_reply_enabled}`
  // and ChatBubble's `replyLanguage` prop comes from each message's
  // `reply_language` — so when the student reopened the PWA mid-session
  // every assistant bubble lost its speaker control silently.
  //
  // The backend GET /api/student/edutalk/session/{session_id} already
  // returns:
  //   • voice_reply_enabled    (bool)
  //   • voice_cost             (int)
  //   • greeting_language      ("english" | "khmer")
  //   • messages[i].reply_language (per-message)
  //
  // So this is a pure frontend hydration bug — no backend change required.
  // ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !student?.studentId) return;
    if (!bookSlug) return;
    let cancelled = false;
    try {
      const sid = localStorage.getItem(_chapterStorageKey(bookSlug, chapterIdx));
      if (!sid) return;
      _apiGet(`/api/student/edutalk/session/${encodeURIComponent(sid)}`).then((d) => {
        if (cancelled || !d || !d.success) return;
        if (d.status === "active" && d.replies_remaining > 0) {
          // Preserve server-provided messages verbatim, including
          // reply_language on each assistant message — ChatBubble uses
          // this to render the correct audio button label.
          const serverMsgs = Array.isArray(d.messages) ? d.messages : [];
          let resumedMessages = serverMsgs;

          // Edge case: messages list is empty but the server still
          // remembers the greeting (e.g. the student tapped Start and
          // immediately closed the panel before any reply).  Rebuild a
          // greeting assistant message so the audio button on the very
          // first bubble is not lost.
          if (serverMsgs.length === 0 && d.greeting) {
            resumedMessages = [{
              role: "assistant",
              message: d.greeting,
              created_at: new Date().toISOString(),
              reply_language: d.greeting_language || "english",
            }];
          }

          setSession({
            session_id: d.session_id,
            replies_remaining: d.replies_remaining,
            reply_limit: d.reply_limit,
            content_mode: d.content_mode,
            greeting: d.greeting,
            greeting_language: d.greeting_language || "english",
            messages: resumedMessages,
            status: d.status,
            // ⬇ Part 1 fix — voice flags MUST be carried over so the
            //   ChatBubble speaker button stays visible on every
            //   assistant message after PWA cold-start / panel reopen.
            voice_reply_enabled: !!d.voice_reply_enabled,
            voice_cost: Number(d.voice_cost) || 0,
            // v9.6 — pass per-student replay entitlements through so
            // ChatPanel can seed its voiceCache without forcing the
            // student to pay/regenerate the same audio after a panel
            // reopen, refresh, or device switch.
            voice_entitlements: Array.isArray(d.voice_entitlements)
              ? d.voice_entitlements
              : [],
          });
        } else {
          try { localStorage.removeItem(_chapterStorageKey(bookSlug, chapterIdx)); } catch { /* noop */ }
        }
      });
    } catch { /* noop */ }
    return () => { cancelled = true; };
  }, [isAuthenticated, student?.studentId, bookSlug, chapterIdx]);

  // ──────────────────────────────────────────────────────────────────────
  // Part 2 — Proactive Smart Top-Up Triggers
  // ──────────────────────────────────────────────────────────────────────
  // Fires only when EduTalk is actually in use (panel open / active session)
  // so we never interrupt free reading.  The guard handles cooldown,
  // dismissal cap, audio-playing, and max-per-session checks internally,
  // so this effect is just the "should we even consider opening?" gate.
  //
  // Triggers (admin-configurable):
  //   • low_balance   — balance ≤ topup_low_balance_threshold
  //   • replies_left  — session.replies_remaining ≤ 1 after a useful reply
  //
  // The after-value trigger is OFF by default (admin opt-in).  When ON, it
  // fires every Nth assistant reply if balance is below threshold.
  // ──────────────────────────────────────────────────────────────────────
  const repliesRemaining = Number(session?.replies_remaining || 0);
  const sessionReplyLimit = Number(session?.reply_limit || 0);
  const repliesUsed = Math.max(0, sessionReplyLimit - repliesRemaining);
  useEffect(() => {
    if (!config) return;
    if (gateOpen) return;
    if (phase !== "chat" && phase !== "confirm") return;
    const balance = Number(balanceNum ?? -1);
    if (balance < 0) return; // unknown balance — don't speculate
    const cfg = config || {};
    const threshold = Number(cfg.topup_low_balance_threshold ?? 10);
    const isLow = balance <= threshold;
    const _sessionCost = Number(cfg.session_cost ?? 5) || 0;

    // 1) Replies-left trigger  — only meaningful inside an active session.
    if (
      cfg.topup_trigger_replies_left !== false &&
      session?.status === "active" &&
      repliesRemaining > 0 &&
      repliesRemaining <= 1 &&
      _topupGuardRef.current?.canOpen("replies_left")
    ) {
      _topupGuardRef.current.markOpened();
      setGateContext({
        feature: "continue",
        reason: "replies_left",
        requiredPoints: _sessionCost,
        balance,
        label: "Keep your EduTalk Coach active",
        onResume: () => setGateOpen(false),
      });
      setGateOpen(true);
      return;
    }

    // 2) After-value trigger — admin opt-in.  Fires every Nth assistant
    //    reply if balance is below threshold.
    if (
      cfg.topup_trigger_after_value === true &&
      isLow &&
      session?.status === "active" &&
      repliesUsed > 0 &&
      repliesUsed % Math.max(1, Number(cfg.topup_after_value_every_n ?? 3)) === 0 &&
      _topupGuardRef.current?.canOpen("after_value")
    ) {
      _topupGuardRef.current.markOpened();
      setGateContext({
        feature: "continue",
        reason: "after_value",
        requiredPoints: _sessionCost,
        balance,
        label: "You're making progress 👏",
        onResume: () => setGateOpen(false),
      });
      setGateOpen(true);
      return;
    }

    // 3) Low-balance trigger — fired once per session/cooldown when
    //    student enters the panel with insufficient runway for the next
    //    session/voice action.
    if (
      cfg.topup_trigger_low_balance !== false &&
      isLow &&
      _topupGuardRef.current?.canOpen("low_balance")
    ) {
      _topupGuardRef.current.markOpened();
      setGateContext({
        feature: "low_balance",
        reason: "low_balance",
        requiredPoints: Math.max(_sessionCost, threshold),
        balance,
        label: "Top up to continue learning",
        onResume: () => setGateOpen(false),
      });
      setGateOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase, gateOpen, config, balanceNum,
    repliesRemaining, repliesUsed, session?.status,
  ]);
  // ──────────────────────────────────────────────────────────────────────

  // Reading Hub (P1) — read-only state notification, additive. Mirrors
  // exactly what the standalone fab would have shown (same label logic),
  // computed early so it can sit before the early-return guards below
  // (hooks must run in the same order every render). Reports visible:false
  // (not just omitting the call) once EduTalk is unavailable, so a host
  // that cached a previous "visible" state knows to drop its own row.
  useEffect(() => {
    if (!onFabState) return;
    const available = isAuthenticated && !!student?.studentId && !!config?.enabled;
    if (!available) {
      onFabState({ visible: false });
      return;
    }
    const cost = Number(config.session_cost ?? 5) || 0;
    const label = session && session.status === "active"
      ? `Active ${session.reply_limit - session.replies_remaining}/${session.reply_limit}`
      : session && session.status === "completed"
      ? "Continue"
      : cost <= 0 ? "Free" : `${cost} pts`;
    onFabState({
      visible: phase === "idle",
      label,
      isActive: session?.status === "active",
      onOpen: openViaHub,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFabState, isAuthenticated, student?.studentId, config, phase, session?.status, session?.reply_limit, session?.replies_remaining]);

  if (!isAuthenticated || !student?.studentId) return null;
  if (!config || !config.enabled) return null;

  const sessionCost = Number(config.session_cost ?? 5) || 0;
  const replyLimit = Number(config.reply_limit ?? 5) || 0;
  const detectedContentMode = session?.content_mode || "general_reading";

  const onOpen = () => {
    if (session && session.status === "active" && session.replies_remaining > 0) {
      setPhase("chat");
      return;
    }
    setErrorMsg("");
    setInsufficient(null);
    setContinueState(null);
    setPhase("confirm");
  };
  // Reading Hub (P1) — see onOpenRef's declaration comment above.
  onOpenRef.current = onOpen;

  // Core start logic. Reused by ConfirmCard and ContinuationCard.
  // Returns true on successful start, false on insufficient_points (handled
  // inline by callers), and throws on hard errors.
  const _doStart = async () => {
    // P0 fix — resolvedPassword is a snapshot from THIS render. If it's
    // empty, AuthContext's GAS re-hydration effect may simply not have
    // landed yet (see the studentRef comment above) — give it a bounded
    // window via the live ref before concluding the student really isn't
    // authenticated. The common case (password already resolved) hits
    // neither branch and starts exactly as before.
    const password = hasPassword ? resolvedPassword : await _waitForPassword(studentRef);
    if (!password) {
      throw new Error("Please refresh and log in again to use EduTalk.");
    }
    // Phase 3: include book_tier so the backend resolves tier-aware config
    // server-side, and student_context (6 monthly scores + teacher notes)
    // read from AuthContext.portalData — NEVER refetched from GAS here.
    const startPayload = {
      book_slug: bookSlug || "",
      book_title: bookTitle || "",
      book_tier: bookTier || "",
      chapter_title: chapterTitle || "",
      chapter_idx: Number.isFinite(chapterIdx) ? chapterIdx : 0,
      page_idx: Number.isFinite(pageIdx) ? pageIdx : 0,
      visible_text: String(visibleText || "").slice(0, 4500),
      content_mode_hint: "",
      password,
    };
    const sc = _buildStudentContext(student);
    if (sc && config?.score_aware) {
      // Only send context to tiers that actually use it. Free/Standard
      // tiers receive a clean payload identical to Phase 2A.
      startPayload.student_context = sc;
    }
    const r = await _apiPost("/api/student/edutalk/start", startPayload);
    if (r?.success === false && r?.error === "insufficient_points") {
      return {
        ok: false,
        insufficient: {
          required: Number(r.required_points) || sessionCost,
          remaining: Number(r.points_remaining) || 0,
          message: r.message || "Not enough points.",
        },
      };
    }
    if (!r?.success) {
      throw new Error("Unexpected response from server.");
    }
    const startedSession = {
      session_id: r.session_id,
      replies_remaining: Number(r.replies_remaining) || replyLimit,
      reply_limit: Number(r.reply_limit) || replyLimit,
      content_mode: r.content_mode || "general_reading",
      greeting: r.greeting || "",
      // v2.1 — honour server-decided greeting language for the first
      // assistant bubble so the audio button label is correct:
      //   english → 🔊 បកប្រែ (final product default)
      //   khmer   → 🎧 ហាត់ស្តាប់ (Khmer-support mode opt-in)
      messages: r.greeting
        ? [{
            role: "assistant",
            message: r.greeting,
            created_at: new Date().toISOString(),
            reply_language: r.greeting_language || "english",
          }]
        : [],
      status: "active",
      // Phase 3: voice flags from the start response.
      voice_reply_enabled: !!r.voice_reply_enabled,
      voice_cost: Number(r.voice_cost) || 0,
    };
    try {
      localStorage.setItem(
        _chapterStorageKey(bookSlug, chapterIdx),
        startedSession.session_id,
      );
    } catch { /* noop */ }
    return { ok: true, session: startedSession };
  };

  // First-time start flow (called from ConfirmCard).
  const onStart = async () => {
    if (starting) return; // frontend duplicate-tap guard
    setStarting(true);
    setErrorMsg("");
    setInsufficient(null);
    try {
      const out = await _doStart();
      if (!out.ok) {
        // Phase 3: instead of dead-end "insufficient" card, open the
        // contextual PointsGateModal so the student can top up without
        // leaving the book. Keep the inline message too so the original
        // ConfirmCard still surfaces it as a fallback.
        setInsufficient(out.insufficient);
        setStarting(false);
        setGateContext({
          feature: "start",
          requiredPoints: out.insufficient.required,
          balance: out.insufficient.remaining,
          label: "Start EduTalk",
          onResume: () => {
            // Auto-resume: close modal, re-enter confirm phase, then retry.
            setGateOpen(false);
            setPhase("confirm");
            setInsufficient(null);
            // Slight defer so refreshPoints has settled.
            setTimeout(() => { onStart(); }, 120);
          },
        });
        setGateOpen(true);
        return;
      }
      setSession(out.session);
      setStarting(false);
      setPhase("chat");
    } catch (e) {
      setStarting(false);
      setErrorMsg(e?.message || "Could not start EduTalk. No points were charged.");
      setPhase("error");
    }
  };

  // Continuation flow (called from ContinuationCard after replies exhausted
  // OR session expired). Same endpoint, same charge, explicit confirm only.
  const onContinue = async () => {
    if (starting) return;
    setStarting(true);
    setErrorMsg("");
    try {
      const out = await _doStart();
      if (!out.ok) {
        // Insufficient balance on continuation: stay on the continuation
        // card, just show the insufficient message inline.
        setInsufficient(out.insufficient);
        setStarting(false);
        return;
      }
      // Reset chat to brand-new session's greeting only — previous
      // messages are not shown in the visible chat (they remain in DB).
      setSession(out.session);
      setContinueState(null);
      setInsufficient(null);
      setStarting(false);
      setPhase("chat");
    } catch (e) {
      setStarting(false);
      setErrorMsg(e?.message || "Could not start a new session. No points were charged.");
      setPhase("error");
    }
  };

  const onClose = () => {
    setPhase("idle");
    setErrorMsg("");
    setInsufficient(null);
    setContinueState(null);
    setStarting(false);
  };

  // Pill state label
  const launcherLabel = (() => {
    if (session && session.status === "active") {
      return `Active ${session.reply_limit - session.replies_remaining}/${session.reply_limit}`;
    }
    if (session && session.status === "completed") return "Continue";
    if (sessionCost <= 0) return "Free";
    return `${sessionCost} pts`;
  })();

  const isActive = session?.status === "active";
  const isCompleted = session?.status === "completed";

  return (
    <>
      {/* Inject keyframes once — scoped via unique animation name */}
      <style>{`
        @keyframes edutalk-breathe {
          0%, 100% {
            box-shadow:
              0 10px 28px rgba(8, 5, 15, 0.45),
              0 0 0 0 rgba(212, 168, 67, 0.35),
              inset 0 1px 0 rgba(255, 225, 154, 0.18);
          }
          50% {
            box-shadow:
              0 14px 36px rgba(8, 5, 15, 0.55),
              0 0 0 7px rgba(212, 168, 67, 0.00),
              inset 0 1px 0 rgba(255, 225, 154, 0.28);
          }
        }
        @keyframes edutalk-spark {
          0%, 100% { opacity: 0.85; transform: scale(1); }
          50%      { opacity: 1;    transform: scale(1.08); }
        }
        @keyframes edutalkSpin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes edutalkFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .edutalk-fab-wrap {
          position: fixed;
          right: max(18px, env(safe-area-inset-right));
          bottom: calc(118px + env(safe-area-inset-bottom));
          z-index: 60;
          pointer-events: auto;
        }
        @media (min-width: 1024px) {
          .edutalk-fab-wrap { bottom: calc(92px + env(safe-area-inset-bottom)); }
        }
        @media (prefers-reduced-motion: reduce) {
          .edutalk-fab { animation: none !important; }
          .edutalk-fab-spark { animation: none !important; }
        }
      `}</style>

      {/* Floating launcher — hidden while modal/chat is open to avoid
          double-stacked UI behind the overlay. Reading Hub (P1) —
          hideOwnFab additionally suppresses it when a host is providing
          an equivalent trigger via onFabState; everything below (confirm/
          chat/error phases, session logic) is completely unaffected. */}
      {!hideOwnFab && phase === "idle" && (
        <div
          className="edutalk-fab-wrap"
          data-testid="edutalk-launcher-wrap"
        >
          <button
            type="button"
            onClick={onOpen}
            className="edutalk-fab"
            data-testid="edutalk-launcher-btn"
            data-status={session?.status || "idle"}
            aria-label={`Open EduTalk — ${launcherLabel}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 16px 11px 13px",
              minHeight: 48,
              borderRadius: 999,
              background:
                "linear-gradient(135deg, rgba(26, 18, 38, 0.92) 0%, rgba(35, 22, 56, 0.92) 50%, rgba(48, 30, 72, 0.92) 100%)",
              color: "#F4E5C1",
              border: "1px solid rgba(212, 168, 67, 0.65)",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.02em",
              cursor: "pointer",
              backdropFilter: "blur(10px) saturate(140%)",
              WebkitBackdropFilter: "blur(10px) saturate(140%)",
              animation: "edutalk-breathe 3.4s ease-in-out infinite",
              transition: "transform 180ms ease, border-color 180ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.borderColor = "#FFE19A";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.borderColor = "rgba(212, 168, 67, 0.65)";
            }}
          >
            {/* Inline SVG — speech-bubble with sparkle inside.
                Custom mark, not a lucide icon, for premium feel. */}
            <span
              className="edutalk-fab-spark"
              aria-hidden="true"
              style={{
                display: "inline-grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: 999,
                background:
                  "linear-gradient(135deg, rgba(212,168,67,0.28), rgba(155,125,240,0.22))",
                border: "1px solid rgba(255, 225, 154, 0.35)",
                animation: "edutalk-spark 2.6s ease-in-out infinite",
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                xmlns="http://www.w3.org/2000/svg"
                style={{ display: "block" }}
              >
                <defs>
                  <linearGradient id="edutalk-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#FFE19A" />
                    <stop offset="100%" stopColor="#D4A843" />
                  </linearGradient>
                </defs>
                {/* speech bubble */}
                <path
                  d="M5 4.5h11.5a3 3 0 0 1 3 3v6.4a3 3 0 0 1-3 3H10.4l-4.2 2.7a.55.55 0 0 1-.85-.46v-2.45A3 3 0 0 1 2 13.9V7.5a3 3 0 0 1 3-3Z"
                  fill="none"
                  stroke="url(#edutalk-grad)"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                {/* inner sparkle */}
                <path
                  d="M11 8.2 11.9 10l1.8.9-1.8.9-.9 1.8-.9-1.8L8.3 10.9 10.1 10 11 8.2Z"
                  fill="url(#edutalk-grad)"
                />
              </svg>
            </span>

            <span
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 7,
                lineHeight: 1,
              }}
            >
              <span
                style={{
                  fontFamily:
                    "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
                  fontWeight: 700,
                  fontSize: 15,
                  letterSpacing: "0.04em",
                  color: "#FFE19A",
                }}
              >
                EduTalk
              </span>

              {/* Cost / state badge — sub-pill */}
              <span
                data-testid="edutalk-launcher-badge"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: "0.04em",
                  background: isActive
                    ? "rgba(74, 222, 128, 0.16)"
                    : isCompleted
                      ? "rgba(155, 125, 240, 0.20)"
                      : "rgba(212, 168, 67, 0.20)",
                  color: isActive
                    ? "#86efac"
                    : isCompleted
                      ? "#c4b5fd"
                      : "#FFE19A",
                  border: `1px solid ${
                    isActive
                      ? "rgba(74, 222, 128, 0.45)"
                      : isCompleted
                        ? "rgba(155, 125, 240, 0.55)"
                        : "rgba(212, 168, 67, 0.55)"
                  }`,
                }}
              >
                {launcherLabel}
              </span>
            </span>
          </button>
        </div>
      )}

      {phase !== "idle" && (
        <Overlay onBackdrop={gateOpen ? null : (phase === "chat" ? null : onClose)}>
          {/* When the gate modal is open, the backdrop is locked so a
              tap-outside on the top-up modal cannot accidentally reset
              the EduTalk session to idle. */}
          {phase === "confirm" && (
            <ConfirmCard
              displayText={config.display_text}
              firstName={(student.display_name || student.studentId || "friend").split(" ")[0]}
              studentId={student.studentId}
              balance={balanceNum}
              sessionCost={sessionCost}
              replyLimit={replyLimit}
              bookTitle={bookTitle}
              chapterTitle={chapterTitle}
              contentMode={detectedContentMode}
              insufficient={insufficient}
              starting={starting}
              passSummary={passSummary}
              onCancel={onClose}
              onStart={onStart}
            />
          )}
          {phase === "loading" && <LoadingCard label="Starting EduTalk…" />}
          {phase === "error" && (
            <ErrorCard message={errorMsg} onClose={onClose} />
          )}
          {phase === "chat" && session && (
            <ChatPanel
              session={session}
              setSession={setSession}
              onClose={onClose}
              bookSlug={bookSlug}
              chapterIdx={chapterIdx}
              balance={balanceNum}
              sessionCost={sessionCost}
              replyLimit={replyLimit}
              starting={starting}
              insufficient={insufficient}
              continueState={continueState}
              setContinueState={setContinueState}
              onContinue={onContinue}
              // Phase 3 — voice reply context
              voiceEnabled={!!session.voice_reply_enabled}
              voiceCost={Number(session.voice_cost) || 0}
              resolvedPassword={resolvedPassword}
              // v1 — sticky mini-hook context (small premium pill above
              // the typing box).  Hook reads admin config + opens the
              // full modal when tapped.  Respects existing guards.
              config={config}
              activeBanners={activeBanners}
              onOpenMiniHook={() => {
                setGateContext({
                  feature: "edutalk",
                  reason: "low_balance",
                  requiredPoints: replyLimit > 0 ? sessionCost : 0,
                  balance: balanceNum,
                  label: "Top up points",
                  onResume: () => setGateOpen(false),
                });
                setGateOpen(true);
              }}
              onVoiceInsufficient={(req, bal) => {
                setGateContext({
                  feature: "voice",
                  reason: "voice",
                  requiredPoints: req,
                  balance: bal,
                  label: "Voice Reply",
                  onResume: () => {
                    // Auto-resume voice: just close modal. The student
                    // can tap the speaker icon again to retry.
                    setGateOpen(false);
                  },
                });
                setGateOpen(true);
              }}
            />
          )}
        </Overlay>
      )}

      {/* Phase 3 — promotion banners (above launcher; non-blocking).
          Mounted at root so it stays visible even when overlay is open.
          Reading Hub (P1 audit fix) — this is a SEPARATE independently-
          positioned floating element that hideOwnFab's original wrap
          missed (it only covered the main .edutalk-fab-wrap block below).
          Suppressing it too — it's exactly the "duplicated floating
          control" the Phase B audit was asked to find. A future pass can
          surface `activeBanners` through onFabState so Hub can show an
          equivalent badge; for now correctness (no second floating
          object) wins over feature parity. */}
      {!hideOwnFab && activeBanners.length > 0 && phase === "idle" && (
        <div
          data-testid="edutalk-promo-banners"
          style={{
            position: "fixed",
            right: "max(18px, env(safe-area-inset-right))",
            bottom: "calc(178px + env(safe-area-inset-bottom))",
            zIndex: 59,
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            pointerEvents: "auto",
            maxWidth: "280px",
          }}
        >
          {activeBanners.slice(0, 2).map((b) => (
            <PromoBanner
              key={b.promo_id || b.name}
              banner={b}
              preferredLang={
                (config?.topup_prompt_lang || "kh") === "english" ? "en" : "kh"
              }
              onDismiss={() => {
                _dismissPromo(b.promo_id);
                setActiveBanners((prev) =>
                  prev.filter((x) => x.promo_id !== b.promo_id),
                );
              }}
            />
          ))}
        </div>
      )}

      {/* Phase 3 — inline contextual top-up modal */}
      <PointsGateModal
        open={gateOpen}
        onClose={closeGate}
        requiredPoints={gateContext?.requiredPoints || 0}
        balance={
          typeof portalPoints === "number"
            ? portalPoints
            : Number(gateContext?.balance || balanceNum || 0)
        }
        featureLabel={gateContext?.label || "Top up points"}
        config={config}
        preferredLang={
          (config?.topup_prompt_lang || "kh") === "english" ? "en" : "kh"
        }
        promotionAware={config?.topup_trigger_promotion_aware !== false}
        activeBanners={activeBanners}
        triggerReason={gateContext?.reason || "insufficient"}
        onResume={() => {
          // Part 2 — when the student successfully resumes after a top-up,
          // mark the visit as resolved (so closeGate doesn't count it as a
          // dismissal) and suppress further prompts for 3 seconds.
          _topupResolvedRef.current = true;
          try { _topupGuardRef.current?.markSuppressed(3000); } catch { /* noop */ }
          if (typeof gateContext?.onResume === "function") gateContext.onResume();
        }}
        resumeBehaviour={config?.topup_after_behaviour || "auto_start"}
      />
    </>
  );
}

/* ============================================================ */
/*  Overlay + cards                                              */
/* ============================================================ */
function Overlay({ children, onBackdrop }) {
  return (
    <div
      onClick={onBackdrop || undefined}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(8,5,15,0.78)",
        backdropFilter: "blur(4px)",
        display: "flex", alignItems: "flex-end", justifyContent: "center",
      }}
      data-testid="edutalk-overlay"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 520,
          margin: "0 auto",
          background: "linear-gradient(180deg, #1a1226, #100a1b)",
          color: "#F4E5C1",
          borderTopLeftRadius: 22, borderTopRightRadius: 22,
          borderTop: "1px solid rgba(212,168,67,0.35)",
          boxShadow: "0 -22px 60px rgba(0,0,0,0.55)",
          padding: 18,
          maxHeight: "92vh",
          display: "flex", flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ModePill({ mode }) {
  const m = _modePill(mode);
  return (
    <span
      data-testid="edutalk-mode-pill"
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "3px 9px", borderRadius: 999,
        background: "rgba(155,125,240,0.14)",
        color: "#F4E5C1",
        border: "1px solid rgba(155,125,240,0.45)",
        fontSize: 11, fontWeight: 700, letterSpacing: "0.02em",
      }}
    >
      <span aria-hidden="true">{m.icon}</span>
      <span>{m.text}</span>
    </span>
  );
}

function ConfirmCard({
  displayText, firstName, studentId, balance, sessionCost, replyLimit,
  bookTitle, chapterTitle, contentMode, insufficient, starting,
  passSummary,
  onCancel, onStart,
}) {
  const isFree = Number(sessionCost) <= 0;
  const balanceText = balance === null ? "—" : `${balance} points`;
  // v1.2 — pre-start "Pass Available" hints. Counts-only payload from
  // /api/student/edutalk-passes/summary. Auto-hides when zero passes.
  const sessionPasses = Number((passSummary && passSummary.edutalk_session) || 0);
  const voicePasses   = Number((passSummary && passSummary.edutalk_voice)   || 0);
  const ctaLabel = isFree
    ? "Start Free Session"
    : sessionPasses > 0
      ? "Use Free Pass · Start"
      : `Use ${sessionCost} pts · Start`;

  return (
    <div data-testid="edutalk-confirm-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: "rgba(212,168,67,0.18)",
          display: "grid", placeItems: "center",
        }}>
          <Sparkles size={18} color="#d4a843" />
        </div>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
            EduTalk Coach
          </h3>
          <p style={{ margin: "2px 0 0", fontSize: 11.5, opacity: 0.75 }}>
            Book-aware AI session
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close EduTalk"
          data-testid="edutalk-confirm-close"
          style={{
            background: "transparent", border: "none", color: "#F4E5C1",
            cursor: "pointer", minWidth: 44, minHeight: 44,
            display: "grid", placeItems: "center",
          }}
        >
          <X size={18} />
        </button>
      </div>

      <p style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: 12, color: "rgba(244,229,193,0.92)" }}>
        {displayText || `Hello ${firstName}. I'm your EduTalk coach for this chapter.`}
      </p>

      <ul
        data-testid="edutalk-confirm-info"
        style={{ listStyle: "none", padding: 0, margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.7 }}
      >
        <li data-testid="edutalk-confirm-studentid">
          <span style={{ opacity: 0.7, marginRight: 6 }}>Student ID:</span>
          <strong
            style={{
              color: "#d4a843",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              letterSpacing: "0.02em",
            }}
          >
            {studentId || "—"}
          </strong>
        </li>

        {!isFree && (
          <li data-testid="edutalk-confirm-balance">
            <Wallet size={12} style={{ verticalAlign: -1, marginRight: 6, color: "#9b7df0" }} />
            Your balance: <strong style={{ color: "#F4E5C1", fontWeight: 800 }}>{balanceText}</strong>
            {balance === null && (
              <span style={{ display: "block", marginLeft: 18, fontSize: 11, opacity: 0.7 }}>
                (verified before deduction)
              </span>
            )}
          </li>
        )}

        {!isFree && (
          <li data-testid="edutalk-confirm-cost">
            <Wallet size={12} style={{ verticalAlign: -1, marginRight: 6, color: "#d4a843" }} />
            Session cost: <strong style={{ color: "#d4a843" }}>{sessionCost} points</strong>
          </li>
        )}

        {/* v1.2 — Mystery Box EduTalk pass hints. Counts-only, auto-hides
            when zero. Rendered inside the existing confirm card so the
            launcher visibility & last-page-only guard are untouched. */}
        {sessionPasses > 0 && (
          <li
            data-testid="edutalk-pass-hint-session"
            style={{
              listStyle: "none",
              marginLeft: -2,
              padding: "8px 10px",
              borderRadius: 10,
              background: "linear-gradient(135deg, rgba(255,225,154,0.14), rgba(212,168,67,0.10))",
              border: "1px solid rgba(212,168,67,0.40)",
              color: "#F4E5C1",
            }}
          >
            <span role="img" aria-label="ticket" style={{ marginRight: 6 }}>🎟</span>
            <strong style={{ color: "#FFE19A" }}>
              {sessionPasses} EduTalk Pass{sessionPasses === 1 ? "" : "es"} Available
            </strong>
            <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 2 }}>
              Use your free pass before points.
            </div>
          </li>
        )}
        {voicePasses > 0 && (
          <li
            data-testid="edutalk-pass-hint-voice"
            style={{
              listStyle: "none",
              marginLeft: -2,
              padding: "8px 10px",
              borderRadius: 10,
              background: "linear-gradient(135deg, rgba(186,148,255,0.16), rgba(120,85,200,0.10))",
              border: "1px solid rgba(186,148,255,0.40)",
              color: "#F4E5C1",
            }}
          >
            <span role="img" aria-label="headphones" style={{ marginRight: 6 }}>🎧</span>
            <strong style={{ color: "#E1D2FF" }}>
              {voicePasses} Voice Reply Pass{voicePasses === 1 ? "" : "es"} Available
            </strong>
            <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 2 }}>
              Use your free voice pass before points.
            </div>
          </li>
        )}

        <li data-testid="edutalk-confirm-replies">
          <MessageCircle size={12} style={{ verticalAlign: -1, marginRight: 6, color: "#d4a843" }} />
          Included replies: <strong style={{ color: "#F4E5C1" }}>{replyLimit}</strong>
        </li>

        {!!bookTitle && (
          <li data-testid="edutalk-confirm-book">
            <span style={{ opacity: 0.7, marginRight: 6 }}>Book:</span>
            <strong style={{ color: "#F4E5C1" }}>{bookTitle}</strong>
          </li>
        )}

        {!!chapterTitle && (
          <li data-testid="edutalk-confirm-chapter">
            <span style={{ opacity: 0.7, marginRight: 6 }}>Chapter:</span>
            <strong style={{ color: "#F4E5C1" }}>{chapterTitle}</strong>
          </li>
        )}

        <li data-testid="edutalk-confirm-mode" style={{ marginTop: 4 }}>
          <span style={{ opacity: 0.7, marginRight: 6 }}>Mode:</span>
          <ModePill mode={contentMode} />
        </li>
      </ul>

      {insufficient && (
        <div
          data-testid="edutalk-insufficient"
          style={{
            border: "1px solid rgba(244,114,114,0.5)",
            background: "rgba(244,114,114,0.10)",
            padding: 10, borderRadius: 12, marginBottom: 12, fontSize: 12.5,
            color: "#fca5a5",
          }}
        >
          <AlertCircle size={13} style={{ verticalAlign: -1, marginRight: 6 }} />
          {insufficient.message}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={starting}
          data-testid="edutalk-confirm-cancel"
          style={{
            flex: 1, padding: "12px 14px", borderRadius: 12,
            minHeight: 44,
            background: "transparent",
            color: "#F4E5C1",
            border: "1px solid rgba(244,229,193,0.30)",
            cursor: starting ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600,
            opacity: starting ? 0.6 : 1,
          }}
        >
          Not now
        </button>
        <button
          type="button"
          onClick={onStart}
          disabled={!!insufficient || starting}
          data-testid="edutalk-confirm-start"
          style={{
            flex: 1.4, padding: "12px 14px", borderRadius: 12,
            minHeight: 44,
            background: insufficient || starting
              ? "rgba(60,40,80,0.6)"
              : "linear-gradient(135deg, #d4a843, #9b7df0)",
            color: insufficient || starting ? "rgba(244,229,193,0.6)" : "#1a1226",
            border: "none",
            cursor: insufficient || starting ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 800, letterSpacing: "0.02em",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
          }}
        >
          {starting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span>Starting…</span>
            </>
          ) : (
            <span>{ctaLabel}</span>
          )}
        </button>
      </div>
    </div>
  );
}

function LoadingCard({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 18 }}
         data-testid="edutalk-loading">
      <Loader2 size={20} className="animate-spin" color="#d4a843" />
      <span style={{ fontSize: 13.5 }}>{label}</span>
    </div>
  );
}

function ErrorCard({ message, onClose }) {
  return (
    <div data-testid="edutalk-error">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <AlertCircle size={20} color="#fca5a5" />
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>EduTalk could not start</h3>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 16, color: "rgba(244,229,193,0.92)" }}>
        {message || "Something went wrong. No points were charged."}
      </p>
      <button
        type="button"
        onClick={onClose}
        data-testid="edutalk-error-close"
        aria-label="Close EduTalk"
        style={{
          padding: "12px 14px", borderRadius: 12, minHeight: 44,
          background: "linear-gradient(135deg, #d4a843, #9b7df0)",
          color: "#1a1226",
          border: "none", cursor: "pointer", fontSize: 13, fontWeight: 800,
        }}
      >
        Close
      </button>
    </div>
  );
}

/* ============================================================ */
/*  Continuation card (Issue 2 + Section 4D)                     */
/* ============================================================ */
function ContinuationCard({
  kind, replyLimit, balance, sessionCost, starting, insufficient,
  onConfirm, onCancel,
}) {
  const isExpired = kind === "expired";
  const isFree = Number(sessionCost) <= 0;
  const balanceText = balance === null ? "—" : `${balance} points`;
  const cannotAfford =
    !isFree && balance !== null && Number.isFinite(balance) && balance < sessionCost;
  const disabled = starting || cannotAfford;

  return (
    <div
      data-testid="edutalk-continuation-card"
      data-kind={kind}
      style={{
        marginTop: 6,
        padding: 14,
        borderRadius: 14,
        background: "rgba(155,125,240,0.08)",
        border: "1px solid rgba(212,168,67,0.40)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <CheckCircle2 size={16} color={isExpired ? "#fbbf24" : "#4ade80"} />
        <strong style={{ fontSize: 13.5 }}>
          {isExpired ? "Session expired" : "Session complete"}
        </strong>
      </div>

      <p
        style={{
          margin: "0 0 8px", fontSize: 12.5, lineHeight: 1.55,
          color: "rgba(244,229,193,0.92)",
        }}
      >
        {isExpired
          ? `Your session expired. You used all ${replyLimit} replies or ran out of time.`
          : `You used all ${replyLimit} replies.`}
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", fontSize: 12.5, lineHeight: 1.6 }}>
        {!isFree && (
          <li>
            <Wallet size={12} style={{ verticalAlign: -1, marginRight: 6, color: "#9b7df0" }} />
            Current balance: <strong style={{ color: "#F4E5C1" }}>{balanceText}</strong>
          </li>
        )}
        <li>
          <MessageCircle size={12} style={{ verticalAlign: -1, marginRight: 6, color: "#d4a843" }} />
          {replyLimit} more guided replies included
        </li>
        {!isFree && (
          <li>
            Start a new session for <strong style={{ color: "#d4a843" }}>{sessionCost} points</strong>?
          </li>
        )}
      </ul>

      {(cannotAfford || insufficient) && (
        <div
          data-testid="edutalk-continuation-insufficient"
          style={{
            border: "1px solid rgba(244,114,114,0.5)",
            background: "rgba(244,114,114,0.10)",
            padding: 9, borderRadius: 10, marginBottom: 10, fontSize: 12.5,
            color: "#fca5a5",
          }}
        >
          <AlertCircle size={13} style={{ verticalAlign: -1, marginRight: 6 }} />
          {insufficient?.message || "Insufficient points. Please top up."}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={starting}
          data-testid="edutalk-continuation-cancel"
          style={{
            flex: 1, padding: "11px 12px", borderRadius: 12, minHeight: 44,
            background: "transparent",
            color: "#F4E5C1",
            border: "1px solid rgba(244,229,193,0.30)",
            cursor: starting ? "not-allowed" : "pointer",
            fontSize: 12.5, fontWeight: 600,
            opacity: starting ? 0.6 : 1,
          }}
        >
          Not now
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          data-testid="edutalk-continuation-confirm"
          style={{
            flex: 1.4, padding: "11px 12px", borderRadius: 12, minHeight: 44,
            background: disabled
              ? "rgba(60,40,80,0.6)"
              : "linear-gradient(135deg, #d4a843, #9b7df0)",
            color: disabled ? "rgba(244,229,193,0.6)" : "#1a1226",
            border: "none",
            cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 12.5, fontWeight: 800, letterSpacing: "0.02em",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
          }}
        >
          {starting ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              <span>Starting…</span>
            </>
          ) : (
            <span>
              {isFree
                ? "Confirm New Session"
                : `Confirm New Session — ${sessionCost} pts`}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Voice playback helpers — iOS / PWA fix v1                   */
/*                                                               */
/*  Root cause of silent failure on iPhone/PWA:                  */
/*    1. `data:audio/mpeg;base64,...` URLs are large, slow to    */
/*       decode, and unreliable on WebKit.                       */
/*    2. `new Audio(url)` without preload/volume/playsInline     */
/*       setup fails silently on iOS.                            */
/*    3. `await a.play()` was called AFTER `await _apiPost()`    */
/*       (2-5 s round-trip). iOS expires the user-gesture        */
/*       context in ~1 s, so play() is always rejected with      */
/*       NotAllowedError — and the error was swallowed silently. */
/*                                                               */
/*  Fix:                                                          */
/*    - b64 → Blob → blob: URL (fast, small, WebKit-friendly)   */
/*    - Configure Audio element for inline iOS playback          */
/*    - Expose play() errors as an actionable inline message     */
/*    - Cache the blob: URL so second tap plays without network  */
/*    - Revoke blob: URLs on unmount to prevent memory leaks     */
/* ============================================================ */

/**
 * Decode a base64 audio string into a blob: object URL.
 * Blob URLs are smaller to store, faster for WebKit to decode, and avoid
 * the large-string allocation that data: URLs require.
 * The caller must call URL.revokeObjectURL() when done.
 */
function _b64ToObjectUrl(b64, mimeType = "audio/mpeg") {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  const blob = new Blob([buf], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Create an Audio element configured for reliable iOS / PWA inline playback.
 *   - preload="auto"  : browser buffers audio before play() is called
 *   - volume=1        : ensure full volume (iOS silent-switch aside)
 *   - muted=false     : never start muted
 *   - playsInline     : prevents iOS full-screen hijack or background-audio
 *   - load()          : kick off buffering immediately so play() latency
 *                       stays within the iOS user-gesture window on replay
 */
function _makeSafeAudio(src) {
  const a = new Audio();
  a.preload = "auto";
  a.volume = 1;
  a.muted = false;
  // playsInline is non-standard — set both the property and the attribute
  // so all WebKit versions recognise it.
  try { a.playsInline = true; } catch { /* read-only in some environments */ }
  a.setAttribute("playsinline", "");
  a.src = src;
  a.load();
  return a;
}

/* ============================================================ */
/*  Voice Input hook (EduTalk Voice-to-Text)                     */
/* ============================================================ */
/*
 * useVoiceInput — captures a short spoken question from the student,
 * sends it as base64 to /api/student/edutalk/transcribe, and returns
 * the transcribed text via onTranscribed().  Free of charge — no
 * point deduction occurs.  Points are only deducted at /message when
 * the student finally hits Send.
 *
 * Codec selection: we ask MediaRecorder.isTypeSupported() directly,
 * NO UA sniffing.  iOS Safari naturally lands on audio/mp4, Chrome /
 * Android on audio/webm;codecs=opus.  Whatever the browser actually
 * recorded is forwarded as `mime_type` to the backend so Gemini sees
 * the truthful container — no guessing.
 */
function _pickSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=aac",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch { /* noop */ }
  }
  return "";
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      // result is "data:<mime>;base64,<payload>" — strip the prefix.
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

function useVoiceInput({ sessionId, password, onTranscribed, onError }) {
  const [state, setState] = useState("idle"); // idle | requesting | recording | processing | error
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const autoStopRef = useRef(null);
  const errorResetRef = useRef(null);
  const mimeTypeRef = useRef("");

  const mimeType = useMemo(() => _pickSupportedMimeType(), []);
  const micSupported =
    typeof MediaRecorder !== "undefined" &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    mimeType !== "";

  // Reset to idle 3 s after entering error state.
  useEffect(() => {
    if (state !== "error") return undefined;
    if (errorResetRef.current) clearTimeout(errorResetRef.current);
    errorResetRef.current = setTimeout(() => setState("idle"), 3000);
    return () => {
      if (errorResetRef.current) {
        clearTimeout(errorResetRef.current);
        errorResetRef.current = null;
      }
    };
  }, [state]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
      if (errorResetRef.current) clearTimeout(errorResetRef.current);
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch { /* noop */ }
      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((tr) => {
            try { tr.stop(); } catch { /* noop */ }
          });
        }
      } catch { /* noop */ }
    };
  }, []);

  const _releaseStream = useCallback(() => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((tr) => {
          try { tr.stop(); } catch { /* noop */ }
        });
      }
    } catch { /* noop */ }
    streamRef.current = null;
  }, []);

  const _processRecording = useCallback(async () => {
    setState("processing");
    try {
      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || "audio/webm" });
      chunksRef.current = [];
      if (!blob || blob.size === 0) {
        setState("idle");
        return;
      }
      const audio_b64 = await _blobToBase64(blob);
      const data = await _apiPost("/api/student/edutalk/transcribe", {
        session_id: sessionId,
        audio_b64,
        mime_type: mimeTypeRef.current || "audio/webm",
        password: password || "",
      });
      const text = (data && typeof data.text === "string") ? data.text : "";
      if (typeof onTranscribed === "function") onTranscribed(text);
      setState("idle");
    } catch (exc) {
      if (typeof onError === "function") {
        onError("Could not transcribe. Please type your question.");
      }
      setState("error");
    }
  }, [sessionId, password, onTranscribed, onError]);

  const start = useCallback(async () => {
    if (!micSupported) return;
    if (state !== "idle") return;
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeTypeRef.current = mimeType;
      let recorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType });
      } catch {
        recorder = new MediaRecorder(stream);
        mimeTypeRef.current = recorder.mimeType || mimeType;
      }
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        _releaseStream();
        if (autoStopRef.current) {
          clearTimeout(autoStopRef.current);
          autoStopRef.current = null;
        }
        _processRecording();
      };
      recorder.onerror = () => {
        _releaseStream();
        if (typeof onError === "function") {
          onError("Recording failed. Please type your question.");
        }
        setState("error");
      };
      recorder.start();
      setState("recording");
      // Auto-stop after 30 s so a stuck recording cannot run forever.
      autoStopRef.current = setTimeout(() => {
        try {
          if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
          }
        } catch { /* noop */ }
      }, 30000);
    } catch {
      _releaseStream();
      if (typeof onError === "function") {
        onError("Microphone access was denied.");
      }
      setState("error");
    }
  }, [micSupported, state, mimeType, _releaseStream, _processRecording, onError]);

  const stop = useCallback(() => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      _releaseStream();
      setState("idle");
    }
  }, [_releaseStream]);

  return { state, start, stop, micSupported };
}

/* ============================================================ */
/*  Chat panel                                                   */
/* ============================================================ */
function ChatPanel({
  session, setSession, onClose, bookSlug, chapterIdx,
  balance, sessionCost, replyLimit,
  starting, insufficient,
  continueState, setContinueState, onContinue,
  // Phase 3 — voice reply props
  voiceEnabled, voiceCost, resolvedPassword, onVoiceInsufficient,
  // v1 — mini top-up hook props (optional).  When `onOpenMiniHook` is
  // provided, ChatPanel renders a small sticky pill above the typing
  // box that opens the full PointsGateModal on tap.
  config, activeBanners, onOpenMiniHook,
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const listRef = useRef(null);

  // EduTalk Voice Input — auto-clearing error timer (mirrors chatError pattern).
  const voiceErrorTimerRef = useRef(null);
  const showVoiceError = useCallback((msg) => {
    setChatError(msg);
    if (voiceErrorTimerRef.current) clearTimeout(voiceErrorTimerRef.current);
    voiceErrorTimerRef.current = setTimeout(() => setChatError(""), 3000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimerRef.current) clearTimeout(voiceErrorTimerRef.current);
  }, []);

  // EduTalk Voice Input — mic button hook.  Free of charge; the
  // returned text only populates the input field — the student
  // must still tap Send to spend a reply.
  const {
    state: voiceState,
    start: voiceStart,
    stop: voiceStop,
    micSupported,
  } = useVoiceInput({
    sessionId: session?.session_id || "",
    password: resolvedPassword || "",
    onTranscribed: (text) => {
      if (typeof text === "string" && text.length > 0) {
        setInput(text.slice(0, 800));
      }
    },
    onError: (msg) => showVoiceError(msg),
  });
  const voiceVisible =
    micSupported && session && session.status === "active";

  // Phase 3 — per-message audio cache keyed by message index.
  // Once a voice reply is generated for message i, replays cost zero.
  // Shape: { [i]: { audioUrl: "blob:...", scriptText: "..." } }
  const [voiceCache, setVoiceCache] = useState({});
  // Currently-loading message index (one at a time). null when idle.
  const [voiceLoading, setVoiceLoading] = useState(null);
  // Active <audio> element ref so we can stop a previous playback when a
  // new one starts.
  const audioRef = useRef(null);
  // Mirror of voiceCache kept in a ref so the unmount cleanup can revoke
  // blob: URLs without needing voiceCache in its dependency array.
  const voiceCacheRef = useRef({});

  // Revoke all cached blob: URLs and stop playback when ChatPanel unmounts.
  // This prevents memory leaks when the student closes the EduTalk panel.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch { /* noop */ }
        audioRef.current = null;
      }
      // voiceCacheRef intentionally reads latest cached blob URLs during unmount cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(voiceCacheRef.current).forEach((entry) => {
        const audioUrl = entry?.audioUrl;
        // v9.6 — only revoke blob: URLs we created locally; remote
        // R2 URLs seeded from the server must be left intact.
        if (
          typeof audioUrl === "string" &&
          audioUrl.startsWith("blob:") &&
          !entry?.fromServer
        ) {
          try { URL.revokeObjectURL(audioUrl); } catch { /* noop */ }
        }
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // v9.6 — seed voiceCache from server-side replay entitlements.
  //
  // `session.voice_entitlements` is populated by the resume path
  // (`GET /api/student/edutalk/session/:id`) with the list of
  // {message_index, audio_url, mime_type, script_text} that this
  // student has ALREADY PAID FOR.  We hydrate them as cache entries
  // so a replay tap is instant and FREE — no /speak call, no Gemini
  // call, no ElevenLabs/Gemini-TTS call, no point deduction.
  //
  // Server URLs are remote R2 URLs (NOT blob:), so we tag them with
  // `fromServer:true` to opt them out of the unmount-time
  // revokeObjectURL() sweep.  We never OVERWRITE a cache entry the
  // student just generated locally during this same session — the
  // local blob URL is fresher and avoids an extra network round-trip
  // when they replay immediately.
  const _entitlements = Array.isArray(session?.voice_entitlements)
    ? session.voice_entitlements
    : [];
  const _entitlementsKey = _entitlements
    .map((e) => `${e?.message_index ?? ""}:${e?.audio_url ?? ""}`)
    .join("|");
  useEffect(() => {
    if (!_entitlementsKey) return;
    setVoiceCache((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const e of _entitlements) {
        const mi = Number(e?.message_index);
        const url = String(e?.audio_url || "");
        if (!Number.isFinite(mi) || !url) continue;
        if (next[mi]) continue; // never clobber a fresher local entry
        next[mi] = {
          audioUrl: url,
          scriptText: String(e?.script_text || ""),
          fromServer: true,
        };
        voiceCacheRef.current[mi] = next[mi];
        changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_entitlementsKey]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [session.messages?.length, sending]);

  // Whenever the session crosses into completed locally, surface the
  // continuation card automatically — but never auto-charge.
  useEffect(() => {
    if (
      session &&
      (session.status === "completed" ||
        (session.status === "active" && Number(session.replies_remaining) <= 0))
    ) {
      try {
        localStorage.removeItem(_chapterStorageKey(bookSlug, chapterIdx));
      } catch { /* noop */ }
      if (!continueState) setContinueState({ kind: "completed" });
    }
  }, [session, continueState, setContinueState, bookSlug, chapterIdx]);

  const send = async (override) => {
    const text = String(override ?? input).trim();
    if (!text || sending) return;
    if (session.status !== "active" || session.replies_remaining <= 0) return;
    setInput("");
    setSending(true);
    setChatError("");
    const localStudentMsg = {
      role: "student", message: text, created_at: new Date().toISOString(),
    };
    setSession((prev) => ({
      ...prev,
      messages: [...(prev.messages || []), localStudentMsg],
    }));
    try {
      const r = await _apiPost("/api/student/edutalk/message", {
        session_id: session.session_id,
        message: text,
      });
      if (!r?.success) {
        setChatError("AI did not respond. Please try again.");
        return;
      }
      const assistantMsg = {
        role: "assistant",
        message: r.reply,
        created_at: new Date().toISOString(),
        // "english" → 🔊 បកប្រែ label  |  "khmer" → 🎧 ហាត់ស្ដាប label
        reply_language: r.reply_language || "english",
      };
      setSession((prev) => ({
        ...prev,
        messages: [...(prev.messages || []), assistantMsg],
        replies_remaining: Number(r.replies_remaining) || 0,
        status: r.status || prev.status,
      }));
    } catch (e) {
      const status = e?.status;
      if (status === 503) {
        // Section 4C: Gemini unavailable — do NOT decrement counter,
        // input stays enabled, show explicit inline message.
        setChatError(
          "EduTalk AI is temporarily unavailable. Your reply was not counted. Please try again in a moment."
        );
      } else if (status === 410) {
        // Section 4D: session expired on the server — surface
        // continuation card with the expired variant.
        setSession((prev) => (prev ? { ...prev, status: "expired" } : prev));
        setContinueState({ kind: "expired" });
      } else {
        setChatError(e?.message || "Could not reach EduTalk. Please try again.");
      }
    } finally {
      setSending(false);
    }
  };

  // Phase 3 — voice reply handler.
  // Hard rules respected:
  //   1) Cached audio plays for free (zero re-charge) on replay.
  //   2) Duplicate-tap guard via `voiceLoading` state.
  //   3) On insufficient_points response → bubble up via onVoiceInsufficient
  //      (parent opens PointsGateModal).
  //   4) On 503 / 502 → show inline error, no point change (backend already
  //      handled refund).
  //   5) play() failures surface a clear actionable message — never silent.
  const onSpeak = async (messageIndex, replyText) => {
    if (!voiceEnabled) return;
    if (voiceLoading !== null) return;
    if (!session?.session_id) return;
    if (!replyText || typeof replyText !== "string") return;

    // ── Replay from cache — zero additional cost ────────────────────────────
    // The blob: URL was created during generation and is still valid.
    // On iOS, play() called directly from a tap (no async wait) succeeds
    // because the user-gesture context has not expired.
    const cached = voiceCache[messageIndex];
    if (cached?.audioUrl) {
      try {
        if (audioRef.current) {
          try { audioRef.current.pause(); } catch { /* noop */ }
          audioRef.current = null;
        }
        const a = _makeSafeAudio(cached.audioUrl);
        audioRef.current = a;
        await a.play();
      } catch (playErr) {
        // Surface a clear actionable message rather than silent failure.
        // NotAllowedError = iOS media policy / silent switch.
        // NotSupportedError = codec issue.
        const isPolicy =
          playErr?.name === "NotAllowedError" ||
          playErr?.name === "NotSupportedError";
        setChatError(
          isPolicy
            ? "Audio is ready. Turn up your media volume and tap Replay again."
            : "Could not play audio. Tap Replay again.",
        );
      }
      return;
    }

    // ── Generate new voice audio ─────────────────────────────────────────────
    setVoiceLoading(messageIndex);
    setChatError("");
    try {
      const r = await _apiPost("/api/student/edutalk/speak", {
        session_id: session.session_id,
        message_index: messageIndex,
        reply_text: String(replyText).slice(0, 2800),
        password: resolvedPassword,
      });
      if (r?.success === false && r?.error === "insufficient_points") {
        if (typeof onVoiceInsufficient === "function") {
          onVoiceInsufficient(
            Number(r.required_points) || voiceCost,
            Number(r.points_remaining) || 0,
          );
        }
        setVoiceLoading(null);
        return;
      }
      if (!r?.success) {
        setChatError("Could not generate voice reply. Please try again.");
        setVoiceLoading(null);
        return;
      }

      // v9.6 — when the backend returns a stable R2 audio_url (either
      // from a free same-student replay, a safe-generic cache reuse,
      // or a fresh upload), prefer it: it survives page refresh,
      // device switch, and panel reopen without any extra base64
      // decode work on the client.
      const responseMime = String(r.mime_type || "audio/mpeg");
      const remoteUrl = String(r.audio_url || "");
      let audioUrl = "";
      let fromServer = false;
      if (remoteUrl) {
        audioUrl = remoteUrl;
        fromServer = true;
      } else {
        const b64 = String(r.audio_b64 || "");
        if (!b64) {
          setChatError("Voice reply was empty. Please try again.");
          setVoiceLoading(null);
          return;
        }
        // Convert base64 → Blob → blob: URL.
        // blob: URLs are smaller than data: URLs, decode faster on WebKit, and
        // avoid the large-string allocation that caused silent failures on iPhone.
        // mime_type is returned by the server (audio/mpeg for ElevenLabs,
        // audio/wav for Gemini Khmer TTS).  Default to audio/mpeg for backward
        // compatibility with any cached/older session responses.
        try {
          audioUrl = _b64ToObjectUrl(b64, responseMime);
        } catch {
          audioUrl = `data:${responseMime};base64,${b64}`;
        }
      }

      // Store in React state AND in the ref so the unmount cleanup can revoke
      // the blob: URL even if the component is gone before the student replays.
      const cacheEntry = {
        audioUrl,
        scriptText: r.script_text || "",
        fromServer,
      };
      setVoiceCache((prev) => ({ ...prev, [messageIndex]: cacheEntry }));
      voiceCacheRef.current[messageIndex] = cacheEntry;

      // Attempt immediate playback.
      // On iOS, the user-gesture context may have expired during the network
      // round-trip (ElevenLabs takes 2–5 s). If play() is rejected we show a
      // clear prompt — the audio is now cached so the very next Replay tap
      // will succeed because play() is called directly from the user gesture
      // with no async wait.
      try {
        if (audioRef.current) {
          try { audioRef.current.pause(); } catch { /* noop */ }
          audioRef.current = null;
        }
        const a = _makeSafeAudio(audioUrl);
        audioRef.current = a;
        await a.play();
      } catch (playErr) {
        const isPolicy =
          playErr?.name === "NotAllowedError" ||
          playErr?.name === "NotSupportedError";
        // Audio IS cached — the student does not lose their points.
        // Show a helpful nudge, not a hard error.
        setChatError(
          isPolicy
            ? "Audio is ready. Turn up your media volume and tap Replay."
            : "Audio generated. Tap Replay to hear it.",
        );
      }
    } catch (e) {
      const status = e?.status;
      if (status === 503 || status === 502) {
        setChatError(
          "Voice service is temporarily unavailable. Your points were refunded.",
        );
      } else if (status === 429) {
        setChatError("Voice reply is busy. Please try again shortly.");
      } else {
        setChatError(e?.message || "Could not generate voice reply.");
      }
    } finally {
      setVoiceLoading(null);
    }
  };

  const repliesRemaining = Number(session.replies_remaining) || 0;
  const counterColour = _counterColour(repliesRemaining);
  const counterIsZero = repliesRemaining <= 0;
  const showContinuation =
    !!continueState ||
    session.status === "completed" ||
    session.status === "expired" ||
    counterIsZero;

  return (
    <div data-testid="edutalk-chat-panel" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: "rgba(155,125,240,0.18)",
          display: "grid", placeItems: "center",
        }}>
          <MessageCircle size={16} color="#9b7df0" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>EduTalk Coach</h3>
          <p
            style={{
              margin: 0, fontSize: 11,
              color: "rgba(244,229,193,0.75)",
              display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
            }}
            data-testid="edutalk-replies-remaining"
            data-remaining={repliesRemaining}
          >
            <CheckCircle2
              size={11}
              style={{ verticalAlign: -1, color: counterColour }}
            />
            <span style={{ color: counterColour, fontWeight: 700 }}>
              {repliesRemaining} of {session.reply_limit} replies remaining
            </span>
            <span aria-hidden="true" style={{ opacity: 0.5 }}>·</span>
            <ModePill mode={session.content_mode} />
          </p>
        </div>
        <button
          type="button" onClick={onClose}
          aria-label="Close EduTalk"
          data-testid="edutalk-chat-close"
          style={{
            background: "transparent", border: "none", color: "#F4E5C1",
            cursor: "pointer", minWidth: 44, minHeight: 44,
            display: "grid", placeItems: "center",
          }}
        >
          <X size={18} />
        </button>
      </div>

      <div
        ref={listRef}
        data-testid="edutalk-chat-list"
        style={{
          flex: 1, minHeight: 200, maxHeight: "55vh", overflowY: "auto",
          padding: "8px 4px", display: "flex", flexDirection: "column", gap: 8,
          marginBottom: 8,
        }}
      >
        {(session.messages || []).map((m, i) => (
          <ChatBubble
            key={i}
            role={m.role}
            text={m.message}
            messageIndex={i}
            voiceEnabled={voiceEnabled && m.role === "assistant"}
            voiceCost={voiceCost}
            voiceLoading={voiceLoading === i}
            voiceCached={!!voiceCache[i]}
            replyLanguage={m.reply_language || "english"}
            onSpeak={onSpeak}
          />
        ))}
        {sending && <ChatBubble role="assistant" text={"…"} typing />}
      </div>

      {session.status === "active" && repliesRemaining > 0 && !showContinuation && (
        <div data-testid="edutalk-chips"
             style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {SUGGESTED_CHIPS.map((c, i) => (
            <button
              key={i} type="button"
              onClick={() => send(c.message)}
              disabled={sending}
              aria-label={`Quick prompt: ${c.label}`}
              style={{
                fontSize: 11, padding: "8px 12px", borderRadius: 999,
                minHeight: 36,
                background: "rgba(155,125,240,0.10)",
                color: "#F4E5C1",
                border: "1px solid rgba(155,125,240,0.45)",
                cursor: sending ? "not-allowed" : "pointer",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* v1 — Sticky mini top-up hook (small premium pill above the
          typing box).  Acts as a non-blocking teaser entry point to
          the full PointsGateModal.  Visibility, copy, badge, and
          anti-spam all read from the EXISTING Author Studio config:
            • topup_mini_hook_enabled                (toggle, this patch)
            • topup_prompt_lang                       (en | khmer)
            • topup_badge_enabled / _text_en / _text_kh / _style
            • topup_low_balance_threshold             (when to surface)
            • topup_dismiss_cap_per_session           (anti-spam)
            • topup_respect_audio_playing             (silence while audio plays)
          Tapping the pill calls `onOpenMiniHook()` which opens the
          full overlay modal.  Dismiss persists in sessionStorage. */}
      {!showContinuation && (
        <MiniTopUpHook
          config={config}
          activeBanners={activeBanners}
          balance={balance}
          sessionCost={sessionCost}
          insufficient={insufficient}
          audioPlaying={voiceLoading !== null}
          bookSlug={bookSlug}
          chapterIdx={chapterIdx}
          onOpen={onOpenMiniHook}
        />
      )}

      {chatError && (
        <div
          data-testid="edutalk-chat-error"
          style={{
            padding: 8, borderRadius: 10, background: "rgba(244,114,114,0.12)",
            color: "#fca5a5", fontSize: 12, marginBottom: 8,
          }}
        >
          {chatError}
        </div>
      )}

      {showContinuation ? (
        <ContinuationCard
          kind={continueState?.kind || (session.status === "expired" ? "expired" : "completed")}
          replyLimit={replyLimit}
          balance={balance}
          sessionCost={sessionCost}
          starting={starting}
          insufficient={insufficient}
          onConfirm={onContinue}
          onCancel={onClose}
        />
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          style={{ display: "flex", gap: 6 }}
        >
          <style>{`
            @keyframes edutalk-mic-pulse {
              0%   { box-shadow: 0 0 0 0 rgba(244,114,114,0.55); }
              70%  { box-shadow: 0 0 0 10px rgba(244,114,114,0); }
              100% { box-shadow: 0 0 0 0 rgba(244,114,114,0); }
            }
          `}</style>
          <input
            type="text"
            value={input}
            disabled={sending || voiceState === "recording" || voiceState === "processing"}
            onChange={(e) => setInput(e.target.value.slice(0, 800))}
            placeholder="Ask EduTalk anything about this chapter…"
            data-testid="edutalk-input"
            aria-label="Type your message"
            style={{
              flex: 1, padding: "12px 12px", borderRadius: 12,
              minHeight: 44,
              background: "rgba(20,14,32,0.65)",
              color: "#F4E5C1",
              border: "1px solid rgba(244,229,193,0.20)",
              outline: "none", fontSize: 13,
            }}
          />
          {voiceVisible && (() => {
            const isRecording = voiceState === "recording";
            const isProcessing = voiceState === "processing";
            const isRequesting = voiceState === "requesting";
            const busy = sending || isProcessing || isRequesting;
            const ariaLabel = isRecording
              ? "Stop recording"
              : isProcessing
                ? "Transcribing"
                : "Start voice input";
            const handleClick = () => {
              if (busy) return;
              if (isRecording) voiceStop();
              else voiceStart();
            };
            return (
              <button
                type="button"
                onClick={handleClick}
                disabled={busy}
                data-testid="edutalk-mic-btn"
                aria-label={ariaLabel}
                title={ariaLabel}
                style={{
                  padding: "12px 12px", borderRadius: 12, border: "none",
                  minWidth: 48, minHeight: 44,
                  background: isRecording
                    ? "rgba(244,114,114,0.18)"
                    : "rgba(244,229,193,0.10)",
                  color: isRecording ? "#fca5a5" : "#F4E5C1",
                  cursor: busy ? "not-allowed" : "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  animation: isRecording
                    ? "edutalk-mic-pulse 1.4s ease-out infinite"
                    : "none",
                  transition: "background 160ms ease, color 160ms ease",
                }}
              >
                {isProcessing || isRequesting ? (
                  <Loader2 size={15} className="animate-spin" style={{ animation: "spin 1s linear infinite" }} />
                ) : isRecording ? (
                  <Square size={15} fill="currentColor" />
                ) : (
                  <Mic size={15} />
                )}
              </button>
            );
          })()}
          <button
            type="submit" disabled={sending || !input.trim() || voiceState === "recording" || voiceState === "processing"}
            data-testid="edutalk-send-btn"
            aria-label="Send message"
            style={{
              padding: "12px 14px", borderRadius: 12, border: "none",
              minWidth: 48, minHeight: 44,
              background: sending || !input.trim()
                ? "rgba(60,40,80,0.6)"
                : "linear-gradient(135deg, #d4a843, #9b7df0)",
              color: sending || !input.trim() ? "rgba(244,229,193,0.5)" : "#1a1226",
              cursor: sending || !input.trim() ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Send size={15} />
          </button>
        </form>
      )}
    </div>
  );
}

function ChatBubble({
  role,
  text,
  typing,
  // Phase 3 — voice props (all optional). Only assistant bubbles render
  // the speaker control. Student bubbles ignore these props.
  messageIndex = 0,
  voiceEnabled = false,
  voiceCost = 0,
  voiceLoading = false,
  voiceCached = false,
  replyLanguage = "english",
  onSpeak,
}) {
  const isAssistant = role === "assistant";
  const showSpeaker = isAssistant && voiceEnabled && !typing && !!text;

  // v2.2 Adaptive language mode — labels are FULLY self-contained
  // (icon + glyph + cost baked in).  This makes it impossible to ever
  // render a duplicate icon by accident — the JSX below renders the label
  // verbatim, with NO additional icon prefix.
  // Khmer-support mode (Khmer visible text): 🎧 ហាត់ស្តាប់ / 🎧 ស្តាប់ម្ដងទៀត
  // English-preference mode (English visible text): 🔊 បកប្រែ / 🔊 ស្តាប់ម្ដងទៀត
  // Safe fallback (cannot detect): English-preference labels (final product
  // direction is English-visible + Khmer audio support).
  // `replyLanguage` from server is authoritative; falls back to text detection.
  const _isEnglishReply =
    replyLanguage === "english" ||
    (replyLanguage !== "khmer" && !_hasKhmerChars(text));
  const _speakLabelNew = _isEnglishReply
    ? `🔊 បកប្រែ · ${voiceCost}pt`
    : `🎧 ហាត់ស្តាប់ · ${voiceCost}pt`;
  const _speakLabelCached = _isEnglishReply
    ? "🔊 ស្តាប់ម្ដងទៀត"
    : "🎧 ស្តាប់ម្ដងទៀត";
  const _speakAriaNew = _isEnglishReply
    ? `Khmer explanation (${voiceCost} pt${voiceCost === 1 ? "" : "s"})`
    : `ហាត់ស្តាប់ (${voiceCost} pt${voiceCost === 1 ? "" : "s"})`;
  const _speakAriaCached = _isEnglishReply
    ? "ស្តាប់ម្ដងទៀត (Khmer replay)"
    : "ស្តាប់ម្ដងទៀត";

  const handleSpeak = () => {
    if (!showSpeaker) return;
    if (voiceLoading) return;
    if (typeof onSpeak === "function") onSpeak(messageIndex, text);
  };

  return (
    <div
      style={{
        alignSelf: isAssistant ? "flex-start" : "flex-end",
        maxWidth: "88%",
        padding: "8px 12px",
        borderRadius: isAssistant ? "12px 12px 12px 4px" : "12px 12px 4px 12px",
        background: isAssistant
          ? "rgba(155,125,240,0.13)"
          : "linear-gradient(135deg, rgba(212,168,67,0.20), rgba(244,229,193,0.10))",
        color: "#F4E5C1",
        fontSize: 13, lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        opacity: typing ? 0.6 : 1,
        border: isAssistant
          ? "1px solid rgba(155,125,240,0.30)"
          : "1px solid rgba(212,168,67,0.35)",
      }}
    >
      {text}
      {showSpeaker && (
        <div
          style={{
            marginTop: "6px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            borderTop: "1px solid rgba(244,229,193,0.10)",
            paddingTop: "6px",
          }}
        >
          <button
            type="button"
            onClick={handleSpeak}
            disabled={voiceLoading}
            aria-label={
              voiceCached ? _speakAriaCached : _speakAriaNew
            }
            data-testid={`edutalk-speak-${messageIndex}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(155,125,240,0.45)",
              background: voiceLoading
                ? "rgba(155,125,240,0.10)"
                : "rgba(155,125,240,0.18)",
              color: "#E2D1FF",
              fontSize: "11px",
              fontWeight: 600,
              cursor: voiceLoading ? "wait" : "pointer",
              opacity: voiceLoading ? 0.7 : 1,
            }}
          >
            {voiceLoading ? (
              <Loader2
                size={12}
                style={{ animation: "edutalkSpin 700ms linear infinite" }}
              />
            ) : null}
            <span>
              {voiceLoading
                ? "Generating…"
                : voiceCached
                  ? _speakLabelCached
                  : _speakLabelNew}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================ */
/*  Phase 3 — Promotion banner (non-blocking, dismissable)       */
/* ============================================================ */
function PromoBanner({ banner, preferredLang, onDismiss }) {
  const text =
    preferredLang === "en"
      ? banner?.banner_text_en || banner?.banner_text_kh
      : banner?.banner_text_kh || banner?.banner_text_en;
  if (!text) return null;
  return (
    <div
      data-testid={`edutalk-promo-banner-${banner?.promo_id || "x"}`}
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 10px",
        borderRadius: "12px",
        background:
          "linear-gradient(135deg, rgba(255,225,154,0.18) 0%, rgba(212,168,67,0.10) 100%)",
        border: "1px solid rgba(255,225,154,0.45)",
        color: "#F4E5C1",
        fontSize: "11.5px",
        lineHeight: 1.35,
        boxShadow: "0 8px 18px rgba(0,0,0,0.35)",
      }}
    >
      <Sparkles size={13} color="#FFE19A" />
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss promotion"
        data-testid={`edutalk-promo-dismiss-${banner?.promo_id || "x"}`}
        style={{
          border: "none",
          background: "transparent",
          color: "rgba(244,229,193,0.75)",
          cursor: "pointer",
          padding: 0,
          fontSize: "14px",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiniTopUpHook (v1) — small premium sticky pill rendered above the EduTalk
// typing input.  Acts as a NON-BLOCKING teaser entry point to the full
// PointsGateModal.  All gating is driven by existing admin config — this
// component never invents thresholds or copy on its own.
//
//   • Hidden when topup_mini_hook_enabled === false.
//   • Hidden when balance ≥ topup_low_balance_threshold (admin-configurable).
//   • Hidden when `insufficient` is already true (the full modal will open
//     anyway — no need to also tease).
//   • Hidden while audio is loading/playing if topup_respect_audio_playing
//     is on (we treat the panel-level `voiceLoading` as "audio active").
//   • Hidden after the student dismisses it `topup_dismiss_cap_per_session`
//     times in the same session (per book + chapter, persisted via
//     sessionStorage — no server call).
//   • Tapping it calls `onOpen()` which the parent wires to the same
//     `setGateOpen(true)` flow used by the modal-from-insufficient path.
//
// Visual: rounded green-glow pill mirroring the PointsGateModal header
// banner — small icon + "Low on points?" + gold "Top up" pill + admin
// badge + × dismiss.  Mobile-first; never covers the typing input.
// ---------------------------------------------------------------------------
function MiniTopUpHook({
  config, activeBanners, balance, sessionCost, insufficient,
  audioPlaying, bookSlug, chapterIdx, onOpen,
}) {
  const dismissKey = useMemo(
    () =>
      `edutalk:mini_hook_dismiss:${bookSlug || "x"}:${chapterIdx ?? "0"}`,
    [bookSlug, chapterIdx],
  );
  const [dismissed, setDismissed] = useState(false);
  // Read dismiss counter from sessionStorage on mount.  We compare against
  // the admin-configured `topup_dismiss_cap_per_session` so the same anti-
  // spam policy as the modal applies here too.
  const dismissCount = useMemo(() => {
    try {
      const raw = sessionStorage.getItem(dismissKey);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }, [dismissKey]); // dismiss state is checked separately below

  // Bail early when the parent did not wire the open callback.
  if (typeof onOpen !== "function") return null;
  if (config?.topup_mini_hook_enabled === false) return null;
  // The full overlay modal will handle truly insufficient balance — no
  // need to also tease here.
  if (insufficient) return null;
  // Respect the admin's audio-playing guard.
  if (config?.topup_respect_audio_playing !== false && audioPlaying) {
    return null;
  }
  // Surface only when actually low.  Default threshold mirrors the
  // existing config (10 pts) so this matches the modal's own guard.
  const threshold = Math.max(
    0,
    Math.min(1000, Number(config?.topup_low_balance_threshold ?? 10) || 0),
  );
  const safeBalance = Number.isFinite(Number(balance)) ? Number(balance) : 0;
  // ALSO surface when the student is one cycle away from running out
  // (balance < sessionCost * 2) — gentle, anticipatory.
  const lowByCost =
    Number(sessionCost) > 0 && safeBalance < Number(sessionCost) * 2;
  if (safeBalance > threshold && !lowByCost) return null;
  // Dismiss cap.
  const cap = Math.max(
    1,
    Math.min(10, Number(config?.topup_dismiss_cap_per_session ?? 2) || 2),
  );
  if (dismissed || dismissCount >= cap) return null;

  // ---- copy & badge resolution (reuse modal-side config) ----
  const lang = config?.topup_prompt_lang === "english" ? "en" : "kh";
  const headline = lang === "en" ? "Low on points?" : "ខ្វះពិន្ទុ?";
  const cta = lang === "en" ? "Top up" : "បញ្ចូលពិន្ទុ";

  // Badge: same source/precedence as PointsGateModal header.
  let badge = null;
  if (config?.topup_badge_enabled !== false) {
    const style = String(config?.topup_badge_style || "bonus")
      .toLowerCase()
      .replace(/[^a-z_]/g, "")
      .slice(0, 30) || "bonus";
    const promoAware = config?.topup_badge_promotion_aware !== false;
    const activeBanner =
      promoAware && Array.isArray(activeBanners) && activeBanners[0]
        ? activeBanners[0] || null
        : null;
    let text = "";
    let fromPromotion = false;
    if (activeBanner) {
      const promoText =
        (lang === "en"
          ? (activeBanner.tag_text_en || activeBanner.banner_tag_en || "")
          : (activeBanner.tag_text_kh || activeBanner.banner_tag_kh || "")) || "";
      if (String(promoText).trim()) {
        text = String(promoText).trim().slice(0, 30);
        fromPromotion = true;
      }
    }
    if (!text) {
      const adminText = (lang === "en"
        ? (config?.topup_badge_text_en || "")
        : (config?.topup_badge_text_kh || "")
      ).trim();
      // Non-claim safe default (matches modal v1.1).
      const safeDefault = lang === "en" ? "Best Value" : "តម្លៃល្អ";
      text = (adminText || safeDefault).slice(0, 30);
    }
    const styleMap = {
      bonus:       { bg: "linear-gradient(135deg,#FFE19A,#D4A843)", color: "#1a1420" },
      recommended: { bg: "linear-gradient(135deg,#B8E2C2,#6FB97F)", color: "#0a2014" },
      flash_sale:  { bg: "linear-gradient(135deg,#FFB199,#E85C3F)", color: "#270b08" },
      premium:     { bg: "linear-gradient(135deg,#D8C2FF,#7B5BD8)", color: "#190a35" },
    };
    badge = { text, style, ...((styleMap[style] || styleMap.bonus)), fromPromotion };
  }

  const handleDismiss = (e) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    try {
      sessionStorage.setItem(dismissKey, String(dismissCount + 1));
    } catch { /* sessionStorage may be unavailable in some PWAs */ }
    setDismissed(true);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid="edutalk-mini-topup-hook"
      data-mini-hook-source={badge?.fromPromotion ? "promotion" : "config"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 10px",
        marginBottom: "8px",
        borderRadius: "12px",
        cursor: "pointer",
        background:
          "linear-gradient(135deg, rgba(120,200,140,0.22) 0%, rgba(80,150,100,0.10) 60%, rgba(50,90,70,0.08) 100%)",
        border: "1px solid rgba(150,220,170,0.35)",
        boxShadow:
          "0 0 0 1px rgba(150,220,170,0.10) inset, 0 6px 16px rgba(70,150,90,0.18)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "20px",
          height: "20px",
          flexShrink: 0,
          borderRadius: "999px",
          background:
            "linear-gradient(135deg, #BFEFC9 0%, #6FB97F 100%)",
          color: "#0a2014",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "11px",
          fontWeight: 800,
        }}
      >
        ✦
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: "12.5px",
          fontWeight: 700,
          color: "#E6F7EB",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        data-testid="edutalk-mini-topup-headline"
      >
        {headline}
      </span>
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "6px 11px",
          borderRadius: "999px",
          background:
            "linear-gradient(135deg, #FFE19A 0%, #D4A843 60%, #9C7A2C 100%)",
          color: "#1a1420",
          fontWeight: 800,
          fontSize: "12px",
          letterSpacing: "0.01em",
          boxShadow:
            "0 4px 10px rgba(212,168,67,0.30), 0 0 0 1px rgba(255,225,154,0.45) inset",
        }}
        data-testid="edutalk-mini-topup-cta"
      >
        <span aria-hidden style={{ fontSize: "10px" }}>✦</span>
        <span>{cta}</span>
        {badge && (
          <span
            data-testid="edutalk-mini-topup-badge"
            data-badge-style={badge.style}
            data-badge-source={badge.fromPromotion ? "promotion" : "config"}
            style={{
              position: "absolute",
              top: "-8px",
              right: "-8px",
              background: badge.bg,
              color: badge.color,
              fontSize: "9px",
              fontWeight: 800,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              padding: "2px 6px",
              borderRadius: "999px",
              whiteSpace: "nowrap",
              boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.45)",
            }}
          >
            {badge.text}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss top-up hook"
        data-testid="edutalk-mini-topup-dismiss"
        style={{
          flexShrink: 0,
          border: "none",
          background: "rgba(244,229,193,0.08)",
          color: "#F4E5C1",
          width: "26px",
          height: "26px",
          borderRadius: "8px",
          cursor: "pointer",
          fontSize: "14px",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}




