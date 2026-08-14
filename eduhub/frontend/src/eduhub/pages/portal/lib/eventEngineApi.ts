/**
 * eventEngineApi.ts — student-facing client for the Event Engine
 * (architecture.md continuation: "Student PWA: browse available events,
 * register, view eligibility, view tickets"). Mounted at
 * /api/v1/events/available (GET) and /api/v1/events/{id}/register
 * (POST) — event_engine.py.
 *
 * Entirely additive: no existing api.ts or speakingLabApi.ts export is
 * changed. Follows the SAME auth/error/idempotency conventions as
 * speakingLabApi.ts (bearer token from localStorage, falling back to
 * the `student_session` cookie via credentials: "include") so both
 * clients behave identically from the student's perspective.
 *
 * Registration delegates server-side to the SAME atomic join
 * transaction speakingLabApi.ts's joinActive() already uses
 * (speaking_lab_direct_join._run_direct_join) — this client just calls
 * a different, event-template-driven entry point into it, so the
 * response shape below matches DirectJoinResponse exactly.
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

function _authHeadersGet(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("student_session_token")
      : null;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export interface AvailableEvent {
  _id: string;
  event_type: string;
  template_id: string;
  template_name: string;
  state: string;
  schedule: string;
  entry_fee: number;
}

export interface EventRegisterResult {
  ok: boolean;
  session_id: string;
  lucky_code: string;
  position: number;
  entry_fee: number;
  pool_total: number;
  player_count: number;
  idempotent_replay: boolean;
}

export class EventEngineApiError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

async function _parseError(res: Response): Promise<EventEngineApiError> {
  if (res.status === 401) {
    return new EventEngineApiError(
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
  return new EventEngineApiError(code, message, res.status);
}

/** One stable idempotency key per (browser, event) — mirrors
 * speakingLabApi.ts's getOrCreateJoinIdempotencyKey so a page refresh
 * or double-tap on the same event can never register twice. */
export function getOrCreateEventRegisterIdempotencyKey(eventId: string): string {
  const storageKey = `event_register_idem:${eventId}`;
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
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export const eventEngineApi = {
  /** List every event currently open for registration or already live,
   * across every event_type — not just Speaking Lab. Charge-free read,
   * safe to call on mount. */
  async listAvailableEvents(): Promise<AvailableEvent[]> {
    if (!RENDER_BASE) {
      throw new EventEngineApiError("backend_unreachable", "REACT_APP_BACKEND_URL is not set", 0);
    }
    const res = await fetch(`${RENDER_BASE}/api/v1/events/available`, {
      method: "GET",
      credentials: "include",
      headers: _authHeadersGet(),
    });
    if (!res.ok) throw await _parseError(res);
    const data = await res.json();
    return (data.events || []) as AvailableEvent[];
  },

  /** Register for one event. One attempt, a stable per-event
   * idempotency key — the SAME "ambiguity resolved by re-checking, never
   * a blind re-POST" discipline as speakingLabApi.ts's joinActive(). */
  async registerForEvent(eventId: string): Promise<EventRegisterResult> {
    if (!RENDER_BASE) {
      throw new EventEngineApiError("backend_unreachable", "REACT_APP_BACKEND_URL is not set", 0);
    }
    const idempotencyKey = getOrCreateEventRegisterIdempotencyKey(eventId);
    const res = await fetch(`${RENDER_BASE}/api/v1/events/${encodeURIComponent(eventId)}/register`, {
      method: "POST",
      credentials: "include",
      headers: _authHeaders(),
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    });
    if (!res.ok) throw await _parseError(res);
    const data = await res.json();
    return data.result as EventRegisterResult;
  },
};
