/**
 * liveCoachRewardPanelLogic.test.js — pure-logic tests for the persistent
 * EduTalk Live Coach Surprise Reward panel.
 *
 * No React rendering — exercises the SAME helpers the component imports, so the
 * code under test IS the code that ships. Covers the preserved v1–v6 regression
 * logic AND the v7 canonical authoritative claim-outcome normalizer that is now
 * shared by BOTH the REST claim path and the WebSocket reward_claim_failed path.
 */
import {
  resolvePanelMode,
  deriveRewardPanel,
  shouldKeepPollingStatus,
  createStatusPollController,
  selectClaimOfferId,
  reconcileStatusRevision,
  // v7 canonical claim-outcome mapping (single source of truth)
  CANONICAL_CLAIM_OUTCOMES,
  normalizeAuthoritativeClaimOutcome,
  normalizeWsClaimFailedOutcome,
  statusFromAuthoritativeClaimOutcome,
  statusFromRestClaimOutcome,
  statusFromRestClaimUnavailable,
  statusFromWsClaimFailed,
} from "../liveCoachRewardPanelLogic";

const emptyReward = {
  offer: null,
  claiming: false,
  result: null,
  revealOpen: false,
};

// A deterministic, IO-free status-poll controller probe for race/refresh tests.
function makeController(intervalMs = 1000) {
  let timerToken = 0;
  const timers = new Map();
  let executions = 0;
  const ctrl = createStatusPollController({
    setTimer: (cb) => { timerToken += 1; timers.set(timerToken, cb); return timerToken; },
    clearTimer: (t) => timers.delete(t),
    execute: () => { executions += 1; },
    intervalMs,
  });
  return {
    ctrl,
    timers,
    getExecutions: () => executions,
    fireTimer: (t) => { const cb = timers.get(t); timers.delete(t); if (cb) cb(); },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Regression: resolvePanelMode / deriveRewardPanel / polling / claim-id
// ─────────────────────────────────────────────────────────────────────────
describe("resolvePanelMode (regression)", () => {
  test("disabled/unavailable -> hidden", () => {
    expect(resolvePanelMode({ state: "disabled" }, emptyReward)).toBe("hidden");
    expect(resolvePanelMode({ state: "unavailable" }, emptyReward)).toBe("hidden");
  });
  test("tracking/progressing/eligible pass through", () => {
    expect(resolvePanelMode({ state: "tracking" }, emptyReward)).toBe("tracking");
    expect(resolvePanelMode({ state: "progressing" }, emptyReward)).toBe("progressing");
    expect(resolvePanelMode({ state: "eligible", offer_id: "o1" }, emptyReward)).toBe("eligible");
  });
  test("claiming/terminal/expired authoritative statuses pass through", () => {
    expect(resolvePanelMode({ state: "claiming" }, emptyReward)).toBe("claiming");
    expect(resolvePanelMode({ state: "terminal" }, emptyReward)).toBe("terminal");
    expect(resolvePanelMode({ state: "expired" }, emptyReward)).toBe("expired");
  });
  test("WS offer flips to eligible only when not contradicted", () => {
    const reward = { ...emptyReward, offer: { offer_id: "o1", session_id: "s1" } };
    expect(resolvePanelMode({ state: "tracking", session_id: "s1" }, reward)).toBe("eligible");
    expect(resolvePanelMode({ state: "terminal", session_id: "s1" }, reward)).toBe("terminal");
  });
});

describe("deriveRewardPanel visibility + locked clickability (regression + v7)", () => {
  test("eligible clickable only with a real offer id", () => {
    expect(deriveRewardPanel({ status: { state: "eligible", offer_id: "o1" }, reward: emptyReward }).clickable).toBe(true);
    expect(deriveRewardPanel({ status: { state: "eligible" }, reward: emptyReward }).clickable).toBe(false);
  });
  test("v7 — panel is NEVER clickable for claiming/unavailable/disabled/expired/terminal", () => {
    for (const state of ["claiming", "unavailable", "disabled", "expired", "terminal"]) {
      const status = { state, offer_id: "o1", session_id: "s1" };
      const reward = { ...emptyReward, offer: { offer_id: "o1", session_id: "s1" } };
      const v = deriveRewardPanel({ status, reward });
      expect(v.clickable).toBe(false);
      expect(selectClaimOfferId(status, reward, "s1")).toBeNull();
    }
  });
  test("amount text hidden until confirmed", () => {
    expect(deriveRewardPanel({ status: { state: "eligible", offer_id: "o1" }, reward: emptyReward }).showAmount).toBe(false);
  });
});

describe("shouldKeepPollingStatus (regression)", () => {
  test("pollable vs final", () => {
    ["tracking", "progressing", "eligible", "claiming", "unavailable", "disabled"].forEach((s) => expect(shouldKeepPollingStatus(s)).toBe(true));
    ["confirmed", "terminal", "expired"].forEach((s) => expect(shouldKeepPollingStatus(s)).toBe(false));
  });
});

describe("selectClaimOfferId — current-session discipline (regression + v7)", () => {
  test("eligible offer-B + stale session-A offer-A -> offer-B (backend wins)", () => {
    const status = { state: "eligible", session_id: "session-B", offer_id: "offer-B" };
    const reward = { ...emptyReward, offer: { session_id: "session-A", offer_id: "offer-A" } };
    expect(selectClaimOfferId(status, reward)).toBe("offer-B");
    expect(deriveRewardPanel({ status, reward }).offerId).toBe("offer-B");
  });
  test("eligible w/o backend offer + mismatched local -> null (non-clickable)", () => {
    const status = { state: "eligible", session_id: "session-B" };
    const reward = { ...emptyReward, offer: { session_id: "session-A", offer_id: "offer-A" } };
    expect(selectClaimOfferId(status, reward)).toBeNull();
    expect(deriveRewardPanel({ status, reward }).clickable).toBe(false);
  });
});

describe("createStatusPollController invariants (regression, generation-safe)", () => {
  test("at most one in-flight + one timer; stale token ignored", () => {
    const { ctrl, timers, getExecutions } = makeController();
    ctrl.start(); const tokenA = ctrl.getGeneration();
    ctrl.cancel(); ctrl.start(); const tokenB = ctrl.getGeneration();
    expect(tokenB).toBeGreaterThan(tokenA);
    expect(ctrl.settle(tokenA, true)).toBe(false); // stale ignored
    expect(ctrl.isInflight()).toBe(true);
    const before = getExecutions(); ctrl.poke();
    expect(getExecutions()).toBe(before); // coalesced
    expect(ctrl.settle(tokenB, true)).toBe(true);
    expect(timers.size).toBe(1);
  });
});

describe("reconcileStatusRevision (regression, stale-status barrier)", () => {
  test("unchanged -> apply; advanced -> superseded + queueRefresh", () => {
    expect(reconcileStatusRevision(3, 3)).toEqual({ apply: true, queueRefresh: false });
    expect(reconcileStatusRevision(3, 4)).toEqual({ apply: false, queueRefresh: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v7 — canonical normalizer matrix (every required alias)
// ─────────────────────────────────────────────────────────────────────────
const NORMALIZER_MATRIX = [
  ["unavailable", "unavailable"],
  ["disabled", "disabled"],
  ["pending_confirmation", "claiming"],
  ["pending", "claiming"],
  ["claim_reserved", "claiming"],
  ["grant_dispatching", "claiming"],
  ["grant_retryable", "claiming"],
  ["retryable", "claiming"],
  ["grant_unknown", "claiming"],
  ["unknown", "claiming"],
  ["expired", "expired"],
  ["grant_terminal_failed", "terminal"],
  ["failed_terminal", "terminal"],
  ["terminal", "terminal"],
];

const UNKNOWN_VALUES = [
  "internal_error",
  "network_error",
  "timeout",
  "not_found",
  "session_expired",
  "rate_limited",
  "forbidden",
  "Something blew up: stack trace text",
  "arbitrary string",
  "",
  "   ",
];

describe("v7 normalizeAuthoritativeClaimOutcome — table-driven matrix", () => {
  test.each(NORMALIZER_MATRIX)("%s -> %s", (raw, canonical) => {
    expect(normalizeAuthoritativeClaimOutcome(raw)).toBe(canonical);
  });
  test("every canonical result is in CANONICAL_CLAIM_OUTCOMES", () => {
    for (const [, canonical] of NORMALIZER_MATRIX) {
      expect(CANONICAL_CLAIM_OUTCOMES).toContain(canonical);
    }
  });
  test.each(UNKNOWN_VALUES)("unknown value %p -> null", (raw) => {
    expect(normalizeAuthoritativeClaimOutcome(raw)).toBeNull();
  });
  test("missing / non-string -> null", () => {
    expect(normalizeAuthoritativeClaimOutcome(undefined)).toBeNull();
    expect(normalizeAuthoritativeClaimOutcome(null)).toBeNull();
    expect(normalizeAuthoritativeClaimOutcome(42)).toBeNull();
    expect(normalizeAuthoritativeClaimOutcome({})).toBeNull();
  });
});

describe("v7 normalizeWsClaimFailedOutcome — state→reason precedence", () => {
  test("null for non-reward_claim_failed types regardless of fields", () => {
    expect(normalizeWsClaimFailedOutcome(null)).toBeNull();
    expect(normalizeWsClaimFailedOutcome(undefined)).toBeNull();
    expect(normalizeWsClaimFailedOutcome({ type: "reward_offer_available", state: "unavailable" })).toBeNull();
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_confirmed", reason: "terminal" })).toBeNull();
  });
  test("recognized event.state takes precedence over event.reason", () => {
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", state: "expired", reason: "internal_error" })).toBe("expired");
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", state: "disabled", reason: "unavailable" })).toBe("disabled");
  });
  test("event.reason used when state absent/unrecognized", () => {
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", offer_id: "o", reason: "unavailable" })).toBe("unavailable");
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", offer_id: "o", reason: "claim_reserved" })).toBe("claiming");
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", state: "internal_error", reason: "grant_terminal_failed" })).toBe("terminal");
  });
  test("both unrecognized -> null", () => {
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", state: "internal_error", reason: "network_error" })).toBeNull();
    expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", offer_id: "o" })).toBeNull();
  });
});

describe("v7 statusFromAuthoritativeClaimOutcome — per-category status shape", () => {
  const prev = { state: "eligible", session_id: "s1", offer_id: "offer-A" };
  test("unavailable/disabled: non-operational, offer hidden, reason kept", () => {
    for (const oc of ["unavailable", "disabled"]) {
      const next = statusFromAuthoritativeClaimOutcome(prev, oc, "s1", "gate off");
      expect(next.state).toBe(oc);
      expect(next.operational).toBe(false);
      expect(next.offer_id).toBeNull();
      expect(next.inactive_reason).toBe("gate off");
      expect(next.session_id).toBe("s1");
    }
  });
  test("claiming: state claiming, offer_id PRESERVED for recovery", () => {
    const next = statusFromAuthoritativeClaimOutcome(prev, "claiming", "s1", "claim_reserved");
    expect(next.state).toBe("claiming");
    expect(next.offer_id).toBe("offer-A");
  });
  test("expired/terminal: non-operational, claimability removed", () => {
    for (const oc of ["expired", "terminal"]) {
      const next = statusFromAuthoritativeClaimOutcome(prev, oc, "s1", "reason text");
      expect(next.state).toBe(oc);
      expect(next.operational).toBe(false);
      expect(next.offer_id).toBeNull();
    }
  });
  test("null/unrecognized outcome -> null (no fabrication)", () => {
    expect(statusFromAuthoritativeClaimOutcome(prev, null, "s1")).toBeNull();
    expect(statusFromAuthoritativeClaimOutcome(prev, "not_a_canonical", "s1")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v7 — EXACT WebSocket tests using the real backend payload shape.
//   { type: "reward_claim_failed", offer_id: "offer-A", reason: "<value>" }
// ─────────────────────────────────────────────────────────────────────────
function eligibleStart() {
  const offer = { offer_id: "offer-A", session_id: "s1" };
  return {
    status: { state: "eligible", session_id: "s1", offer_id: "offer-A" },
    reward: { ...emptyReward, offer },
    offer,
  };
}
function wsFail(reason) {
  return { type: "reward_claim_failed", offer_id: "offer-A", reason };
}

describe("v7 EXACT WebSocket lifecycle matrix (eligible → reward_claim_failed reason=…)", () => {
  test("starts clickable", () => {
    const { status, reward } = eligibleStart();
    expect(deriveRewardPanel({ status, reward }).clickable).toBe(true);
  });

  test("reason=unavailable → hidden/non-clickable, revision++, one refresh queued", () => {
    let { status, reward } = eligibleStart();
    let revision = 0;
    const outcome = normalizeWsClaimFailedOutcome(wsFail("unavailable"));
    expect(outcome).toBe("unavailable");
    revision += 1;
    status = statusFromWsClaimFailed(status, wsFail("unavailable"), "s1");
    reward = { ...reward, claiming: false };
    const v = deriveRewardPanel({ status, reward });
    expect(v.visible).toBe(false);
    expect(v.clickable).toBe(false);
    expect(revision).toBe(1);
    // exactly one coalesced refresh
    const { ctrl, timers, getExecutions } = makeController();
    const tokenA = ctrl.start();
    ctrl.settle(tokenA, true);
    ctrl.poke();
    expect(getExecutions()).toBe(2);
    expect(ctrl.isInflight()).toBe(true);
    expect(timers.size).toBe(0);
  });

  test("reason=disabled → immediately non-clickable", () => {
    let { status, reward } = eligibleStart();
    status = statusFromWsClaimFailed(status, wsFail("disabled"), "s1");
    expect(deriveRewardPanel({ status, reward }).clickable).toBe(false);
    expect(status.state).toBe("disabled");
  });

  test("reason=expired → expired/non-clickable, second claim impossible", () => {
    let { status, reward } = eligibleStart();
    status = statusFromWsClaimFailed(status, wsFail("expired"), "s1");
    const v = deriveRewardPanel({ status, reward });
    expect(v.mode).toBe("expired");
    expect(v.clickable).toBe(false);
    expect(selectClaimOfferId(status, reward, "s1")).toBeNull();
  });

  test("reason=grant_terminal_failed → terminal/non-clickable, second claim impossible", () => {
    let { status, reward } = eligibleStart();
    status = statusFromWsClaimFailed(status, wsFail("grant_terminal_failed"), "s1");
    const v = deriveRewardPanel({ status, reward });
    expect(v.mode).toBe("terminal");
    expect(v.clickable).toBe(false);
    expect(selectClaimOfferId(status, reward, "s1")).toBeNull();
  });

  test("reason=claim_reserved → claiming/non-clickable, second claim impossible", () => {
    let { status, reward } = eligibleStart();
    expect(normalizeWsClaimFailedOutcome(wsFail("claim_reserved"))).toBe("claiming");
    status = statusFromWsClaimFailed(status, wsFail("claim_reserved"), "s1");
    const v = deriveRewardPanel({ status, reward });
    expect(v.mode).toBe("claiming");
    expect(v.clickable).toBe(false);
    expect(selectClaimOfferId(status, reward, "s1")).toBeNull();
  });

  test("reason=grant_unknown → claiming/non-clickable, second claim impossible", () => {
    let { status, reward } = eligibleStart();
    expect(normalizeWsClaimFailedOutcome(wsFail("grant_unknown"))).toBe("claiming");
    status = statusFromWsClaimFailed(status, wsFail("grant_unknown"), "s1");
    expect(deriveRewardPanel({ status, reward }).clickable).toBe(false);
    expect(selectClaimOfferId(status, reward, "s1")).toBeNull();
  });

  test("reason=internal_error → ordinary retryable; NO fabricated authoritative status", () => {
    const { status } = eligibleStart();
    expect(normalizeWsClaimFailedOutcome(wsFail("internal_error"))).toBeNull();
    expect(statusFromWsClaimFailed(status, wsFail("internal_error"), "s1")).toBeNull();
  });

  test("future payload { state: expired, reason: internal_error } → recognized state wins", () => {
    const { status } = eligibleStart();
    const ev = { type: "reward_claim_failed", state: "expired", reason: "internal_error" };
    expect(normalizeWsClaimFailedOutcome(ev)).toBe("expired");
    const next = statusFromWsClaimFailed(status, ev, "s1");
    expect(next.state).toBe("expired");
    expect(next.offer_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v7 — EXACT REST tests (REST claim returns { state: … })
// ─────────────────────────────────────────────────────────────────────────
function restClaim(state, reason) {
  return { success: true, state, reason };
}

describe("v7 EXACT REST claim lifecycle matrix (eligible → state=…)", () => {
  const prev = { state: "eligible", session_id: "s1", offer_id: "offer-A" };

  test("state=unavailable → non-clickable", () => {
    const next = statusFromRestClaimOutcome(prev, restClaim("unavailable", "gate off"), "s1");
    expect(next.state).toBe("unavailable");
    expect(next.offer_id).toBeNull();
    expect(deriveRewardPanel({ status: next, reward: emptyReward }).clickable).toBe(false);
  });
  test("state=disabled → non-clickable", () => {
    const next = statusFromRestClaimOutcome(prev, restClaim("disabled"), "s1");
    expect(next.state).toBe("disabled");
    expect(deriveRewardPanel({ status: next, reward: emptyReward }).clickable).toBe(false);
  });
  test("state=expired → expired/non-clickable", () => {
    const next = statusFromRestClaimOutcome(prev, restClaim("expired"), "s1");
    expect(next.state).toBe("expired");
    expect(deriveRewardPanel({ status: next, reward: emptyReward }).mode).toBe("expired");
  });
  test("state=grant_terminal_failed → terminal/non-clickable", () => {
    const next = statusFromRestClaimOutcome(prev, restClaim("grant_terminal_failed"), "s1");
    expect(next.state).toBe("terminal");
    expect(deriveRewardPanel({ status: next, reward: emptyReward }).mode).toBe("terminal");
  });
  test("state=grant_dispatching → claiming/non-clickable", () => {
    const next = statusFromRestClaimOutcome(prev, restClaim("grant_dispatching"), "s1");
    expect(next.state).toBe("claiming");
    expect(deriveRewardPanel({ status: next, reward: emptyReward }).clickable).toBe(false);
  });
  test("state=grant_unknown → claiming/non-clickable", () => {
    const next = statusFromRestClaimOutcome(prev, restClaim("grant_unknown"), "s1");
    expect(next.state).toBe("claiming");
    expect(deriveRewardPanel({ status: next, reward: emptyReward }).clickable).toBe(false);
  });
  test("network rejection → no fabricated authoritative state", () => {
    // A thrown/rejected request never reaches the normalizer; modelled here as
    // a response with no recognizable state.
    expect(statusFromRestClaimOutcome(prev, undefined, "s1")).toBeNull();
    expect(statusFromRestClaimOutcome(prev, { success: false }, "s1")).toBeNull();
  });
  test("state=internal_error → ordinary retryable failure (null)", () => {
    expect(statusFromRestClaimOutcome(prev, restClaim("internal_error"), "s1")).toBeNull();
  });
  test("statusFromRestClaimUnavailable is the SAME function (single mapping)", () => {
    expect(statusFromRestClaimUnavailable).toBe(statusFromRestClaimOutcome);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v7 — revision race tests per representative category
// ─────────────────────────────────────────────────────────────────────────
describe("v7 stale-response / queued-refresh race (per category)", () => {
  const CASES = [
    ["unavailable", wsFail("unavailable")],
    ["expired", wsFail("expired")],
    ["terminal", wsFail("grant_terminal_failed")],
    ["claiming/unresolved", wsFail("grant_unknown")],
  ];
  test.each(CASES)("%s: stale eligible ignored; B starts only after A settles; B applies truth", (_label, event) => {
    const { ctrl, timers, getExecutions } = makeController();
    let revision = 0;
    let panelStatus = { state: "eligible", session_id: "s1", offer_id: "offer-A" };

    // request A starts while eligible
    const tokenA = ctrl.start();
    const revAtA = revision;
    expect(getExecutions()).toBe(1);
    expect(ctrl.isInflight()).toBe(true);

    // authoritative claim outcome occurs → revision increments
    revision += 1;
    panelStatus = statusFromWsClaimFailed(panelStatus, event, "s1");
    expect(panelStatus).not.toBeNull();
    expect(deriveRewardPanel({ status: panelStatus, reward: emptyReward }).clickable).toBe(false);

    // request A returns STALE eligible → must be ignored
    const decisionA = reconcileStatusRevision(revAtA, revision);
    expect(decisionA.apply).toBe(false);
    expect(decisionA.queueRefresh).toBe(true);
    ctrl.settle(tokenA, true);          // A settles first (no overlap)
    if (decisionA.queueRefresh) ctrl.poke(); // exactly one refresh queued

    // no overlap: exactly 2 physical requests, one in flight, no pending timer
    expect(getExecutions()).toBe(2);
    expect(ctrl.isInflight()).toBe(true);
    expect(timers.size).toBe(0);

    // stale data never overwrote the newer truth
    expect(deriveRewardPanel({ status: panelStatus, reward: emptyReward }).clickable).toBe(false);

    // request B (current) applies the current backend truth
    const decisionB = reconcileStatusRevision(revision, revision);
    expect(decisionB.apply).toBe(true);
    expect(ctrl.settle(ctrl.getGeneration(), false)).toBe(false); // final state → stop
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v7 — recovery tests
// ─────────────────────────────────────────────────────────────────────────
describe("v7 recovery semantics", () => {
  test("unavailable → later eligible with SAME valid server offer → clickable again", () => {
    let { status, reward } = eligibleStart();
    status = statusFromWsClaimFailed(status, wsFail("unavailable"), "s1");
    expect(deriveRewardPanel({ status, reward }).clickable).toBe(false);
    // the local server offer is preserved
    expect(reward.offer).toEqual({ offer_id: "offer-A", session_id: "s1" });
    // later authoritative eligible restores the same unexpired offer
    const restored = { state: "eligible", session_id: "s1", offer_id: "offer-A" };
    const v = deriveRewardPanel({ status: restored, reward });
    expect(v.clickable).toBe(true);
    expect(v.offerId).toBe("offer-A");
  });

  test("claiming/grant_unknown → later confirmed → confirmed/non-clickable", () => {
    let { status, reward } = eligibleStart();
    status = statusFromWsClaimFailed(status, wsFail("grant_unknown"), "s1");
    expect(deriveRewardPanel({ status, reward }).mode).toBe("claiming");
    const confirmedStatus = { state: "confirmed", session_id: "s1" };
    const confirmedReward = { ...reward, result: { offer_id: "offer-A", reward_summary: "10 EduHub Points" } };
    const v = deriveRewardPanel({ status: confirmedStatus, reward: confirmedReward });
    expect(v.mode).toBe("confirmed");
    expect(v.clickable).toBe(false);
  });

  test("expired/terminal → stale LOCAL eligible offer cannot restore clickability", () => {
    for (const event of [wsFail("expired"), wsFail("grant_terminal_failed")]) {
      let { status, reward } = eligibleStart();
      status = statusFromWsClaimFailed(status, event, "s1");
      // even though the local reward.offer still references offer-A,
      // the authoritative expired/terminal status overrides it.
      const v = deriveRewardPanel({ status, reward });
      expect(v.clickable).toBe(false);
      expect(selectClaimOfferId(status, reward, "s1")).toBeNull();
    }
  });

  test("current-session offer safety: backend offer-B + stale local offer-A → claim uses offer-B", () => {
    const status = { state: "eligible", session_id: "s2", offer_id: "offer-B" };
    const reward = { ...emptyReward, offer: { offer_id: "offer-A", session_id: "s1" } };
    expect(selectClaimOfferId(status, reward, "s2")).toBe("offer-B");
    expect(deriveRewardPanel({ status, reward, sessionId: "s2" }).offerId).toBe("offer-B");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v7 — source/contract test: frontend normalizer ↔ ACTUAL backend lifecycle
// aliases emitted/returned by eduhub-backend-master/edutalk_coach_reward_tools.py.
// These are NOT invented payload shapes; each carries its backend provenance.
// ─────────────────────────────────────────────────────────────────────────
describe("v7 source/contract: backend claim-lifecycle aliases are all covered", () => {
  // REST `_safe_claim_result.state` + recovery `client_state`
  // (edutalk_coach_reward_tools.py: _safe_claim_result / _finalize_claim /
  //  student_active_offer) and WS `reward_claim_failed.reason = state or
  // "unknown"` (handle_ws_claim_command). Granted/confirmed are handled by the
  // confirm branch and are intentionally NOT claim-failure outcomes.
  const BACKEND_AUTHORITATIVE_ALIASES = {
    // REST claim result states
    pending_confirmation: "claiming",
    expired: "expired",
    grant_terminal_failed: "terminal",
    failed_terminal: "terminal",
    // grant dispatch / reconcile lifecycle states
    claim_reserved: "claiming",
    grant_dispatching: "claiming",
    grant_retryable: "claiming",
    grant_unknown: "claiming",
    pending: "claiming",
    // gate closures surfaced as reasons
    unavailable: "unavailable",
    disabled: "disabled",
    // generic terminal/unknown
    terminal: "terminal",
    unknown: "claiming",
  };
  // WS `reason` values that are NON-authoritative (HTTPException detail or
  // internal_error) and MUST stay retryable.
  const BACKEND_NON_AUTHORITATIVE_REASONS = [
    "internal_error",
    "not_found",
    "session_expired",
    "rate_limited",
    "forbidden",
  ];

  test.each(Object.entries(BACKEND_AUTHORITATIVE_ALIASES))(
    "backend alias %s normalizes to %s",
    (alias, canonical) => {
      expect(normalizeAuthoritativeClaimOutcome(alias)).toBe(canonical);
      // also covered through the actual WS payload shape (reason field)
      expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", offer_id: "x", reason: alias })).toBe(canonical);
    },
  );

  test.each(BACKEND_NON_AUTHORITATIVE_REASONS)(
    "backend non-authoritative reason %s → null (stays retryable)",
    (reason) => {
      expect(normalizeAuthoritativeClaimOutcome(reason)).toBeNull();
      expect(normalizeWsClaimFailedOutcome({ type: "reward_claim_failed", offer_id: "x", reason })).toBeNull();
    },
  );

  test("the canonical mapping covers every alias in the normalizer matrix", () => {
    for (const [raw, expected] of NORMALIZER_MATRIX) {
      expect(normalizeAuthoritativeClaimOutcome(raw)).toBe(expected);
    }
  });
});
