/**
 * liveCoachRewardPanelLogic.js — PURE logic for the PERSISTENT EduTalk Live
 * Coach Surprise Reward panel (hotfix v1).
 *
 * The panel is backend-truth-driven: it renders ONLY what the server reports
 * via `GET /api/edutalk/reward-status` (the `status` object) merged with the
 * already-authoritative WebSocket/offer reward state (`reward`). The frontend
 * NEVER infers eligibility from Gemini praise or local counters.
 *
 * Everything here is a pure, synchronous helper so the project's Jest suite
 * can exercise the decision logic without rendering React — the code under
 * test IS the code that ships.
 */

// Backend state-contract values (see student_reward_status in
// edutalk_coach_reward_tools.py).
export const PANEL_STATES = Object.freeze([
  "disabled",
  "unavailable",
  "tracking",
  "progressing",
  "eligible",
  "claiming",
  "confirmed",
  "terminal",
  "expired",
]);

// States that are still "live" and worth polling. Truly FINAL states
// (confirmed / terminal / expired) stop the status poll loop.
//
// v3 Blocker 1B — `disabled` and `unavailable` are RECOVERABLE, not final:
// a Studio gate switched OFF and later ON during the SAME session must
// restore the panel WITHOUT a reconnect. So both are kept pollable at the
// controlled interval for the active session, allowing the bounded,
// single-flight, generation-safe controller to detect a re-enable and flip
// the panel back to eligible. (`unavailable` was already pollable to recover
// from a transient index warm-up.)
const POLLABLE_STATUS = new Set([
  "tracking",
  "progressing",
  "eligible",
  "claiming",
  "unavailable",
  "disabled",
]);

export function shouldKeepPollingStatus(state) {
  return POLLABLE_STATUS.has(String(state || ""));
}

// v3 Blocker 1A — authoritative backend statuses that MUST override a stale
// local WebSocket offer. Once the backend has moved on to any of these, a
// cached local offer can no longer present a clickable surprise.
const CONTRADICTORY_STATUS = new Set([
  "disabled",
  "unavailable",
  "claiming",
  "confirmed",
  "terminal",
  "expired",
]);

// A local offer may only drive an immediate `eligible` transition when it
// belongs to the CURRENT session. Only a DEFINITE mismatch (both ids present
// and different) disqualifies it — when either id is absent we do not
// contradict, because the reducer already session-validates offers upstream.
function offerMatchesSession(offer, status) {
  const offerSid = offer && offer.session_id;
  const statusSid = status && status.session_id;
  if (offerSid && statusSid && String(offerSid) !== String(statusSid)) {
    return false;
  }
  return true;
}

/**
 * Merge the authoritative server status with the live WebSocket/offer reward
 * state into a single presentation "mode".
 *
 * v3 Blocker 1A — the LATEST AUTHORITATIVE backend status now takes precedence
 * over a stale local offer. Precedence order:
 *   1. Local CONFIRMED truth (the claim already succeeded locally) — real and
 *      never masked.
 *   2. A contradictory authoritative backend status
 *      (disabled / unavailable / claiming / confirmed / terminal / expired)
 *      OVERRIDES any cached local offer, so the panel can never present a
 *      stale clickable surprise after the backend has moved on.
 *   3. A local claim-in-flight (the user just tapped) wins over the non-final
 *      tracking / progressing / eligible statuses.
 *   4. A local WebSocket offer grants an IMMEDIATE `eligible` transition ONLY
 *      when no contradictory status exists, the offer belongs to the current
 *      session, and no claim/final state is active.
 *   5. Otherwise fall back to the remaining server-status contract.
 *
 * Returns one of:
 *   "hidden" | "tracking" | "progressing" | "eligible" |
 *   "claiming" | "confirmed" | "terminal" | "expired"
 */
export function resolvePanelMode(status, reward) {
  const r = reward || {};
  const st = status && status.state;

  // 1) Local authoritative CONFIRMED truth wins (claim already succeeded).
  if (r.result || r.revealOpen) return "confirmed";

  // 2) A contradictory authoritative backend status overrides a stale offer.
  if (CONTRADICTORY_STATUS.has(String(st || ""))) {
    switch (st) {
      case "confirmed":
        return "confirmed";
      case "claiming":
        return "claiming";
      case "terminal":
        return "terminal";
      case "expired":
        return "expired";
      case "disabled":
      case "unavailable":
      default:
        return "hidden";
    }
  }

  // 3) Local claim-in-flight (user just tapped) wins over non-final statuses.
  if (r.claiming) return "claiming";

  // 4) A current-session local WS offer may flip immediately to eligible.
  if (r.offer && r.offer.offer_id && offerMatchesSession(r.offer, status)) {
    return "eligible";
  }

  // 5) Fall back to the remaining (non-contradictory) server statuses.
  switch (st) {
    case "eligible":
      return "eligible";
    case "progressing":
      return "progressing";
    case "tracking":
      return "tracking";
    default:
      return "hidden";
  }
}

// v4 Blocker 1 — a local offer id may only be used as the CLAIM id when it
// POSITIVELY belongs to the current session. When a current session id is
// known (an explicit `sessionId`, else `status.session_id`), the local offer
// must carry the SAME session id — a different-session OR missing-session
// local offer is rejected. When no session context exists at all we fall back
// to the permissive, reducer-validated assumption (offers are session-checked
// upstream) so existing session-less callers keep working.
function localOfferBelongsToCurrentSession(localOffer, status, sessionId) {
  const offerSid = localOffer && localOffer.session_id;
  const currentSid =
    sessionId || (status && status.session_id) || null;
  if (currentSid) {
    return !!offerSid && String(offerSid) === String(currentSid);
  }
  return true;
}

/**
 * v4 Blocker 1 — select the authoritative CURRENT-SESSION claim offer id.
 *
 * `resolvePanelMode` already rejects a different-session offer for the
 * presentation MODE, but the clickable CLAIM id must be chosen with the same
 * session discipline (the v3 defect selected `local || status` blindly):
 *   - a contradictory / final / claiming status yields NO claim id;
 *   - for an authoritative backend `eligible` status the BACKEND offer id wins
 *     (it supersedes any local id); a verified current-session local id is used
 *     only when the backend supplied none; otherwise null (render non-clickable
 *     rather than guess);
 *   - for the non-contradictory tracking/progressing statuses a verified
 *     current-session local offer supplies the id (immediate WS eligibility),
 *     else any backend-supplied id.
 *
 * A different-session or missing-session local offer can NEVER supply the id.
 */
export function selectClaimOfferId(status, reward, sessionId = null) {
  const r = reward || {};
  const st = (status && status.state) || "";
  const statusOfferId = (status && status.offer_id) || null;
  const localOffer = r.offer || null;
  const localOfferId = (localOffer && localOffer.offer_id) || null;

  // No claim id is ever offered for a contradictory / final / claiming state.
  if (CONTRADICTORY_STATUS.has(st)) return null;

  const localUsable =
    !!localOfferId &&
    localOfferBelongsToCurrentSession(localOffer, status, sessionId);

  if (st === "eligible") {
    // Authoritative backend eligibility — backend offer id supersedes.
    if (statusOfferId) return statusOfferId;
    if (localUsable) return localOfferId;
    return null; // eligible but no safe id → caller renders non-clickable
  }

  // tracking / progressing / unknown: a verified current-session local offer
  // grants immediate eligibility; otherwise defer to any backend offer id.
  if (localUsable) return localOfferId;
  return statusOfferId;
}

// ─────────────────────────────────────────────────────────────────────────
// v7 — THE single, canonical, authoritative claim-outcome normalizer shared by
// BOTH the REST claim path AND the WebSocket `reward_claim_failed` path. v6
// only recognised `unavailable`/`disabled`; without normalising the richer
// backend claim lifecycle, outcomes such as `expired`, `grant_terminal_failed`,
// `claim_reserved`, or `grant_unknown` could clear the claim spinner while
// leaving the stale eligible offer clickable. There is ONE mapping — the REST
// and WS helpers below both delegate to it; aliases are never duplicated.
//
// Canonical outcomes (the only non-null return values):
//   "unavailable" | "disabled" | "claiming" | "expired" | "terminal"
//
// Backend alias provenance (eduhub-backend-master/edutalk_coach_reward_tools.py):
//   * REST `_safe_claim_result.state`         → pending_confirmation, expired,
//                                                grant_terminal_failed,
//                                                failed_terminal
//     (granted/confirmed are handled by the confirm path, not here).
//   * WS `reward_claim_failed.reason`         → `state or "unknown"` where the
//                                                state may be expired /
//                                                grant_terminal_failed /
//                                                failed_terminal / claim_reserved
//                                                / grant_dispatching; plus
//                                                unavailable / disabled gate
//                                                closures; plus internal_error
//                                                and arbitrary HTTPException
//                                                detail strings (NON-authoritative).
//   * dispatch / recovery lifecycle           → grant_dispatching, grant_retryable,
//                                                grant_unknown, claim_reserved,
//                                                pending.
// ─────────────────────────────────────────────────────────────────────────
export const CANONICAL_CLAIM_OUTCOMES = Object.freeze([
  "unavailable",
  "disabled",
  "claiming",
  "expired",
  "terminal",
]);

const AUTHORITATIVE_CLAIM_OUTCOME_MAP = Object.freeze({
  // Non-operational — a Studio/provider gate is closed.
  unavailable: "unavailable",
  disabled: "disabled",
  // In-flight or unresolved — the claim is progressing; never re-submit.
  pending_confirmation: "claiming",
  pending: "claiming",
  claim_reserved: "claiming",
  grant_dispatching: "claiming",
  grant_retryable: "claiming",
  retryable: "claiming",
  grant_unknown: "claiming",
  unknown: "claiming",
  // The offer window elapsed.
  expired: "expired",
  // Terminal unsuccessful grant — the backend idempotency record is preserved.
  grant_terminal_failed: "terminal",
  failed_terminal: "terminal",
  terminal: "terminal",
});

/**
 * v7 — Map a single raw lifecycle value to its canonical claim outcome. PURE.
 * Returns null for any unrecognised value (internal_error, network_error,
 * timeout, arbitrary HTTPException detail strings, empty/whitespace, or a
 * non-string) so callers never fabricate an authoritative lifecycle state and
 * keep ordinary retryable-error behaviour.
 */
export function normalizeAuthoritativeClaimOutcome(rawValue) {
  if (typeof rawValue !== "string") return null;
  const key = rawValue.trim();
  if (!key) return null;
  return AUTHORITATIVE_CLAIM_OUTCOME_MAP[key] || null;
}

/**
 * v7 — Resolve the canonical claim outcome from a WebSocket
 * `reward_claim_failed` event. Precedence (per the locked spec):
 *   1. a RECOGNISED `event.state` (future payload shape) wins;
 *   2. otherwise a RECOGNISED `event.reason` (current production shape
 *      `{ type: "reward_claim_failed", offer_id, reason }`);
 *   3. otherwise null.
 * Exported for the source/contract test that verifies the frontend normalizer
 * stays compatible with the actual backend emission shapes.
 */
export function normalizeWsClaimFailedOutcome(event) {
  if (!event || event.type !== "reward_claim_failed") return null;
  const fromState = normalizeAuthoritativeClaimOutcome(event.state);
  if (fromState) return fromState;
  return normalizeAuthoritativeClaimOutcome(event.reason);
}

/**
 * v7 — Build the IMMEDIATE non-clickable status object from a canonical claim
 * outcome. PURE. Used by BOTH the REST and WebSocket paths so they converge on
 * identical truth. Returns null for a null/unrecognised outcome (caller keeps
 * ordinary retryable behaviour).
 *
 * Per-category behaviour:
 *   - unavailable / disabled: operational:false; the DISPLAYED offer_id is
 *     cleared (the server offer is preserved server-side); calm inactive_reason.
 *   - claiming (in-flight/unresolved): state "claiming"; the displayed offer id
 *     is PRESERVED for server recovery, but the derived panel is non-clickable
 *     for a claiming state regardless (resolvePanelMode / selectClaimOfferId),
 *     so no second claim can be submitted.
 *   - expired: state "expired"; stale displayed claimability removed.
 *   - terminal: state "terminal"; stale displayed claimability removed; the
 *     backend idempotency record is untouched (only the client display clears).
 */
export function statusFromAuthoritativeClaimOutcome(
  prevStatus, outcome, sessionId = null, reason = null,
) {
  if (!outcome) return null;
  const prev = prevStatus || {};
  const base = {
    ...prev,
    success: true,
    session_id: sessionId || prev.session_id || null,
  };
  const inactiveReason = reason || prev.inactive_reason || null;
  switch (outcome) {
    case "unavailable":
    case "disabled":
      return {
        ...base,
        operational: false,
        state: outcome,
        offer_id: null, // hide the stale clickable offer (server offer kept)
        inactive_reason: inactiveReason,
      };
    case "claiming":
      return {
        ...base,
        operational: true,
        state: "claiming",
        // offer_id intentionally preserved for server recovery; the panel is
        // non-clickable for a claiming state via the derived-panel logic.
        inactive_reason: prev.inactive_reason || null,
      };
    case "expired":
      return {
        ...base,
        operational: false,
        state: "expired",
        offer_id: null,
        inactive_reason: inactiveReason,
      };
    case "terminal":
      return {
        ...base,
        operational: false,
        state: "terminal",
        offer_id: null,
        inactive_reason: inactiveReason,
      };
    default:
      return null;
  }
}

/**
 * v7 — REST claim-response path. Normalises `data.state` through the SAME
 * canonical mapping and delegates to `statusFromAuthoritativeClaimOutcome`.
 * Returns null for a non-authoritative response (network error, internal_error,
 * granted/confirmed handled by the confirm branch) so the caller keeps ordinary
 * retryable behaviour. Exported as `statusFromRestClaimUnavailable` too for
 * backward compatibility — same function, same single mapping.
 */
export function statusFromRestClaimOutcome(prevStatus, data, sessionId = null) {
  const outcome = normalizeAuthoritativeClaimOutcome(data && data.state);
  return statusFromAuthoritativeClaimOutcome(
    prevStatus, outcome, sessionId, (data && data.reason) || null);
}
export const statusFromRestClaimUnavailable = statusFromRestClaimOutcome;

/**
 * v7 — WebSocket `reward_claim_failed` path. Resolves the canonical outcome via
 * `normalizeWsClaimFailedOutcome` (state→reason precedence) and delegates to
 * the SAME `statusFromAuthoritativeClaimOutcome` builder, so the live socket
 * and the REST fallback converge on identical truth. Returns null for any
 * non-authoritative failure so an ordinary claim error keeps its retryable
 * behaviour and never fabricates a lifecycle state.
 */
export function statusFromWsClaimFailed(prevStatus, event, sessionId = null) {
  const outcome = normalizeWsClaimFailedOutcome(event);
  return statusFromAuthoritativeClaimOutcome(
    prevStatus, outcome, sessionId, (event && event.reason) || null);
}

/**
 * v5 Blocker 2 — reconcile a same-session reward-STATUS response against the
 * claim-truth REVISION barrier. A status poll captures the revision at dispatch;
 * if a NEWER authoritative claim outcome bumps the revision while the request is
 * still in flight, the now-stale response must NOT override the newer truth.
 * Instead the caller drops the stale body and queues exactly ONE coalesced
 * refresh through the single-flight controller (never overlapping an in-flight
 * request). Returns `{ apply, queueRefresh }`: when the revision is unchanged
 * the response applies normally and nothing extra is queued.
 */
export function reconcileStatusRevision(revisionAtRequest, currentRevision) {
  const superseded = Number(currentRevision) !== Number(revisionAtRequest);
  return { apply: !superseded, queueRefresh: superseded };
}

/**
 * Compute the full, render-ready panel view from `status` + `reward`. PURE.
 *
 * Locked rules enforced here:
 *   - `clickable` is true ONLY for the eligible mode AND only when a real
 *     server offer_id exists. Tracking / progressing / claiming are never
 *     clickable.
 *   - `showAmount` (and any amount text) is true ONLY for the confirmed mode
 *     — the exact reward is hidden before an authoritative confirmed grant.
 *   - disabled / unavailable → `visible:false` by default (the panel hides
 *     rather than promising a reward the backend cannot issue). A subtle
 *     admin-only diagnostic can be opted in with `showDiagnostics`.
 */
export function deriveRewardPanel(
  { status, reward, showDiagnostics = false, sessionId = null } = {},
) {
  const mode = resolvePanelMode(status, reward);
  const r = reward || {};
  // v4 Blocker 1 — the clickable CLAIM id is chosen with session discipline
  // (backend-preferring, current-session-only) instead of the old blind
  // `local || status` selection.
  const offerId = selectClaimOfferId(status, reward, sessionId);
  const correctionPending = !!(status && status.correction_goal_pending);

  const base = {
    mode,
    visible: true,
    clickable: false,
    offerId: null,
    tone: "locked",
    icon: "lock",
    title: "Surprise Reward",
    subtitle: "",
    showAmount: false,
    amountText: "",
    busy: false,
    ariaLabel: "Surprise reward",
  };

  switch (mode) {
    case "tracking":
      return {
        ...base,
        tone: "locked",
        icon: "lock",
        title: "Surprise Reward",
        subtitle: correctionPending
          ? "Your coach is tracking your progress"
          : "Keep practicing to unlock",
        ariaLabel: "Surprise reward locked — keep practicing to unlock",
      };
    case "progressing":
      return {
        ...base,
        tone: "progress",
        icon: "sparkle",
        title: "Almost ready",
        subtitle: "Strong practice detected — stay with your coach",
        ariaLabel: "Surprise reward — you are building momentum",
      };
    case "eligible":
      return {
        ...base,
        tone: "eligible",
        icon: "gift",
        title: "A surprise is ready",
        subtitle: "Tap to reveal",
        clickable: !!offerId,
        offerId,
        ariaLabel: "A surprise reward is ready — tap to reveal",
      };
    case "claiming":
      return {
        ...base,
        tone: "claiming",
        icon: "spinner",
        title: "Opening your surprise…",
        subtitle: "",
        busy: true,
        offerId,
        ariaLabel: "Opening your surprise",
      };
    case "confirmed": {
      const summary =
        (r.result && r.result.reward_summary) ||
        (status && status.reward_summary) ||
        (r.result && typeof r.result.reward_amount === "number"
          ? `${r.result.reward_amount} EduHub Points`
          : "");
      return {
        ...base,
        tone: "confirmed",
        icon: "check",
        title: "Reward received",
        subtitle: summary,
        showAmount: !!summary,
        amountText: summary,
        ariaLabel: summary
          ? `Reward received: ${summary}`
          : "Reward received",
      };
    }
    case "terminal":
      return {
        ...base,
        tone: "locked",
        icon: "lock",
        title: "Surprise Reward",
        subtitle: "Keep practicing — more chances ahead",
        ariaLabel: "Surprise reward — keep practicing",
      };
    case "expired":
      return {
        ...base,
        tone: "locked",
        icon: "lock",
        title: "Surprise Reward",
        subtitle: "That one expired — keep practicing",
        ariaLabel: "Surprise reward expired — keep practicing",
      };
    case "hidden":
    default: {
      // disabled / unavailable. Hidden unless an admin opts into the subtle
      // diagnostic — and even then we never promise a reward.
      if (showDiagnostics && status && status.inactive_reason) {
        return {
          ...base,
          visible: true,
          tone: "diagnostic",
          icon: "lock",
          title: "Surprise Reward",
          subtitle: `Unavailable (${status.inactive_reason})`,
          ariaLabel: `Surprise reward unavailable: ${status.inactive_reason}`,
        };
      }
      return { ...base, visible: false };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Bounded, single-flight, GENERATION-SAFE status poll controller.
//
// Separate from the offer-recovery and announcement-retry controllers. It
// keeps the persistent panel in sync with backend truth while the reward is
// not yet final.
//
// v2 Blocker 2 — every execution is tagged with a GENERATION token. A stale
// request (one that started before a cancel()/session change) can NEVER mutate
// the new session's state: its settle()/timer is ignored because its token no
// longer matches the current generation. This eliminates the audited race
// where request A from session A settled after session B started and cleared
// B's in-flight flag (allowing request C to overlap B).
//
// Invariants (asserted by the Jest suite):
//   * at most ONE timer and at most ONE in-flight request exist at a time;
//   * `start()` / `poke()` PASS the active generation token to `execute(token)`;
//   * `settle(token, keepGoing)` IGNORES a stale token completely — it does not
//     clear in-flight, touch the timer, start a request, or mutate state;
//   * `cancel()` increments the generation, invalidating any in-flight/timer
//     completion, and clears everything;
//   * `start()` (session (re)start) also increments the generation so any
//     prior in-flight request becomes stale.
// It performs NO IO itself — `setTimer` / `clearTimer` / `execute` are
// injected so it is deterministic and unit-testable.
// ─────────────────────────────────────────────────────────────────────────
export function createStatusPollController({
  setTimer,
  clearTimer,
  execute = () => {},
  intervalMs = 5000,
} = {}) {
  const state = {
    timer: null,
    inflight: false,
    active: false,
    generation: 0, // bumped on cancel() and start(); tags each execution
    requests: 0,
  };

  // Begin exactly one request for the CURRENT generation. Caller guarantees
  // we are active and not already in-flight.
  function _begin() {
    state.inflight = true;
    state.requests += 1;
    const token = state.generation;
    execute(token);
    return token;
  }

  function _schedule() {
    if (!state.active) return false;
    if (state.timer) return false;
    if (state.inflight) return false;
    const gen = state.generation;
    state.timer = setTimer(() => {
      state.timer = null;
      // Stale timer from a previous generation — ignore.
      if (gen !== state.generation) return;
      if (!state.active || state.inflight) return;
      _begin();
    }, intervalMs);
    return true;
  }

  // Session (re)start: invalidate any prior generation/in-flight/timer, then
  // run one immediate request under a fresh generation.
  function start() {
    state.generation += 1;
    if (state.timer && clearTimer) {
      clearTimer(state.timer);
      state.timer = null;
    }
    state.inflight = false; // any prior in-flight is now stale (token changed)
    state.active = true;
    return _begin();
  }

  // Request a poll "soon" without ever creating a second in-flight request.
  // Coalesces into the single in-flight slot if one is already running.
  function poke() {
    if (!state.active) return start();
    if (state.inflight) return null; // coalesce — current request covers it
    if (state.timer && clearTimer) {
      clearTimer(state.timer);
      state.timer = null;
    }
    return _begin();
  }

  // Complete a request. A stale token (from a cancelled/superseded generation)
  // is ignored COMPLETELY — it must not clear in-flight, touch the timer,
  // start another request, or mutate the new session's state.
  function settle(token, keepGoing) {
    if (token !== state.generation) return false; // stale — ignore
    if (!state.inflight) return false;
    state.inflight = false;
    if (keepGoing && state.active) return _schedule();
    return false;
  }

  // Cancel (unmount / session change / final state). Increment the generation
  // so any outstanding request's completion becomes a no-op.
  function cancel() {
    state.generation += 1;
    if (state.timer && clearTimer) clearTimer(state.timer);
    state.timer = null;
    state.inflight = false;
    state.active = false;
  }

  return {
    state,
    start,
    settle,
    poke,
    cancel,
    isActive: () => state.active,
    isInflight: () => state.inflight,
    getGeneration: () => state.generation,
    getRequests: () => state.requests,
  };
}
