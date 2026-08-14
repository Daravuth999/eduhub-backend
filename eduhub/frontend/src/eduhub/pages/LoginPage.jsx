// LoginPage.jsx — Student PWA sign-in screen.
//
// v12.0 (Feb 2026) — EduHub Premium DY Authentication Experience v1
// ------------------------------------------------------------------
// The visual shell has been reconstructed into a calm, white,
// official DY-branded premium login surface inspired by Apple's
// sign-in flow (NOT copied). Every interactive piece, payload,
// AuthContext call, redirect logic, Turnstile token plumbing and
// fallback GAS->Render chain is preserved BYTE-FOR-BYTE from v11.0.
//
// What changed:
//   • The aurora/glassmorphism canvas is replaced by <PremiumAuthShell>
//     (white background, soft accent halos, safe-area aware).
//   • The credential card is now <PremiumCredentialCard> with the
//     DY brand mark above the form, premium gray-200 inputs, and
//     polished inline error text instead of a red block.
//   • Submitting the form opens a full-screen <DYSigningOverlay>
//     with the DY orbit animation and rotating supportive status
//     copy. The overlay closes automatically on success/failure.
//   • Turnstile widget is unchanged; rendered via the same ref and
//     reset() / getToken() contract.
//
// What did NOT change:
//   • The Render-first loginStudent() call still runs with the same
//     (studentId, password, tsToken) signature, and the legacy GAS
//     fallback through `login(studentId, password)` is preserved.
//   • The redirect query parameter behavior is identical (default
//     "/portal/me" — matches v11.0 of this file).
//   • Error/hint copy strings still flow through the existing
//     LanguageContext `t(...)` keys.
//   • No new dependencies. framer-motion + lucide-react already in
//     package.json and used here exactly like before.
import { useState, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../pages/portal/contexts/LanguageContext";
import { api as portalApi } from "../pages/portal/lib/api";
import TurnstileWidget from "../auth/TurnstileWidget";
import { requestPasswordReset } from "../auth/studentAuthService";
import {
  PremiumAuthShell,
  PremiumCredentialCard,
  DYSigningOverlay,
} from "../auth/premium";

export default function LoginPage() {
  const { login, loginStudent } = useAuth();
  const { t, lang, toggle: toggleLang } = useLang();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirect = params.get("redirect") || "/portal/me";

  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState(null);
  const [hintLoading, setHintLoading] = useState(false);

  // Milestone 4 (teacher-assisted password reset) — additive, separate
  // from the existing GAS "hint" mechanism above (kept untouched).
  const [resetRequestSending, setResetRequestSending] = useState(false);
  const [resetRequestMessage, setResetRequestMessage] = useState(null);

  // v11.0 — Centralized Turnstile widget ref. Untouched in v12.0.
  const turnstileRef = useRef(null);
  const [turnstileReady, setTurnstileReady] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tsToken = turnstileRef.current ? turnstileRef.current.getToken() : "";
      // Prefer the v10.0.1 Render-backed login when available; fall back
      // to the legacy GAS-backed login() for any code path that has not
      // yet been migrated. Both signatures coexist inside AuthContext.
      if (typeof loginStudent === "function") {
        let renderOk = false;
        try {
          const result = await loginStudent(studentId, password, tsToken);
          if (result && result.error) {
            // Render responded but flagged an application-level error
            // (e.g. bot check). Do NOT fall through to legacy — show it.
            if (turnstileRef.current) turnstileRef.current.reset();
            setError(result.error);
            setLoading(false);
            return;
          }
          renderOk = true;
        } catch (renderErr) {
          // Render login failed (e.g. student has no bcrypt password
          // yet). Silently fall through to the legacy GAS-backed login
          // below so students registered before the Render backend can
          // still sign in.
          renderOk = false;
        }
        if (!renderOk) {
          // Legacy GAS fallback — verifies password against Google Sheet.
          await login(studentId, password);
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

  // Milestone 4 — teacher-assisted password reset request. Reuses the
  // same Turnstile token already obtained for the login form (no second
  // widget). Backend never reveals whether studentId is registered, so
  // the success message is identical regardless — shown from our own
  // bilingual copy rather than the backend's (English-only) message.
  async function handleForgotPassword() {
    if (!studentId.trim()) {
      setResetRequestMessage(t("enterIdForReset"));
      return;
    }
    setResetRequestMessage(null);
    setResetRequestSending(true);
    try {
      const tsToken = turnstileRef.current ? turnstileRef.current.getToken() : "";
      await requestPasswordReset(studentId.trim(), tsToken);
      setResetRequestMessage(t("forgotPasswordSent"));
    } catch {
      setResetRequestMessage(t("forgotPasswordGenericError"));
    } finally {
      setResetRequestSending(false);
    }
  }

  // Language toggle pill — sits in the shell's top-right slot.
  const langToggle = (
    <button
      type="button"
      onClick={toggleLang}
      data-testid="login-lang-toggle"
      className="text-[12px] font-semibold uppercase tracking-[0.16em]"
      style={{
        color: "#0B1B36",
        background: "transparent",
        border: "1px solid #E5E7EB",
        borderRadius: 999,
        padding: "6px 12px",
      }}
    >
      {lang === "en" ? "ខ្មែរ" : "EN"}
    </button>
  );

  // Telegram / "Need help?" support link under the form.
  const supportSlot = (
    <span>
      <span style={{ display: "block", marginBottom: 6 }}>
        {t("forgotPasswordPrompt")}{" "}
        <button
          type="button"
          onClick={handleForgotPassword}
          disabled={resetRequestSending || !turnstileReady}
          data-testid="login-forgot-password-btn"
          style={{
            color: "#1A56DB", fontWeight: 600, textDecoration: "underline",
            background: "none", border: "none", padding: 0, cursor: "pointer",
            font: "inherit",
          }}
        >
          {resetRequestSending ? t("forgotPasswordSending") : t("forgotPasswordLink")}
        </button>
      </span>
      {resetRequestMessage && (
        <span
          data-testid="login-forgot-password-message"
          style={{ display: "block", marginBottom: 6, color: "#6B7280" }}
        >
          {resetRequestMessage}
        </span>
      )}
      Need help?{" "}
      <a
        href="https://t.me/alita995"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="login-support-link"
        style={{ color: "#1A56DB", fontWeight: 600, textDecoration: "none" }}
      >
        Contact us on Telegram
      </a>
    </span>
  );

  // Bilingual footer under the shell content.
  const footer = (
    <>
      <p>EduHub by DY Learning · {new Date().getFullYear()}</p>
      <p className="font-khmer" lang="km" style={{ color: "#9CA3AF" }}>
        ប្រព័ន្ធអប់រំឆ្លាតវៃរបស់អ្នក
      </p>
    </>
  );

  return (
    <>
      <PremiumAuthShell
        backTo="/"
        backLabel="Back to Dashboard"
        rightSlot={langToggle}
        footer={footer}
        testID="login-shell"
      >
        <PremiumCredentialCard
          title="Sign in to EduHub"
          subtitle="Your smart English learning ecosystem"
          idLabel={t("studentId")}
          idValue={studentId}
          onIdChange={setStudentId}
          idPlaceholder="e.g. stu001"
          passwordLabel={t("password")}
          passwordValue={password}
          onPasswordChange={setPassword}
          passwordPlaceholder="••••••••"
          showPassword={showPw}
          onTogglePassword={() => setShowPw((v) => !v)}
          onSubmit={handleSubmit}
          submitLabel={t("signInBtn")}
          submittingLabel={t("signingIn")}
          submitting={loading}
          submitDisabled={!turnstileReady}
          error={error}
          onHint={getHint}
          hintLoading={hintLoading}
          hintMessage={hint}
          hintLabel={t("hint")}
          turnstileSlot={
            <TurnstileWidget
              ref={turnstileRef}
              theme="light"
              size="flexible"
              onError={(msg) => setError(msg)}
              onToken={() => setTurnstileReady(true)}
            />
          }
          supportSlot={supportSlot}
          testID="login-card"
        />
      </PremiumAuthShell>

      {/* Full-screen DY signing-in overlay — shown while the auth
          request is pending. Closes automatically on success/failure
          because `loading` flips back to false in the finally block. */}
      <DYSigningOverlay
        open={loading}
        title={t("signingIn") || "Signing in…"}
        statuses={[
          "Checking your learning profile…",
          "Loading your points wallet…",
          "Preparing EduTalk and AI Coach…",
          "Almost ready…",
        ]}
        testID="login-signing-overlay"
      />
    </>
  );
}
