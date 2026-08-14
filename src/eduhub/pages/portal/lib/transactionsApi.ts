/**
 * transactionsApi.ts -- Phase 5 (Mongo Points Ledger + My Portal SoT v1.0.2)
 *
 * Typed client for the corrected authoritative ledger endpoints:
 *
 *   GET /api/student/points/transactions   (timeline)
 *   GET /api/student/points/latest         (latest confirmed credit)
 *
 * The endpoints read from MongoDB `points_wallets` (balance) and
 * `points_transactions` (ledger). Supports both legacy shadow_writer
 * rows (from_id / to_id / type) AND future WalletService rows
 * (student_id / operation / delta / balance_after), so the My Portal
 * timeline reflects the real current ledger shape instead of an
 * empty list.
 *
 * Failure mode: every call is wrapped to NEVER throw to React. If the
 * Render backend is unreachable, returns `{ ok: false, ... }` so the
 * component can display a graceful "history temporarily unavailable"
 * fallback without breaking the rest of the Portal.
 *
 * v1.0.2 -- My Portal Premium reconstruction
 * ------------------------------------------
 *   In the previous build the production My Portal showed the literal
 *   string "Backend URL not configured" inside the Transaction History
 *   card. The root cause was a preflight `if (!RENDER_BASE) { ... }`
 *   guard that short-circuited the helper with that exact message
 *   whenever `process.env.REACT_APP_BACKEND_URL` was unset OR not
 *   inlined by CRA at build time. Every other working API helper in
 *   the project (voucherApi.js, loginRewardApi.js, referralApi.js,
 *   aiAssistantApi.js) uses a simpler pattern: they accept an empty
 *   BASE silently and let the relative-URL fetch run; a network
 *   failure then surfaces through the normal try/catch.
 *
 *   We align this helper with that pattern. Three behavioural changes:
 *
 *     1. Drop the `typeof process !== "undefined" && process.env && ...`
 *        guard. CRA always injects `process.env.REACT_APP_BACKEND_URL`
 *        as a literal at build time, and the guard was preventing
 *        inlining in some toolchain configurations.
 *     2. Remove the "Backend URL not configured" pre-bail. If the env
 *        var is unset, we still attempt the relative fetch -- exactly
 *        like voucherApi.js. The component-level honest error fallback
 *        ("Transaction history is temporarily unavailable") then renders
 *        instead of the developer-facing config string.
 *     3. Surface non-2xx HTTP responses with the same `{ ok:false }`
 *        shape so the component continues to branch cleanly.
 *
 *   Truth contract is unchanged: NO localStorage transaction history,
 *   NO fake rows, NO mocked data -- only real Mongo `points_transactions`
 *   rows are ever returned.
 */

/* eslint-disable no-undef */
const RENDER_BASE: string = (
  (process.env.REACT_APP_BACKEND_URL as string | undefined) || ""
).replace(/\/$/, "");
/* eslint-enable no-undef */

export type TransactionDirection = "credit" | "debit";
export type TransactionStatus =
  | "confirmed"
  | "pending"
  | "shadow"
  | "failed";

export interface LedgerTransaction {
  id: string;
  direction: TransactionDirection;
  /** Absolute amount, always >= 0. */
  amount: number;
  /** Signed amount: negative for debits, positive for credits. */
  signed_amount: number;
  /** English friendly title (Login reward / Book unlocked / etc.). */
  title: string;
  /** Optional Khmer label. */
  title_km?: string;
  /** Optional one-line context (provider ref, book slug, counterparty). */
  description?: string;
  /** Raw source code from the ledger (payment_bridge, p2p_send, ...). */
  source: string;
  /** Display status badge. Most rows ship as "confirmed". */
  status: TransactionStatus;
  /** ISO-8601 UTC. */
  created_at?: string;
  /** Counterparty wallet id, for P2P transfers. */
  related_student_id?: string | null;
  /** Book slug, for unlock rows. */
  book_slug?: string | null;
  /** Raw `operation` / `type` field -- admin debugging only. */
  raw_type?: string | null;
  /** Post-mutation wallet balance, when the row recorded one. */
  balance_after?: number | null;
}

export interface TransactionsResponse {
  success: true;
  student_id: string;
  wallet_id: string;
  balance: number | null;
  transactions: LedgerTransaction[];
  next_cursor: string | null;
  count: number;
  /** v1.0.1 -- always false for student timeline (shadow rows hidden). */
  includes_shadow: boolean;
}

export interface LatestResponse {
  success: true;
  student_id: string;
  /** Newest confirmed CREDIT row, or null when only shadow/no rows. */
  transaction: LedgerTransaction | null;
}

export interface TransactionsFailure {
  ok: false;
  status: number;
  message: string;
}

export interface TransactionsSuccess {
  ok: true;
  data: TransactionsResponse;
}

export interface LatestSuccess {
  ok: true;
  data: LatestResponse;
}

export type TransactionsResult = TransactionsSuccess | TransactionsFailure;
export type LatestResult = LatestSuccess | TransactionsFailure;

function _bearer(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return (
      localStorage.getItem("student_session_token") ||
      localStorage.getItem("session_token") ||
      null
    );
  } catch {
    return null;
  }
}

function _buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bearer = _bearer();
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return headers;
}

/**
 * Fetch the calling student's normalised ledger. Always resolves
 * (never throws) so React renderers can branch on `result.ok` cleanly.
 */
export async function fetchStudentTransactions(
  options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {},
): Promise<TransactionsResult> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const url =
    `${RENDER_BASE}/api/student/points/transactions` +
    (params.toString() ? `?${params.toString()}` : "");

  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: _buildHeaders(),
      signal: options.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as TransactionsResponse | null;
    if (!data || data.success !== true || !Array.isArray(data.transactions)) {
      return {
        ok: false,
        status: 200,
        message: "Malformed response",
      };
    }
    return { ok: true, data };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, message: "aborted" };
    }
    return {
      ok: false,
      status: 0,
      message: err?.message || "Network error",
    };
  }
}

/**
 * Fetch the calling student's newest CONFIRMED credit row. Returns
 * `null` when only shadow rows or no rows exist -- the UI must show
 * an honest empty state in that case, not a guessed reward.
 */
export async function fetchLatestConfirmedCredit(
  options: { signal?: AbortSignal } = {},
): Promise<LatestResult> {
  const url = `${RENDER_BASE}/api/student/points/latest`;
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: _buildHeaders(),
      signal: options.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as LatestResponse | null;
    if (!data || data.success !== true) {
      return {
        ok: false,
        status: 200,
        message: "Malformed response",
      };
    }
    return { ok: true, data };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, message: "aborted" };
    }
    return {
      ok: false,
      status: 0,
      message: err?.message || "Network error",
    };
  }
}

/** Cheap relative-time formatter shared with the timeline component. */
export function ledgerRelativeTime(
  iso: string | null | undefined,
  lang: "en" | "km" = "en",
): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  const hr = Math.floor(diff / 3_600_000);
  const day = Math.floor(diff / 86_400_000);
  if (lang === "km") {
    if (min < 1) return "មុននេះ";
    if (min < 60) return `${min} នាទីមុន`;
    if (hr < 24) return `${hr} ម៉ោងមុន`;
    if (day < 2) return "ម្សិលមិញ";
    if (day < 30) return `${day} ថ្ងៃមុន`;
    return `${Math.floor(day / 30)} ខែមុន`;
  }
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 2) return "yesterday";
  if (day < 30) return `${day} days ago`;
  return `${Math.floor(day / 30)} months ago`;
}
