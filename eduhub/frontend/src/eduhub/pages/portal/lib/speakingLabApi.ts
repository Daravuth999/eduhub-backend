/**
 * speakingLabApi.ts — client for the Speaking Lab one-tap "Join Now" flow
 * (server-resolved active session, zero typed codes). Entirely additive:
 * no existing api.ts export is changed.
 *
 * The backend route is hard-disabled by default
 * (speaking_lab_direct_join_enabled=false) — every call below will get a
 * 503 with error "direct_join_disabled" until that flag is turned on in a
 * separately-approved activation step. This client already handles that
 * response shape so the UI degrades cleanly while the flag stays off.
 *
 * Auth follows the exact same pattern as `_renderPointsLogin` in api.ts:
 * bearer token from localStorage (falls back to the `student_session`
 * cookie via `credentials: "include"`).
 */

const RENDER_BASE = (
  (typeof process !== "undefined" &&
    process.env &&
    process.env.REACT_APP_BACKEND_URL) ||
  ""
).replace(/\/$/, "");

function _authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("student_session_token")
      : null;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** GET requests must NOT send Content-Type: it has no body to describe,
 * and a Content-Type header makes an otherwise-simple GET a "non-simple"
 * CORS request — forcing a preflight OPTIONS round trip before every
 * read. Through a cold-started backend that doubles the latency budget
 * and was eating into the read timeout on slow mobile networks. */
function _authHeadersGet(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("student_session_token")
      : null;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export interface DirectJoinResponse {
  ok: boolean;
  session_id: string;
  lucky_code: string;
  position: number;
  entry_fee: number;
  pool_total: number;
  player_count: number;
  idempotent_replay: boolean;
}

export interface JoinPreviewExistingEntry {
  lucky_code: string;
  status: string;
}

/** "Is there a live session for me right now?" — drives the one-tap My
 * Portal card. No session code is ever typed; the server resolves the
 * student's eligible live session. The card fires this on open and
 * HIDES itself if it fails or `active` is false — never an error on the
 * main screen. */
export interface ActiveSessionResponse {
  ok: boolean;
  active: boolean;
  session_id: string;
  schedule: string;
  entry_fee: number;
  pool_total: number;
  player_count: number;
  direct_join_enabled: boolean;
  existing_entry: JoinPreviewExistingEntry | null;
}

export class SpeakingLabApiError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** A join request that neither confirmed success nor a clean failure
 * within this window (dropped connection, backend restart mid-request,
 * a stalled proxy, etc.) is "ambiguous" — the caller must resolve it via
 * `activeSession()`, never by silently re-showing a fresh payment CTA. */
export const DIRECT_JOIN_TIMEOUT_MS = 12_000;

/** activeSession is a plain read — there is no charge at risk, so a slow
 * or failed request is never "ambiguous", just a clean failure. Because
 * it's charge-free it is also safe to RETRY automatically: up to
 * ACTIVE_SESSION_MAX_ATTEMPTS attempts with a short backoff, each with a
 * generous per-attempt timeout. A one-shot, hard-abort read misclassifies
 * a Render cold start or one dropped mobile packet as "service
 * unreachable" — the single biggest source of the false "couldn't reach
 * the Prize Pool service" failures the old flow suffered from. */
export const ACTIVE_SESSION_TIMEOUT_MS = 20_000;
export const ACTIVE_SESSION_MAX_ATTEMPTS = 3;
export const ACTIVE_SESSION_RETRY_BACKOFF_MS = [1_000, 2_000];

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One stable idempotency key per (browser, session) — reused across
 * retries of the SAME join attempt so a page refresh or double-tap can
 * never cause a second charge. A brand-new session id gets a brand-new
 * key. Never regenerated once created for a given session. */
export function getOrCreateJoinIdempotencyKey(sessionOrCode: string): string {
  const storageKey = `sl_direct_join_idem:${sessionOrCode}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    // sessionStorage unavailable (private mode, etc.) — fall back to a
    // per-call key; at worst this loses replay protection across a
    // refresh, it never causes a double charge within one call.
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function _parseError(res: Response): Promise<SpeakingLabApiError> {
  // A 401 here is always the shared `require_student` auth dependency
  // (FastAPI's plain-string `{"detail": "Not authenticated"}`, never the
  // `{error, message}` shape our own business-logic errors use) — the
  // student's session/cookie has expired, distinct from every other
  // failure mode.
  if (res.status === 401) {
    return new SpeakingLabApiError(
      "auth_expired",
      "Your session has expired. Please sign in again.",
      401,
    );
  }
  let detail: any = null;
  try {
    detail = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const code =
    (detail && detail.detail && detail.detail.error) ||
    (detail && detail.error) ||
    "unknown_error";
  const message =
    (detail && detail.detail && detail.detail.message) ||
    (detail && detail.message) ||
    `HTTP ${res.status}`;
  return new SpeakingLabApiError(code, message, res.status);
}

export const speakingLabApi = {
  /** One-tap driver: "is there a live session for me right now?" No code
   * is typed — the server resolves the student's eligible session. Safe
   * to retry automatically (charge-free read). The CALLER is expected to
   * fail SILENT on any error (hide the card), so this still surfaces
   * classified errors but they should never reach a student's screen. */
  async activeSession(): Promise<ActiveSessionResponse> {
    if (!RENDER_BASE) {
      throw new SpeakingLabApiError("backend_unreachable", "REACT_APP_BACKEND_URL is not set", 0);
    }
    let lastError: SpeakingLabApiError = new SpeakingLabApiError(
      "backend_unreachable", "The Prize Pool service could not be reached.", 0,
    );
    for (let attempt = 1; attempt <= ACTIVE_SESSION_MAX_ATTEMPTS; attempt++) {
      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), ACTIVE_SESSION_TIMEOUT_MS)
        : null;
      try {
        const res = await fetch(`${RENDER_BASE}/api/speaking-lab/active-session`, {
          method: "GET",
          credentials: "include",
          headers: _authHeadersGet(),
          signal: controller?.signal,
        });
        if (!res.ok) throw await _parseError(res);
        return (await res.json()) as ActiveSessionResponse;
      } catch (err: any) {
        if (err instanceof SpeakingLabApiError) throw err;
        lastError = new SpeakingLabApiError("backend_unreachable", String(err?.message || err), 0);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      const backoff = ACTIVE_SESSION_RETRY_BACKOFF_MS[attempt - 1];
      if (attempt < ACTIVE_SESSION_MAX_ATTEMPTS && backoff) {
        await _sleep(backoff);
      }
    }
    throw lastError;
  },

  /** One-tap join: the server resolves the live session and runs the
   * atomic enrollment. One attempt, a stable idempotency key, ambiguity
   * resolved by the caller via activeSession() (never a blind re-POST). */
  async joinActive(): Promise<DirectJoinResponse> {
    if (!RENDER_BASE) {
      throw new SpeakingLabApiError("backend_unreachable", "REACT_APP_BACKEND_URL is not set", 0);
    }
    const idempotencyKey = getOrCreateJoinIdempotencyKey("active");
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), DIRECT_JOIN_TIMEOUT_MS)
      : null;
    let res: Response;
    try {
      res = await fetch(`${RENDER_BASE}/api/speaking-lab/join-active`, {
        method: "POST",
        credentials: "include",
        headers: _authHeaders(),
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
        signal: controller?.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new SpeakingLabApiError(
          "ambiguous_timeout", "The join request took too long to confirm.", 0);
      }
      throw new SpeakingLabApiError("ambiguous_network_error", String(err?.message || err), 0);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (!res.ok) throw await _parseError(res);
    return (await res.json()) as DirectJoinResponse;
  },
};
