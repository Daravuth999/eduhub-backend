/**
 * TurnstileWidget — v11.0 (Feb 2026)
 *
 * Centralized, route-safe Cloudflare Turnstile widget for the EduHub PWA.
 * Replaces every per-page useEffect-based loader that was silently breaking
 * after SPA navigation between login gates (My Portal / Lucky Spin / AI
 * Assistant / System Test / Classroom Library all funnel through /login).
 *
 * Why a single component?
 *   • The previous design appended a <script> tag inside each login screen's
 *     useEffect and removed it on unmount. Cloudflare's loader sets a global
 *     window.turnstile object on first init that PERSISTS after the script
 *     tag is removed. When the user navigated /login → /library (success)
 *     → /login (next attempt), the cleanup removed the <script>, the new
 *     LoginPage mount re-injected it, but window.turnstile was already in
 *     memory so no fresh auto-init ran. The new `.cf-turnstile` div was
 *     orphaned, and getResponse() failed with "Could not find widget."
 *
 * Why explicit render?
 *   • Cloudflare's implicit auto-render scans the DOM ONCE on script load.
 *     SPA pages mount AFTER that scan. We use ?render=explicit and call
 *     turnstile.render() ourselves, tied to React lifecycle. The script
 *     is loaded ONCE at app boot (see public/index.html) and stays loaded
 *     for the life of the PWA — including PWA install mode and offline
 *     navigation in cached shell.
 *
 * API:
 *   <TurnstileWidget ref={turnstileRef} theme="dark" onToken={fn} />
 *   turnstileRef.current.getToken()   → string ("" if widget not ready)
 *   turnstileRef.current.reset()      → re-render the challenge
 *   turnstileRef.current.isReady()    → boolean
 *
 * The widget renders nothing when REACT_APP_TURNSTILE_SITE_KEY is unset,
 * keeping it safe to drop into local dev / preview environments.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

// Poll interval while waiting for window.turnstile to become available.
// Cloudflare's bootstrap is < 500 ms on Wi-Fi; we cap retries to keep mobile
// 3G from spinning forever.
const POLL_MS = 100;
const POLL_MAX_MS = 15000;

const TurnstileWidget = forwardRef(function TurnstileWidget(
  { theme = "auto", size = "flexible", action, cdata, onToken, onError, className = "" },
  ref,
) {
  const mountRef = useRef(null);
  const widgetIdRef = useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const siteKey = process.env.REACT_APP_TURNSTILE_SITE_KEY;

  useImperativeHandle(
    ref,
    () => ({
      getToken: () => {
        if (!widgetIdRef.current || !window.turnstile) return "";
        try {
          return window.turnstile.getResponse(widgetIdRef.current) || "";
        } catch {
          return "";
        }
      },
      reset: () => {
        if (!widgetIdRef.current || !window.turnstile) return;
        try {
          window.turnstile.reset(widgetIdRef.current);
        } catch {
          /* ignore */
        }
      },
      isReady: () => ready,
    }),
    [ready],
  );

  useEffect(() => {
    if (!siteKey) return undefined;
    let cancelled = false;
    let pollHandle = 0;
    const deadline = Date.now() + POLL_MAX_MS;

    function tryRender() {
      if (cancelled) return true;
      if (!window.turnstile || !mountRef.current) return false;
      // Avoid double-render if React strict-mode fires the effect twice.
      if (widgetIdRef.current) return true;
      try {
        widgetIdRef.current = window.turnstile.render(mountRef.current, {
          sitekey: siteKey,
          theme,
          size,
          ...(action ? { action } : {}),
          ...(cdata ? { cData: cdata } : {}),
          callback: (token) => {
            if (!cancelled && typeof onToken === "function") onToken(token);
          },
          "error-callback": (code) => {
            if (cancelled) return;
            const msg = `Turnstile error: ${code}`;
            setError(msg);
            if (typeof onError === "function") onError(msg);
          },
          "expired-callback": () => {
            if (!cancelled && typeof onToken === "function") onToken("");
          },
        });
        setReady(true);
        return true;
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
        return false;
      }
    }

    if (!tryRender()) {
      pollHandle = window.setInterval(() => {
        if (tryRender() || Date.now() > deadline) {
          window.clearInterval(pollHandle);
          if (!widgetIdRef.current && !cancelled) {
            setError("Turnstile script did not load within 15s — check CSP / network.");
          }
        }
      }, POLL_MS);
    }

    return () => {
      cancelled = true;
      if (pollHandle) window.clearInterval(pollHandle);
      if (widgetIdRef.current && window.turnstile && window.turnstile.remove) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* ignore */
        }
        widgetIdRef.current = null;
      }
    };
    // siteKey / theme / size are effectively static for the life of a mount;
    // changing them remounts the component, which re-runs the effect cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, theme, size]);

  if (!siteKey) return null;

  return (
    <div className={className} data-testid="turnstile-wrapper">
      <div ref={mountRef} data-testid="turnstile-mount" />
      {error && (
        <div
          className="mt-1 text-xs text-rose-400 text-center"
          data-testid="turnstile-error"
        >
          {error}
        </div>
      )}
    </div>
  );
});

export default TurnstileWidget;
