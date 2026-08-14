// LoginPage.jsx — unified auth UI for every /login redirect (My Portal,
//   Lucky Spin, AI Assistant, System Test, Classroom Library).
//
// v11.0 (Feb 2026) — Turnstile widget extracted into the centralized
//   <TurnstileWidget /> component in src/eduhub/auth/. The previous
//   inline useEffect-based script loader was racing with SPA navigation:
//   after a successful Library login + logout cycle, the Cloudflare
//   script was already cached by window.turnstile but the new mount's
//   .cf-turnstile div was never picked up by Cloudflare's one-shot
//   auto-init, so turnstile.getResponse() returned "Could not find
//   widget." The new component uses explicit render() / remove() tied
//   to React lifecycle and works reliably across every login entry
//   point — including PWA standalone mode and iPhone Safari.
//
// v10.0.1 (Feb 2026) — Token now flows to loginStudent(id, pw, token)
//   via AuthContext so the Render backend can verify it. The legacy
//   window.__lastTurnstileToken__ stash is removed.
import { useState, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  GraduationCap,
  Lock,
  User,
  Eye,
  EyeOff,
  ArrowRight,
  ArrowLeft,
  Loader2,
  HelpCircle,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../pages/portal/contexts/LanguageContext";
import { api as portalApi } from "../pages/portal/lib/api";
import TurnstileWidget from "../auth/TurnstileWidget";

export default function LoginPage() {
  const { login, loginStudent } = useAuth();
  const { t, lang, toggle: toggleLang } = useLang();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // v11.5 fix: default redirect is "/" (Dashboard) instead of "/portal/me" so that
  // PushOptInPrompt (mounted in Dashboard) and BellRingNagCard (visible on "/") both
  // fire immediately after login. Deep-link redirects (e.g. ?redirect=/portal/me)
  // still honour the explicit parameter as before.
  const redirect = params.get("redirect") || "/";

  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState(null);
  const [hintLoading, setHintLoading] = useState(false);

  // v11.0 — Centralized Turnstile widget ref.
  const turnstileRef = useRef(null);
  const [turnstileReady, setTurnstileReady] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tsToken = turnstileRef.current ? turnstileRef.current.getToken() : "";
      // Prefer the v10.0.1 Render-backed login when available; fall back to
      // the legacy GAS-backed login() for any code path that has not yet
      // been migrated. Both signatures coexist inside AuthContext.
      if (typeof loginStudent === "function") {
        const result = await loginStudent(studentId, password, tsToken);
        if (result && result.error) {
          if (turnstileRef.current) turnstileRef.current.reset();
          setError(result.error);
          setLoading(false);
          return;
        }
      } else {
        await login(studentId, password);
      }
      navigate(redirect, { replace: true });
    } catch (err) {
      if (turnstileRef.current) turnstileRef.current.reset();
      setError((err && err.message) || t("loginGenericError"));
    } finally {
      setLoading(false);
    }
  }

  async function getHint() {
    if (!studentId.trim()) {
      setError(t("enterIdFirst"));
      return;
    }
    setError(null);
    setHintLoading(true);
    try {
      const res = await portalApi.passwordHint(studentId.trim());
      setHint(res?.hint || res?.error || t("noHint"));
    } catch {
      setHint(t("hintFetchError"));
    } finally {
      setHintLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 py-8 overflow-hidden">
      {/* Aurora backdrop — uses EduHub's existing orb classes */}
      <div className="absolute inset-0 -z-10" aria-hidden>
        <div className="orb orb-violet" />
        <div className="orb orb-cyan" />
        <div className="orb orb-magenta" />
        <div className="aurora-wave" />
        <div className="bg-grid" />
      </div>

      {/* Top bar with back link + lang toggle */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between z-10">
        <motion.div whileHover={{ x: -3 }} whileTap={{ scale: 0.96 }} transition={{ type: "spring", stiffness: 320, damping: 22 }}>
          <Link
            to="/"
            data-testid="login-back-home"
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] backdrop-blur-md px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/10 hover:border-aurora-cyan/40 hover:text-white transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Dashboard
          </Link>
        </motion.div>
        <motion.button
          onClick={toggleLang}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.94 }}
          data-testid="login-lang-toggle"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] backdrop-blur-md px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-white/80 hover:bg-white/10 hover:border-aurora-magenta/40 hover:text-white transition-colors"
        >
          {lang === "en" ? "ខ្មែរ" : "EN"}
        </motion.button>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md relative"
      >
        <div className="rounded-3xl border border-aurora-violet/30 bg-white/[0.05] backdrop-blur-xl p-7 sm:p-9 shadow-[0_24px_80px_-24px_rgba(155,92,255,0.45)] border-conic">
          <motion.div
            initial={{ scale: 0.6, rotate: -10, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ delay: 0.15, type: "spring", damping: 14 }}
            className="mx-auto mb-5 h-16 w-16 rounded-2xl flex items-center justify-center text-white shadow-[0_8px_30px_rgba(155,92,255,0.55)]"
            style={{
              background: "linear-gradient(135deg, #00e0ff, #9b5cff, #ff3da6)",
            }}
          >
            <GraduationCap className="h-8 w-8" />
          </motion.div>

          <div className="text-center mb-6">
            <h1 className="font-display text-3xl font-bold text-iridescent">
              EduHub Portal
            </h1>
            <p className="text-sm text-white/70 mt-1.5">
              {t("signInLong") || t("signIn")}
            </p>
            <p className="font-khmer text-xs text-white/50 mt-1" lang="km">
              ចូលគណនីដើម្បីបើកមុខងារផ្ទាល់ខ្លួន
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">
                {t("studentId")}
              </label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 pointer-events-none" />
                <input
                  type="text"
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  placeholder="e.g., stu001"
                  autoComplete="username"
                  data-testid="login-student-id-input"
                  className="w-full pl-11 pr-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50 focus:border-aurora-cyan/50 font-mono"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wider text-white/70">
                  {t("password")}
                </label>
                <button
                  type="button"
                  onClick={getHint}
                  disabled={hintLoading}
                  data-testid="login-hint-btn"
                  className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-aurora-cyan hover:text-aurora-magenta transition"
                >
                  {hintLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <HelpCircle className="h-3 w-3" />
                  )}
                  {t("hint")}
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 pointer-events-none" />
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  data-testid="login-password-input"
                  className="w-full pl-11 pr-11 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-aurora-cyan/50 focus:border-aurora-cyan/50"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  data-testid="login-toggle-password-visibility"
                  className="absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {hint && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                data-testid="login-hint-message"
                className="rounded-xl px-3 py-2.5 text-sm border bg-aurora-lime/10 border-aurora-lime/30 text-aurora-lime"
              >
                <span className="font-semibold">{t("hint")}:</span> {hint}
              </motion.div>
            )}

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                data-testid="login-error"
                className="rounded-xl px-3 py-2.5 text-sm border bg-aurora-magenta/10 border-aurora-magenta/30 text-aurora-magenta"
              >
                {error}
              </motion.div>
            )}

            {/* v11.0 — Centralized Turnstile widget (script loaded globally
                from public/index.html with render=explicit). Renders nothing
                if REACT_APP_TURNSTILE_SITE_KEY is unset. */}
            <TurnstileWidget
              ref={turnstileRef}
              theme="dark"
              size="flexible"
              className="flex justify-center"
              onError={(msg) => setError(msg)}
              onToken={() => setTurnstileReady(true)}
            />

            <motion.button
              type="submit"
              disabled={loading || !turnstileReady}
              whileHover={loading ? {} : { y: -2, scale: 1.015 }}
              whileTap={{ scale: 0.97 }}
              data-testid="login-submit-btn"
              className="group relative w-full overflow-hidden rounded-xl py-3.5 font-bold text-white transition disabled:opacity-70 disabled:cursor-not-allowed"
              style={{
                background: "linear-gradient(135deg, #00e0ff, #9b5cff, #ff3da6)",
                backgroundSize: "200% 200%",
                boxShadow:
                  "0 10px 30px -8px rgba(155,92,255,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset",
              }}
            >
              {/* Continuous gradient breathing — subtle, professional */}
              <motion.span
                aria-hidden
                className="absolute inset-0 rounded-xl pointer-events-none"
                style={{
                  background:
                    "linear-gradient(135deg, #00e0ff, #9b5cff, #ff3da6)",
                  backgroundSize: "220% 220%",
                }}
                animate={{
                  backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"],
                }}
                transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
              />

              {/* Soft pulsing halo around the button */}
              <motion.span
                aria-hidden
                className="absolute -inset-[2px] rounded-[14px] pointer-events-none"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(0,224,255,0.45), rgba(155,92,255,0.45), rgba(255,61,166,0.45))",
                  filter: "blur(12px)",
                  opacity: 0.55,
                }}
                animate={{ opacity: loading ? 0.6 : [0.35, 0.7, 0.35] }}
                transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              />

              {/* Hover-only shine sweep */}
              <span
                aria-hidden
                className="absolute inset-y-0 -left-1/3 w-1/3 pointer-events-none translate-x-[-120%] group-hover:translate-x-[420%] transition-transform duration-[1100ms] ease-out"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
                  filter: "blur(2px)",
                }}
              />

              {/* Inner highlight ring */}
              <span
                aria-hidden
                className="absolute inset-0 rounded-xl pointer-events-none"
                style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.18)" }}
              />

              <span className="relative z-10 flex items-center justify-center gap-2 text-[0.95rem] tracking-wide">
                {loading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t("signingIn")}
                  </>
                ) : (
                  <>
                    {t("signInBtn")}
                    <motion.span
                      aria-hidden
                      animate={{ x: [0, 4, 0] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                      className="inline-flex"
                    >
                      <ArrowRight className="h-5 w-5" />
                    </motion.span>
                  </>
                )}
              </span>
            </motion.button>
          </form>

          <p className="mt-6 text-center text-[11px] text-white/40">
            EduHub Unified Portal · Indigo Education
          </p>
        </div>
      </motion.div>
    </div>
  );
}
