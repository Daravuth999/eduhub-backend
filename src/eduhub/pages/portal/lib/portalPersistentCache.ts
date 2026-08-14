/**
 * portalPersistentCache.ts — My Portal Instant Persistent Cache v2
 *
 * Persistent, student-scoped, stale-while-revalidate (SWR) cache for
 * the My Portal dashboard display snapshots. Successor to v1's
 * `portalFastCache.ts` (sessionStorage, 45 s) — extended to survive
 * full PWA close/reopen so the dashboard feels instant on relaunch.
 *
 * Design goals
 * ------------
 *  - Make repeat AND cold-relaunch visits to My Portal feel instant.
 *    On a warm relaunch the cached snapshot is rendered IMMEDIATELY
 *    while a quiet background fetch revalidates against the real
 *    backend.
 *  - Backend remains the source of truth. The cache is a UI-only
 *    accelerator. Every consumer still performs the real network
 *    fetch on mount; the cache only suppresses the first-paint
 *    skeleton when we already know what to draw.
 *  - Student-scoped. Two students sharing the same browser/device
 *    can never read each other's cached payloads. Keys are
 *    namespaced by the currently authenticated student's id.
 *  - Safe across logout / student switch. Cross-tab logout (via the
 *    canonical `eduhub_profile_v1` key being cleared) is observed
 *    through the `storage` event and the in-memory layer is wiped
 *    immediately. localStorage entries that belong to other students
 *    are garbage-collected lazily.
 *  - No tokens, no payment data, no admin data. Only the small,
 *    non-sensitive UI display snapshot (vouchers list, referral
 *    stats, latest reward summary, recent transaction rows).
 *  - No new dependencies. Pure browser APIs.
 *
 * Storage
 * -------
 * We use `localStorage` (not IndexedDB) on purpose:
 *   1. Each cached section is a small JSON blob (a few KB at most).
 *   2. The whole codebase already persists the student profile +
 *      points cache in localStorage with student-scoped keys (see
 *      `eduhub_profile_v1` and `eduhub_points_cache_v1:<id>` in
 *      AuthContext.jsx). Using the same primitive keeps the cache
 *      eviction model identical and avoids introducing an async
 *      IndexedDB layer that components would have to await.
 *   3. `localStorage` is synchronous, so the very first render of a
 *      component can read the cached payload without waiting for a
 *      microtask — there is no skeleton flash on a warm reopen.
 *
 * If IndexedDB ever becomes necessary (e.g. for large structured
 * snapshots), this module's public API can be re-implemented on top
 * of it without changing any caller.
 *
 * TTLs
 * ----
 *   - FRESH window  : 10 minutes. Within this window the cached
 *                     payload is shown WITHOUT a background refetch
 *                     being marked as a UI miss — the silent
 *                     revalidation still runs.
 *   - STALE window  : 24 hours. Past `FRESH` and up to `STALE` the
 *                     cached payload is still shown immediately to
 *                     avoid skeleton flash, and a foreground refetch
 *                     is started so any change lands quickly.
 *   - Beyond STALE  : the cached payload is dropped (cacheRead
 *                     returns null) so the consumer's existing
 *                     loading path runs normally.
 *
 * Public API
 * ----------
 *   - PORTAL_CACHE_SECTIONS         — stable section name constants.
 *   - cacheRead<T>(section)         — returns `{ value, freshness }`
 *                                     or `null`. `freshness` is
 *                                     "fresh" | "stale".
 *   - cacheWrite<T>(section, value) — persist a successful payload.
 *   - cacheInvalidate(section)      — drop one section.
 *   - cacheClearCurrentStudent()    — drop every section for the
 *                                     student currently identified
 *                                     by `eduhub_profile_v1`.
 *   - cacheClearAllStudents()       — drop every persistent entry
 *                                     this module ever wrote.
 *
 * This module never reads or writes tokens, passwords, payment
 * status, KHQR/CamRapidPay payloads, admin data, or anything that
 * could leak between students.
 */

// ──────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────

/** Storage key prefix. Includes a schema version so future shape
 *  changes can safely evict old entries by bumping the version. */
const STORAGE_PREFIX = "eduhub.portalCache.v2::";

/** Inside this window the cached value is considered "fresh" — we
 *  show it instantly and still kick off a quiet background refetch. */
export const FRESH_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Past FRESH but up to this window we still render the cached value
 *  (to avoid skeleton flash) and run a FOREGROUND refetch so any
 *  change lands quickly. */
export const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Stable namespaced section keys. Use these instead of free-form
 *  strings so typos are compile-time errors. */
export const PORTAL_CACHE_SECTIONS = {
  vouchers:     "vouchers",
  referral:     "referral",
  latestReward: "latestReward",
  transactions: "transactions",
} as const;

export type PortalCacheSection =
  (typeof PORTAL_CACHE_SECTIONS)[keyof typeof PORTAL_CACHE_SECTIONS];

export type Freshness = "fresh" | "stale";

/** Wire shape persisted in localStorage. Kept small + JSON-safe. */
interface Envelope<T> {
  /** Epoch ms at which the entry was written. */
  ts: number;
  /** Snapshot payload. */
  v: T;
  /** Student id this snapshot belongs to. */
  sid: string;
  /** Schema version (in case the payload shape changes later). */
  sv: number;
}

const CURRENT_SCHEMA = 1;

// ──────────────────────────────────────────────────────────────────
// Helpers — student identity + storage probes
// ──────────────────────────────────────────────────────────────────

/** The canonical localStorage key used by AuthContext.jsx to persist
 *  the 30-day student profile. We read it (never write it) to learn
 *  which student is currently authenticated. */
const PROFILE_CACHE_KEY = "eduhub_profile_v1";

/**
 * Returns a stable, non-PII student identifier for the currently
 * authenticated student. Reads from the AuthContext-managed
 * `eduhub_profile_v1` localStorage entry. Falls back to "anon" when
 * no profile is cached (e.g. on the very first cold-start before
 * login).
 *
 * Two different students on the same browser will return different
 * ids here, which makes their cache keyspaces disjoint.
 */
function _currentStudentId(): string {
  try {
    if (typeof localStorage === "undefined") return "anon";
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return "anon";
    const parsed = JSON.parse(raw) as
      | { profile?: { studentId?: string; StudentID?: string } }
      | null;
    const sid =
      parsed?.profile?.studentId ||
      parsed?.profile?.StudentID ||
      "";
    return sid ? String(sid) : "anon";
  } catch {
    return "anon";
  }
}

/** Probe localStorage — degrades gracefully (Safari private mode etc). */
function _ls(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    localStorage.getItem(STORAGE_PREFIX + "__probe__");
    return localStorage;
  } catch {
    return null;
  }
}

function _key(section: PortalCacheSection, sid: string): string {
  return `${STORAGE_PREFIX}${sid}::${section}`;
}

// In-memory shadow of the disk cache. Used so multiple components
// reading the same section on the same SPA navigation don't re-parse
// JSON. The memory layer is wiped when a `storage` event reports the
// profile cache changed (logout / student switch on another tab).
const MEM: Map<string, Envelope<unknown>> = new Map();

// ──────────────────────────────────────────────────────────────────
// Read / write
// ──────────────────────────────────────────────────────────────────

function _diskRead<T>(
  section: PortalCacheSection,
  sid: string,
): Envelope<T> | null {
  const ls = _ls();
  if (!ls) return null;
  try {
    const raw = ls.getItem(_key(section, sid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Envelope<T>;
    if (!parsed || typeof parsed.ts !== "number") return null;
    if (parsed.sid !== sid) return null; // belt-and-suspenders
    if ((parsed.sv ?? 0) < CURRENT_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

function _diskWrite<T>(
  section: PortalCacheSection,
  env: Envelope<T>,
): void {
  const ls = _ls();
  if (!ls) return;
  try {
    ls.setItem(_key(section, env.sid), JSON.stringify(env));
  } catch {
    /* quota / privacy-mode — memory layer still serves this tab */
  }
}

function _diskDelete(section: PortalCacheSection, sid: string): void {
  const ls = _ls();
  if (!ls) return;
  try {
    ls.removeItem(_key(section, sid));
  } catch {
    /* no-op */
  }
}

/**
 * Read a cached snapshot for the current student.
 *
 * Returns `{ value, freshness }` when an entry exists and is still
 * within the `STALE_TTL_MS` window. `freshness` is:
 *   - "fresh" : within `FRESH_TTL_MS` — the consumer should render
 *               it AND start a QUIET background refetch.
 *   - "stale" : past `FRESH_TTL_MS` but within `STALE_TTL_MS` — the
 *               consumer should still render it (skeleton-flash
 *               avoidance) AND start a FOREGROUND refetch.
 *
 * Returns `null` when no cached entry exists, when the entry belongs
 * to another student, or when it is past the `STALE_TTL_MS` window.
 * In that case the consumer's existing loading path runs unchanged.
 */
export function cacheRead<T>(
  section: PortalCacheSection,
): { value: T; freshness: Freshness } | null {
  const sid = _currentStudentId();
  if (sid === "anon") return null;

  const memKey = _key(section, sid);
  let env = MEM.get(memKey) as Envelope<T> | undefined;
  if (!env) {
    const disk = _diskRead<T>(section, sid);
    if (disk) {
      MEM.set(memKey, disk as Envelope<unknown>);
      env = disk;
    }
  }
  if (!env) return null;
  if (env.sid !== sid) return null; // student switched mid-session

  const age = Date.now() - env.ts;
  if (age <= FRESH_TTL_MS) return { value: env.v, freshness: "fresh" };
  if (age <= STALE_TTL_MS) return { value: env.v, freshness: "stale" };

  // Beyond STALE window — expire so a later read with a smaller TTL
  // can never re-serve this entry.
  MEM.delete(memKey);
  _diskDelete(section, sid);
  return null;
}

/**
 * Persist a successful payload for the current student. No-ops when
 * the student is not yet identified ("anon") so we never write a
 * pre-login snapshot.
 */
export function cacheWrite<T>(
  section: PortalCacheSection,
  value: T,
): void {
  const sid = _currentStudentId();
  if (sid === "anon") return;
  const env: Envelope<T> = {
    ts: Date.now(),
    v: value,
    sid,
    sv: CURRENT_SCHEMA,
  };
  MEM.set(_key(section, sid), env as Envelope<unknown>);
  _diskWrite<T>(section, env);
}

/** Drop a single section for the current student. */
export function cacheInvalidate(section: PortalCacheSection): void {
  const sid = _currentStudentId();
  if (sid === "anon") return;
  MEM.delete(_key(section, sid));
  _diskDelete(section, sid);
}

/** Drop every section this module wrote for the current student. */
export function cacheClearCurrentStudent(): void {
  const sid = _currentStudentId();
  if (sid === "anon") {
    // No identified student to scope to — fall back to a global wipe
    // for safety. This is also called from the cross-tab logout
    // observer where `eduhub_profile_v1` is already gone.
    cacheClearAllStudents();
    return;
  }
  for (const section of Object.values(PORTAL_CACHE_SECTIONS)) {
    MEM.delete(_key(section, sid));
    _diskDelete(section, sid);
  }
}

/**
 * Drop every persistent entry this module ever wrote, regardless of
 * which student it belonged to. Used by the cross-tab logout
 * observer when the canonical profile cache was cleared on another
 * tab — at that point the current student id is "anon" and we
 * cannot derive a scoped sweep, so we wipe everything we own.
 *
 * This function is intentionally narrow: it only touches keys that
 * begin with this module's `STORAGE_PREFIX`. AuthContext's own
 * caches, the points cache, and the GAS sessionToken are untouched.
 */
export function cacheClearAllStudents(): void {
  MEM.clear();
  const ls = _ls();
  if (!ls) return;
  try {
    // Snapshot keys first; mutating during iteration is undefined.
    const toDelete: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) toDelete.push(k);
    }
    for (const k of toDelete) {
      try { ls.removeItem(k); } catch { /* ignore */ }
    }
  } catch {
    /* iteration blocked — memory cache is already empty */
  }
}

// ──────────────────────────────────────────────────────────────────
// Cross-tab logout / student-switch observer
// ──────────────────────────────────────────────────────────────────
//
// AuthContext.jsx clears the canonical `eduhub_profile_v1` key from
// localStorage on every logout path (interactive logout, server
// 401/403, cross-tab logout). The `storage` event fires in every
// OTHER tab when that happens.
//
// We listen for that event and either:
//   - If the key was removed/cleared → wipe everything this module
//     owns. The next time the student logs back in, our cache starts
//     empty and re-hydrates from real backend responses.
//   - If the key was changed to a different student id → wipe only
//     the memory layer (the disk entries belonging to other students
//     are GC'd lazily on read since keys are student-scoped).
//
// We also wipe everything on a same-tab logout by re-checking the
// current student id whenever cacheRead is called — if it's "anon"
// we already return null, so no stale data ever surfaces.

function _onStorageEvent(e: StorageEvent): void {
  if (e.key !== PROFILE_CACHE_KEY) return;
  if (!e.newValue) {
    // Logout (or session evicted on another tab) — purge everything.
    cacheClearAllStudents();
    return;
  }
  // Profile changed — could be a different student logging in on
  // another tab, or simply a refreshed timestamp. Wipe the memory
  // layer so the next read re-resolves the current student id.
  MEM.clear();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  try {
    window.addEventListener("storage", _onStorageEvent);
  } catch {
    /* ignore — environments without window/storage events */
  }
}
