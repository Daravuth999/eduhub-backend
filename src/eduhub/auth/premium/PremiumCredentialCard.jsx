// PremiumCredentialCard.jsx — the actual student sign-in form rendered
// inside the white DY auth shell. This component is intentionally
// "controlled" by the parent LoginPage so it can wire straight into the
// existing AuthContext (loginStudent / login) without changing any
// auth/payload logic or storage behavior.
//
// All native behaviors preserved:
//   • Student ID + Password fields (existing payload shape)
//   • Optional "Keep me signed in" toggle (parent decides whether to mount)
//   • Hint button (parent provides handler)
//   • Show/hide password toggle
//   • Inline error text (no scary red blocks)
//   • Disabled inputs + button while submitting
//   • TurnstileWidget passthrough slot
//
// No new dependencies. Framer Motion already in package.json.
import { motion } from "framer-motion";
import { Eye, EyeOff, HelpCircle, Loader2, ArrowRight } from "lucide-react";
import DYLogo from "./DYLogo";
import "./premium-auth.css";

/**
 * Props (all optional unless noted):
 *
 *   title:            string         e.g. "Sign in to EduHub"
 *   subtitle:         string         e.g. "Your smart English learning ecosystem"
 *
 *   idLabel:          string         label for the identifier input
 *   idValue:          string         REQUIRED — controlled value
 *   onIdChange:       (v) => void    REQUIRED — change handler
 *   idPlaceholder:    string         placeholder text
 *   idAutoComplete:   string         autocomplete attr (default "username")
 *
 *   passwordLabel:    string
 *   passwordValue:    string         REQUIRED
 *   onPasswordChange: (v) => void    REQUIRED
 *   passwordPlaceholder: string
 *
 *   showPassword:     boolean        controlled show/hide state
 *   onTogglePassword: () => void
 *
 *   onSubmit:         (e) => void    REQUIRED
 *   submitLabel:      string         e.g. "Sign In"
 *   submittingLabel:  string         e.g. "Signing in…"
 *   submitting:       boolean        controls disabled / spinner
 *   submitDisabled:   boolean        extra disabled gate (e.g. Turnstile not ready)
 *
 *   error:            string|null    inline error text (null hides)
 *
 *   onHint:           () => void     optional — adds the Hint pill
 *   hintLoading:      boolean
 *   hintMessage:      string|null
 *   hintLabel:        string         default "Hint"
 *
 *   keepSignedIn:     boolean|null   if NOT null, render the toggle
 *   onKeepSignedInChange: (b) => void
 *   keepSignedInLabel: string        default "Keep me signed in"
 *
 *   turnstileSlot:    ReactNode      optional — renders centered above button
 *
 *   supportSlot:      ReactNode      optional — renders below the button
 *
 *   testID:           string         data-testid root (default "premium-credential-card")
 */
export default function PremiumCredentialCard(props) {
  const {
    title = "Sign in to EduHub",
    subtitle = "Your smart English learning ecosystem",
    idLabel = "Student ID",
    idValue,
    onIdChange,
    idPlaceholder = "e.g. stu001",
    idAutoComplete = "username",
    passwordLabel = "Password",
    passwordValue,
    onPasswordChange,
    passwordPlaceholder = "Enter your password",
    showPassword = false,
    onTogglePassword,
    onSubmit,
    submitLabel = "Sign In",
    submittingLabel = "Signing in…",
    submitting = false,
    submitDisabled = false,
    error = null,
    onHint,
    hintLoading = false,
    hintMessage = null,
    hintLabel = "Hint",
    keepSignedIn = null,
    onKeepSignedInChange,
    keepSignedInLabel = "Keep me signed in",
    turnstileSlot = null,
    supportSlot = null,
    testID = "premium-credential-card",
  } = props;

  const disabled = submitting;

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      data-testid={testID}
      className="w-full"
      style={{ color: "#0B1B36" }}
    >
      {/* Brand mark + title block */}
      <div className="flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{
            opacity: 1,
            scale: 1,
          }}
          transition={{
            opacity: { duration: 0.5, ease: "easeOut" },
            scale: { type: "spring", stiffness: 200, damping: 18 },
          }}
        >
          <motion.div
            animate={{ opacity: [0.92, 1, 0.92] }}
            transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
            style={{ display: "inline-block" }}
          >
            <DYLogo size={84} testID={`${testID}-brand`} />
          </motion.div>
        </motion.div>

        <p
          className="mt-3 text-[11px] font-semibold tracking-[0.22em] uppercase"
          style={{ color: "#9CA3AF" }}
        >
          DY · EduHub
        </p>

        <h1
          className="mt-2 font-display text-[26px] sm:text-[28px] font-semibold"
          style={{ color: "#0B1B36", letterSpacing: "-0.01em" }}
          data-testid={`${testID}-title`}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className="mt-1.5 text-[14px]"
            style={{ color: "#6B7280" }}
            data-testid={`${testID}-subtitle`}
          >
            {subtitle}
          </p>
        )}
      </div>

      {/* Credential card */}
      <form
        onSubmit={onSubmit}
        className="mt-7 mx-auto w-full rounded-[22px] border bg-white"
        style={{
          maxWidth: 384,
          borderColor: "#EDEFF2",
          boxShadow:
            "0 1px 2px rgba(11,27,54,0.04), 0 12px 32px -20px rgba(11,27,54,0.18)",
          padding: "22px 20px 20px",
        }}
        data-testid={`${testID}-form`}
        noValidate
      >
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          {/* Student ID / Email field */}
          <label
            htmlFor={`${testID}-id-input`}
            className="block text-[12.5px] font-semibold"
            style={{ color: "#0B1B36" }}
          >
            {idLabel}
          </label>
          <div className="relative mt-1.5">
            <input
              id={`${testID}-id-input`}
              type="text"
              value={idValue}
              onChange={(e) => onIdChange(e.target.value)}
              placeholder={idPlaceholder}
              autoComplete={idAutoComplete}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              className="dy-input"
              data-testid={`${testID}-id`}
            />
          </div>

          {/* Password field */}
          <div className="mt-4 flex items-center justify-between">
            <label
              htmlFor={`${testID}-pw-input`}
              className="block text-[12.5px] font-semibold"
              style={{ color: "#0B1B36" }}
            >
              {passwordLabel}
            </label>
            {typeof onHint === "function" && (
              <button
                type="button"
                onClick={onHint}
                disabled={hintLoading || disabled}
                data-testid={`${testID}-hint-btn`}
                className="inline-flex items-center gap-1 text-[12px] font-semibold"
                style={{
                  color: "#1A56DB",
                  background: "transparent",
                  border: 0,
                  padding: "2px 4px",
                  borderRadius: 6,
                }}
              >
                {hintLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <HelpCircle className="h-3.5 w-3.5" />
                )}
                {hintLabel}
              </button>
            )}
          </div>
          <div className="relative mt-1.5">
            <input
              id={`${testID}-pw-input`}
              type={showPassword ? "text" : "password"}
              value={passwordValue}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder={passwordPlaceholder}
              autoComplete="current-password"
              className="dy-input"
              style={{ paddingRight: 44 }}
              data-testid={`${testID}-password`}
            />
            {typeof onTogglePassword === "function" && (
              <button
                type="button"
                onClick={onTogglePassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="dy-input-affix"
                style={{ right: 4, top: 4, bottom: 4 }}
                data-testid={`${testID}-toggle-password`}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            )}
          </div>

          {/* Keep me signed in (optional) */}
          {keepSignedIn !== null && (
            <label
              className="mt-4 inline-flex items-center gap-2 cursor-pointer select-none text-[13px]"
              style={{ color: "#4B5563" }}
              data-testid={`${testID}-keep-signed-in-label`}
            >
              <input
                type="checkbox"
                checked={!!keepSignedIn}
                onChange={(e) => onKeepSignedInChange?.(e.target.checked)}
                data-testid={`${testID}-keep-signed-in`}
                style={{
                  width: 16,
                  height: 16,
                  accentColor: "#0B1B36",
                  margin: 0,
                }}
              />
              {keepSignedInLabel}
            </label>
          )}

          {/* Hint message (success-ish, calm) */}
          {hintMessage && (
            <motion.p
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="mt-3 text-[13px]"
              style={{ color: "#0B1B36" }}
              data-testid={`${testID}-hint-message`}
            >
              <span style={{ fontWeight: 600 }}>{hintLabel}: </span>
              {hintMessage}
            </motion.p>
          )}

          {/* Inline error text */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="dy-error-text mt-3"
              role="alert"
              data-testid={`${testID}-error`}
            >
              <span className="dy-error-dot" />
              <span>{error}</span>
            </motion.div>
          )}

          {/* Optional Turnstile / extra slot */}
          {turnstileSlot && (
            <div
              className="mt-4 flex justify-center"
              data-testid={`${testID}-turnstile-slot`}
            >
              {turnstileSlot}
            </div>
          )}

          {/* Submit */}
          <motion.button
            type="submit"
            disabled={disabled || submitDisabled}
            whileTap={disabled ? {} : { scale: 0.985 }}
            className="dy-primary-btn mt-5"
            data-testid={`${testID}-submit`}
          >
            <span className="dy-btn-shine" aria-hidden />
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{submittingLabel}</span>
              </>
            ) : (
              <>
                <span>{submitLabel}</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </motion.button>

          {/* Support slot under the button */}
          {supportSlot && (
            <div
              className="mt-4 text-center text-[12.5px]"
              style={{ color: "#6B7280" }}
              data-testid={`${testID}-support`}
            >
              {supportSlot}
            </div>
          )}
        </fieldset>
      </form>
    </motion.section>
  );
}
