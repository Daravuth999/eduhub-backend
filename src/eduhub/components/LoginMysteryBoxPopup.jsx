/**
 * LoginMysteryBoxPopup.jsx — Premium 4-treasure-chest mystery reward popup.
 *
 * UI Reconstruct v1 (2026-06):
 *   • Replaced flat "gift box" art with a 3D-feeling wooden treasure chest
 *     (gold metal frame, hinges, lock, plank texture, ground glow).
 *   • 2x2 mobile-first grid with floating idle animation + gold sparkles.
 *   • Selection state: non-picked chests dim, picked chest lifts/zooms,
 *     short 700–1100ms suspense window with rumble + seam light-leak.
 *   • Reveal: chest open, vertical golden light burst, reward icon floats
 *     upward with halo + sparkles, rarity badge + reward label/value.
 *   • Other-box reveal: opens sequentially (one at a time), "YOUR PICK"
 *     label on the selected chest, rarity glow on each.
 *   • Premium gold CONTINUE button. Glassy modal on a darker blurred
 *     backdrop. Reduced-motion respected. Mobile tap targets preserved.
 *
 * Locked perimeter — this component does NOT touch:
 *   backend, payment, wallet core, ABA/KHQR/CamRapidPay, AuthContext,
 *   Google login, service worker, public/index.html, public/sw.js,
 *   package.json, yarn.lock, vercel.json, craco.config.js, EduTalk
 *   audio cache / entitlement / replay / billing, Premium AI backend,
 *   existing login rewards, Speaking Lab Mystery Box, referrals.
 *
 * Backend is the source of truth: the frontend never decides the winning
 * box, the reward, or the rarity. All randomness lives server-side. We
 * only animate and reveal what /select returns.
 *
 * All animations are CSS-only (no new npm dep). All particle / glow
 * elements use pointer-events:none so taps land on the underlying chests.
 * prefers-reduced-motion disables sparkles & motion but never blocks
 * interactivity.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  getMysteryBoxStatus,
  selectMysteryBox,
  readMysteryDismiss,
  writeMysteryDismiss,
} from "../lib/loginMysteryApi";

/* ────────────────────────────────────────────────────────────────────── */
/* utilities                                                              */
/* ────────────────────────────────────────────────────────────────────── */

// Task B bridge — let the normal LoginRewardPopup know it may re-check the
// backend for the next eligible Login Reward campaign once the mystery flow
// is resolved (claimed-today on cold start, or the fresh reveal was closed).
// The normal popup listens for this event and calls /login-campaigns/active.
// Backend stays the source of truth; this is only a UI nudge.
function dispatchLoginRewardsRefresh() {
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("eduhub:login-rewards-refresh"));
    }
  } catch {
    /* ignore — refresh is best-effort */
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(!!mq.matches);
    update();
    if (mq.addEventListener) mq.addEventListener("change", update);
    else if (mq.addListener) mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else if (mq.removeListener) mq.removeListener(update);
    };
  }, []);
  return reduced;
}

// Each chest gets a slightly different wood/metal tint to feel hand-picked.
const CHEST_THEMES = [
  { key: "oak",    wood1: "#8a5a2b", wood2: "#5a3818", band: "#FFE19A", trim: "#9C7A2C", glow: "#FFE19A" },
  { key: "rose",   wood1: "#8c3f3f", wood2: "#4a1d1d", band: "#FFE19A", trim: "#D4A843", glow: "#FFC58A" },
  { key: "violet", wood1: "#5a3f7a", wood2: "#2d1b48", band: "#FFE19A", trim: "#D4A843", glow: "#C9A8F3" },
  { key: "ember",  wood1: "#7a4a2a", wood2: "#3d1f0f", band: "#FFE19A", trim: "#9C7A2C", glow: "#FFB870" },
];

function rarityGlow(rarity) {
  switch ((rarity || "common").toLowerCase()) {
    case "legendary": return "0 0 36px rgba(255,225,154,0.95), 0 0 72px rgba(212,168,67,0.55)";
    case "epic":      return "0 0 30px rgba(201,168,243,0.85), 0 0 60px rgba(75,42,143,0.5)";
    case "rare":      return "0 0 26px rgba(159,212,255,0.75), 0 0 52px rgba(31,79,143,0.45)";
    default:          return "0 0 20px rgba(212,168,67,0.5)";
  }
}

function rarityRingColor(rarity) {
  switch ((rarity || "common").toLowerCase()) {
    case "legendary": return "#FFE19A";
    case "epic":      return "#C9A8F3";
    case "rare":      return "#9FD4FF";
    default:          return "#D4A843";
  }
}

function rewardTypeLabel(rt) {
  switch ((rt || "").toLowerCase()) {
    case "points": return "Points";
    case "voucher": return "Voucher";
    case "edutalk_session": return "EduTalk Session";
    case "edutalk_voice": return "EduTalk Voice";
    case "edutalk_live_coupon": return "Live Voice Coach Coupon";
    default: return "Reward";
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* 3D Treasure Chest (CSS+SVG, no external assets)                         */
/* ────────────────────────────────────────────────────────────────────── */
function TreasureChest({
  theme = CHEST_THEMES[0],
  state = "idle", // "idle" | "dim" | "selected" | "opening" | "opened"
  reducedMotion = false,
}) {
  const rawId = useId();
  const id = `lmbc${rawId.replace(/:/g, "")}`;
  const isOpen = state === "opening" || state === "opened";

  return (
    <svg viewBox="0 0 140 150" width="100%" height="100%" aria-hidden="true"
         style={{ display: "block", overflow: "visible" }}>
      <defs>
        {/* wood plank gradient */}
        <linearGradient id={`wood-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.wood1} />
          <stop offset="55%" stopColor={theme.wood2} />
          <stop offset="100%" stopColor="#1c0f06" />
        </linearGradient>
        {/* curved lid wood */}
        <linearGradient id={`lid-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.wood1} />
          <stop offset="100%" stopColor={theme.wood2} />
        </linearGradient>
        {/* gold metal band */}
        <linearGradient id={`band-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FFF1B8" />
          <stop offset="45%"  stopColor={theme.band} />
          <stop offset="100%" stopColor={theme.trim} />
        </linearGradient>
        {/* inner radiance (visible when open) */}
        <radialGradient id={`inner-${id}`} cx="0.5" cy="0.35" r="0.7">
          <stop offset="0%"  stopColor="#FFF8DC" stopOpacity="1" />
          <stop offset="55%" stopColor="#FFE19A" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#1a1420" stopOpacity="0.95" />
        </radialGradient>
        {/* shine highlight */}
        <linearGradient id={`shine-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#ffffff" stopOpacity="0" />
          <stop offset="50%"  stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* soft ground glow */}
      <ellipse cx="70" cy="135" rx="48" ry="7"
               fill={theme.glow}
               opacity={isOpen ? 0.45 : 0.28} />
      {/* ground shadow */}
      <ellipse cx="70" cy="138" rx="40" ry="4.5" fill="#000" opacity="0.55" />

      {/* floating wrapper (idle bob) */}
      <g className={!reducedMotion && state === "idle" ? "lmb-float" : ""}
         style={{ transformOrigin: "70px 100px",
                  transition: "transform 380ms cubic-bezier(.2,.7,.2,1)",
                  transform:
                    state === "selected" ? "translateY(-8px) scale(1.05)" :
                    state === "opening"  ? "translateY(-6px) scale(1.04)" :
                    state === "dim"      ? "translateY(0) scale(0.96)" :
                                            "translateY(0) scale(1)" }}>

        {/* chest BODY */}
        <g>
          {/* main body */}
          <rect x="20" y="70" width="100" height="55" rx="4"
                fill={`url(#wood-${id})`}
                stroke="#0d0703" strokeWidth="1.2" />
          {/* plank seams */}
          <line x1="20" y1="86"  x2="120" y2="86"  stroke="#0d0703" strokeOpacity="0.55" />
          <line x1="20" y1="102" x2="120" y2="102" stroke="#0d0703" strokeOpacity="0.55" />
          <line x1="20" y1="118" x2="120" y2="118" stroke="#0d0703" strokeOpacity="0.4" />
          {/* vertical wood grain hints */}
          <line x1="46" y1="72" x2="46" y2="124" stroke="#0d0703" strokeOpacity="0.25" />
          <line x1="94" y1="72" x2="94" y2="124" stroke="#0d0703" strokeOpacity="0.25" />

          {/* gold side bands */}
          <rect x="20" y="70"  width="100" height="6" fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.6" />
          <rect x="20" y="119" width="100" height="6" fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.6" />
          {/* vertical gold straps */}
          <rect x="32" y="70"  width="6" height="55" fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.5" />
          <rect x="102" y="70" width="6" height="55" fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.5" />
          {/* rivets */}
          {[24,38,108].map((x) => (
            <g key={x}>
              <circle cx={x+1} cy="73" r="1.1" fill="#FFF1B8" />
              <circle cx={x+1} cy="122" r="1.1" fill="#FFF1B8" />
            </g>
          ))}

          {/* lock plate */}
          <rect x="62" y="92" width="16" height="18" rx="2"
                fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.6" />
          <circle cx="70" cy="99" r="2.4" fill="#1a1208" />
          <rect x="68.5" y="100" width="3" height="6" fill="#1a1208" />

          {/* seam light leak when opening */}
          {state === "opening" && (
            <rect x="22" y="68" width="96" height="3"
                  fill="#FFF8DC"
                  style={{ filter: "blur(1.4px)" }}>
              <animate attributeName="opacity"
                       values="0;1;0.4;1;0.6" dur="0.9s" repeatCount="indefinite" />
            </rect>
          )}
        </g>

        {/* INTERIOR (visible only when lid is up) */}
        {isOpen && (
          <g>
            <rect x="24" y="55" width="92" height="22" rx="3"
                  fill="#0a0510" stroke="#1a1208" />
            <rect x="26" y="56" width="88" height="20" rx="2"
                  fill={`url(#inner-${id})`} opacity="0.95" />
          </g>
        )}

        {/* LID (curved top) */}
        <g style={{
              transformOrigin: "70px 70px",
              transition: "transform 620ms cubic-bezier(.5,1.7,.3,1)",
              transform: isOpen
                ? "translateY(-6px) rotate(-58deg)"
                : "translateY(0) rotate(0)",
            }}>
          {/* curved top arc */}
          <path d="M20,70 Q20,38 70,38 Q120,38 120,70 Z"
                fill={`url(#lid-${id})`}
                stroke="#0d0703" strokeWidth="1.2" />
          {/* gold arc bands */}
          <path d="M20,70 Q20,38 70,38 Q120,38 120,70"
                stroke={`url(#band-${id})`} strokeWidth="5" fill="none"
                strokeLinecap="round" />
          {/* center vertical strap on lid */}
          <path d="M67,70 Q67,40 70,38 Q73,40 73,70 Z"
                fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.5" />
          {/* lid shine */}
          <path d="M28,52 Q70,30 112,52"
                stroke="url(#shine-${id})" strokeWidth="6" fill="none"
                opacity="0.55" />
          {/* lid rivets */}
          <circle cx="26" cy="68" r="1.2" fill="#FFF1B8" />
          <circle cx="114" cy="68" r="1.2" fill="#FFF1B8" />
          {/* lock hasp on lid front */}
          <rect x="65" y="66" width="10" height="8" rx="1.5"
                fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.5" />
        </g>

        {/* hinges */}
        <rect x="24" y="68" width="6" height="6" rx="1"
              fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.4" />
        <rect x="110" y="68" width="6" height="6" rx="1"
              fill={`url(#band-${id})`} stroke="#5a3a0a" strokeWidth="0.4" />
      </g>

      {/* gold sparkles around chest (idle / selected) */}
      {!reducedMotion && (state === "idle" || state === "selected" || isOpen) && (
        <g opacity="0.95" style={{ pointerEvents: "none" }}>
          {[
            { cx: 18,  cy: 40, r: 1.6, d: 0 },
            { cx: 122, cy: 46, r: 2.0, d: 0.3 },
            { cx: 10,  cy: 96, r: 1.4, d: 0.6 },
            { cx: 130, cy: 90, r: 1.8, d: 0.9 },
            { cx: 70,  cy: 22, r: 1.6, d: 1.1 },
            { cx: 50,  cy: 32, r: 1.2, d: 1.4 },
          ].map((s, i) => (
            <circle key={i} cx={s.cx} cy={s.cy} r={s.r}
                    fill="#FFE19A"
                    style={{
                      animation: `lmb-twinkle 2.4s ease-in-out ${s.d}s infinite`,
                      transformOrigin: `${s.cx}px ${s.cy}px`,
                    }} />
          ))}
        </g>
      )}

      {/* vertical light burst when opened */}
      {state === "opened" && !reducedMotion && (
        <g style={{ pointerEvents: "none" }}>
          <rect x="60" y="-10" width="20" height="80"
                fill="url(#inner-${id})" opacity="0.55"
                style={{ filter: "blur(2px)", animation: "lmb-burst 1.4s ease-out forwards" }} />
        </g>
      )}
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Reward icon for the reveal card                                         */
/* ────────────────────────────────────────────────────────────────────── */
function RewardIcon({ type, accent = "#D4A843" }) {
  const t = (type || "").toLowerCase();
  if (t === "points") {
    return (
      <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill={accent} stroke="#7B1E2F" />
        <text x="24" y="29" textAnchor="middle" fontSize="18"
              fontWeight="700" fill="#1a1420">pts</text>
      </svg>
    );
  }
  if (t === "voucher") {
    return (
      <svg viewBox="0 0 56 48" width="64" height="56" aria-hidden="true">
        <rect x="3" y="8" width="50" height="32" rx="4"
              fill={accent} stroke="#1a1420" />
        <path d="M3,18 a4,4 0 0 1 0,12 M53,18 a4,4 0 0 0 0,12"
              fill="#1a1420" />
        <text x="28" y="29" textAnchor="middle" fontSize="13"
              fontWeight="700" fill="#1a1420">VOUCHER</text>
      </svg>
    );
  }
  if (t === "edutalk_session" || t === "edutalk_voice") {
    return (
      <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
        <path d="M8 10h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4h-7l-8 7v-7H8a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z"
              fill={accent} stroke="#1a1420" />
        <circle cx="18" cy="22" r="2" fill="#1a1420" />
        <circle cx="24" cy="22" r="2" fill="#1a1420" />
        <circle cx="30" cy="22" r="2" fill="#1a1420" />
      </svg>
    );
  }
  if (t === "edutalk_live_coupon") {
    return (
      <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
        <rect x="4" y="6" width="40" height="30" rx="6" fill={accent} stroke="#1a1420" />
        <rect x="10" y="16" width="18" height="4" rx="2" fill="#1a1420" />
        <rect x="10" y="24" width="12" height="4" rx="2" fill="#1a1420" />
        <circle cx="34" cy="24" r="7" fill="#1a1420" />
        <rect x="31.5" y="19.5" width="5" height="8" rx="2.5" fill={accent} />
        <path d="M29 26.5a5 5 0 0 0 10 0" stroke={accent} strokeWidth="1.4" fill="none" />
        <rect x="33" y="30" width="2" height="3" fill={accent} />
      </svg>
    );
  }
  // default: gift icon
  return (
    <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
      <rect x="6" y="20" width="36" height="22" rx="2" fill={accent} stroke="#1a1420" />
      <rect x="22" y="20" width="4" height="22" fill="#7B1E2F" />
      <rect x="4" y="14" width="40" height="8" rx="2" fill={accent} stroke="#1a1420" />
      <path d="M16,14 Q24,2 32,14" stroke="#7B1E2F" strokeWidth="2" fill="none" />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Main popup component                                                    */
/* ────────────────────────────────────────────────────────────────────── */
export default function LoginMysteryBoxPopup() {
  const { student, renderStudent, isBootstrapping } = useAuth() || {};
  const location = useLocation();
  const reducedMotion = usePrefersReducedMotion();

  const isAuthed = useMemo(() => {
    if (isBootstrapping) return false;
    if (student && (student.studentId || student.student_id)) return true;
    if (renderStudent && (renderStudent.clean_id || renderStudent.student_id)) return true;
    return false;
  }, [student, renderStudent, isBootstrapping]);

  const identityKey = useMemo(() => {
    const a = student?.studentId || student?.student_id || "";
    const b = renderStudent?.clean_id || renderStudent?.student_id || "";
    return `${a}|${b}`;
  }, [student, renderStudent]);

  const routeAllows = useMemo(() => {
    const p = (location?.pathname || "/").toLowerCase();
    if (p.startsWith("/login")) return false;
    if (p.startsWith("/studio")) return false;
    if (p.startsWith("/library/read")) return false;
    return true;
  }, [location]);

  // State machine: idle | checking | offer | suspense | revealed | error
  const [phase, setPhase] = useState("idle");
  const [status, setStatus] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [revealResp, setRevealResp] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [showRecap, setShowRecap] = useState(false);

  const fetchedKeyRef = useRef(null);

  useEffect(() => {
    if (!isAuthed || !routeAllows) return undefined;
    if (!identityKey || identityKey === "|") return undefined;
    if (fetchedKeyRef.current === identityKey) return undefined;
    fetchedKeyRef.current = identityKey;
    let cancelled = false;
    setPhase("checking");
    getMysteryBoxStatus()
      .then((data) => {
        if (cancelled) return;
        if (!data || !data.campaign) { setPhase("idle"); return; }
        setStatus(data);
        const dismKey = `${data.campaign.id}_${new Date().toISOString().slice(0, 10)}`;
        const dism = readMysteryDismiss(data.campaign.id, dismKey);
        if (data.eligible && dism) {
          setDismissed(true);
          setPhase("idle");
          return;
        }
        if (data.already_claimed) {
          // v12.0.2 hotfix (Task A) — DO NOT auto-open the recap modal on
          // cold-start revisit. A claimed-today campaign must NOT keep
          // covering the screen and blocking the normal LoginRewardPopup.
          // The reveal modal is for the immediate post-claim moment only
          // (set by onPickBox below). Leaving phase="idle" keeps the popup
          // hidden; the credit is still recorded server-side and points
          // already landed in the wallet/ledger. We also nudge the normal
          // Login Reward popup so any other eligible campaign can surface.
          setPhase("idle");
          dispatchLoginRewardsRefresh();
          return;
        }
        if (data.eligible) setPhase("offer");
        else setPhase("idle");
      })
      .catch((err) => {
        if (cancelled) return;
        const sc = (err && err.status) || 0;
        if (sc === 401 || sc === 403) fetchedKeyRef.current = null;
        // eslint-disable-next-line no-console
        console.warn("[LoginMysteryBox] status failed:", err && err.message);
        setPhase("idle");
      });
    return () => { cancelled = true; };
  }, [isAuthed, identityKey, routeAllows]);

  const onPickBox = useCallback(async (idx) => {
    if (phase !== "offer" || !status || !status.campaign) return;
    setSelectedIdx(idx);
    setPhase("suspense");
    setErrorMsg("");
    try {
      // Suspense window: reduced motion → no artificial delay.
      const minDelay = reducedMotion
        ? Promise.resolve()
        : new Promise((r) => setTimeout(r, 950));
      const [r] = await Promise.all([
        selectMysteryBox(idx, status.claim_id),
        minDelay,
      ]);
      setRevealResp(r);
      setPhase("revealed");
    } catch (err) {
      setErrorMsg((err && err.message) || "Could not claim reward.");
      setPhase("error");
    }
  }, [phase, status, reducedMotion]);

  const onDismissOffer = useCallback(() => {
    if (!status || !status.campaign) return;
    const today = new Date().toISOString().slice(0, 10);
    writeMysteryDismiss(status.campaign.id, `${status.campaign.id}_${today}`);
    setDismissed(true);
    setPhase("idle");
  }, [status]);

  const onCloseRevealed = useCallback(() => {
    setPhase("idle");
    setShowRecap(false);
    // Task B bridge — after a fresh mystery reveal is dismissed, let the
    // normal Login Reward popup re-check the backend for the next eligible
    // campaign so reward campaigns can be claimed sequentially.
    dispatchLoginRewardsRefresh();
  }, []);

  if (!isAuthed) return null;
  if (!routeAllows) return null;
  if (dismissed) return null;
  if (phase === "idle" || phase === "checking") return null;

  const camp = status && status.campaign;
  const titleText = (camp && camp.title) || "Mystery Reward";
  const subtitleText = (camp && camp.subtitle)
    || "Choose one treasure chest to reveal your reward";

  return (
    <div className="lmb-root" role="dialog" aria-modal="true"
         data-testid="login-mystery-popup">
      <style>{POPUP_STYLES}</style>
      <div className="lmb-backdrop" onClick={onDismissOffer}
           data-testid="login-mystery-backdrop" />

      <div className="lmb-modal" data-testid="login-mystery-modal">
        {/* ambient floating particles inside the modal */}
        {!reducedMotion && (
          <div className="lmb-particles" aria-hidden="true">
            {Array.from({ length: 14 }).map((_, i) => (
              <span key={i} className="lmb-particle"
                    style={{
                      left: `${(i * 73) % 100}%`,
                      animationDelay: `${(i % 7) * 0.4}s`,
                      animationDuration: `${5 + (i % 4)}s`,
                    }} />
            ))}
          </div>
        )}

        {/* Header */}
        <div className="lmb-header">
          <div className="lmb-title-wrap">
            <div className="lmb-eyebrow">Login Reward</div>
            <h2 className="lmb-title" data-testid="login-mystery-title">
              {titleText}
            </h2>
            <p className="lmb-subtitle" data-testid="login-mystery-subtitle">
              {subtitleText}
            </p>
            {phase === "offer" && (
              <p className="lmb-microcopy">
                One pick only — what's inside is yours.
              </p>
            )}
          </div>
          <button className="lmb-close-btn"
                  onClick={phase === "revealed" ? onCloseRevealed : onDismissOffer}
                  aria-label="Close"
                  data-testid="login-mystery-close-btn">
            ×
          </button>
        </div>

        {/* Body */}
        {phase === "offer" && status && (
          <ChestGrid
            boxes={status.boxes || []}
            onPick={onPickBox}
            selectedIdx={null}
            reducedMotion={reducedMotion}
          />
        )}

        {phase === "suspense" && (
          <ChestGrid
            boxes={status?.boxes || []}
            onPick={() => {}}
            selectedIdx={selectedIdx}
            reducedMotion={reducedMotion}
            disabled
            suspenseIdx={selectedIdx}
          />
        )}

        {phase === "revealed" && revealResp && (
          <RevealedView
            resp={revealResp}
            campaign={camp}
            showRecap={showRecap || !revealResp.already_claimed}
            onShowRecap={() => setShowRecap(true)}
            onClose={onCloseRevealed}
            reducedMotion={reducedMotion}
          />
        )}

        {phase === "error" && (
          <div className="lmb-error" data-testid="login-mystery-error">
            <p className="lmb-error-msg">{errorMsg || "Something went wrong."}</p>
            <button className="lmb-btn lmb-btn-secondary"
                    onClick={() => setPhase("offer")}
                    data-testid="login-mystery-retry-btn">
              Try again
            </button>
          </div>
        )}

        {phase === "offer" && (
          <div className="lmb-footer">
            <button className="lmb-link" onClick={onDismissOffer}
                    data-testid="login-mystery-maybe-later-btn">
              Maybe later
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Chest grid sub-component                                                */
/* ────────────────────────────────────────────────────────────────────── */
function ChestGrid({
  boxes, onPick, selectedIdx, reducedMotion,
  disabled = false, suspenseIdx = null,
}) {
  // Pad to 4 to guarantee the 2x2 mobile layout even if backend ever returns fewer.
  const slots = boxes.length ? boxes : [0,1,2,3].map((i) => ({ box_index: i }));
  return (
    <div className="lmb-grid" data-testid="login-mystery-box-grid">
      {slots.map((b, i) => {
        const theme = CHEST_THEMES[i % CHEST_THEMES.length];
        const isSelected = selectedIdx === i || suspenseIdx === i;
        const isOther = suspenseIdx !== null && suspenseIdx !== i;
        const state =
          suspenseIdx === i ? "opening"
          : isSelected ? "selected"
          : isOther ? "dim"
          : "idle";
        const cls = [
          "lmb-chest",
          disabled ? "lmb-chest--disabled" : "",
          isSelected ? "lmb-chest--selected" : "",
          isOther ? "lmb-chest--dim" : "",
          state === "opening" ? "lmb-chest--rumble" : "",
        ].filter(Boolean).join(" ");
        return (
          <button
            key={b.box_index ?? i}
            type="button"
            className={cls}
            onClick={() => !disabled && onPick(i)}
            disabled={disabled}
            aria-label={`Treasure chest ${i + 1}`}
            data-testid={`login-mystery-box-${i}`}
            style={{
              boxShadow: isSelected
                ? `0 0 0 2px ${theme.glow}, 0 0 36px ${theme.glow}99`
                : undefined,
            }}
          >
            <div className="lmb-chest-glow" aria-hidden="true"
                 style={{ background:
                   `radial-gradient(ellipse at 50% 80%, ${theme.glow}55 0%, transparent 65%)` }} />
            <div className="lmb-chest-art">
              <TreasureChest theme={theme} state={state} reducedMotion={reducedMotion} />
            </div>
            <div className="lmb-chest-label">
              Chest <span style={{ color: theme.glow }}>{i + 1}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Revealed (post-pick) view                                               */
/* ────────────────────────────────────────────────────────────────────── */
function RevealedView({ resp, campaign, showRecap, onShowRecap, onClose, reducedMotion }) {
  const selected = resp.selected_reward || {};
  const all = resp.revealed_rewards || [];
  const accent = selected.accent_color || (campaign && campaign.accent_color) || "#D4A843";
  const ringColor = rarityRingColor(selected.rarity);
  const selectedTheme = CHEST_THEMES[(resp.selected_box_index ?? 0) % CHEST_THEMES.length];

  // Sequential reveal of other chests
  const [revealedCount, setRevealedCount] = useState(0);
  useEffect(() => {
    if (!showRecap) { setRevealedCount(0); return; }
    if (revealedCount >= all.length) return;
    const delay = reducedMotion ? 0 : 420;
    const t = setTimeout(() => setRevealedCount((n) => n + 1), delay);
    return () => clearTimeout(t);
  }, [showRecap, revealedCount, all.length, reducedMotion]);

  return (
    <div className="lmb-reveal" data-testid="login-mystery-reveal">
      {/* Winner card with open chest + light burst */}
      <div className="lmb-winner"
           style={{ boxShadow: rarityGlow(selected.rarity) }}
           data-testid="login-mystery-winner-card">
        {!reducedMotion && (
          <div className="lmb-halo" aria-hidden="true">
            {Array.from({ length: 14 }).map((_, i) => (
              <span key={i} className="lmb-halo-ray"
                    style={{
                      transform: `rotate(${i * (360/14)}deg) translateY(-70px)`,
                      background: `linear-gradient(180deg, ${ringColor}cc, transparent)`,
                    }} />
            ))}
          </div>
        )}

        {/* open chest behind the reward */}
        <div className="lmb-winner-chest" aria-hidden="true">
          <TreasureChest theme={selectedTheme} state="opened" reducedMotion={reducedMotion} />
        </div>

        {/* reward icon floats up out of the chest */}
        <div className={`lmb-winner-icon ${reducedMotion ? "" : "lmb-rise"}`}
             style={{ borderColor: ringColor }}>
          <RewardIcon type={selected.reward_type} accent={accent} />
        </div>

        <div className="lmb-winner-rarity"
             style={{ color: ringColor, borderColor: ringColor }}
             data-testid="login-mystery-winner-rarity">
          {(selected.rarity || "common").toUpperCase()} · {rewardTypeLabel(selected.reward_type)}
        </div>
        <div className="lmb-winner-label" data-testid="login-mystery-winner-label">
          {selected.label || "Reward"}
        </div>
        <div className="lmb-winner-value" data-testid="login-mystery-winner-value">
          {selected.display_value}
        </div>
        {selected.description && (
          <div className="lmb-winner-desc">{selected.description}</div>
        )}
        {resp.voucher && resp.voucher.coupon_code && (
          <div className="lmb-voucher-code" data-testid="login-mystery-voucher-code">
            Code: <strong>{resp.voucher.coupon_code}</strong>
          </div>
        )}
        {resp.edutalk_live_coupon && resp.edutalk_live_coupon.coupon_code && (
          <div className="lmb-voucher-code" data-testid="login-mystery-edutalk-live-coupon-code">
            Code: <strong>{resp.edutalk_live_coupon.coupon_code}</strong>
            <div className="lmb-edutalk-live-coupon-hint">
              Open Live Voice Coach and enter this code to redeem it.
            </div>
          </div>
        )}
        <p className="lmb-success-msg" data-testid="login-mystery-success-msg">
          {resp.success_message || campaign?.success_message || "Reward claimed!"}
        </p>
      </div>

      {/* Recap of the other chests (sequential) */}
      {showRecap ? (
        <>
          <div className="lmb-recap-title"
               data-testid="login-mystery-recap-title">
            {resp.post_claim_message ||
             campaign?.post_claim_message ||
             "See what was hidden in the other chests"}
          </div>
          <div className="lmb-recap-grid" data-testid="login-mystery-recap-grid">
            {all.map((r, i) => {
              const isSelected = i === resp.selected_box_index;
              const visible = i < revealedCount || reducedMotion;
              const theme = CHEST_THEMES[i % CHEST_THEMES.length];
              const ring = rarityRingColor(r.rarity);
              return (
                <div key={i}
                     className={[
                       "lmb-recap-card",
                       isSelected ? "lmb-recap-card--selected" : "",
                       visible ? "lmb-recap-card--in" : "lmb-recap-card--hidden",
                     ].filter(Boolean).join(" ")}
                     style={visible ? { boxShadow: rarityGlow(r.rarity), borderColor: ring } : undefined}
                     data-testid={`login-mystery-recap-${i}`}>
                  <div className="lmb-recap-num">Chest {i + 1}</div>
                  <div className="lmb-recap-chest" aria-hidden="true">
                    <TreasureChest
                      theme={theme}
                      state={visible ? "opened" : "idle"}
                      reducedMotion={reducedMotion}
                    />
                  </div>
                  <div className="lmb-recap-icon">
                    {visible && (
                      <RewardIcon type={r.reward_type} accent={r.accent_color || "#D4A843"} />
                    )}
                  </div>
                  <div className="lmb-recap-label">
                    {visible ? r.label : "…"}
                  </div>
                  <div className="lmb-recap-value"
                       style={visible ? { color: ring } : undefined}>
                    {visible ? r.display_value : ""}
                  </div>
                  {isSelected && (
                    <div className="lmb-recap-badge">YOUR PICK</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <button className="lmb-btn lmb-btn-secondary"
                onClick={onShowRecap}
                data-testid="login-mystery-show-recap-btn">
          See what was hidden in the other chests
        </button>
      )}

      <div className="lmb-actions">
        <button className="lmb-btn lmb-btn-primary" onClick={onClose}
                data-testid="login-mystery-continue-btn">
          CONTINUE
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Scoped styles                                                            */
/* ────────────────────────────────────────────────────────────────────── */
const POPUP_STYLES = `
.lmb-root { position: fixed; inset: 0; z-index: 9990;
  display: grid; place-items: center;
  padding: max(env(safe-area-inset-top, 0px), 8px) 10px
           max(env(safe-area-inset-bottom, 0px), 8px);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif; }
.lmb-backdrop { position: absolute; inset: 0;
  background:
    radial-gradient(circle at 30% 20%, rgba(60,38,86,0.72) 0%, rgba(10,6,18,0.94) 70%),
    rgba(6,3,12,0.7);
  backdrop-filter: blur(14px) saturate(120%); }
/* v1.1 mobile polish — modal now hugs the viewport more tightly, the
   internal scroll only kicks in when the recap is fully open, and chest
   cards/recap cards are visibly more compact so the result is reachable
   without long scrolls. */
.lmb-modal { position: relative; z-index: 1;
  width: min(680px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  overflow-y: auto; overflow-x: hidden;
  border-radius: 22px;
  background:
    linear-gradient(160deg, rgba(40,26,62,0.92) 0%, rgba(18,10,32,0.96) 100%);
  border: 1px solid rgba(212,168,67,0.32);
  box-shadow: 0 30px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(212,168,67,0.18) inset,
              0 0 60px rgba(212,168,67,0.12) inset;
  color: #F4E5C1; padding: 14px 12px 16px;
  backdrop-filter: blur(6px) saturate(120%);
  scrollbar-width: thin; }
.lmb-particles { position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  border-radius: 22px; }
.lmb-particle { position: absolute; bottom: -10px; width: 4px; height: 4px;
  border-radius: 999px; background: #FFE19A;
  box-shadow: 0 0 8px #FFE19A, 0 0 14px rgba(255,225,154,0.4);
  opacity: 0.6; animation: lmb-rise-particle 6s linear infinite; }

.lmb-header { display: flex; align-items: flex-start; gap: 10px;
  position: relative; z-index: 2; }
.lmb-title-wrap { flex: 1; min-width: 0; text-align: center; }
.lmb-eyebrow { font-size: 9.5px; letter-spacing: 0.26em; font-weight: 700;
  color: #C9B98E; text-transform: uppercase; margin-bottom: 2px; }
.lmb-title { font-size: 20px; font-weight: 800; margin: 0; letter-spacing: 0.01em;
  background: linear-gradient(135deg, #FFF1B8 0%, #FFE19A 35%, #D4A843 70%, #9C7A2C 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  text-shadow: 0 0 22px rgba(255,225,154,0.25); line-height: 1.15; }
.lmb-subtitle { margin: 4px 0 0; font-size: 12px; color: #D9C9A0; line-height: 1.4; }
.lmb-microcopy { margin: 4px 0 0; font-size: 11px; color: #9c8a5a;
  letter-spacing: 0.06em; font-style: italic; }
.lmb-close-btn { border: 1px solid rgba(244,229,193,0.22); background: rgba(0,0,0,0.25);
  color: #F4E5C1; width: 32px; height: 32px; border-radius: 999px; font-size: 20px;
  line-height: 1; cursor: pointer; transition: transform 0.2s, background 0.2s;
  flex: 0 0 auto; }
.lmb-close-btn:hover { background: rgba(244,229,193,0.1); transform: scale(1.06); }

.lmb-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;
  margin-top: 14px; position: relative; z-index: 2; }
@media (min-width: 620px) { .lmb-grid { grid-template-columns: repeat(4, 1fr); gap: 14px; } }

.lmb-chest { position: relative; appearance: none;
  border: 1px solid rgba(212,168,67,0.32);
  background:
    linear-gradient(180deg, rgba(60,40,90,0.55) 0%, rgba(20,12,34,0.92) 100%);
  border-radius: 16px; padding: 8px 6px 8px; cursor: pointer; color: #F4E5C1;
  transition: transform 260ms ease, box-shadow 260ms ease, border-color 260ms ease,
              opacity 260ms ease, filter 260ms ease;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  min-height: 132px; overflow: hidden; -webkit-tap-highlight-color: transparent; }
@media (min-width: 620px) { .lmb-chest { padding: 14px 8px 10px; min-height: 180px; border-radius: 20px; } }
.lmb-chest::before { content: ""; position: absolute; inset: 0;
  background: radial-gradient(ellipse at top, rgba(255,225,154,0.08), transparent 60%);
  pointer-events: none; }
.lmb-chest-glow { position: absolute; inset: 0; pointer-events: none; opacity: 0.9; }
.lmb-chest:hover:not(:disabled) { transform: translateY(-4px);
  border-color: rgba(255,225,154,0.65); box-shadow: 0 0 22px rgba(212,168,67,0.32); }
.lmb-chest:active:not(:disabled) { transform: translateY(-1px) scale(0.98); }
.lmb-chest--selected { border-color: rgba(255,225,154,0.95) !important;
  transform: translateY(-5px) scale(1.04); z-index: 3; }
.lmb-chest--dim { opacity: 0.45; filter: saturate(0.6) brightness(0.85); }
.lmb-chest--disabled { cursor: not-allowed; }
.lmb-chest--rumble { animation: lmb-rumble 0.22s linear infinite; }
.lmb-chest-art { width: 100%; aspect-ratio: 1 / 1; max-width: 96px; position: relative; z-index: 1; }
@media (min-width: 620px) { .lmb-chest-art { max-width: 140px; } }
.lmb-chest-label { font-size: 10px; font-weight: 700; letter-spacing: 0.2em;
  text-transform: uppercase; color: #C9B98E; position: relative; z-index: 1; }

.lmb-float { animation: lmb-float 3.6s ease-in-out infinite; }

.lmb-reveal { margin-top: 14px; position: relative; z-index: 2; }
.lmb-winner { position: relative; border: 1px solid rgba(255,225,154,0.5);
  background:
    radial-gradient(ellipse at 50% 0%, rgba(255,225,154,0.15), transparent 60%),
    linear-gradient(160deg, rgba(50,32,76,0.92) 0%, rgba(18,10,32,0.97) 100%);
  border-radius: 20px; padding: 16px 14px 16px; text-align: center;
  overflow: hidden; }
@media (min-width: 620px) { .lmb-winner { padding: 26px 16px 20px; border-radius: 24px; } }
.lmb-halo { position: absolute; inset: 0; pointer-events: none;
  display: grid; place-items: center; top: 40px; }
.lmb-halo-ray { position: absolute; top: 50%; left: 50%;
  width: 2.5px; height: 70px; transform-origin: 50% 100%;
  border-radius: 999px; opacity: 0.45;
  animation: lmb-pulse 1.8s ease-in-out infinite; }
@media (min-width: 620px) { .lmb-halo-ray { height: 100px; } }
.lmb-winner-chest { position: relative; width: 118px; height: 126px; margin: 0 auto -8px;
  z-index: 1; }
@media (min-width: 620px) { .lmb-winner-chest { width: 160px; height: 170px; margin-bottom: -10px; } }
.lmb-winner-icon { position: relative; z-index: 2; width: 72px; height: 72px;
  margin: -30px auto 8px; display: grid; place-items: center;
  border-radius: 999px; border: 2px solid #D4A843;
  background:
    radial-gradient(circle at 50% 40%, rgba(255,248,220,0.95), rgba(60,40,90,0.95) 70%);
  box-shadow: 0 0 24px rgba(255,225,154,0.5); }
@media (min-width: 620px) { .lmb-winner-icon { width: 92px; height: 92px; margin: -40px auto 12px; } }
.lmb-rise { animation: lmb-rise 1.1s cubic-bezier(.2,.8,.2,1) both; }
.lmb-winner-rarity { position: relative; z-index: 2;
  display: inline-block; padding: 3px 10px; border-radius: 999px;
  border: 1px solid; font-size: 10px; font-weight: 800; letter-spacing: 0.2em;
  text-transform: uppercase; margin-bottom: 6px; background: rgba(0,0,0,0.35); }
.lmb-winner-label { position: relative; z-index: 2; font-size: 15px; font-weight: 700; }
@media (min-width: 620px) { .lmb-winner-label { font-size: 18px; } }
.lmb-winner-value { position: relative; z-index: 2; font-size: 24px; font-weight: 900;
  background: linear-gradient(135deg, #FFF1B8 0%, #FFE19A 40%, #D4A843 70%, #9C7A2C 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  margin-top: 2px; letter-spacing: 0.01em; }
@media (min-width: 620px) { .lmb-winner-value { font-size: 30px; margin-top: 4px; } }
.lmb-winner-desc { position: relative; z-index: 2; font-size: 12px; color: #D9C9A0;
  margin-top: 6px; }
.lmb-voucher-code { position: relative; z-index: 2; font-size: 12.5px; margin-top: 8px;
  background: rgba(255,225,154,0.12); border: 1px dashed rgba(255,225,154,0.6);
  border-radius: 10px; padding: 5px 10px; display: inline-block; }
.lmb-edutalk-live-coupon-hint { font-size: 10.5px; color: #C9B98E; margin-top: 4px; }
.lmb-success-msg { position: relative; z-index: 2; font-size: 12px; color: #F4E5C1;
  margin: 8px 0 0; }

.lmb-recap-title { margin: 12px 0 8px; font-size: 10.5px; letter-spacing: 0.2em;
  text-transform: uppercase; color: #C9B98E; text-align: center; font-weight: 700; }
.lmb-recap-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
@media (min-width: 620px) { .lmb-recap-grid { gap: 10px; } }
.lmb-recap-card { position: relative; border: 1px solid rgba(212,168,67,0.25);
  background: linear-gradient(180deg, rgba(40,26,62,0.7) 0%, rgba(18,10,32,0.92) 100%);
  border-radius: 12px; padding: 6px 4px 8px;
  text-align: center; transition: opacity 380ms ease, transform 380ms ease,
                                    border-color 380ms ease, box-shadow 380ms ease; }
@media (min-width: 620px) { .lmb-recap-card { border-radius: 16px; padding: 10px 8px 12px; } }
.lmb-recap-card--hidden { opacity: 0.55; transform: translateY(6px); filter: saturate(0.6); }
.lmb-recap-card--in { opacity: 1; transform: translateY(0); }
.lmb-recap-card--selected { border-color: rgba(255,225,154,0.95) !important; }
.lmb-recap-chest { width: 100%; aspect-ratio: 1 / 1; max-width: 56px; margin: 0 auto; }
@media (min-width: 620px) { .lmb-recap-chest { max-width: 90px; } }
.lmb-recap-num { font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
  color: #C9B98E; font-weight: 700; }
.lmb-recap-icon { display: grid; place-items: center; margin: 1px 0; min-height: 22px; }
.lmb-recap-icon svg { max-width: 36px; height: auto; }
@media (min-width: 620px) { .lmb-recap-icon svg { max-width: none; } .lmb-recap-icon { min-height: 28px; } }
.lmb-recap-label { font-size: 10.5px; font-weight: 700; min-height: 14px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 620px) { .lmb-recap-label { font-size: 12px; min-height: 16px; } }
.lmb-recap-value { font-size: 10.5px; color: #C9B98E; margin-top: 1px; font-weight: 700; }
.lmb-recap-badge { position: absolute; top: -8px; left: 50%; transform: translateX(-50%);
  font-size: 8.5px; letter-spacing: 0.2em; font-weight: 800; color: #1a1420;
  background: linear-gradient(135deg, #FFF1B8 0%, #FFE19A 40%, #D4A843 100%);
  border-radius: 999px; padding: 2px 8px;
  box-shadow: 0 4px 12px rgba(212,168,67,0.45); white-space: nowrap; }

.lmb-actions { margin-top: 14px; display: flex; gap: 10px; justify-content: center; }
.lmb-btn { appearance: none; border: 0; padding: 11px 22px; border-radius: 999px;
  font-size: 12.5px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase;
  cursor: pointer; transition: transform 0.2s, box-shadow 0.2s, filter 0.2s;
  min-height: 44px; }
.lmb-btn-primary { color: #1a1420;
  background: linear-gradient(135deg, #FFF1B8 0%, #FFE19A 35%, #D4A843 70%, #9C7A2C 100%);
  box-shadow: 0 10px 26px rgba(212,168,67,0.45),
              0 0 0 1px rgba(255,255,255,0.35) inset; }
.lmb-btn-primary:hover { transform: translateY(-2px); filter: brightness(1.05); }
.lmb-btn-secondary { color: #F4E5C1; background: rgba(244,229,193,0.08);
  border: 1px solid rgba(244,229,193,0.3); margin: 12px auto 0; display: block; }
.lmb-btn-secondary:hover { background: rgba(244,229,193,0.14); }
.lmb-link { background: transparent; border: 0; color: #C9B98E; font-size: 12.5px;
  cursor: pointer; padding: 6px 12px; text-decoration: underline;
  text-decoration-color: rgba(201,185,142,0.5); min-height: 40px; }
.lmb-link:hover { color: #FFE19A; }
.lmb-footer { margin-top: 8px; text-align: center; position: relative; z-index: 2; }
.lmb-error { padding: 14px; text-align: center; position: relative; z-index: 2; }
.lmb-error-msg { color: #FF9F9F; margin-bottom: 10px; font-size: 13px; }

@keyframes lmb-twinkle {
  0%, 100% { opacity: 0.2; transform: scale(0.6); }
  50%      { opacity: 1;   transform: scale(1.4); }
}
@keyframes lmb-pulse {
  0%, 100% { opacity: 0.25; transform-origin: 50% 100%; }
  50%      { opacity: 0.95; }
}
@keyframes lmb-float {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-4px); }
}
@keyframes lmb-rumble {
  0%   { transform: translate(0, 0) rotate(0); }
  20%  { transform: translate(-1.5px, 1px) rotate(-0.6deg); }
  40%  { transform: translate(2px, -1px) rotate(0.6deg); }
  60%  { transform: translate(-1px, 2px) rotate(-0.4deg); }
  80%  { transform: translate(1.5px, -0.5px) rotate(0.4deg); }
  100% { transform: translate(0, 0) rotate(0); }
}
@keyframes lmb-rise {
  0%   { transform: translateY(40px) scale(0.6); opacity: 0; }
  60%  { transform: translateY(-6px) scale(1.08); opacity: 1; }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes lmb-burst {
  0%   { opacity: 0; transform: scaleY(0.2); }
  40%  { opacity: 1; transform: scaleY(1.2); }
  100% { opacity: 0; transform: scaleY(1); }
}
@keyframes lmb-rise-particle {
  0%   { transform: translateY(0) translateX(0); opacity: 0; }
  10%  { opacity: 0.9; }
  100% { transform: translateY(-110%) translateX(20px); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .lmb-halo-ray, .lmb-particle, .lmb-float,
  .lmb-chest--rumble, .lmb-rise { animation: none !important; }
  .lmb-chest { transition: none; }
}
`;
