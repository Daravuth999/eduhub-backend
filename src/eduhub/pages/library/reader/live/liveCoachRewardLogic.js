/**
 * liveCoachRewardLogic.js — Pure functions for the EduTalk Live Coach
 * reward UI behaviors. Extracted so the project's Jest-based test suite
 * can exercise the decision logic without rendering React components.
 *
 * All exports are pure synchronous helpers — they take state and a
 * message and return a new state object. The actual React component
 * (`EduTalkLiveCoach.jsx`) consumes these via `useReducer`-style calls.
 */

/**
 * Initial reward UI state. Centralised so the React component and tests
 * agree on the shape exactly.
 */
export const initialRewardState = Object.freeze({
  offer: null,           // {offer_id, session_id, label, message, expires_at}
  claiming: false,
  result: null,          // backend-confirmed result; null until confirmed
  revealOpen: false,
  confirmedMessage: "",
  error: "",
  claimedOfferIds: [],   // ids whose reveal already fired (dedup guard)
});

/**
 * Apply a backend → frontend reward WS event to the current reward UI
 * state. Returns a NEW state object. The function:
 *  - rejects offer events whose ``session_id`` does not match the
 *    currently-active session_id;
 *  - never shows a reveal except for a ``reward_claim_confirmed`` event;
 *  - never duplicates a reveal — every offer_id can fire at most once;
 *  - leaves the offer mounted on a failed claim so the student may
 *    safely retry.
 *
 * @param {object} state  — current reward UI state.
 * @param {object} event  — a single WS reward event (`msg`).
 * @param {string} currentSessionId — the active live-coach session id.
 */
export function applyRewardEvent(state, event, currentSessionId) {
  if (!event || typeof event.type !== "string") return state;
  switch (event.type) {
    case "reward_offer_available": {
      // B4 (audit) — STRICT session-bound filter. An offer event with
      // a missing or mismatched session_id MUST be ignored. We never
      // default a missing session_id to the active session id, because
      // that would let a stale or cross-session event mount a button.
      if (!event.session_id || event.session_id !== currentSessionId) {
        return state;
      }
      if (!event.offer_id) return state;
      if (state.claimedOfferIds.includes(event.offer_id)) return state;
      return {
        ...state,
        offer: {
          offer_id: event.offer_id,
          session_id: event.session_id,
          label: event.button_label || "Your surprise is ready",
          message: event.pre_claim_message || "",
          expires_at: event.expires_at || null,
        },
        error: "",
      };
    }
    case "reward_claim_pending":
      return { ...state, claiming: true };
    case "reward_claim_confirmed": {
      const oid = event.offer_id;
      // Idempotent — duplicate confirmed event does NOT replay reveal.
      if (oid && state.claimedOfferIds.includes(oid)) {
        return { ...state, claiming: false };
      }
      return {
        ...state,
        claiming: false,
        offer: null,
        result: {
          offer_id: oid || null,
          reward_type: event.reward_type || null,
          reward_amount: event.reward_amount ?? null,
          reward_summary: event.reward_summary || "",
        },
        confirmedMessage: event.confirmed_message || state.confirmedMessage,
        revealOpen: true,
        claimedOfferIds: oid
          ? [...state.claimedOfferIds, oid]
          : state.claimedOfferIds,
      };
    }
    case "reward_claim_failed": {
      const reason = event.reason
        ? String(event.reason).slice(0, 80)
        : "Sorry — that surprise could not be confirmed.";
      // Leave the offer mounted so retry stays possible.
      return { ...state, claiming: false, error: reason };
    }
    default:
      return state;
  }
}

/**
 * Decide whether a click on the reward button should send a claim. The
 * frontend MUST suppress rapid duplicate taps WITHOUT removing the
 * underlying retry capability. Returns true iff the click should
 * trigger a network call.
 */
export function shouldSendClaimOnTap(state, offerId) {
  if (!offerId) return false;
  if (state.claiming) return false;
  if (state.claimedOfferIds.includes(offerId)) return false;
  return true;
}

/**
 * Compose the reveal payload from a CONFIRMED backend result. Returns
 * an object with the three visible fields the reveal UI displays.
 * Never falls back to a default if the result is missing — the reveal
 * must come from authoritative backend data.
 */
export function composeRevealPayload(result, confirmedMessage) {
  if (!result) return null;
  const summary =
    result.reward_summary ||
    (typeof result.reward_amount === "number"
      ? `${result.reward_amount} EduHub Points`
      : "");
  return {
    summary,
    rewardType: result.reward_type || "points",
    rewardAmount: result.reward_amount ?? null,
    message:
      confirmedMessage ||
      "Practice streak reward — you earned this through strong practice!",
  };
}

/**
 * Produce the safe student-name fallback used by the pre-claim button
 * hint. Trims, strips control chars, and falls back to neutral wording
 * when the source is empty — mirrors the backend ``_safe_first_name``.
 */
export function safeFirstName(displayName) {
  if (typeof displayName !== "string") return "";
  const first = displayName.trim().split(/\s+/)[0] || "";
  return first.replace(/[^\w\u0E00-\u17FF-]/g, "").slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────
// Blocker E — active-offer recovery + bounded polling (pure helpers).
// The component (`EduTalkLiveCoach.jsx`) consumes ONLY these helpers so the
// unit-tested recovery/polling logic IS the production logic. There is no
// divergent inline state machine.
// ─────────────────────────────────────────────────────────────────────────

/** Bounded-polling parameters. ``maxAttempts`` caps total polls; the delay
 * grows with exponential backoff up to ``maxDelayMs``. */
export const RECOVERY_POLL = Object.freeze({
  maxAttempts: 6,
  baseDelayMs: 1500,
  maxDelayMs: 12000,
});

/** States that are NOT yet final — these are the ONLY states that may be
 * polled. ``granted`` / terminal / ``expired`` are never polled. */
export function isPollableRecoveredState(state) {
  return (
    state === "pending_confirmation" ||
    state === "pending" ||
    state === "retryable" ||
    state === "grant_retryable" ||
    state === "unknown" ||
    state === "grant_unknown" ||
    // Finding 1 — pre-confirmation lifecycle states must also be
    // pollable so a transient pre-credit response (claim reserved on
    // the offer table, or grant dispatching to the provider) keeps
    // the bounded loop alive until the authoritative provider result
    // arrives. The backend's active-offer route normalizes these to
    // ``pending_confirmation`` already; the helper also accepts them
    // raw so a frontend-only normalization mismatch can never stall
    // polling.
    state === "claim_reserved" ||
    state === "grant_dispatching"
  );
}

/** States that are final — polling must STOP on these. */
export function isTerminalRecoveredState(state) {
  return (
    state === "granted" ||
    state === "confirmed" ||
    state === "grant_terminal_failed" ||
    state === "failed_terminal" ||
    state === "terminal" ||
    state === "expired"
  );
}

/** Exponential backoff delay for the Nth poll attempt (0-indexed), capped
 * at ``maxDelayMs``. Pure + deterministic so it is unit-testable. */
export function nextPollDelayMs(attempt) {
  const a = Math.max(0, Number(attempt) || 0);
  const d = RECOVERY_POLL.baseDelayMs * Math.pow(2, a);
  return Math.min(d, RECOVERY_POLL.maxDelayMs);
}

// ─────────────────────────────────────────────────────────────────────────
// Correction B — resilient bounded polling decisions (pure helpers).
// The EduTalkLiveCoach component calls these to decide whether to schedule
// another bounded poll after every active-offer fetch outcome (success,
// empty response, or transient error). All decisions are pure functions
// of the latest reward UI state and the outcome — no React, no timers, no
// IO. The same helpers back the behavioural Jest tests so the production
// component IS the controller under test.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Has the student got an UNRESOLVED reward claim in flight? Returns true
 * if the local reward state shows the student is mid-claim — i.e. a
 * confirmation could still arrive and the polling loop must NOT terminate
 * prematurely. False once the reveal opened, no offer is mounted, and
 * the claiming flag has cleared.
 */
export function hasUnresolvedRewardClaim(state) {
  if (!state) return false;
  if (state.revealOpen) return false;       // already revealed → done
  if (state.claiming) return true;          // a claim is in flight
  if (state.offer) return true;             // an offer button is mounted
  return false;
}

/**
 * Decide whether the bounded poll loop should reschedule itself after a
 * recovery cycle completes. Pure helper consumed by the component AND
 * by the behavioural test suite. Returns one of:
 *
 *   { schedule: false }                       — stop polling
 *   { schedule: true, stateHint: "<state>" } — schedule next bounded poll
 *
 * The state-hint is what ``scheduleRewardPoll`` consumes — only the
 * ``isPollableRecoveredState`` set survives, so terminal / granted /
 * expired never re-arm the loop here either.
 */
export function decideNextPoll({ outcome, recovered, prevState }) {
  // outcome ∈ {"recovered", "empty", "error", "stale"}
  if (outcome === "stale") return { schedule: false };
  if (outcome === "recovered" && recovered) {
    const st = recovered.state;
    if (isPollableRecoveredState(st)) {
      return { schedule: true, stateHint: st };
    }
    // granted / claimable / terminal / expired — no reschedule here.
    return { schedule: false };
  }
  // Empty or transient error — keep polling ONLY while a local claim
  // is still unresolved. This is what makes the loop resilient to a
  // single transient request rejection or temporary offer:null result.
  if (hasUnresolvedRewardClaim(prevState)) {
    return { schedule: true, stateHint: "pending_confirmation" };
  }
  return { schedule: false };
}

/**
 * Decide whether to RESET the bounded attempt counter for a new poll
 * cycle. Repeated pending events for the SAME offer must NOT reset the
 * counter (that would let the bounded loop become effectively
 * unbounded). Only a genuinely new offer / claim cycle resets. Pure
 * helper exercised directly in the behavioural tests.
 *
 *   prevCycleOfferId — id of the offer whose cycle is currently active
 *                       (or null / "" if no cycle is active).
 *   newOfferId        — id of the offer that just triggered a new
 *                       polling intent (may be falsy for WS events).
 *
 * Returns { reset: boolean, nextCycleOfferId: string|null }.
 */
export function shouldResetPollBudget(prevCycleOfferId, newOfferId) {
  if (!prevCycleOfferId) {
    // No cycle is currently active — this IS a new cycle.
    return {
      reset: true,
      nextCycleOfferId: newOfferId || prevCycleOfferId || null,
    };
  }
  if (newOfferId && newOfferId !== prevCycleOfferId) {
    // A different offer entered the unresolved state.
    return { reset: true, nextCycleOfferId: newOfferId };
  }
  // Same offer / same cycle — DO NOT reset the bounded budget.
  return { reset: false, nextCycleOfferId: prevCycleOfferId };
}

/**
 * Apply an authoritative backend recovery offer (from
 * ``GET /reward-offers/active``) to the reward UI state. STRICT
 * session-bound: a recovered offer whose ``session_id`` does not match the
 * active session is IGNORED (stale / cross-session responses can never
 * mount a button or replay a reveal). Delegates to ``applyRewardEvent`` so
 * the dedup / reveal-once / no-reveal-on-pending rules are shared exactly.
 *
 *  - ``granted`` / ``confirmed`` → reveal once (deduped by offer_id);
 *  - ``claimable`` / ``offered`` → mount the claim button;
 *  - pending / unknown / retryable → keep waiting, NEVER reveal success;
 *  - terminal / expired → clear claiming, NEVER reveal success.
 */
export function applyRecoveredOffer(state, recovered, currentSessionId) {
  if (!recovered || typeof recovered !== "object") return state;
  const sid = recovered.session_id;
  if (!sid || sid !== currentSessionId) return state; // stale/foreign
  const st = recovered.state;
  if (st === "granted" || st === "confirmed") {
    return applyRewardEvent(
      state,
      {
        type: "reward_claim_confirmed",
        offer_id: recovered.offer_id,
        session_id: sid,
        reward_type: recovered.reward_type,
        reward_amount: recovered.reward_amount,
        reward_summary: recovered.reward_summary || recovered.summary,
        confirmed_message: recovered.confirmed_message,
      },
      currentSessionId,
    );
  }
  if (st === "claimable" || st === "offered") {
    return applyRewardEvent(
      state,
      {
        type: "reward_offer_available",
        offer_id: recovered.offer_id,
        session_id: sid,
        button_label: recovered.button_label || recovered.label,
        pre_claim_message:
          recovered.pre_claim_message || recovered.message || "",
        expires_at: recovered.expires_at,
      },
      currentSessionId,
    );
  }
  if (isPollableRecoveredState(st)) {
    // Already claimed and still confirming — reflect the spinner but NEVER
    // reveal success. Polling continues until granted/terminal/expired.
    return { ...state, claiming: true, error: "" };
  }
  // terminal / expired — no success reveal; stop the spinner.
  return { ...state, claiming: false };
}


// ─────────────────────────────────────────────────────────────────────────
// Correction 2 (final) — PRODUCTION bounded-poll controller.
//
// This factory IS the single production polling controller. The
// EduTalkLiveCoach component uses it directly (with real
// setTimeout/clearTimeout/Date.now), and the behavioural Jest suite uses
// the SAME factory with fake timer dependencies. There is no separately
// reconstructed imitation of the gate — the code under test is the code
// that ships.
//
// The controller owns the timer-starvation gate, the bounded attempt
// budget, the per-cycle reset rule, the same-session reconnect rule, and
// the no-overlap (single in-flight request) invariant. It performs NO IO
// itself: scheduling and the actual recovery request are injected via
// ``setTimer`` / ``clearTimer`` / ``now`` / ``execute`` so it is fully
// deterministic and unit-testable.
//
// Invariants enforced here (and asserted by the real-controller tests):
//   * duplicate same-offer pending events while a timer is pending do NOT
//     clear it, do NOT schedule another, and consume ZERO attempt budget;
//   * an attempt is consumed ONLY when a scheduled timer fires and runs a
//     recovery request (execution), never on an incoming event;
//   * at most one timer and at most one in-flight request exist at a time;
//   * a same-session reconnect never resets the bounded budget; a new
//     session does;
//   * only ``isPollableRecoveredState`` hints ever (re)arm the loop, so
//     granted / terminal / expired stop polling;
//   * ``cancel()`` (unmount / session change) clears the timer and budget.
//
// Dependencies:
//   setTimer(cb, ms) -> token        schedule a one-shot timer
//   clearTimer(token)                cancel a scheduled timer
//   now() -> ms                      monotonic-ish clock (diagnostics only)
//   execute()                        run exactly one recovery request; the
//                                    caller MUST eventually call settle()
//   maxAttempts                      bounded budget (defaults to RECOVERY_POLL)
// ─────────────────────────────────────────────────────────────────────────
export function createRewardPollController({
  setTimer,
  clearTimer,
  now = () => 0,
  execute = () => {},
  maxAttempts = RECOVERY_POLL.maxAttempts,
} = {}) {
  const state = {
    timer: null,            // active timer token, or null
    timerExpiresAt: null,   // diagnostics
    attempts: 0,            // EXECUTED recovery requests in this cycle
    inflight: false,        // a recovery request is currently running
    cycleOfferId: null,     // offer id whose poll cycle is active
    lastSessionAtOpen: null,
    requestsScheduled: 0,   // diagnostics — number of timers armed
    requestsExecuted: 0,    // diagnostics — number of timers that fired
  };

  function _fire() {
    // A scheduled timer fired: clear it, consume one attempt at EXECUTION
    // time (not at schedule time), mark in-flight, and run the request.
    state.timer = null;
    state.timerExpiresAt = null;
    state.attempts += 1;
    state.requestsExecuted += 1;
    state.inflight = true;
    execute();
  }

  function scheduleNext(stateHint) {
    // Only non-final states may (re)arm the loop.
    if (!isPollableRecoveredState(stateHint)) return false;
    // Timer-starvation gate — a pending timer is the single scheduled work.
    if (state.timer) return false;
    // No overlapping requests.
    if (state.inflight) return false;
    // Bounded budget.
    if (state.attempts >= maxAttempts) return false;
    const delay = nextPollDelayMs(state.attempts);
    state.timerExpiresAt = now() + delay;
    state.requestsScheduled += 1;
    state.timer = setTimer(_fire, delay);
    return true;
  }

  // Run one recovery request immediately WITHOUT consuming attempt budget
  // (used on connect/reconnect). No-op if a request is already in flight.
  function requestImmediate() {
    if (state.inflight) return false;
    state.inflight = true;
    execute();
    return true;
  }

  // The recovery request finished; clear in-flight and, based on the pure
  // ``decideNextPoll`` decision, arm the next bounded poll if warranted.
  function settle(decision) {
    state.inflight = false;
    if (decision && decision.schedule) {
      return scheduleNext(decision.stateHint);
    }
    return false;
  }

  // Arm a (possibly new) poll cycle. Resets the bounded budget ONLY when
  // ``shouldResetPollBudget`` says this is a genuinely new cycle.
  function armCycle(stateHint, offerId) {
    const { reset, nextCycleOfferId } = shouldResetPollBudget(
      state.cycleOfferId, offerId || null);
    if (reset) state.attempts = 0;
    state.cycleOfferId = nextCycleOfferId;
    return scheduleNext(stateHint);
  }

  // A WebSocket opened for ``sessionId``. A genuinely new live session
  // resets the bounded budget + cycle; an ordinary reconnect of the same
  // session preserves them.
  function onSessionOpen(sessionId) {
    if (state.lastSessionAtOpen !== sessionId) {
      state.attempts = 0;
      state.cycleOfferId = null;
      state.lastSessionAtOpen = sessionId;
      return true;
    }
    return false;
  }

  // The current cycle resolved (granted / terminal / claimable) — clear the
  // cycle marker so a later genuinely-new offer resets the budget.
  function endCycle() {
    state.cycleOfferId = null;
  }

  // Session change / unmount — cancel the timer and reset all budget.
  function cancel() {
    if (state.timer && clearTimer) clearTimer(state.timer);
    state.timer = null;
    state.timerExpiresAt = null;
    state.attempts = 0;
    state.inflight = false;
    state.cycleOfferId = null;
    state.lastSessionAtOpen = null;
  }

  return {
    state,
    scheduleNext,
    requestImmediate,
    settle,
    armCycle,
    onSessionOpen,
    endCycle,
    cancel,
    isInflight: () => state.inflight,
    setInflight: (v) => { state.inflight = !!v; },
    getAttempts: () => state.attempts,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Correction B (final) — bounded ANNOUNCEMENT-DELIVERY retry controller.
//
// This is a SEPARATE controller from the bounded reward-poll controller. The
// reward poll resolves the WALLET (pending → granted) and STOPS once the
// wallet is authoritatively granted. But the delayed Gemini congratulations is
// a distinct delivery: after `granted`, the browser sends an
// `announce_confirmed_reward` over the live WebSocket and the backend may
// answer with a RETRYABLE negative acknowledgement (in_progress / inject_failed
// / a lost ack on a temporarily-unavailable socket). Reusing the wallet poll
// here is wrong (the wallet is already resolved), so this controller owns the
// bounded retry of the ANNOUNCEMENT only.
//
// Guarantees (asserted by the announcement-retry tests):
//   * starts only after an authoritative granted offer is armed;
//   * the visual reveal is independent and is never repeated by this loop;
//   * exact offer id + session id are preserved across retries;
//   * at most one timer and one in-flight acknowledgement at a time;
//   * retries ONLY retryable acks (in_progress / inject_failed / temporary
//     send failure / temporarily-unavailable socket / stale-not-yet-reclaimable
//     / no_live_session), with bounded exponential backoff;
//   * stops on delivered, authoritative already_delivered, permanent
//     owner/session/state rejection, attempt exhaustion, cancel (session
//     change / unmount);
//   * duplicate granted events for the SAME offer never reset the budget;
//   * a reconnect MAY resume an undelivered announcement (within budget);
//   * never calls the wallet/provider.
// ─────────────────────────────────────────────────────────────────────────
export const ANNOUNCE_RETRY = {
  maxAttempts: 6,
  baseDelayMs: 1500,
  maxDelayMs: 15000,
};

export function announceRetryDelayMs(attempt) {
  const a = Math.max(0, Number(attempt) || 0);
  const d = ANNOUNCE_RETRY.baseDelayMs * Math.pow(2, a);
  return Math.min(d, ANNOUNCE_RETRY.maxDelayMs);
}

// Retryable acknowledgement reasons (in addition to an explicit
// `retryable === true` flag from the backend).
const ANNOUNCE_RETRYABLE_REASONS = new Set([
  "in_progress",
  "inject_failed",
  "no_live_session",
  "socket_unavailable",
  "temporarily_unavailable",
  "stale",
]);

// Classify an acknowledgement into one of: "delivered" | "retry" | "stop".
// Only durable delivery evidence (delivered / already_delivered) marks the
// offer complete; permanent rejections stop without success; everything else
// retryable schedules another bounded attempt.
export function classifyAnnounceAck(ack) {
  if (!ack) return "retry"; // no/lost ack → retry (e.g. socket dropped)
  if (ack.delivered === true) return "delivered";
  if (ack.already_delivered === true) return "delivered";
  const reason = String(ack.reason || "");
  if (ack.retryable === true || ANNOUNCE_RETRYABLE_REASONS.has(reason)) {
    return "retry";
  }
  // wrong_owner / wrong_session / not_granted / no_offer / unknown → stop.
  return "stop";
}

export function createAnnounceRetryController({
  setTimer,
  clearTimer,
  now = () => 0,
  send,
  maxAttempts = ANNOUNCE_RETRY.maxAttempts,
} = {}) {
  const state = {
    timer: null,
    inflight: false,
    attempts: 0,
    done: false,
    offerId: null,
    sessionId: null,
    outcome: null, // delivered | rejected | exhausted | cancelled | null
  };

  function _clearTimer() {
    if (state.timer && clearTimer) clearTimer(state.timer);
    state.timer = null;
  }

  // Send one announcement attempt now (consumes one bounded attempt) and arm
  // an ack-timeout timer so a lost ack / temporarily-unavailable socket still
  // retries within the budget.
  function _sendNow() {
    if (state.done) return false;
    if (state.inflight) return false;   // one in-flight ack maximum
    if (state.timer) return false;      // one timer maximum
    if (!state.offerId || !state.sessionId) return false;
    if (state.attempts >= maxAttempts) {
      state.done = true; state.outcome = "exhausted"; return false;
    }
    state.attempts += 1;
    state.inflight = true;
    if (send) { try { send(state.offerId, state.sessionId); } catch (e) { /* transient */ } }
    state.timer = setTimer(() => {
      // No ack arrived in time (or socket was unavailable) → retry.
      state.timer = null;
      state.inflight = false;
      _sendNow();
    }, announceRetryDelayMs(state.attempts));
    return true;
  }

  // Arm the controller for an authoritative granted offer. A genuinely new
  // offer resets the bounded budget; a duplicate granted for the SAME offer
  // does NOT reset it.
  function start(offerId, sessionId) {
    if (!offerId || !sessionId) return false;
    if (state.offerId !== offerId) {
      _clearTimer();
      state.attempts = 0; state.inflight = false; state.done = false;
      state.outcome = null;
      state.offerId = offerId; state.sessionId = sessionId;
    }
    if (state.done) return false; // already resolved for this offer
    return _sendNow();
  }

  // Feed a backend acknowledgement. Returns the classification result.
  function onAck(ack) {
    if (!ack || ack.offer_id !== state.offerId) return state.outcome; // stale
    const cls = classifyAnnounceAck(ack);
    _clearTimer();
    state.inflight = false;
    if (cls === "delivered") { state.done = true; state.outcome = "delivered"; return "delivered"; }
    if (cls === "stop") { state.done = true; state.outcome = "rejected"; return "rejected"; }
    if (state.attempts >= maxAttempts) { state.done = true; state.outcome = "exhausted"; return "exhausted"; }
    // retryable → schedule the next bounded attempt with backoff.
    state.timer = setTimer(() => { state.timer = null; _sendNow(); },
      announceRetryDelayMs(state.attempts));
    return "retry";
  }

  // Resume an undelivered announcement on reconnect (within budget).
  function requestImmediate() {
    if (state.done) return false;
    _clearTimer();
    state.inflight = false;
    return _sendNow();
  }

  // Session change / unmount — stop all retries.
  function cancel() {
    _clearTimer();
    state.inflight = false;
    state.done = true;
    state.outcome = "cancelled";
  }

  // Full reset (e.g. a brand-new live session).
  function reset() {
    _clearTimer();
    state.inflight = false; state.attempts = 0; state.done = false;
    state.offerId = null; state.sessionId = null; state.outcome = null;
  }

  return {
    state, start, onAck, requestImmediate, cancel, reset,
    isDone: () => state.done,
    getAttempts: () => state.attempts,
    isInflight: () => state.inflight,
    getOutcome: () => state.outcome,
  };
}
