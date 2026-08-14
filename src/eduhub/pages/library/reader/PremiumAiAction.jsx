/**
 * PremiumAiAction.jsx - Per-block premium AI utility button + result card.
 *
 * Phase 1 scope (approved):
 *   - Two tools: Khmer Decoder + Executive Upgrade
 *   - Confirmation modal showing cost and current balance
 *   - Result card (greeting / khmer mindset / natural / executive / practice)
 *   - "Top Up via ABA" CTA when balance is insufficient
 *
 * Strict client-side rules:
 *   - Does NOT deduct points client-side. The backend is the gatekeeper.
 *   - Sends the in-memory student password (already held in useAuth().student.password
 *     for the existing purchaseBook flow) only on the network call. Never persists it.
 *   - Hides itself when the student is not authenticated or block text is empty.
 *
 * v1.4 FIXES:
 *   FIX-1 — Duplicate auth (ReauthCard on every page refresh):
 *     After a page refresh the student is still authenticated via Render session,
 *     but `student.password` is stripped from sessionStorage (v7.9.8 security
 *     hardening). The GAS password is always available as `student.portalData.Password`
 *     because hydrateStudentFromGAS() re-reads it from the GAS Sheet on every
 *     cold-start hydration. We now resolve the GAS password from that fallback so
 *     the AI tools remain usable without forcing a re-login.
 *
 *   FIX-2 — AI config pricing not fetched (frontend always shows fallback 5 pts):
 *     PremiumAiAction previously used a hardcoded DEFAULT_COST constant and never
 *     called the /api/student/premium/ai-config endpoint. Now we fetch live pricing
 *     on mount (authenticated via Bearer token) and use the server values. The
 *     hardcoded constant becomes the display fallback only while the fetch is in-flight.
 *
 *   FIX-3 — HTTP 503 error surfaced as "AI service error":
 *     503 = GEMINI_API_KEY not set in the Render environment. This is a server
 *     configuration problem, not a points problem. We detect the 503 status and
 *     surface a clear admin-configuration message instead of the generic error card.
 *     No points are ever charged on 503 (backend guarantee preserved).
 *
 * Visual style: respects the existing reader theme variables and stays
 * out of the way (small pill row below the block, expandable on tap).
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Loader2,
  Sparkles,
  Wallet,
  X,
  Crown,
} from "lucide-react";
import { useAuth } from "../../../context/AuthContext";

// Direct fetch with the *student* session token.
// Mirrors the byte-for-byte auth pattern of every other student-side fetch in the app.

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

async function studentApiPost(path, body) {
  const bearer = _studentBearer();
  const hasBearer = !!bearer.Authorization;
  try {
    // eslint-disable-next-line no-console
    console.info("[premium-ai] POST", path, { hasBearer });
  } catch { /* SSR */ }
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...bearer,
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* server sent non-JSON */ }
  if (!res.ok) {
    try {
      // eslint-disable-next-line no-console
      console.warn("[premium-ai] FAIL", path, res.status, data?.detail || "");
    } catch { /* SSR */ }
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  try {
    // eslint-disable-next-line no-console
    console.info("[premium-ai] OK", path, { success: data?.success });
  } catch { /* SSR */ }
  return data;
}

async function studentApiGet(path) {
  const bearer = _studentBearer();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    credentials: "include",
    headers: { ...bearer },
  });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

const ABA_TOP_UP_PATH = "/portal"; // existing portal hosts the Top Up flow

// Tier rules mirrored from server defaults. The backend is still the
// authoritative gate; this is only for UI visibility.
const TIER_VISIBILITY = {
  free: { khmer_decoder: false, executive_upgrade: false },
  standard: { khmer_decoder: true, executive_upgrade: true },
  premium: { khmer_decoder: true, executive_upgrade: true },
  limited: { khmer_decoder: true, executive_upgrade: true },
};

// FIX-2: These are DISPLAY FALLBACKS only (shown while config fetch is in-flight).
// The live values come from /api/student/premium/ai-config.
const COST_FALLBACK = { khmer_decoder: 5, executive_upgrade: 5 };

// Module-level singleton -- one fetch per student session, shared across
// all block instances. PremiumAiAction mounts once per dialog block so
// without this a 10-block page fires 10 identical GET requests.
let _aiConfigCache = null;
let _aiConfigPromise = null;
let _aiConfigStudentId = null;

function _getAiConfig(studentId) {
  if (_aiConfigStudentId !== studentId) {
    _aiConfigCache = null;
    _aiConfigPromise = null;
    _aiConfigStudentId = studentId;
  }
  if (_aiConfigCache !== null) return Promise.resolve(_aiConfigCache);
  if (_aiConfigPromise !== null) return _aiConfigPromise;
  _aiConfigPromise = studentApiGet("/api/student/premium/ai-config")
    .then((data) => {
      _aiConfigCache = (data && data.success && data.config) ? data.config : {};
      return _aiConfigCache;
    })
    .catch(() => { _aiConfigPromise = null; return {}; });
  return _aiConfigPromise;
}


// v1.2 — Per-student entitlement map cache. Keyed by `${bookSlug}::${normText}`
// so multiple PremiumAiAction instances rendering the same block don't fire
// duplicate access-status requests. Reset when the student session changes.
const _accessCache = new Map();
const _accessPromises = new Map();
let _accessStudentId = null;

function _normBlockKey(bookSlug, blockText) {
  const norm = String(blockText || "").replace(/\s+/g, " ").trim().toLowerCase();
  return `${bookSlug || ""}::${norm}`;
}

function _resetAccessCacheForStudent(studentId) {
  if (_accessStudentId !== studentId) {
    _accessCache.clear();
    _accessPromises.clear();
    _accessStudentId = studentId;
  }
}

async function _fetchAccessStatus(studentId, bookSlug, blockText) {
  _resetAccessCacheForStudent(studentId);
  const key = _normBlockKey(bookSlug, blockText);
  if (_accessCache.has(key)) return _accessCache.get(key);
  if (_accessPromises.has(key)) return _accessPromises.get(key);

  const body = {
    book_slug: bookSlug || "",
    items: [
      { item_id: "khmer_decoder", tool: "khmer_decoder", block_text: blockText },
      { item_id: "executive_upgrade", tool: "executive_upgrade", block_text: blockText },
    ],
  };
  const p = studentApiPost("/api/student/premium/access-status", body)
    .then((data) => {
      const m = (data && data.access) || {};
      const out = {
        khmer_decoder: !!m.khmer_decoder,
        executive_upgrade: !!m.executive_upgrade,
      };
      _accessCache.set(key, out);
      _accessPromises.delete(key);
      return out;
    })
    .catch(() => {
      // Fail-safe: treat as locked so the student is asked to pay (which the
      // backend will re-check). Never throw — the Reader must keep rendering.
      const out = { khmer_decoder: false, executive_upgrade: false };
      _accessPromises.delete(key);
      return out;
    });
  _accessPromises.set(key, p);
  return p;
}

// Called after a successful paid run so the same block immediately reflects
// "Unlocked" state without a page refresh and without re-hitting the backend.
function _markUnlockedLocally(bookSlug, blockText, toolKey) {
  const key = _normBlockKey(bookSlug, blockText);
  const cur = _accessCache.get(key) || { khmer_decoder: false, executive_upgrade: false };
  _accessCache.set(key, { ...cur, [toolKey]: true });
}


export default function PremiumAiAction({ blockText, bookSlug, bookTier }) {
  const { student } = useAuth();
  const [tool, setTool] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [insufficient, setInsufficient] = useState(null);

  // FIX-2: Live pricing fetched from backend AI config endpoint.
  const [liveCost, setLiveCost] = useState(null); // null = not yet loaded

  // v1.2 — Per-tool entitlement state for THIS block. null = not yet
  // queried (we render the paid pill until we know). After the fetch
  // resolves we render an "Unlocked" pill for the tools the student has
  // already paid for on this exact block under the current Personality
  // config.
  const [accessMap, setAccessMap] = useState({
    khmer_decoder: false,
    executive_upgrade: false,
  });

  const safeText = String(blockText || "").trim();
  const balance = Number(student?.portalPoints ?? student?.points ?? 0) || 0;

  // FIX-1: Resolve the GAS password from both memory and the portalData fallback.
  // After a page refresh `student.password` is empty (v7.9.8 security hardening),
  // but `student.portalData.Password` is always populated by hydrateStudentFromGAS()
  // from the GAS Sheet — making AI tools usable without re-login.
  const resolvedPassword = useMemo(() => {
    const direct = String(student?.password ?? "").trim();
    if (direct) return direct;
    const gasSheet = String(student?.portalData?.Password ?? "").trim();
    return gasSheet;
  }, [student?.password, student?.portalData?.Password]);

  const hasPassword = resolvedPassword.length > 0;

  const tierKey = useMemo(() => {
    const t = String(bookTier || "").trim().toLowerCase();
    return ["free", "standard", "premium", "limited"].includes(t) ? t : "standard";
  }, [bookTier]);

  // Singleton fetch -- all block instances share one request per session.
  useEffect(() => {
    if (!student?.studentId) return;
    let cancelled = false;
    _getAiConfig(student.studentId).then((cfg) => {
      if (cancelled || !cfg?.pricing) return;
      const p = cfg.pricing;
      setLiveCost({
        khmer_decoder: Number(p.khmer_decoder) || COST_FALLBACK.khmer_decoder,
        executive_upgrade: Number(p.executive_upgrade) || COST_FALLBACK.executive_upgrade,
      });
    });
    return () => { cancelled = true; };
  }, [student?.studentId]);

  // v1.2 — Fetch this block's entitlement status (no Gemini, no points).
  // Module-level cache de-duplicates concurrent requests for the same
  // (book_slug, normalised block_text) pair across all block instances.
  useEffect(() => {
    if (!student?.studentId || !safeText) return;
    let cancelled = false;
    _fetchAccessStatus(student.studentId, bookSlug || "", safeText)
      .then((map) => {
        if (!cancelled) setAccessMap(map);
      });
    return () => { cancelled = true; };
  }, [student?.studentId, bookSlug, safeText]);

  // Use live cost if available, otherwise fall back to hardcoded defaults.
  const effectiveCost = liveCost || COST_FALLBACK;

  // Hide entirely if no text, no auth, or tier blocks both tools
  if (!safeText || safeText.length < 3) return null;
  if (!student?.studentId) return null;
  const visible = TIER_VISIBILITY[tierKey] || {};
  if (!visible.khmer_decoder && !visible.executive_upgrade) return null;

  const open = (toolKey) => {
    if (!visible[toolKey]) return;
    setTool(toolKey);
    setResult(null);
    setErrorMsg("");
    setInsufficient(null);
    // FIX-1: Only show reauth if BOTH direct password and GAS sheet password are
    // unavailable. Most refreshes will have portalData.Password populated.
    if (!hasPassword) {
      setPhase("reauth");
      return;
    }
    // v1.2 — If this student already paid for this exact (tool, block) under
    // the current Author Studio Personality config, skip the confirmation
    // modal entirely and fire the request directly. The backend will
    // re-check entitlement server-side and serve the cached result for free
    // (entitlement HIT → no balance read, no debit, no Gemini call).
    if (accessMap[toolKey]) {
      setPhase("loading");
      // Defer one microtask so React commits "loading" before the fetch runs.
      Promise.resolve().then(() => { void runTool(toolKey); });
      return;
    }
    setPhase("confirm");
  };

  const close = () => {
    setTool(null);
    setPhase("idle");
    setResult(null);
    setErrorMsg("");
    setInsufficient(null);
  };

  const runTool = async (toolArg) => {
    const activeTool = toolArg || tool;
    if (!activeTool) return;
    if (!hasPassword) {
      setPhase("reauth");
      return;
    }
    setPhase("loading");
    setErrorMsg("");
    setInsufficient(null);
    try {
      const body = {
        book_slug: bookSlug || "",
        block_text: safeText,
        // FIX-1: Use the resolved password (direct memory OR portalData fallback).
        password: resolvedPassword,
      };
      const call = activeTool === "khmer_decoder"
        ? (b) => studentApiPost("/api/student/premium/decode-block", b)
        : (b) => studentApiPost("/api/student/premium/executive-upgrade", b);
      const r = await call(body);

      if (r?.success === false && r?.error === "insufficient_points") {
        setInsufficient({
          required: Number(r.required_points) || effectiveCost[activeTool],
          remaining: Number(r.points_remaining) || 0,
          message: r.message || "Not enough points.",
        });
        setPhase("insufficient");
        return;
      }
      if (r?.success) {
        // v1.2 — Update local entitlement cache so subsequent clicks on the
        // same block render as "Unlocked" without a page refresh and without
        // re-hitting access-status. Covers BOTH the entitlement-HIT response
        // (already unlocked) AND a fresh paid run.
        if (r?.unlocked || r?.points_deducted >= 0) {
          _markUnlockedLocally(bookSlug || "", safeText, activeTool);
          setAccessMap((prev) => ({ ...prev, [activeTool]: true }));
        }
        setResult(r);
        setPhase("result");
        return;
      }
      setErrorMsg("Unexpected response from server.");
      setPhase("error");
    } catch (e) {
      // FIX-3: Detect 503 (GEMINI_API_KEY not configured) and show a clear message.
      if (e?.status === 503) {
        setErrorMsg(
          "AI tools are not yet configured on the server. Please contact your administrator to set up the GEMINI_API_KEY. No points were charged."
        );
      } else {
        setErrorMsg(e?.message || "Something went wrong. No points were charged.");
      }
      setPhase("error");
    }
  };

  return (
    <div className="premium-ai-action" data-testid="premium-ai-action"
         style={{
           margin: "8px 0 18px",
           display: "flex",
           flexWrap: "wrap",
           gap: "8px",
         }}>
      {visible.khmer_decoder && (
        <PremiumPill
          testid="premium-ai-khmer-btn"
          icon={<Brain className="h-3.5 w-3.5" />}
          label="Khmer Mindset"
          cost={effectiveCost.khmer_decoder}
          unlocked={accessMap.khmer_decoder}
          onClick={() => open("khmer_decoder")}
          accent="#9b7df0"
        />
      )}
      {visible.executive_upgrade && (
        <PremiumPill
          testid="premium-ai-exec-btn"
          icon={<Crown className="h-3.5 w-3.5" />}
          label="Executive Tone"
          cost={effectiveCost.executive_upgrade}
          unlocked={accessMap.executive_upgrade}
          onClick={() => open("executive_upgrade")}
          accent="#d4a843"
        />
      )}

      {phase !== "idle" && (
        <Modal onClose={phase === "loading" ? null : close}>
          {phase === "confirm" && (
            <ConfirmCard
              tool={tool}
              balance={balance}
              cost={effectiveCost[tool] || 5}
              onCancel={close}
              onConfirm={runTool}
              previewText={safeText}
            />
          )}
          {phase === "loading" && <LoadingCard tool={tool} />}
          {phase === "result" && (
            <ResultCard tool={tool} result={result} onClose={close} />
          )}
          {phase === "insufficient" && (
            <InsufficientCard info={insufficient} balance={balance} onClose={close} />
          )}
          {phase === "reauth" && (
            <ReauthCard onClose={close} />
          )}
          {phase === "error" && (
            <ErrorCard message={errorMsg} onClose={close} />
          )}
        </Modal>
      )}
    </div>
  );
}

/* ----------------------- Pill button ----------------------- */
function PremiumPill({ icon, label, cost, unlocked, onClick, accent, testid }) {
  // v1.2 — Unlocked state: show a CheckCircle + "Unlocked" badge instead of
  // the cost pill. The button still triggers the same handler — the parent
  // skips the confirm modal and goes straight to loading + result.
  const showUnlocked = !!unlocked;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      data-unlocked={showUnlocked ? "true" : "false"}
      aria-label={showUnlocked ? `${label} — unlocked, view free` : `${label} — costs ${cost} points`}
      title={showUnlocked ? "You already paid for this. Click to view free." : `Costs ${cost} points`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "5px 12px 5px 9px",
        borderRadius: "999px",
        background: showUnlocked
          ? "rgba(45,212,127,0.10)"
          : "rgba(20,14,32,0.55)",
        color: "var(--reader-fg, #f4e5c1)",
        border: `1px solid ${showUnlocked ? "rgba(74,222,128,0.55)" : `${accent}55`}`,
        fontSize: "11.5px",
        fontWeight: 600,
        letterSpacing: "0.02em",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
        transition: "all 160ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = showUnlocked ? "#4ade80" : accent;
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = showUnlocked
          ? "rgba(74,222,128,0.55)"
          : `${accent}55`;
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <span style={{ color: showUnlocked ? "#4ade80" : accent }}>{icon}</span>
      <span>{label}</span>
      {showUnlocked ? (
        <span
          data-testid={`${testid}-unlocked-badge`}
          style={{
            marginLeft: "2px",
            padding: "1px 8px",
            borderRadius: "999px",
            background: "rgba(74,222,128,0.18)",
            color: "#4ade80",
            fontSize: "10px",
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
          }}
        >
          <CheckCircle2 size={10} /> Unlocked
        </span>
      ) : (
        <span style={{
          marginLeft: "2px",
          padding: "1px 7px",
          borderRadius: "999px",
          background: `${accent}22`,
          color: accent,
          fontSize: "10.5px",
          fontWeight: 700,
        }}>
          {cost} pts
        </span>
      )}
    </button>
  );
}

/* ----------------------- Modal shell ----------------------- */
function Modal({ children, onClose }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose ? onClose : undefined}
      data-testid="premium-ai-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,5,15,0.66)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "520px",
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          borderRadius: "18px",
          background: "linear-gradient(160deg, #221432 0%, #14091e 100%)",
          border: "1px solid rgba(212,168,67,0.30)",
          color: "#F4E5C1",
          padding: "22px 22px 18px",
          boxShadow: "0 25px 60px rgba(0,0,0,0.55)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ----------------------- Confirm ----------------------- */
function ConfirmCard({ tool, balance, cost, onCancel, onConfirm, previewText }) {
  const isExec = tool === "executive_upgrade";
  return (
    <div data-testid="premium-ai-confirm">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          display: "grid", placeItems: "center",
          background: "rgba(212,168,67,0.16)",
        }}>
          {isExec ? <Crown size={18} color="#d4a843" /> : <Brain size={18} color="#9b7df0" />}
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {isExec ? "Executive Tone Upgrade" : "Khmer Mindset Decoder"}
          </h3>
          <p style={{ margin: 0, fontSize: 11.5, opacity: 0.7 }}>Premium AI utility</p>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          data-testid="premium-ai-confirm-close"
          style={{ background: "transparent", color: "#F4E5C1", border: "none", cursor: "pointer" }}
        >
          <X size={18} />
        </button>
      </div>

      <p
        style={{
          fontSize: 12.5,
          lineHeight: 1.6,
          color: "rgba(244,229,193,0.92)",
          marginBottom: 12,
        }}
        data-testid="premium-ai-confirm-balance-line"
      >
        This premium AI tool costs{" "}
        <strong style={{ color: "#d4a843" }}>{cost} points</strong>.{" "}
        Your current balance is{" "}
        <strong
          data-testid="premium-ai-confirm-balance-value"
          style={{ color: "#F4E5C1", fontWeight: 800 }}
        >
          {balance} points
        </strong>
        . Points are deducted only after a successful AI response.
      </p>

      <div style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: "10px 12px",
        fontSize: 12.5,
        marginBottom: 16,
        maxHeight: 100,
        overflowY: "auto",
      }} data-testid="premium-ai-confirm-preview">
        {previewText.length > 240 ? `${previewText.slice(0, 240)}...` : previewText}
      </div>

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCancel}
          data-testid="premium-ai-confirm-cancel"
          style={pillButton({ ghost: true })}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          data-testid="premium-ai-confirm-use"
          style={pillButton({ primary: true })}
        >
          <Sparkles size={14} /> Use {cost} points
        </button>
      </div>
    </div>
  );
}

/* ----------------------- Loading ----------------------- */
function LoadingCard({ tool }) {
  const isExec = tool === "executive_upgrade";
  return (
    <div data-testid="premium-ai-loading" style={{ textAlign: "center", padding: "20px 0" }}>
      <Loader2
        size={36}
        color="#d4a843"
        style={{ animation: "spin 1s linear infinite" }}
      />
      <p style={{ marginTop: 14, fontSize: 13, opacity: 0.9 }}>
        {isExec ? "Polishing the executive version..." : "Decoding the Khmer mindset..."}
      </p>
      <p style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>
        Points are not deducted yet. We charge only after AI succeeds.
      </p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ----------------------- Result ----------------------- */
function ResultCard({ tool, result, onClose }) {
  const isExec = tool === "executive_upgrade";

  // v1.2 — Unlocked re-read response omits `points_remaining` (backend does
  // not call GAS on entitlement HIT). Handle defensively so older keys still
  // render and a missing balance doesn't print "NaN pts" or "undefined pts".
  const isUnlocked = !!result?.unlocked && Number(result?.points_deducted || 0) === 0;
  const deducted = Number(result?.points_deducted || 0);
  const remainingRaw = result?.points_remaining;
  const hasRemaining =
    typeof remainingRaw === "number" && Number.isFinite(remainingRaw);

  return (
    <div data-testid="premium-ai-result" data-unlocked={isUnlocked ? "true" : "false"}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          display: "grid", placeItems: "center",
          background: "rgba(45,212,127,0.16)",
        }}>
          <CheckCircle2 size={18} color="#4ade80" />
        </div>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {result.greeting || (isExec ? "Here's your executive upgrade" : "Here's your Khmer decode")}
          </h3>
          <p
            style={{ margin: 0, fontSize: 11, color: "rgba(244,229,193,0.85)" }}
            data-testid="premium-ai-result-meta"
          >
            <Wallet size={11} style={{ display: "inline", verticalAlign: -1, marginRight: 3 }} />
            {isUnlocked ? (
              <>
                Unlocked re-read &middot; <strong style={{ color: "#4ade80" }}>0 pts charged</strong>
              </>
            ) : (
              <>
                -{deducted} pts
                {hasRemaining && (
                  <> &middot; balance now <strong style={{ color: "#F4E5C1" }}>{remainingRaw} pts</strong></>
                )}
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          data-testid="premium-ai-result-close"
          style={{ background: "transparent", color: "#F4E5C1", border: "none", cursor: "pointer" }}
        >
          <X size={18} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {result.khmer_mindset && (
          <Section label="Khmer thinking pattern" body={result.khmer_mindset} accent="#9b7df0" />
        )}
        {result.natural_version && (
          <Section label="Natural English" body={result.natural_version} accent="#7dd3fc" />
        )}
        {result.executive_version && (
          <Section label="Executive English" body={result.executive_version} accent="#d4a843" />
        )}
        {result.why_it_works && (
          <Section label="Why it works" body={result.why_it_works} accent="#fbbf24" />
        )}
        {result.practice_line && (
          <Section label="Speaking practice" body={result.practice_line} accent="#4ade80" />
        )}
      </div>

      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onClose}
          data-testid="premium-ai-result-done"
          style={pillButton({ primary: true })}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function Section({ label, body, accent }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 12,
      padding: "10px 12px",
    }}>
      <div style={{
        fontSize: 9.5,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: accent,
        fontWeight: 700,
        marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

/* ----------------------- Re-auth (password guard) ----------------------- */
function ReauthCard({ onClose }) {
  return (
    <div data-testid="premium-ai-reauth">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          display: "grid", placeItems: "center",
          background: "rgba(155,125,240,0.18)",
        }}>
          <AlertCircle size={18} color="#9b7df0" />
        </div>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Sign in again to continue</h3>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.9, marginBottom: 8 }}>
        Please sign in again to use premium AI tools.
      </p>
      <p style={{ fontSize: 11.5, opacity: 0.7, marginBottom: 14 }}>
        Your session is still valid for reading, but for security your password
        is not kept after a page refresh. Sign in once more to enable point-based AI tools.
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onClose}
          data-testid="premium-ai-reauth-later"
          style={pillButton({ ghost: true })}
        >
          Maybe later
        </button>
        <a
          href="/login"
          data-testid="premium-ai-reauth-signin"
          style={{ ...pillButton({ primary: true }), textDecoration: "none" }}
        >
          Sign in
        </a>
      </div>
    </div>
  );
}

/* ----------------------- Insufficient points ----------------------- */
function InsufficientCard({ info, balance, onClose }) {
  return (
    <div data-testid="premium-ai-insufficient">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          display: "grid", placeItems: "center",
          background: "rgba(251,191,36,0.16)",
        }}>
          <Wallet size={18} color="#fbbf24" />
        </div>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Not enough points</h3>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.9 }}>
        {info?.message || `You need ${info?.required ?? 5} points to use this premium AI tool.`}
      </p>
      <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 14 }}>
        Your balance is <strong>{info?.remaining ?? balance}</strong> points.
        Top up via ABA PayWay to keep unlocking premium AI features.
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onClose}
          data-testid="premium-ai-insufficient-cancel"
          style={pillButton({ ghost: true })}
        >
          Maybe later
        </button>
        <a
          href={ABA_TOP_UP_PATH}
          data-testid="premium-ai-topup-cta"
          style={{ ...pillButton({ primary: true }), textDecoration: "none" }}
        >
          <Wallet size={14} /> Top Up via ABA
        </a>
      </div>
    </div>
  );
}

/* ----------------------- Error ----------------------- */
function ErrorCard({ message, onClose }) {
  return (
    <div data-testid="premium-ai-error">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          display: "grid", placeItems: "center",
          background: "rgba(239,68,68,0.16)",
        }}>
          <AlertCircle size={18} color="#f87171" />
        </div>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Something went wrong</h3>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.9, marginBottom: 14 }}>
        {message || "We could not complete that AI request."} No points were charged.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onClose}
          data-testid="premium-ai-error-close"
          style={pillButton({ primary: true })}
        >
          OK
        </button>
      </div>
    </div>
  );
}

/* ----------------------- shared button styling ----------------------- */
function pillButton({ primary, ghost }) {
  if (ghost) {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "8px 16px",
      borderRadius: 999,
      background: "transparent",
      color: "#F4E5C1",
      border: "1px solid rgba(244,229,193,0.25)",
      fontSize: 12,
      fontWeight: 600,
      cursor: "pointer",
    };
  }
  if (primary) {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "8px 16px",
      borderRadius: 999,
      background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
      color: "#1a1420",
      border: "1px solid rgba(255,225,154,0.6)",
      fontSize: 12,
      fontWeight: 700,
      cursor: "pointer",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
    };
  }
  return {};
}
