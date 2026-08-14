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

const STORAGE_KEY = "eduhub_student";
const AuthCtx = createContext(null);

/**
 * v7.9.8 — hardened session persistence.
 *
 * The cleartext password is NO LONGER persisted to sessionStorage. It
 * lives ONLY in React state (i.e. JS memory) for as long as the tab is
 * open. Every writeSession call strips it before the JSON lands on
 * disk/storage, so an XSS that reaches the storage API (or a device
 * inspection after the student walked away) can never read the
 * password.
 *
 * Pages that still need the legacy password for un-upgraded GAS calls
 * (sendPoints, pointsLogin, askGPT, game play) read it from React state
 * via `useAuth().student.password`. Post page-refresh the password is
 * gone until the student re-logs-in — the sessionToken path keeps every
 * upgraded endpoint working without prompting.
 */
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

function readSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !v.studentId) return null;
    return v;
  } catch {
    return null;
  }
}

function writeSession(v) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stripSensitive(v)));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
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
  // v7.9.8 — ref mirror so memoised callbacks always see the current
  // in-memory password without adding `student` to their dep array
  // (which would re-create them on every render).
  const studentRef = useRef(student);
  useEffect(() => { studentRef.current = student; }, [student]);

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

  const logout = useCallback(() => {
    clearSession();
    clearSessionToken();
    setStudent(null);
    navigate("/", { replace: true });
  }, [navigate]);

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
      if (e.key === STORAGE_KEY) setStudent(readSession());
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
      isAuthenticated: !!student,
      isLoading,
      restrictionMsg,
      isRestricted: !!restrictionMsg,
    }),
    [student, login, logout, refreshPoints, setBalance, isLoading, restrictionMsg],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
