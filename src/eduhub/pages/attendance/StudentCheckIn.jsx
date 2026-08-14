/**
 * StudentCheckIn.jsx — Class Gate join-link landing page, route `/attendance/j/:slug`.
 *
 * Auth strategy (v3 — browser-friendly):
 *   No ProtectedRoute wrapper. The page handles authentication inline:
 *   1. Try getSessionBySlug with whatever token is in localStorage.
 *   2. If 401 (no session / browser context with no token): show an inline
 *      sign-in form — no full-page redirect. The student logs in right here,
 *      token is written to localStorage, then the check-in auto-proceeds.
 *   3. If authenticated: proceed normally.
 *
 *   This removes the annoying redirect-to-login experience when the student
 *   opens the link in Telegram / WhatsApp in-app browser for the first time.
 *   After the first login the token persists in SFSafariViewController's
 *   localStorage (shared with Safari on iOS 14.5+), so future link taps
 *   are seamless.
 *
 * tracked=false handling (v3):
 *   The backend returns tracked:false when it couldn't save the stamp (e.g.
 *   the student is not in the class roster). We now show a clear amber
 *   warning instead of the misleading green "Stamped" success state, so
 *   students understand they need to contact their teacher.
 *
 * Check-in correctness invariants (unchanged from v2.1):
 *   - checkinWithRetry retries up to 3× with backoff before surfacing failure
 *   - Backend degrades safely: returns meet_url even when its own write fails
 *   - "Never block access to class" guarantee still holds
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Compass, Users, CheckCircle2, AlertTriangle, Loader2,
  ArrowRight, MapPin, Lock,
} from "lucide-react";
import attendanceApi from "./api";
import { studentLogin } from "../../auth/studentAuthService";
import TurnstileWidget from "../../auth/TurnstileWidget";
import { Stamp } from "./PassportArt";

const IVORY = "#F6F1E6";
const INK = "#1B2A4A";
const AMBER_BG = "#FBF0DC";
const AMBER_BORDER = "#E8D09A";
const AMBER_TEXT = "#7A5A10";
const SERIF = "Georgia, 'Times New Roman', serif";

const fade = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
};

function gotoMeet(url) {
  if (url) window.location.href = url;
}

function isInPwa() {
  try {
    return (
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches
    );
  } catch { return false; }
}

function hasToken() {
  try { return !!localStorage.getItem("student_session_token"); } catch { return false; }
}

export default function StudentCheckIn() {
  const { slug } = useParams();
  const [session, setSession] = useState(null);
  // phases: loading | login | ready | picker | checking | joined | error
  const [phase, setPhase] = useState("loading");
  const [error, setError] = useState("");
  const [meetUrl, setMeetUrl] = useState("");
  const [tracked, setTracked] = useState(true);
  const [sessionIsOpen, setSessionIsOpen] = useState(true);
  const inBrowser = !isInPwa();

  // ── inline login state ────────────────────────────────────────────────────
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [tsReady, setTsReady] = useState(false);
  const turnstileRef = useRef(null);

  // ── load session by slug ─────────────────────────────────────────────────
  const loadSession = useCallback(async () => {
    setPhase("loading");
    setError("");
    try {
      const s = await attendanceApi.getSessionBySlug(slug);
      setSession(s);
      setPhase("ready");
    } catch (e) {
      // 401 = no session token in this browser context → ask student to sign in inline
      if (e?.status === 401 || e?.status === 403) {
        setPhase("login");
      } else {
        setError(e?.message || "Could not load this class.");
        setPhase("error");
      }
    }
  }, [slug]);

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // ── inline login → auto-retry session load ───────────────────────────────
  const doLogin = useCallback(async (e) => {
    e?.preventDefault();
    if (!loginId.trim() || !loginPw.trim()) {
      setLoginErr("Please enter your Student ID and password.");
      return;
    }
    setLoggingIn(true);
    setLoginErr("");
    try {
      const tsToken = turnstileRef.current?.getToken?.() || "";
      await studentLogin({ cleanId: loginId.trim(), password: loginPw.trim(), turnstileToken: tsToken });
      // Token now in localStorage — reload session without redirect
      await loadSession();
    } catch (err) {
      setLoginErr(err?.message || "Sign in failed. Check your ID and password.");
      turnstileRef.current?.reset?.();
    } finally {
      setLoggingIn(false);
    }
  }, [loginId, loginPw, loadSession]);

  // ── resilient check-in (unchanged) ───────────────────────────────────────
  const doCheckin = useCallback(async (asStudentId) => {
    setPhase("checking");
    setError("");
    try {
      const res = await attendanceApi.checkinWithRetry({ slug, asStudentId });
      setMeetUrl(res.meet_url || "");
      setTracked(!!res.tracked);
      setSessionIsOpen(res.is_open !== false);
      setPhase("joined");
      gotoMeet(res.meet_url);
    } catch (err) {
      setError("We couldn't confirm your check-in. You can still join class.");
      setPhase("error");
    }
  }, [slug]);

  const stampedFailed = phase === "joined" && !tracked;
  const steps = [
    { key: "checkpoint", label: "Checkpoint", active: ["ready", "picker", "login"].includes(phase) },
    { key: "verifying",  label: "Verifying",  active: phase === "checking" },
    { key: "stamped",    label: stampedFailed ? "Not Stamped" : "Stamped", active: phase === "joined", warn: stampedFailed },
  ];

  return (
    <div
      className="min-h-screen flex items-center justify-center px-5 py-10"
      style={{ background: "#EFE9DB", color: INK }}
      data-testid="attendance-checkin-page"
    >
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md rounded-[26px] overflow-hidden"
        style={{ background: "#FBF8F1", border: "1px solid #E4DAC6", boxShadow: "0 26px 60px -34px rgba(27,42,74,0.5)" }}
      >
        {/* "Open in app" banner — browser context only, not shown inside PWA */}
        {inBrowser && (
          <a
            href={window.location.href}
            className="flex items-center justify-between px-4 py-2.5 text-[12px] font-medium"
            style={{ background: "#1B3A2C", color: "#7ED8A0", borderBottom: "1px solid #1B2A4A" }}
            data-testid="checkin-open-in-app-banner"
          >
            <span>📱 Open in your EduHub app for the best experience</span>
            <span style={{ opacity: 0.7 }}>→</span>
          </a>
        )}

        {/* header strip */}
        <div className="px-6 pt-5 pb-4" style={{ background: INK, color: IVORY }}>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em]" style={{ color: "#C7CFE0" }}>
            <Compass className="h-3.5 w-3.5" /> Class Gate
          </div>
          <div className="mt-1 text-[18px] font-semibold" style={{ fontFamily: SERIF }} data-testid="checkin-title">
            {session?.title_en || (phase === "login" ? "Sign in to join class" : "Join your class")}
          </div>
          {session?.title_kh ? (
            <div className="text-[12.5px] opacity-70 font-khmer">{session.title_kh}</div>
          ) : null}

          {/* gate progress */}
          <div className="mt-4 flex items-center gap-2">
            {steps.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full transition-colors"
                    style={{ background: s.warn ? "#E8A030" : s.active ? "#C2992E" : "rgba(255,255,255,0.25)" }}
                    data-testid={`gate-step-${s.key}${s.active ? "-active" : ""}${s.warn ? "-warn" : ""}`} />
                  <span className="text-[10.5px]" style={{ color: s.warn ? "#F1C97A" : s.active ? "#F1E2B4" : "#8C97B0" }}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <span className="h-[1.5px] flex-1" style={{ background: "rgba(255,255,255,0.18)" }} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-6">
          <AnimatePresence mode="wait">

            {/* ── loading ────────────────────────────────────────────────── */}
            {phase === "loading" && (
              <motion.div key="loading" {...fade} className="flex items-center gap-2 text-sm" style={{ color: "#6B6552" }} data-testid="checkin-loading">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </motion.div>
            )}

            {/* ── inline login (replaces full-page redirect) ─────────────── */}
            {phase === "login" && (
              <motion.div key="login" {...fade} className="space-y-4" data-testid="checkin-login">
                <div className="flex items-start gap-3 rounded-2xl px-4 py-3.5" style={{ background: IVORY, border: "1px solid #E8DEC9" }}>
                  <Lock className="h-5 w-5 mt-0.5 shrink-0" style={{ color: "#2F7D5B" }} strokeWidth={1.9} />
                  <p className="text-[13px] leading-relaxed" style={{ color: "#5A5345" }}>
                    Sign in with your EduHub Student ID to stamp your attendance and join class.
                  </p>
                </div>

                <form onSubmit={doLogin} className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-semibold mb-1" style={{ color: "#6B6552" }}>
                      Student ID
                    </label>
                    <input
                      type="text"
                      value={loginId}
                      onChange={(e) => setLoginId(e.target.value)}
                      placeholder="e.g. stu001"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      data-testid="checkin-login-id"
                      className="w-full rounded-xl px-4 py-3 text-[13.5px] outline-none"
                      style={{ background: IVORY, border: "1.5px solid #D8CAAF", color: INK }}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold mb-1" style={{ color: "#6B6552" }}>
                      Password
                    </label>
                    <input
                      type="password"
                      value={loginPw}
                      onChange={(e) => setLoginPw(e.target.value)}
                      placeholder="••••••••"
                      data-testid="checkin-login-pw"
                      className="w-full rounded-xl px-4 py-3 text-[13.5px] outline-none"
                      style={{ background: IVORY, border: "1.5px solid #D8CAAF", color: INK }}
                    />
                  </div>

                  {/* Turnstile — renders nothing when REACT_APP_TURNSTILE_SITE_KEY is unset */}
                  <TurnstileWidget
                    ref={turnstileRef}
                    theme="light"
                    onToken={() => setTsReady(true)}
                    onError={() => setTsReady(false)}
                  />

                  {loginErr && (
                    <div className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px]"
                         style={{ background: AMBER_BG, border: `1px solid ${AMBER_BORDER}`, color: AMBER_TEXT }}>
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      {loginErr}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loggingIn || !loginId.trim() || !loginPw.trim()}
                    data-testid="checkin-login-btn"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3.5 text-[13.5px] font-semibold transition-transform active:scale-[0.98] disabled:opacity-50"
                    style={{ background: INK, color: IVORY }}
                  >
                    {loggingIn
                      ? <><Loader2 className="h-4 w-4 animate-spin" /> Signing in…</>
                      : <>Sign in &amp; check in <ArrowRight className="h-4 w-4" /></>
                    }
                  </button>
                </form>
              </motion.div>
            )}

            {/* ── ready ──────────────────────────────────────────────────── */}
            {phase === "ready" && (
              <motion.div key="ready" {...fade} className="space-y-4">
                <div className="flex items-start gap-3 rounded-2xl px-4 py-3.5" style={{ background: IVORY, border: "1px solid #E8DEC9" }}>
                  <MapPin className="h-5 w-5 mt-0.5" style={{ color: "#2F7D5B" }} strokeWidth={1.9} />
                  <p className="text-[13px] leading-relaxed" style={{ color: "#5A5345" }}>
                    Stamp your passport to record today's attendance, then you'll head straight
                    into the Google Meet.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => doCheckin(null)}
                  data-testid="checkin-join-btn"
                  className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3.5 text-[13.5px] font-semibold transition-transform active:scale-[0.98]"
                  style={{ background: INK, color: IVORY }}
                >
                  Check in &amp; join class <ArrowRight className="h-4 w-4" />
                </button>
                {session?.shared_device_prompt_enabled && (
                  <button
                    type="button"
                    onClick={() => setPhase("picker")}
                    data-testid="checkin-not-you-btn"
                    className="w-full text-center text-[12.5px] underline underline-offset-4"
                    style={{ color: "#9A7A20" }}
                  >
                    Not you? Choose a different student
                  </button>
                )}
              </motion.div>
            )}

            {/* ── roster picker (shared device) ──────────────────────────── */}
            {phase === "picker" && (
              <motion.div key="picker" {...fade} className="space-y-3" data-testid="checkin-picker">
                <div className="flex items-center gap-2 text-[13px]" style={{ color: "#5A5345" }}>
                  <Users className="h-4 w-4" /> Who is joining on this device?
                </div>
                <div className="max-h-64 overflow-auto space-y-1.5">
                  {(session?.roster || []).map((r) => (
                    <button
                      key={r.student_id}
                      type="button"
                      onClick={() => doCheckin(r.student_id)}
                      data-testid={`checkin-roster-${r.student_id}`}
                      className="w-full text-left rounded-xl px-3 py-2.5 text-[13px] transition-colors hover:bg-[#F1E7D2]"
                      style={{ border: "1px solid #E8DEC9", background: IVORY, color: INK }}
                    >
                      {r.display_name}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ── checking ───────────────────────────────────────────────── */}
            {phase === "checking" && (
              <motion.div key="checking" {...fade} className="flex flex-col items-center gap-3 py-4" data-testid="checkin-checking">
                <Loader2 className="h-7 w-7 animate-spin" style={{ color: "#C2992E" }} />
                <span className="text-sm" style={{ color: "#5A5345" }}>Verifying your check-in…</span>
              </motion.div>
            )}

            {/* ── joined ─────────────────────────────────────────────────── */}
            {phase === "joined" && (
              <motion.div key="joined" {...fade} className="space-y-4" data-testid="checkin-joined">
                {tracked ? (
                  /* ✅ Stamp saved — real success */
                  <div className="flex flex-col items-center">
                    <motion.div
                      initial={{ scale: 0.6, rotate: -8, opacity: 0 }}
                      animate={{ scale: 1, rotate: 0, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 220, damping: 14 }}
                    >
                      <Stamp status="present_full" size={108} />
                    </motion.div>
                    <div className="flex items-center gap-2 text-[14px] font-semibold -mt-1" style={{ color: "#2F7D5B" }}>
                      <CheckCircle2 className="h-5 w-5" /> Stamped — you're checked in.
                    </div>
                  </div>
                ) : (
                  /* ⚠️ Stamp NOT saved — show honest warning */
                  <div className="space-y-3" data-testid="checkin-untracked-warning">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-16 h-16 rounded-full flex items-center justify-center"
                           style={{ background: AMBER_BG, border: `2px solid ${AMBER_BORDER}` }}>
                        <AlertTriangle className="h-8 w-8" style={{ color: AMBER_TEXT }} />
                      </div>
                      <p className="text-[14px] font-semibold text-center" style={{ color: AMBER_TEXT }}>
                        Attendance not recorded
                      </p>
                    </div>
                    <div className="rounded-2xl px-4 py-3.5 text-[12.5px] leading-relaxed text-center"
                         style={{ background: AMBER_BG, border: `1px solid ${AMBER_BORDER}`, color: AMBER_TEXT }}>
                      {sessionIsOpen
                        ? "Your stamp could not be saved — you may not be on the class roster."
                        : "Your stamp could not be saved — the check-in window is closed. Your teacher may need to open the session."}
                      <strong className="block mt-1">Please let your teacher know.</strong>
                    </div>
                  </div>
                )}

                {/* Always show Meet button — never block class access */}
                {meetUrl && (
                  <button
                    type="button"
                    onClick={() => gotoMeet(meetUrl)}
                    data-testid="checkin-open-meet-btn"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3.5 text-[13.5px] font-semibold"
                    style={{ background: INK, color: IVORY }}
                  >
                    Open Google Meet <ArrowRight className="h-4 w-4" />
                  </button>
                )}
              </motion.div>
            )}

            {/* ── error ──────────────────────────────────────────────────── */}
            {phase === "error" && (
              <motion.div key="error" {...fade} className="space-y-3" data-testid="checkin-error">
                <div className="flex items-start gap-2 rounded-2xl px-4 py-3 text-[13.5px]"
                  style={{ background: "#F7ECD6", border: "1px solid #E6D2A6", color: "#8A6A18" }}>
                  <AlertTriangle className="h-5 w-5 mt-0.5" /> {error || "Something went wrong."}
                </div>
                <button
                  type="button"
                  onClick={() => doCheckin(null)}
                  data-testid="checkin-retry-btn"
                  className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3.5 text-[13.5px] font-semibold"
                  style={{ background: INK, color: IVORY }}
                >
                  Try again
                </button>
                {meetUrl && (
                  <button
                    type="button"
                    onClick={() => gotoMeet(meetUrl)}
                    data-testid="checkin-join-anyway-btn"
                    className="w-full text-center text-[12.5px] underline underline-offset-4"
                    style={{ color: "#9A7A20" }}
                  >
                    Join class anyway
                  </button>
                )}
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
