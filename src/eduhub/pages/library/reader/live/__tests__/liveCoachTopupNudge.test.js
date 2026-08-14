/**
 * liveCoachTopupNudge.test.js — EduTalk Live Coach "Smart Top-Up Nudge"
 * (Phase 1) frontend coverage.
 *
 * Pure decision helpers are exercised directly; the production
 * ``EduTalkLiveCoach.jsx`` / ``EduTalkLivePanel.jsx`` / ``useTopUpAffordance.js``
 * are asserted STATICALLY (the same pattern used by the existing
 * liveCoachReward*.test.js files) so the real wiring is the thing under test —
 * not a divergent inline re-implementation. This avoids rendering the heavy
 * live-session component (which needs mic / WebSocket / Gemini) while still
 * proving:
 *   * the pill renders ONLY in phase start/report (ZERO phase === "live" code);
 *   * exactly ONE PointsPurchaseModal instance is mounted;
 *   * the EXISTING SmartTopUp snooze/dismissal storage is reused (not bypassed);
 *   * the report balance is refreshed via the existing setBalance callback;
 *   * Studio validation rejects invalid input.
 */
import fs from "fs";
import path from "path";
import {
  selectModePreview,
  shouldShowStartPill,
  shouldShowReportPill,
  settledBalanceToApply,
  normalizeStartVisibilityDecision,
  normalizeReportVisibilityDecision,
  NUDGE_DIAGNOSTIC_REASONS,
  NUDGE_BALANCE_SOURCES,
} from "../liveCoachTopupNudgeLogic";
import {
  isEduTalkTopUpSnoozed,
  recordEduTalkTopUpDismiss,
  dismissLogKey,
  snoozeUntilKey,
  normalizeStudentId,
} from "../liveCoachTopupSnooze";
import {
  validateTopupNudgeConfig,
  strictInt,
  TOPUP_NUDGE_REASONS,
} from "../../../../../../studio/edutalkLive/edutalkTopupNudgeSchema";

const LIVE_DIR = path.resolve(__dirname, "..");
const SRC = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}
function count(haystack, re) {
  return (haystack.match(re) || []).length;
}

// --------------------------------------------------------------------------- //
// Pure logic — preview selection + visibility decisions.                      //
// --------------------------------------------------------------------------- //
describe("liveCoachTopupNudgeLogic (pure)", () => {
  const eligible = { enabled: true, eligible: true,
    reason: "projected_balance_at_or_below_threshold",
    verified_current_balance: 30, projected_post_reservation_balance: 15 };
  const notEligible = { enabled: true, eligible: false,
    reason: "balance_above_threshold" };

  test("selectModePreview returns the matching mode entry", () => {
    const map = { quick: eligible, deep: notEligible };
    expect(selectModePreview(map, "quick")).toBe(eligible);
    expect(selectModePreview(map, "deep")).toBe(notEligible);
    expect(selectModePreview(map, "missing")).toBeNull();
    expect(selectModePreview(null, "quick")).toBeNull();
  });

  test("shouldShowStartPill — enabled + eligible + not snoozed", () => {
    expect(shouldShowStartPill({ enabled: true, preview: eligible, snoozed: false })).toBe(true);
    // snoozed student never sees the pill
    expect(shouldShowStartPill({ enabled: true, preview: eligible, snoozed: true })).toBe(false);
    // not eligible
    expect(shouldShowStartPill({ enabled: true, preview: notEligible, snoozed: false })).toBe(false);
    // feature disabled
    expect(shouldShowStartPill({ enabled: false, preview: eligible, snoozed: false })).toBe(false);
    // no preview
    expect(shouldShowStartPill({ enabled: true, preview: null, snoozed: false })).toBe(false);
  });

  test("shouldShowReportPill — only from report_eligible finalization", () => {
    const fin = { report_eligible: true, settled_balance: 12 };
    expect(shouldShowReportPill({ enabled: true, finalization: fin, snoozed: false })).toBe(true);
    expect(shouldShowReportPill({ enabled: true, finalization: fin, snoozed: true })).toBe(false);
    expect(shouldShowReportPill({ enabled: true,
      finalization: { report_eligible: false }, snoozed: false })).toBe(false);
    expect(shouldShowReportPill({ enabled: false, finalization: fin, snoozed: false })).toBe(false);
  });

  test("settledBalanceToApply only returns real numbers", () => {
    expect(settledBalanceToApply({ settled_balance: 12 })).toBe(12);
    expect(settledBalanceToApply({ settled_balance: null })).toBeNull();
    expect(settledBalanceToApply({})).toBeNull();
    expect(settledBalanceToApply(null)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// v2.2 — client fallback honours top-level weekly-cap status from the         //
// student config endpoint when the backend preview is balance-gated.          //
// The fallback mirrors EduTalkLiveCoach.jsx::clientFallbackPreview so a       //
// regression here proves the production gating logic.                        //
// --------------------------------------------------------------------------- //
function clientFallbackPreview({ modePreview, config, balance, selectedMode }) {
  const selectedModeObj =
    (config && config.modes ? config.modes : []).find(
      (m) => m.key === selectedMode);
  if (
    modePreview?.reason !== "balance_unavailable_for_preview" ||
    !config?.topup_nudge_enabled ||
    config?.topup_nudge_cap_available !== true ||
    typeof balance !== "number" ||
    !selectedModeObj?.cost_points
  ) return null;
  const threshold = config?.topup_nudge_threshold ?? 15;
  const projected = balance - selectedModeObj.cost_points;
  return { enabled: true, eligible: projected <= threshold };
}

describe("clientFallbackPreview — weekly-cap gating (v2.2 blocker)", () => {
  const baseConfig = {
    topup_nudge_enabled: true,
    topup_nudge_threshold: 50,
    topup_nudge_cap_available: true,
    topup_nudge_cap_reason: "ok",
    modes: [{ key: "quick", cost_points: 15 }],
  };
  const balanceGatedPreview = { reason: "balance_unavailable_for_preview" };

  test("EXACT case: admin on, threshold 50, balance 40, cost 15, cap available → pill shows", () => {
    const out = clientFallbackPreview({
      modePreview: balanceGatedPreview, config: baseConfig,
      balance: 40, selectedMode: "quick",
    });
    expect(out).not.toBeNull();
    expect(out.enabled).toBe(true);
    expect(out.eligible).toBe(true);   // projected 25 <= threshold 50
    expect(shouldShowStartPill({ enabled: true, preview: out, snoozed: false })).toBe(true);
  });

  test("EXACT case: same setup but cap exhausted → fallback null, pill NOT shown", () => {
    const out = clientFallbackPreview({
      modePreview: balanceGatedPreview,
      config: { ...baseConfig, topup_nudge_cap_available: false,
        topup_nudge_cap_reason: "weekly_cap_reached" },
      balance: 40, selectedMode: "quick",
    });
    expect(out).toBeNull();
    expect(shouldShowStartPill({ enabled: true, preview: out, snoozed: false })).toBe(false);
  });

  test("cap_available missing/undefined → treated as unavailable (no pill)", () => {
    const { topup_nudge_cap_available: _omit, ...cfgNoCap } = baseConfig;
    const out = clientFallbackPreview({
      modePreview: balanceGatedPreview, config: cfgNoCap,
      balance: 40, selectedMode: "quick",
    });
    expect(out).toBeNull();
  });

  test("cap available but feature disabled → null", () => {
    const out = clientFallbackPreview({
      modePreview: balanceGatedPreview,
      config: { ...baseConfig, topup_nudge_enabled: false },
      balance: 40, selectedMode: "quick",
    });
    expect(out).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Studio validation — REJECT invalid input (no silent clamping).              //
// --------------------------------------------------------------------------- //
describe("edutalkTopupNudgeSchema (validation)", () => {
  test("strictInt rejects non-integers", () => {
    expect(strictInt(15)).toBe(15);
    expect(strictInt(15.0)).toBe(15);
    expect(strictInt(1.5)).toBeNull();
    expect(strictInt("abc")).toBeNull();
    expect(strictInt("")).toBeNull();
    expect(strictInt(true)).toBeNull();
  });

  test("accepts a valid config", () => {
    expect(validateTopupNudgeConfig({
      topup_nudge_enabled: true, topup_nudge_threshold: 15,
      topup_nudge_max_per_week: 3 })).toEqual({ ok: true, reason: "" });
  });

  test("rejects bad threshold / cap with feature-specific reasons", () => {
    expect(validateTopupNudgeConfig({ topup_nudge_threshold: -1 }).reason)
      .toBe(TOPUP_NUDGE_REASONS.THRESHOLD_INVALID);
    expect(validateTopupNudgeConfig({ topup_nudge_threshold: 1.5 }).reason)
      .toBe(TOPUP_NUDGE_REASONS.THRESHOLD_INVALID);
    expect(validateTopupNudgeConfig({ topup_nudge_max_per_week: -2 }).reason)
      .toBe(TOPUP_NUDGE_REASONS.WEEKLY_CAP_INVALID);
    expect(validateTopupNudgeConfig({ topup_nudge_max_per_week: 2.5 }).reason)
      .toBe(TOPUP_NUDGE_REASONS.WEEKLY_CAP_INVALID);
  });

  test("reason codes never reuse Reward-system literals", () => {
    // Feature-specific values only.
    expect(Object.values(TOPUP_NUDGE_REASONS)).toEqual(
      expect.arrayContaining(["config_disabled", "threshold_invalid",
        "weekly_cap_invalid"]));
  });
});

// --------------------------------------------------------------------------- //
// Static wiring — EduTalkLiveCoach.jsx (the real integration).                //
// --------------------------------------------------------------------------- //
describe("EduTalkLiveCoach.jsx static wiring", () => {
  const file = read("eduhub/pages/library/reader/live/EduTalkLiveCoach.jsx");

  test("pill is rendered exactly twice (start + report)", () => {
    expect(count(file, /<LiveCoachTopUpNudge\b/g)).toBe(2);
  });

  test("exactly ONE PointsPurchaseModal instance is mounted", () => {
    expect(count(file, /<TopUpPointsModal\b/g)).toBe(1);
  });

  test("ZERO top-up pill code inside the phase === \"live\" render block", () => {
    // Anchor on the actual JSX render conditions (not explanatory comments).
    const live = file.indexOf('{phase === "live" && (');
    const report = file.indexOf('{phase === "report" && (');
    expect(live).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(live);
    const liveBlock = file.slice(live, report);
    expect(liveBlock.includes("LiveCoachTopUpNudge")).toBe(false);
    expect(liveBlock.includes("TopUpPointsModal")).toBe(false);
  });

  test("uses the EduTalk-ONLY per-student snooze (not the shared predicate)", () => {
    // Phase 0B — the pill now uses the EduTalk-only per-student snooze; it must
    // NOT import the shared isTopUpSnoozed / recordTopUpDismiss predicates.
    expect(file).toMatch(/isEduTalkTopUpSnoozed\s*\(/);
    expect(file).toMatch(/recordEduTalkTopUpDismiss\s*\(/);
    expect(file).not.toMatch(/\bisTopUpSnoozed\s*\(/);
    expect(file).not.toMatch(/\brecordTopUpDismiss\s*\(/);
    // The shared "auto-shown" marker is STILL used to avoid duplicate modals.
    expect(file).toMatch(/markTopUpAutoShown\s*\(/);
    // The recommended-package helper is still the shared one.
    expect(file).toMatch(/pickRecommendedPackage\s*\(/);
  });

  test("config refresh is wired to open/start and protected by 30s staleness", () => {
    expect(file).toMatch(/refreshLiveConfig/);
    expect(file).toMatch(/CONFIG_STALE_MS\s*=\s*30000/);
    expect(file).toMatch(/open\s*&&\s*phase\s*===\s*"start"/);
  });

  test("visibility reporting is deduplicated and never rendered to students", () => {
    expect(file).toMatch(/reportTopupNudgeVisibility\s*\(/);
    expect(file).toMatch(/lastVisibilityKeyRef/);
    // The diagnostic reason/source strings are only sent to the API, never
    // placed into JSX text. (Guard: the decision object is not spread into a
    // rendered element.)
    expect(file).not.toMatch(/>\{visibilityDecision\.reason\}</);
  });

  test("refreshes displayed balance via the existing setBalance callback", () => {
    expect(file).toMatch(/getTopupNudgeReport\s*\(/);
    expect(file).toMatch(/setBalance\s*\(/);
  });

  test("recommended package uses the existing helper (no hardcoded id)", () => {
    expect(file).toMatch(/pickRecommendedPackage\s*\(/);
    expect(file).toMatch(/recommendedPackageId=\{topupRecommendedId\}/);
  });

  test("client fallback gates the start pill on top-level cap availability (v2.2)", () => {
    // The client-side fallback (balance_unavailable_for_preview path) MUST
    // consult config.topup_nudge_cap_available — preserving the server-side
    // weekly-cap enforcement when the preview is balance-gated.
    expect(file).toMatch(/topup_nudge_cap_available/);
  });

  test("re-audit fix: the topup-finalization retry timer is tracked in a ref, not a bare setTimeout", () => {
    // Previously `setTimeout(() => {...}, 800)` inside finishToReport was
    // never stored anywhere and never cleared by cleanup() — a genuine
    // leak/stale-write risk if the component unmounted or a NEW session
    // started within that 800ms window. Every other timer in this file
    // follows the ref-and-clear pattern; this one must too.
    expect(file).toMatch(/topupRetryTimerRef\s*=\s*useRef\(null\)/);
    expect(file).toMatch(/topupRetryTimerRef\.current\s*=\s*setTimeout\(/);
  });

  test("re-audit fix: cleanup() clears the topup retry timer like every other tracked timer", () => {
    const cleanupStart = file.indexOf("const cleanup = useCallback(() => {");
    const cleanupEnd = file.indexOf("}, []);", cleanupStart);
    expect(cleanupStart).toBeGreaterThan(-1);
    const cleanupBody = file.slice(cleanupStart, cleanupEnd);
    expect(cleanupBody).toMatch(/if\s*\(topupRetryTimerRef\.current\)\s*clearTimeout\(topupRetryTimerRef\.current\)/);
    expect(cleanupBody).toMatch(/topupRetryTimerRef\.current\s*=\s*null/);
  });
});

// --------------------------------------------------------------------------- //
// Static wiring — Author Studio panel + snooze export.                        //
// --------------------------------------------------------------------------- //
describe("Studio panel + affordance static wiring", () => {
  test("EduTalkLivePanel exposes the three fields + validation", () => {
    const panel = read("studio/edutalkLive/EduTalkLivePanel.jsx");
    expect(panel).toMatch(/live-topup-nudge-enabled/);
    expect(panel).toMatch(/live-topup-nudge-threshold/);
    expect(panel).toMatch(/live-topup-nudge-cap/);
    expect(panel).toMatch(/validateTopupNudgeConfig\s*\(/);
    expect(panel).toMatch(/per student, across all their sessions, rolling 7 days/);
  });

  test("useTopUpAffordance exports the reused snooze predicate", () => {
    const aff = read("eduhub/components/topup/useTopUpAffordance.js");
    expect(aff).toMatch(/export function isTopUpSnoozed/);
  });
});

// --------------------------------------------------------------------------- //
// Phase 0B — EduTalk-Live-Coach-ONLY per-student snooze (separate keys).       //
// Proves §D frontend topup tests 1–5.                                         //
// --------------------------------------------------------------------------- //
describe("liveCoachTopupSnooze (EduTalk-only per-student)", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* noop */ }
  });

  test("uses its OWN keys and never the shared app-wide keys", () => {
    expect(dismissLogKey("alice")).toBe(
      "eduhub_edutalk_topup_dismiss_log_v1:alice");
    expect(snoozeUntilKey("alice")).toBe(
      "eduhub_edutalk_topup_snooze_until_v1:alice");
    // The shared app-wide keys must never appear in this helper's key format.
    expect(dismissLogKey("alice")).not.toMatch(/eduhub_topup_dismiss_log_v1$/);
    expect(snoozeUntilKey("alice")).not.toMatch(/eduhub_topup_snooze_until_v1$/);
  });

  test("normalizeStudentId trims + lowercases and rejects empty/overlong", () => {
    expect(normalizeStudentId("  Alice  ")).toBe("alice");
    expect(normalizeStudentId("")).toBe("");
    expect(normalizeStudentId(null)).toBe("");
    expect(normalizeStudentId("x".repeat(65))).toBe("");
  });

  test("student A's EduTalk snooze cannot suppress student B (test 1)", () => {
    recordEduTalkTopUpDismiss("alice");
    recordEduTalkTopUpDismiss("alice");
    recordEduTalkTopUpDismiss("alice"); // 3 in 7 days → A snoozed
    expect(isEduTalkTopUpSnoozed("alice")).toBe(true);
    expect(isEduTalkTopUpSnoozed("bob")).toBe(false); // B untouched
  });

  test("three dismissals within seven days snooze only that student (test 2)", () => {
    expect(isEduTalkTopUpSnoozed("carol")).toBe(false);
    recordEduTalkTopUpDismiss("carol");
    expect(isEduTalkTopUpSnoozed("carol")).toBe(false); // 1
    recordEduTalkTopUpDismiss("carol");
    expect(isEduTalkTopUpSnoozed("carol")).toBe(false); // 2
    recordEduTalkTopUpDismiss("carol");
    expect(isEduTalkTopUpSnoozed("carol")).toBe(true);  // 3 → snoozed
  });

  test("shared app-wide key is neither read nor written by EduTalk helper (test 3)", () => {
    // Pre-seed a shared app-wide snooze; the EduTalk predicate must ignore it.
    localStorage.setItem(
      "eduhub_topup_snooze_until_v1", String(Date.now() + 1000000));
    expect(isEduTalkTopUpSnoozed("dave")).toBe(false);
    // Recording an EduTalk dismiss must NOT touch the shared keys.
    recordEduTalkTopUpDismiss("dave");
    recordEduTalkTopUpDismiss("dave");
    recordEduTalkTopUpDismiss("dave");
    expect(localStorage.getItem("eduhub_topup_dismiss_log_v1")).toBeNull();
  });

  test("useTopUpAffordance.js is unchanged and still exports its current API (test 4)", () => {
    const aff = read("eduhub/components/topup/useTopUpAffordance.js");
    expect(aff).toMatch(/export function useTopUpAffordance/);
    expect(aff).toMatch(/export function recordTopUpDismiss/);
    expect(aff).toMatch(/export function pickRecommendedPackage/);
    expect(aff).toMatch(/export function markTopUpAutoShown/);
    expect(aff).toMatch(/export function isTopUpSnoozed/);
  });

  test("markTopUpAutoShown remains used to avoid duplicate modal stacking (test 5)", () => {
    const file = read("eduhub/pages/library/reader/live/EduTalkLiveCoach.jsx");
    expect(file).toMatch(/markTopUpAutoShown\s*\(/);
  });
});

// --------------------------------------------------------------------------- //
// Phase 0B — normalized visibility-decision helper (§D frontend topup test 6). //
// --------------------------------------------------------------------------- //
describe("normalizeStartVisibilityDecision / normalizeReportVisibilityDecision", () => {
  test("returns disabled reason when the feature is off", () => {
    const d = normalizeStartVisibilityDecision({
      enabled: false, snoozed: false, preview: null });
    expect(d.pill_shown).toBe(false);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.CONFIG_DISABLED);
  });

  test("returns snoozed reason when snoozed", () => {
    const d = normalizeStartVisibilityDecision({
      enabled: true, snoozed: true,
      preview: { diagnostic_reason: "eligible", eligible: true } });
    expect(d.pill_shown).toBe(false);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.SNOOZED);
  });

  test("returns eligible + shows pill, with truthful balance source", () => {
    const d = normalizeStartVisibilityDecision({
      enabled: true, snoozed: false,
      preview: { diagnostic_reason: "eligible", eligible: true,
        balance_source: NUDGE_BALANCE_SOURCES.MONGO_WALLET } });
    expect(d.pill_shown).toBe(true);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE);
    expect(d.balance_source).toBe(NUDGE_BALANCE_SOURCES.MONGO_WALLET);
  });

  test("cap exhaustion fails closed even if projected balance is low", () => {
    const d = normalizeStartVisibilityDecision({
      enabled: true, snoozed: false,
      preview: { diagnostic_reason: "eligible", eligible: true },
      capReason: "weekly_cap_reached" });
    expect(d.pill_shown).toBe(false);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.WEEKLY_CAP_REACHED);
  });

  test("maps legacy balance-above-threshold reason when no diagnostic_reason", () => {
    const d = normalizeStartVisibilityDecision({
      enabled: true, snoozed: false,
      preview: { reason: "balance_above_threshold", eligible: false } });
    expect(d.pill_shown).toBe(false);
    expect(d.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.BALANCE_ABOVE_THRESHOLD);
  });

  test("report decision returns eligible only when report_eligible", () => {
    const yes = normalizeReportVisibilityDecision({
      enabled: true, snoozed: false,
      finalization: { report_eligible: true,
        balance_source: NUDGE_BALANCE_SOURCES.GAS_VERIFIED_POST_RESERVATION } });
    expect(yes.pill_shown).toBe(true);
    expect(yes.reason).toBe(NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE);
    const no = normalizeReportVisibilityDecision({
      enabled: true, snoozed: false,
      finalization: { report_eligible: false } });
    expect(no.pill_shown).toBe(false);
  });
});
