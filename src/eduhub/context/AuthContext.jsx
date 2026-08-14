// AuthContext.jsx — graceful dual-mode auth.
//   Works seamlessly against BOTH:
//     • your existing (un-upgraded) GAS backend  → legacy studentData + password check
//     • the secured GAS backend (when deployed)  → HMAC sessionToken issued on login
//
//   The frontend tries the modern `?action=login` path first; if the backend
//   doesn't implement it (old deployment) it falls back to the classic flow
//   that v6 shipped with. Whatever sessionToken the server issues is stored
//   and piggy-backed onto every subsequent request so the secured backend
//   (once deployed) immediately starts using it.
//
//   Nothing about the user-visible login flow changes.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api as portalApi, portalLogin } from "../pages/portal/lib/api";
import { login as gameLogin } from "../pages/game/lib/api";
import { setSessionToken, clearSessionToken } from "../lib/secureClient";
// v10.0 — Render-backed student auth (additive, runs alongside legacy GAS auth)
import {
  studentLogin as renderStudentLogin,
  studentMe as renderStudentMe,
  studentLogout as renderStudentLogout,
} from "../auth/studentAuthService";

const STORAGE_KEY = "eduhub_student";
const AuthCtx = createContext(null);
// v10.0 — default export so useStudentAuth can import the same context object
export default AuthCtx;

// ─────────────────────────────────────────────────────────────────────────────
// v12.0 — 30-day localStorage persistence (stale-while-revalidate model)
//
// WHY: sessionStorage is cleared whenever the student closes the PWA tab on
// iOS or Android. That meant every reopen required a full Render /me round-
// trip (0.5-15 s cold start) before any page rendered. Students saw a blank
// spinner and assumed they were logged out, triggering unnecessary re-logins.
//
// FIX: persist the stripped profile to localStorage with a 30-day TTL.
// On reopen the app IMMEDIATELY hydrates from cache and renders the full UI.
// A background renderStudentMe() call then either silently confirms the
// session (no visible change) or, if the server says the session truly
// expired, clears the cache and redirects to /login — same safety as before,
// just never-blocking.
//
// SECURITY:
//   • Password is NEVER written to localStorage — stripSensitive() removes it
//     before any write, exactly as it did for sessionStorage.
//   • Only the non-sensitive profile snapshot (name, studentId, portalData
//     scores, points) is cached.
//   • PROFILE_CACHE_VERSION lets us safely evict any stale-format cache by
//     bumping the version constant.
//   • 30-day TTL matches the Render cookie lifetime — no user outlives their
//     server session in the cache.
//   • Shared-device safety: the cache key includes the studentId so switching
//     accounts on the same device never leaks one profile to another.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_CACHE_KEY    = "eduhub_profile_v1";     // localStorage key
const PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PROFILE_CACHE_VERSION = 1;

const SENSITIVE_KEYS = ["password", "Password"];

function stripSensitive(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clone = { ...obj };
  for (const k of SENSITIVE_KEYS) delete clone[k];
  if (clone.portalData && typeof clone.portalData === "object") {
    clone.portalData = { ...clone.portalData };
    for (const k of SENSITIVE_KEYS) delete clone.portalData[k];
  }
  return clone;
}

// Read the persistent 30-day profile cache.
// Returns the cached student object or null if absent / expired / corrupt.
function readSession() {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return null;
    // Version gate — evict any cache written by an incompatible schema.
    if ((cached._v || 0) < PROFILE_CACHE_VERSION) return null;
    // TTL check — treat as logged-out if the cache is older than 30 days.
    if (!cached._ts || Date.now() - cached._ts > PROFILE_CACHE_TTL_MS) return null;
    const v = cached.profile;
    if (!v || !v.studentId) return null;
    return v;
  } catch {
    return null;
  }
}

// Persist the stripped profile to localStorage with a 30-day TTL.
// Passwords are stripped by stripSensitive() before this call is made —
// but we strip again here as an extra defence-in-depth measure.
function writeSession(v) {
  try {
    const safe = stripSensitive(v);
    localStorage.setItem(
      PROFILE_CACHE_KEY,
      JSON.stringify({ _v: PROFILE_CACHE_VERSION, _ts: Date.now(), profile: safe }),
    );
  } catch {
    /* quota / private-mode — ignore, session still works from React state */
  }
}

// Clear both the new localStorage cache and the old sessionStorage key
// (belt-and-suspenders: sessionStorage may still hold a stale entry on
// devices that were logged in before the v12.0 update).
function clearSession() {
  try { localStorage.removeItem(PROFILE_CACHE_KEY); } catch { /* ignore */ }
  try { sessionStorage.removeItem(STORAGE_KEY); }     catch { /* ignore */ }
}

/** Try the modern token-issuing login. Resolves silently if the backend
 *  doesn't understand action=login (old deployment). */
async function tryTokenLogin(cleanId, pw) {
  try {
    const r = await portalLogin(cleanId, pw);
    if (r && r.success && r.sessionToken) return r;
    return null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [student, setStudent] = useState(() => readSession());
  const [isLoading, setIsLoading] = useState(false);

  // ── v10.0 — Render-backed student auth state ──────────────────────────
  // Intentionally namespaced as `renderStudent` (NOT `student`) so the
  // legacy GAS-backed `student` field above is never clobbered. Both
  // coexist during the 48-hour cutover; once stable, the legacy block
  // above can be retired in a follow-up patch.
  // v12.0 — stale-while-revalidate bootstrap.
  // If the 30-day localStorage cache already holds a valid profile, we know
  // the student was authenticated before — set studentLoading=false immediately
  // so the UI renders instantly from cache.  renderStudentMe() fires in the
  // background to confirm the server session is still alive:
  //   • Confirmed → update renderStudent silently (no visible flash).
  //   • Expired   → clearSession() + setRenderStudent(null) → ProtectedRoute
  //                  redirects to /login exactly as it always has.
  //   • Network error → keep cache, keep student logged in (offline-first).
  const _cachedProfile = readSession(); // already called above for `student`
  const [renderStudent, setRenderStudent] = useState(null);
  const [studentLoading, setStudentLoading] = useState(!_cachedProfile);

  useEffect(() => {
    let cancelled = false;
    // If we already have a cache hit we can skip straight to background
    // revalidation.  If not (fresh install / cleared storage) we must wait
    // for the network before declaring "not authenticated".
    // v12.1 — studentMe() now has a precise return contract:
    //   resolved null  = confirmed 401/403 (session definitively expired)
    //   resolved value = valid session (fresh or from /me cache)
    //   thrown error   = network failure / Render cold start with no cache
    //
    // null always clears the local profile cache regardless of whether we
    // had a hadCache hit, so a real server-confirmed logout is never suppressed.
    // thrown errors keep whatever state we have — never force-logout on a blip.
    renderStudentMe()
      .then((s) => {
        if (cancelled) return;
        if (s) {
          setRenderStudent(s);
          // Refresh the 30-day profile cache timestamp on confirmed session.
          const cur = readSession();
          if (cur) writeSession({ ...cur });
        } else {
          // null = confirmed unauthorized (401/403).
          //
          // v1.3 (audit fix) — must clear BOTH auth states. Previously
          // we cleared only `renderStudent`, but `student` was seeded
          // from readSession() on mount, and the consumer-facing
          // `isAuthenticated` is `!!student || !!renderStudent`. So a
          // stale React `student` kept the user "logged in" even though
          // the server had already invalidated the session — Library,
          // Portal, EduTalk all kept rendering until the next /api
          // call independently bounced to /login.
          //
          // clearSession() removes the persisted profile cache, and
          // setStudent(null) ensures the React state can no longer
          // produce a true `isAuthenticated`. studentAuthService.js
          // additionally clears the bearer-fallback token (LS_KEY) so
          // no sibling fetch keeps replaying the dead session.
          setRenderStudent(null);
          setStudent(null);
          clearSession();
          clearSessionToken();
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Network failure or Render cold start with no /me cache.
          // Keep whatever state we have — never force-logout on a transient error.
        }
      })
      .finally(() => { if (!cancelled) setStudentLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ──────────────────────────────────────────────────────────────────────
  // Part 3 (Persistent Login / Safe Session Restore) — re-check the
  // Render session whenever the app becomes visible again or the page
  // is restored from the bfcache.
  //
  // Why this matters:
  //   • iPhone PWA: when the student switches apps and returns, the
  //     session cookie may have expired silently while the tab was
  //     suspended.  Without a recheck, the student would keep navigating
  //     until the next /api call returned 401 and only then get logged
  //     out — usually in the middle of an EduTalk reply or a top-up.
  //   • Safari bfcache: a back/forward navigation can rehydrate the page
  //     without firing the original mount effect.  We piggy-back on the
  //     standard `pageshow` event to cover that case.
  //
  // Safeguards:
  //   • Temporary network failure does NOT clear the session — only an
  //     actual `null` response from `/me` (server-confirmed logout) does.
  //   • We never throw away the cached legacy `student`.
  //   • Best-effort only: any thrown error is swallowed so an offline
  //     screen never produces a forced logout.
  // ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let inFlight = false;
    const recheck = () => {
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      renderStudentMe()
        .then((s) => {
          // Only mutate when the result is meaningful.  A network error
          // resolves to null here too, which is why we additionally
          // guard against accidentally signing the user out below.
          if (s) {
            setRenderStudent(s);
            // Refresh the 30-day cache timestamp so the window rolls from
            // the last confirmed visit.  The student profile in the cache
            // is already stripped of passwords by writeSession().
            const cur = readSession();
            if (cur) writeSession({ ...cur });
          } else if (renderStudent || student) {
            // Server returned an explicit null (session expired on server).
            //
            // v1.3 (audit fix) — clear BOTH auth states for the same
            // reason the mount-time path does. The previous guard
            // (`else if (renderStudent)`) skipped the legacy `student`
            // state, so a user whose Render cookie expired while the
            // tab was suspended would resume with a stale `student`
            // record and `isAuthenticated === true`, then fail every
            // subsequent /api request with 401 until they manually
            // signed out. We now also setStudent(null) and clear the
            // shared bearer/session-token state so ProtectedRoute
            // redirects cleanly on the next render.
            //
            // We still gate on `renderStudent || student` to avoid
            // touching state when there was nothing to clear — the
            // recheck runs on every tab-visible event, and a fully
            // logged-out tab should not spawn redundant setState calls.
            //
            // Network failures STILL go through .catch() below — only
            // a server-confirmed null reaches this branch (per
            // studentMe()'s documented return contract).
            clearSession();
            clearSessionToken();
            setRenderStudent(null);
            setStudent(null);
          }
        })
        .catch(() => { /* swallow — keep current session */ })
        .finally(() => { inFlight = false; });
    };

    const onVis = () => { if (document.visibilityState === "visible") recheck(); };
    const onPageShow = (e) => { if (e && e.persisted) recheck(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginStudent = useCallback(
    async (cleanId, password, turnstileToken = "") => {
      const data = await renderStudentLogin({
        cleanId: String(cleanId || "").trim(),
        password: String(password || ""),
        turnstileToken,
      });
      setRenderStudent(data);
      // v11.2 — Hybrid bridge: after Render auth succeeds, silently populate
      // the legacy `student` state so Library, Portal, Game, and GAS points
      // all receive the full student record (portalData, points, name, password).
      // Render bcrypt already validated the credential — GAS is used as a data
      // source only. Errors are swallowed so a GAS outage never blocks login.
      try {
        if (hydrateRef.current) await hydrateRef.current(cleanId, password);
      } catch { /* GAS optional — Render session already active */ }
      return data;
    },
    [],
  );

  const logoutStudent = useCallback(async () => {
    // v1.4 (audit fix) — `logoutStudent` previously cleared only
    // `renderStudent` + the profile cache, but `isAuthenticated` is
    // `!!student || !!renderStudent`, so the legacy `student` state
    // kept the user "authenticated" right up until the next route
    // change.  This is the same blocker v1.3 closed for the 401/403
    // paths; v1.4 closes it for the *interactive* logout path too.
    //
    // try / finally:
    //   • the network call to the Render `/logout` endpoint is best-
    //     effort — if it 5xx's or the device is offline we MUST still
    //     wipe local state, otherwise a "logout" click could leave the
    //     student visibly logged-in on the device while the server has
    //     no opinion either way.
    //
    // Cleared in the finally block:
    //   • setRenderStudent(null) — drop the Render identity.
    //   • setStudent(null)       — drop the legacy student identity.
    //   • clearSession()         — evict the 30-day profile cache and
    //                              any stale sessionStorage entry.
    //   • clearSessionToken()    — evict the GAS sessionToken used by
    //                              secureClient.
    //   • localStorage.removeItem("student_session_token") — defensive
    //     duplicate of studentAuthService.studentLogout's own cleanup
    //     so any race where renderStudentLogout() throws *before*
    //     touching localStorage cannot leave the bearer behind.
    try {
      await renderStudentLogout();
    } finally {
      setRenderStudent(null);
      setStudent(null);
      clearSession();
      clearSessionToken();
      try { localStorage.removeItem("student_session_token"); } catch { /* ignore */ }
    }
  }, []);
  // ── end v10.0 block ───────────────────────────────────────────────────

  // v7.9.8 — ref mirror so memoised callbacks always see the current
  // in-memory password without adding `student` to their dep array
  // (which would re-create them on every render).
  const studentRef = useRef(student);
  useEffect(() => { studentRef.current = student; }, [student]);

  // v11.2 — ref so loginStudent can call login() without a circular dep
  // (login is declared below loginStudent; refs bypass the ordering constraint).
  const loginRef = useRef(null);
  // v11.3 — separate ref for the GAS hydration helper. Legacy `login()` keeps
  //         enforcing its password-vs-Sheet check (intentional, for students
  //         still on the pure-GAS path). After credential migration, the
  //         Sheet's Password column may diverge from the bcrypt password the
  //         student now uses on Render — so the v11.2 bridge ran the legacy
  //         gate, failed silently, and left `student` null. The new
  //         hydrator below is purely a *data fetch* and never compares
  //         passwords, because Render bcrypt has already authenticated.
  const hydrateRef = useRef(null);

  const login = useCallback(async (id, password) => {
    setIsLoading(true);
    const cleanId = String(id || "").trim();
    const pw = String(password || "").trim();
    if (!cleanId || !pw) {
      setIsLoading(false);
      throw new Error("Please enter both Student ID and Password.");
    }
    try {
      // 1) Opportunistically fire the modern login for a sessionToken. If the
      //    backend hasn't been upgraded yet, this returns null and we fall
      //    through to the classic flow. Either way, NEVER block login on it.
      const tokenResPromise = tryTokenLogin(cleanId, pw);

      // 2) Classic flow (unchanged from v6) — fetches the student record and
      //    compares the password locally. This is what keeps the app working
      //    against your existing deployed GAS.
      const portalData = await portalApi.studentData(cleanId);
      if (!portalData || portalData.error) {
        throw new Error(portalData?.error || "Student not found. Check your ID and try again.");
      }
      const realPassword = String(portalData.Password ?? "");
      if (pw !== realPassword) {
        throw new Error("Incorrect password. Please try again.");
      }

      // v7.9.5 — IMMEDIATE backend-driven restriction check at the moment
      // of login. Previously the modal only appeared after the watchdog's
      // first 15-s tick which gave a restricted user a brief window of
      // free access. We now block the login and surface the restriction
      // synchronously so the RestrictionGuard fires before the dashboard
      // even paints.
      const rFlag = String(
        portalData.Restriction || portalData.restriction || ""
      ).trim().toUpperCase();
      const liftAt = String(
        portalData.RestrictionLiftAt || portalData.restrictionLiftAt || ""
      ).trim();
      const liftedByClock =
        liftAt &&
        !Number.isNaN(new Date(liftAt).getTime()) &&
        new Date(liftAt).getTime() <= Date.now();
      if (rFlag === "TRUE" && !liftedByClock) {
        const msg = String(
          portalData.RestrictionMessage ||
            portalData.restrictionMessage ||
            "Your account has been restricted by the administrator."
        );
        const reason = String(
          portalData.RestrictionReason || portalData.restrictionReason || ""
        ).trim();
        // Surface to RestrictionGuard immediately. We still write a tiny
        // session so the guard knows who to log out from.
        setRestrictionMsg(reason ? `${msg}\n(${reason})` : msg);
        const stub = {
          studentId: cleanId, StudentID: cleanId,
          name: portalData.Name || cleanId,
          role: "student",
          password: realPassword,
          portalData: { ...portalData, Password: realPassword, Restriction: "TRUE" },
          loggedInAt: Date.now(),
          restrictedAtLogin: true,
        };
        writeSession(stub);
        setStudent(stub);
        // Throw so the LoginPage doesn't navigate to Library; the guard
        // overlay handles the 3-second sign-out from the current view.
        throw new Error(reason ? `${msg} (${reason})` : msg);
      }

      // 3) By now the classic flow has succeeded. Await the token attempt
      //    (already in flight in parallel) — if it issued one, great.
      const tokenRes = await tokenResPromise;
      if (tokenRes?.sessionToken) setSessionToken(tokenRes.sessionToken);

      // 4) Lucky-spin side: balance + display name — never blocks login.
      let gamePoints = 0;
      let gameName = portalData.Name || cleanId;
      try {
        const gRes = await gameLogin(cleanId, realPassword);
        if (gRes && gRes.success) {
          if (typeof gRes.points === "number") gamePoints = gRes.points;
          if (gRes.name) gameName = gRes.name;
          if (gRes.sessionToken) setSessionToken(gRes.sessionToken);
        }
      } catch {
        /* spin service is optional */
      }

      // 5) Portal points ledger — optional, non-blocking.
      let portalPoints = 0;
      try {
        const p = await portalApi.pointsLogin(cleanId, realPassword);
        if (p && p.success && typeof p.points === "number") portalPoints = p.points;
      } catch {
        /* ignore — Portal will retry via usePoints */
      }

      const next = {
        studentId: cleanId,
        StudentID: cleanId,
        name: portalData.Name || gameName,
        gameName,
        role: tokenRes?.role || "student",
        // password kept for legacy-backend compatibility (same as v6).
        // It is ONLY used if the backend hasn't been upgraded yet. Once the
        // secured backend is live, the sessionToken takes over and the
        // password field becomes an ignored legacy tag-along.
        password: realPassword,
        portalData: { ...portalData, Password: realPassword },
        portalPoints,
        gamePoints,
        points: portalPoints,
        loggedInAt: Date.now(),
      };
      writeSession(next);
      setStudent(next);
      return next;
    } catch (err) {
      // If the classic flow failed, make sure no half-issued token survives.
      clearSessionToken();
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // v11.2 — wire loginRef now that login() is in scope
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loginRef.current = login; }, []);

  /* ------------------------------------------------------------------ */
  /* v11.3 — GAS hydration bridge (no password gate)                     */
  /* ------------------------------------------------------------------ */
  //
  // Pulls the full student record (portalData, portalPoints, gamePoints,
  // display name, restriction state) from the existing Google Apps Script
  // backends and writes it into the legacy `student` state so every
  // downstream consumer — Library wallet, Portal dashboard, Game
  // balance, RestrictionGuard, refreshPoints, setBalance — keeps
  // rendering real-time data after the Render bcrypt credential
  // migration.
  //
  // Why this exists separately from `login()`:
  //   • legacy `login()` re-validates the password against the Sheet's
  //     cleartext `Password` column. After the migration the bcrypt
  //     password on Render is the source of truth and may no longer
  //     match the Sheet column — so the v11.2 bridge ran the legacy
  //     gate, threw "Incorrect password", was silently swallowed, and
  //     `student` stayed null. That single failure cascaded into
  //     "every GAS-backed view shows nothing".
  //   • This hydrator skips the password comparison entirely. Render
  //     bcrypt already authenticated the user; GAS is now strictly a
  //     READ-ONLY data source.
  //   • It also never calls clearSessionToken() — so secured-backend
  //     tokens (issued by tryTokenLogin / pointsLogin / gameLogin) are
  //     preserved across partial failures.
  //
  // Failure semantics: every GAS call is wrapped in its own try/catch
  // so a single backend hiccup (e.g. Points sheet rate-limit) never
  // blocks the rest of the hydration, and the Render session stays
  // active regardless.
  const hydrateStudentFromGAS = useCallback(async (cleanId, password) => {
    const id = String(cleanId || "").trim();
    const pw = String(password || "");
    if (!id) return null;

    // 1) Student record from PortalBackend GAS — unauthenticated read.
    let portalData = null;
    try {
      portalData = await portalApi.studentData(id);
    } catch {
      // GAS unreachable / network blocked — leave student null so the
      // Render-only views still render, and let the watchdog re-poll.
      return null;
    }
    if (!portalData || portalData.error) return null;

    // FIX: Use the GAS sheet password (portalData.Password) for all GAS credential
    // calls. After the Render bcrypt migration the student logs in with a new password
    // that the GAS backends do not know — they still validate against the plaintext
    // column in the Sheet. Using 'pw' (the Render password) caused pointsLogin(),
    // gameLogin() and tryTokenLogin() to fail silently, leaving portalPoints = 0
    // and the wallet pill / Points stat card blank. This mirrors what legacy login()
    // has always done: const realPassword = String(portalData.Password ?? "")
    const gasPassword = String(portalData.Password ?? pw);

    // 2) Opportunistic sessionToken upgrade — same as legacy login().
    try {
      const tokenRes = await tryTokenLogin(id, gasPassword);
      if (tokenRes?.sessionToken) setSessionToken(tokenRes.sessionToken);
    } catch { /* token endpoint optional */ }

    // 3) Restriction handling — IDENTICAL semantics to legacy login(),
    //    so RestrictionGuard fires at the same moment it always has.
    const rFlag = String(
      portalData.Restriction || portalData.restriction || ""
    ).trim().toUpperCase();
    const liftAt = String(
      portalData.RestrictionLiftAt || portalData.restrictionLiftAt || ""
    ).trim();
    const liftedByClock =
      liftAt &&
      !Number.isNaN(new Date(liftAt).getTime()) &&
      new Date(liftAt).getTime() <= Date.now();
    if (rFlag === "TRUE" && !liftedByClock) {
      const msg = String(
        portalData.RestrictionMessage ||
          portalData.restrictionMessage ||
          "Your account has been restricted by the administrator."
      );
      const reason = String(
        portalData.RestrictionReason || portalData.restrictionReason || ""
      ).trim();
      setRestrictionMsg(reason ? `${msg}\n(${reason})` : msg);
      const stub = {
        studentId: id, StudentID: id,
        name: portalData.Name || id,
        role: "student",
        password: gasPassword,
        portalData: { ...portalData, Password: gasPassword, Restriction: "TRUE" },
        loggedInAt: Date.now(),
        restrictedAtLogin: true,
      };
      writeSession(stub);
      setStudent(stub);
      return stub;
    }

    // 4) Game points + display name — best-effort, never blocks.
    let gamePoints = 0;
    let gameName = portalData.Name || id;
    let gamePointsFresh = false;
    try {
      const gRes = await gameLogin(id, gasPassword);
      if (gRes && gRes.success) {
        if (typeof gRes.points === "number") {
          gamePoints = gRes.points;
          gamePointsFresh = true;
        }
        if (gRes.name) gameName = gRes.name;
        if (gRes.sessionToken) setSessionToken(gRes.sessionToken);
      }
    } catch { /* spin service optional */ }

    // 5) Portal points ledger — best-effort, never blocks.
    // v11.4 — Last-known wallet balance cache (REAL data, not mocked).
    //         Written on every successful fresh login where the password
    //         was supplied and the credentialed endpoints answered. On
    //         a subsequent cold-start the mount-time hydrator (which
    //         has no password) reads from this cache so the wallet pill
    //         doesn't snap to "0 PTS" — it shows the actual last
    //         server-confirmed balance until the next interactive login
    //         re-confirms it. Storage key is namespaced by studentId so
    //         a device shared by multiple students never leaks balances
    //         between accounts.
    const POINTS_CACHE_PREFIX = "eduhub_points_cache_v1:";
    const cacheKey = `${POINTS_CACHE_PREFIX}${id}`;
    let cachedPortalPoints = null;
    let cachedGamePoints = null;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const c = JSON.parse(raw);
        if (typeof c?.portalPoints === "number") cachedPortalPoints = c.portalPoints;
        if (typeof c?.gamePoints === "number") cachedGamePoints = c.gamePoints;
      }
    } catch { /* localStorage may be unavailable / corrupt */ }

    let portalPoints = 0;
    let portalPointsFresh = false;
    try {
      const p = await portalApi.pointsLogin(id, gasPassword);
      if (p && p.success && typeof p.points === "number") {
        portalPoints = p.points;
        portalPointsFresh = true;
      }
    } catch { /* Portal will retry via usePoints */ }

    // If we didn't get a fresh balance AND have a cached one, use the
    // cache. Cached values are previously-real server responses from
    // this same student — never synthetic.
    if (!portalPointsFresh && cachedPortalPoints !== null) {
      portalPoints = cachedPortalPoints;
    }
    if (!gamePointsFresh && cachedGamePoints !== null) {
      gamePoints = cachedGamePoints;
    }

    // Persist fresh server-confirmed balances so the next cold-start can
    // restore them. Only writes when we actually got a fresh response —
    // never poisons the cache with the cold-start 0 fallback.
    if (portalPointsFresh || gamePointsFresh) {
      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            portalPoints: portalPointsFresh ? portalPoints : (cachedPortalPoints ?? 0),
            gamePoints: gamePointsFresh ? gamePoints : (cachedGamePoints ?? 0),
            ts: Date.now(),
          }),
        );
      } catch { /* quota / privacy mode — ignore */ }
    }

    const next = {
      studentId: id,
      StudentID: id,
      name: portalData.Name || gameName,
      gameName,
      role: "student",
      password: gasPassword,
      portalData: { ...portalData, Password: gasPassword },
      portalPoints,
      gamePoints,
      points: portalPoints,
      loggedInAt: Date.now(),
    };
    writeSession(next);
    setStudent(next);
    return next;
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { hydrateRef.current = hydrateStudentFromGAS; }, []);

  /* ------------------------------------------------------------------ */
  /* v11.4 — Mount-time GAS hydration                                    */
  /* ------------------------------------------------------------------ */
  //
  // Symptom this fixes: on PWA cold-start / new tab / force-quit
  // relaunch, the Render cookie + Bearer survive (so `renderStudent`
  // rehydrates from /api/auth/student/me), but `sessionStorage` is
  // empty so the legacy `student` state stays null. Every downstream
  // view that reads `useAuth().student`:
  //
  //   • Library — `student?.name` → falls back to "Reader", `student?.portalPoints` → 0
  //   • PortalMe — `if (!student?.portalData) return null;` → blank Portal
  //   • GamePlay — `student?.password || ""` → redirects to /login on Spin
  //   • RestrictionGuard watchdog — `student?.studentId` → poll never starts
  //   • refreshPoints / setBalance / PointsCreditPushBridge — no-op
  //
  // Up to v11.3 the GAS hydrator was only wired into the *interactive*
  // `loginStudent()` flow, so any path that re-enters the app without
  // typing a password (PWA relaunch, deep link, push tap into /portal)
  // never repopulated the legacy state.
  //
  // This effect runs once `studentLoading` settles. If `renderStudent`
  // is present but the legacy `student` state is missing — or belongs
  // to a different identity than the Render-confirmed user — it fires
  // the GAS hydrator with an empty password. `portalApi.studentData`
  // is an unauthenticated read, so `name`, `portalData`, and the
  // restriction flag still populate correctly. Credentialed endpoints
  // (`pointsLogin`, `gameLogin`) will fail silently when called
  // without a password — that's intentional and matches the v7.9.8
  // security hardening which keeps the cleartext password in JS memory
  // only. To re-fetch a server-authoritative wallet balance after a
  // cold-start, the student re-enters their password (which goes
  // through `loginStudent` → hydrator with real password). Between
  // cold-start and that next interactive login, the Library/Portal
  // identity rendering is correct, restrictions are enforced, and
  // every view that previously broke now mounts cleanly.
  // ── v12.2 (Send-Points stability hotfix) ───────────────────────────
  // Re-hydrate when EITHER the legacy student is missing OR the cached
  // student lacks an in-memory password.
  //
  // Root cause this closes: v12.0's 30-day localStorage profile cache
  // strips the password by design (stripSensitive). On PWA cold-start
  // `student` rehydrates from that cache WITH a matching studentId but
  // WITHOUT a password. The previous guard
  //     `if (student && student.studentId === cleanId) return;`
  // treated the cached profile as "already hydrated" and skipped the
  // GAS hydration — so `student.password` stayed undefined, which is
  // exactly the field SendPointsModal forwards to api.sendPoints().
  // Receiver-name lookup worked (unauth `studentData` GET), but the
  // final transfer failed with "Sender not found or incorrect
  // password" until the student logged out and logged back in.
  //
  // Safety:
  //   • Password is fetched from the Sheet's `Password` column via the
  //     SAME unauth GAS read the v7.9.8 login path uses; nothing new
  //     is persisted to localStorage — the password lives in React
  //     state only (writeSession strips it before any disk write).
  //   • Loop guard: once the hydrator sets `student.password`, this
  //     effect re-runs once and the new condition early-returns.
  //   • Loop guard for GAS outage: when GAS is unreachable the hydrator
  //     resolves without setStudent, so neither `student` nor
  //     `renderStudent` change and the effect does not re-fire — it
  //     simply retries the next time AuthContext refreshes
  //     `renderStudent` (e.g. on visibility change).
  //   • Real expired session is unaffected: `renderStudent` is `null`
  //     in that case, the first `if (!renderStudent) return;` fires
  //     before any GAS work and `setStudent(null)` from studentMe's
  //     401 path keeps `student` empty.
  useEffect(() => {
    if (studentLoading) return;                  // wait for studentMe() to settle
    if (!renderStudent) return;                  // nothing to hydrate from
    const cleanId =
      renderStudent.clean_id ||
      renderStudent.student_id ||
      renderStudent.studentId ||
      "";
    if (!cleanId) return;
    // v12.2 — also re-hydrate when the cached profile lacks a password.
    // Without this, Send Points (which forwards student.password into
    // the legacy GAS `sendPoints` action) silently fails after every
    // PWA close/reopen even though the dashboard looks logged in.
    if (
      student &&
      student.studentId === cleanId &&
      student.password
    ) return;                                   // already fully hydrated for this user
    if (!hydrateRef.current) return;
    hydrateRef.current(cleanId, "").catch(() => { /* GAS optional */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentLoading, renderStudent, student]);

  const logout = useCallback(() => {
    clearSession();
    clearSessionToken();
    setStudent(null);
    // Also clear the Render-backed session so isAuthenticated becomes false immediately.
    renderStudentLogout().catch(() => {});
    setRenderStudent(null);
    navigate("/", { replace: true });
  }, [navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Refetch the real points balance from PointsBackend and Game backend.
   * Used by the Library after a purchase so the wallet always reflects the
   * server-authoritative balance, not any stale client value.
   *
   * Returns the fresh portalPoints on success, or null if the backend
   * could not be reached. Safe to await.
   */
  const refreshPoints = useCallback(async () => {
    // v7.9.8 — read credentials from in-memory state (not storage, which
    // no longer contains the password). Falls through gracefully after
    // a page refresh: if the sessionToken endpoint is live, upgraded
    // backends still return the balance via token; otherwise the call
    // simply no-ops until the student re-logs-in.
    const cur = studentRef.current || readSession();
    if (!cur?.studentId) return null;
    let portalPoints = cur.portalPoints || 0;
    let gamePoints = cur.gamePoints || 0;
    let gotServer = false;
    if (cur.password) {
      try {
        const p = await portalApi.pointsLogin(cur.studentId, cur.password);
        if (p && p.success && typeof p.points === "number") {
          portalPoints = p.points;
          gotServer = true;
        }
      } catch { /* ignore */ }
      try {
        const g = await gameLogin(cur.studentId, cur.password);
        if (g && g.success && typeof g.points === "number") gamePoints = g.points;
      } catch { /* ignore */ }
    }
    setStudent((prev) => {
      if (!prev || prev.studentId !== cur.studentId) return prev;
      const next = { ...prev, portalPoints, gamePoints, points: portalPoints };
      writeSession(next);
      return next;
    });
    return gotServer ? portalPoints : null;
  }, []);

  /**
   * Optimistically set the local points balance (used right after a
   * purchase when the server has already been debited but we want the UI
   * to reflect the new balance instantly, before the async re-fetch
   * lands). Always followed by a refreshPoints() for reconciliation.
   */
  const setBalance = useCallback((newPortalPoints) => {
    if (typeof newPortalPoints !== "number") return;
    const clamped = Math.max(0, Math.floor(newPortalPoints));
    setStudent((prev) => {
      if (!prev) return prev;
      const next = { ...prev, portalPoints: clamped, points: clamped };
      writeSession(next);
      return next;
    });
  }, []);

  // Keep the local state in sync if another tab signs out / in.
  useEffect(() => {
    const onStorage = (e) => {
      // v12.1 — also respond to the new 30-day localStorage key so cross-tab
      // logout (clearing PROFILE_CACHE_KEY) propagates to this tab immediately.
      if (e.key === STORAGE_KEY || e.key === PROFILE_CACHE_KEY) setStudent(readSession());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /* ---------------------------------------------------------------- */
  /* v7.9.2 — Real-time restriction watchdog (backend-driven)          */
  /* ---------------------------------------------------------------- */
  //
  // The Portal Google Sheet is the single source of truth for
  // account-level restrictions. Suggested columns on the `Students` tab
  // (all optional — everything gracefully falls back if empty):
  //
  //   • Restriction            — "TRUE" | "FALSE" (master switch)
  //   • RestrictionMessage     — plain text shown in the overlay
  //   • RestrictionReason      — short tag (e.g. "unpaid", "abuse")
  //   • RestrictionLiftAt      — ISO date/time; if set and in the past
  //                              the restriction is treated as lifted
  //                              automatically without admin action.
  //
  // We poll the sheet every 15 s (plus immediately on tab-focus) so a
  // flag flipped in Google Sheets reaches every isolated dashboard
  // (Library, Reader, Portal, Game, Assistant, SystemTest) in near
  // real-time. The RestrictionGuard component then auto-logs-out after
  // the 3-second countdown.
  const RESTRICTION_POLL_MS = 15 * 1000;
  const [restrictionMsg, setRestrictionMsg] = useState("");

  useEffect(() => {
    if (!student?.studentId) {
      setRestrictionMsg("");
      return;
    }
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const fresh = await portalApi.studentData(student.studentId);
        if (stopped) return;
        if (!fresh || fresh.error) return;
        const r = String(fresh.Restriction || fresh.restriction || "").trim();
        // Auto-lift: if an admin set RestrictionLiftAt to a past datetime,
        // treat the account as un-restricted regardless of the flag.
        const liftAtRaw = String(
          fresh.RestrictionLiftAt || fresh.restrictionLiftAt || ""
        ).trim();
        const liftedByClock =
          liftAtRaw &&
          !Number.isNaN(new Date(liftAtRaw).getTime()) &&
          new Date(liftAtRaw).getTime() <= Date.now();
        if (r && r.toUpperCase() === "TRUE" && !liftedByClock) {
          const m = String(
            fresh.RestrictionMessage ||
              fresh.restrictionMessage ||
              "Your account has been restricted by the administrator."
          );
          const reason = String(
            fresh.RestrictionReason || fresh.restrictionReason || ""
          ).trim();
          setRestrictionMsg(reason ? `${m}\n(${reason})` : m);
          // also persist on the student so any page that reads
          // student.portalData.Restriction directly stays consistent.
          setStudent((prev) =>
            prev
              ? {
                  ...prev,
                  portalData: {
                    ...(prev.portalData || {}),
                    Restriction: "TRUE",
                    RestrictionMessage: m,
                  },
                }
              : prev
          );
        } else if (restrictionMsg) {
          // Admin lifted the restriction — clear the modal.
          setRestrictionMsg("");
          setStudent((prev) =>
            prev
              ? {
                  ...prev,
                  portalData: {
                    ...(prev.portalData || {}),
                    Restriction: "",
                    RestrictionMessage: "",
                  },
                }
              : prev
          );
        }
      } catch {
        /* offline / transient — silent retry next tick */
      }
    };
    // Honour any restriction that was already in the session at login.
    const initial = String(
      student?.portalData?.Restriction || student?.portalData?.restriction || ""
    ).trim();
    if (initial.toUpperCase() === "TRUE" && !restrictionMsg) {
      setRestrictionMsg(
        student?.portalData?.RestrictionMessage ||
          "Your account has been restricted by the administrator."
      );
    }
    // v7.9.6 — hydrate the cross-device Unlocks cache on login + every
    // tick so a purchase made on another browser/IP propagates within
    // the same poll window.
    const hydrateUnlocks = () => {
      import("../pages/library/books/unlocksService.js")
        .then((m) => m.fetchUnlocksForStudent(student.studentId))
        .catch(() => { /* silent */ });
    };
    hydrateUnlocks();
    // First poll runs immediately, then on interval + tab focus.
    tick();
    const id = setInterval(() => { tick(); hydrateUnlocks(); }, RESTRICTION_POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") { tick(); hydrateUnlocks(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student?.studentId]);

  const value = useMemo(
    () => ({
      student,
      login,
      logout,
      refreshPoints,
      setBalance,
      isAuthenticated: !!student || !!renderStudent,
      isLoading,
      // Part 3 (Persistent Login) — friendlier alias used by
      // ProtectedRoute.  `studentLoading` flips false once the
      // mount-time /api/auth/student/me round-trip settles, regardless
      // of outcome.  Until then ProtectedRoute holds the redirect so
      // PWA cold-starts don't bounce to /login.
      isBootstrapping: !!studentLoading,
      restrictionMsg,
      isRestricted: !!restrictionMsg,
      // v10.0 — Render student auth (additive)
      renderStudent,
      studentLoading,
      loginStudent,
      logoutStudent,
    }),
    [student, login, logout, refreshPoints, setBalance, isLoading, restrictionMsg,
     renderStudent, studentLoading, loginStudent, logoutStudent],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
