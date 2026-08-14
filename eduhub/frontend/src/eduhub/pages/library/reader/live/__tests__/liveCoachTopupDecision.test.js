/**
 * liveCoachTopupDecision.test.js — V2 Bug 3 (frontend fail-closed) + Bug 4 (one
 * effective decision for BOTH render and visibility logging).
 *
 * Pure helpers only. Proves that the rendered pill (`pill_shown`) and the
 * visibility log (`reason`, `balance_source`) always come from ONE decision
 * object — including the client display-snapshot fallback — and that the
 * frontend fails closed when diagnostics say the weekly cap blocks the nudge.
 */
import {
  buildEffectiveStartDecision,
  buildEffectiveReportDecision,
  NUDGE_DIAGNOSTIC_REASONS,
  NUDGE_BALANCE_SOURCES,
} from "../liveCoachTopupNudgeLogic";

describe("buildEffectiveStartDecision (V2 Bug 3 + Bug 4)", () => {
  test("cap-exhausted start decision renders hidden AND logs hidden from one object", () => {
    const preview = {
      enabled: true, eligible: false, reason: "weekly_cap_reached",
      diagnostic_reason: "weekly_cap_reached", balance_source: "mongo_wallet",
    };
    const d = buildEffectiveStartDecision({
      enabled: true, snoozed: false, preview, clientFallback: null,
      capReason: "weekly_cap_reached",
    });
    expect(d.pill_shown).toBe(false);                       // render hidden
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.WEEKLY_CAP_REACHED); // log hidden
    expect(d.source).toBe("backend_preview");
  });

  test("Bug 3 FE — fails closed when preview diagnostic itself says cap blocks", () => {
    // Even if (stale) eligible=true leaked through, the diagnostic forces hidden.
    const preview = {
      enabled: true, eligible: true, reason: "projected_balance_at_or_below_threshold",
      diagnostic_reason: "cap_disabled", balance_source: "mongo_wallet",
    };
    const d = buildEffectiveStartDecision({
      enabled: true, snoozed: false, preview, clientFallback: null,
    });
    expect(d.pill_shown).toBe(false);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.CAP_DISABLED);
  });

  test("eligible backend preview shows the pill and logs eligible from one object", () => {
    const preview = {
      enabled: true, eligible: true, reason: "projected_balance_at_or_below_threshold",
      diagnostic_reason: "eligible", balance_source: "mongo_wallet",
    };
    const d = buildEffectiveStartDecision({
      enabled: true, snoozed: false, preview, clientFallback: null,
    });
    expect(d.pill_shown).toBe(true);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE);
    expect(d.balance_source).toBe(NUDGE_BALANCE_SOURCES.MONGO_WALLET);
  });

  test("client-fallback start decision renders/logs the SAME result + client_display_snapshot", () => {
    // Backend preview was balance-gated; the client display-snapshot fallback
    // DRIVES the decision. Render and log must agree and report the snapshot.
    const preview = {
      enabled: false, eligible: false, reason: "balance_unavailable_for_preview",
      diagnostic_reason: "balance_temporarily_unavailable",
      balance_source: "client_display_snapshot_required",
    };
    const clientFallback = { enabled: true, eligible: true };
    const d = buildEffectiveStartDecision({
      enabled: true, snoozed: false, preview, clientFallback,
    });
    expect(d.pill_shown).toBe(true);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE);
    expect(d.balance_source).toBe(NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT);
    expect(d.source).toBe("client_fallback");
  });

  test("client-fallback NOT eligible → hidden, still reports client_display_snapshot", () => {
    const d = buildEffectiveStartDecision({
      enabled: true, snoozed: false,
      preview: { enabled: false, reason: "balance_unavailable_for_preview" },
      clientFallback: { enabled: true, eligible: false },
    });
    expect(d.pill_shown).toBe(false);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.BALANCE_ABOVE_THRESHOLD);
    expect(d.balance_source).toBe(NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT);
  });

  test("snoozed hides the pill in both backend and client-fallback paths", () => {
    const back = buildEffectiveStartDecision({
      enabled: true, snoozed: true,
      preview: { enabled: true, eligible: true, diagnostic_reason: "eligible",
        balance_source: "mongo_wallet" },
      clientFallback: null,
    });
    expect(back.pill_shown).toBe(false);
    expect(back.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.SNOOZED);
    const front = buildEffectiveStartDecision({
      enabled: true, snoozed: true,
      preview: { enabled: false, reason: "balance_unavailable_for_preview" },
      clientFallback: { enabled: true, eligible: true },
    });
    expect(front.pill_shown).toBe(false);
    expect(front.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.SNOOZED);
    expect(front.balance_source).toBe(NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT);
  });
});

describe("buildEffectiveReportDecision (V2 Bug 4)", () => {
  test("report-phase rendering and logging use one shared backend decision", () => {
    const finalization = {
      report_eligible: true, diagnostic_reason: "eligible",
      balance_source: "gas_verified_post_reservation",
    };
    const d = buildEffectiveReportDecision({
      enabled: true, snoozed: false, finalization, clientFallback: null,
    });
    expect(d.pill_shown).toBe(true);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE);
    expect(d.source).toBe("backend_finalization");
  });

  test("report client fallback reports client_display_snapshot from one object", () => {
    const d = buildEffectiveReportDecision({
      enabled: true, snoozed: false,
      finalization: { reason: "wallet_unavailable" },
      clientFallback: { report_eligible: true, settlement_reason: "client_estimate" },
    });
    expect(d.pill_shown).toBe(true);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE);
    expect(d.balance_source).toBe(NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT);
    expect(d.source).toBe("client_fallback");
  });
});
