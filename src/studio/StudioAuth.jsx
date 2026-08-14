/**
 * StudioAuth.jsx — provider + route gate for the Author Studio.
 *
 * Uses Emergent-managed Google OAuth: the login button redirects to
 * `https://auth.emergentagent.com/?redirect=<current origin>/studio`, then
 * we process the returned `#session_id=...` fragment exactly once, POST it
 * to `/api/auth/google`, and let the backend set an httpOnly cookie.
 *
 * REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS,
 * THIS BREAKS THE AUTH.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { exchangeSession, getMe, logout as logoutApi, setToken } from "./api";

const Ctx = createContext(null);

/* 2026-05 surgical fix · iOS auth-loop root cause
 * ----------------------------------------------------------------
 * Before this fix, useStudioCallback's `ranRef` was a plain boolean
 * that flipped to `true` after the first successful exchange and was
 * never reset. The intent was to stop React-effect double-fires and
 * bfcache `pageshow` from consuming the (single-use) session_id twice.
 *
 * That worked for the first login. But on iPhone Safari / Chrome iOS,
 * when the user signs OUT and taps "Continue with Google" AGAIN, iOS
 * stores the `/studio` document in the back-forward cache during the
 * navigation to auth.emergentagent.com. On return, the document is
 * RESTORED from bfcache — same JS heap, same React tree, same
 * `ranRef.current === true`. The `pageshow` handler fires with
 * `persisted === true`, runs `processCallbackIfPresent()`, sees
 * `ranRef.current` truthy and bails — even though the URL hash now
 * carries a brand-new, never-exchanged session_id.
 *
 * Net effect on device: every re-login after the first one silently
 * skips the exchange, the localStorage Bearer token is never written,
 * `/api/auth/me` returns 401, and the user is stranded on the login
 * screen. From the user's POV that looks identical to an auth "loop".
 *
 * Surgical fix: track the set of session_ids we've already POSTed
 * rather than a single yes/no flag. A new session_id arriving via
 * bfcache (or fresh load) is processed exactly once; a duplicate
 * (StrictMode double-mount, effect double-fire, pageshow with the
 * SAME session_id) is short-circuited.
 *
 * Storage choice:
 *   • Module-level `Set` — survives the component unmount/remount that
 *     React StrictMode triggers in dev, and survives bfcache restore
 *     because the JS module heap is preserved.
 *   • A `ranRef` of type `string | null` — intra-mount fast path so
 *     the within-effect callback double-call (initial `useEffect` body
 *     + immediate `pageshow` event with persisted=false on some
 *     WebKit builds) doesn't make two network calls.
 *
 * Scope of change: confined to `useStudioCallback`. Nothing else in
 * StudioAuthProvider / useStudioAuth / signIn / signOut / the rest of
 * the app changes behaviour. On desktop Chrome (where bfcache is more
 * conservative) and on Android Chrome the new guards short-circuit on
 * the duplicate call exactly like the old boolean did. */
const PROCESSED_SESSION_IDS = new Set();

export function StudioAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // CRITICAL: If returning from OAuth callback, skip the /me check.
    // StudioCallback will exchange the session_id and establish the session first.
    if (typeof window !== "undefined" &&
        window.location.hash?.includes("session_id=")) {
      setLoading(false);
      return;
    }
    refresh();
  }, [refresh]);

  const signIn = useCallback(() => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + "/studio";
    window.location.href =
      `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  }, []);

  const signOut = useCallback(async () => {
    try { await logoutApi(); } catch { /* ignore */ }
    setToken("");            // v8.1 — drop the localStorage fallback token too
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, refresh, signIn, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useStudioAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStudioAuth must be used inside StudioAuthProvider");
  return ctx;
}

/**
 * StudioCallback — synchronous exchange of the URL fragment session_id.
 * Lives on the /studio route itself. Once the exchange succeeds we
 * replace the URL (strip the hash) and hand control back to the router.
 */
export function useStudioCallback() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useStudioAuth();
  // 2026-05 — ranRef now stores the LAST session_id this hook has begun
  // to exchange in the current mount (string), or null if none yet.
  // Combined with PROCESSED_SESSION_IDS this distinguishes:
  //   • duplicate fire with the SAME session_id  → skip (loop guard)
  //   • bfcache restore with a NEW session_id    → proceed (iOS fix)
  const ranRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | processing | done | error

  useEffect(() => {
    let cancelled = false;

    // Extracted so it can run on BOTH initial mount AND on a `pageshow`
    // event with event.persisted === true (iOS WebKit bfcache restore).
    //
    // iOS Safari / Chrome iOS bfcache root cause (Issue 1):
    //   When the user taps "Continue with Google", window.location.href
    //   navigates away. WebKit aggressively stores the /studio document
    //   in the back-forward cache. When the OAuth provider redirects back
    //   to /studio#session_id=…, iOS RESTORES the document from bfcache
    //   rather than executing a fresh load.
    //
    //   Bfcache restoration does NOT re-run useEffect, so the callback
    //   never fires, the hash sits stranded, and the UI stays on the
    //   "Continue with Google" screen — producing the repeating sign-in
    //   loop. Desktop Chrome bfcache rules differ, which is why the
    //   laptop flow works fine.
    //
    //   pageshow with event.persisted === true is the W3C-defined hook
    //   for detecting a bfcache restore. Re-running processCallbackIfPresent
    //   here exchanges the just-arrived session_id and shows the dashboard.
    //
    //   The session_id-aware guard below (PROCESSED_SESSION_IDS + ranRef)
    //   replaces the previous boolean ranRef so that a NEW session_id
    //   arriving via bfcache after logout+re-sign-in is allowed to
    //   proceed exactly once. Same-id duplicates are still short-
    //   circuited.
    function processCallbackIfPresent() {
      if (cancelled) return;
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      if (!hash || !hash.includes("session_id=")) return;
      const params = new URLSearchParams(hash.replace(/^#/, ""));
      const sessionId = params.get("session_id");
      if (!sessionId) {
        setStatus("error");
        return;
      }
      // 1. Cross-mount / bfcache guard: same module heap, same Set.
      if (PROCESSED_SESSION_IDS.has(sessionId)) return;
      // 2. Intra-mount fast path: the very same session_id reached us
      //    twice in this component instance (e.g. initial useEffect body
      //    + an immediate pageshow with persisted=false on some WebKit
      //    builds). Skip the duplicate to keep the POST single-use.
      if (ranRef.current === sessionId) return;
      ranRef.current = sessionId;
      PROCESSED_SESSION_IDS.add(sessionId);
      setStatus("processing");
      exchangeSession(sessionId)
        .then(async (resp) => {
          if (cancelled) return;
          // v8.1 — Cache the session token so the next request from
          // iPhone Safari (where the 3rd-party cookie is blocked by ITP)
          // can authenticate via Authorization: Bearer instead.
          if (resp && resp.session_token) setToken(resp.session_token);
          await refresh();
          if (cancelled) return;
          setStatus("done");
          // Strip the hash so refreshes don't double-process
          navigate(location.pathname, { replace: true });
        })
        .catch(() => { if (!cancelled) setStatus("error"); });
    }

    // 1) Normal path: fresh page load with #session_id= in the URL.
    processCallbackIfPresent();

    // 2) iOS bfcache path: page restored from cache, effects don't re-run.
    function onPageShow(e) {
      if (e && e.persisted) processCallbackIfPresent();
    }
    window.addEventListener("pageshow", onPageShow);

    return () => {
      cancelled = true;
      window.removeEventListener("pageshow", onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return status;
}
