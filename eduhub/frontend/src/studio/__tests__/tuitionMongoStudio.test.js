/**
 * tuitionMongoStudio.test.js — Gate 11 frontend tests (source-inspection)
 *
 * MongoPanel in TuitionReminderStudio — Gate 1: all wired controls present
 *
 * Verifies that every required control is wired to a real backend endpoint,
 * not just displayed as a read-only widget.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const STUDIO_SRC = "studio/TuitionReminderStudio.jsx";

function readSrc(relPath) {
  return fs.readFileSync(path.resolve(ROOT, "src", relPath), "utf8");
}

describe("MongoPanel — Gate 1: all controls wired to backend routes", () => {
  // src    = TuitionReminderStudio.jsx  — UI, sub-tabs, form fields, named fn calls
  // apiSrc = tuitionAdminApi.js         — endpoint strings, HTTP methods
  let src;
  let apiSrc;
  beforeAll(() => {
    src    = readSrc(STUDIO_SRC);
    apiSrc = readSrc("studio/tuitionAdminApi.js");
  });

  /* ── Sub-tab structure (TuitionReminderStudio.jsx) ── */
  test("has Accounts sub-tab", () => {
    expect(src).toMatch(/subTab\s*===\s*["']accounts["']/);
  });
  test("has Global Config sub-tab", () => {
    expect(src).toMatch(/subTab\s*===\s*["']config["']/);
  });
  test("has Reminder Builder sub-tab", () => {
    expect(src).toMatch(/subTab\s*===\s*["']reminder["']/);
  });
  test("has Manual Payment sub-tab", () => {
    expect(src).toMatch(/subTab\s*===\s*["']manual["']/);
  });
  test("has Migration sub-tab", () => {
    expect(src).toMatch(/subTab\s*===\s*["']migration["']/);
  });
  test("has Dashboard sub-tab", () => {
    expect(src).toMatch(/subTab\s*===\s*["']dashboard["']/);
  });

  /* ── Accounts: wired PATCH (endpoint in tuitionAdminApi.js) ── */
  test("accounts tab calls GET /api/admin/tuition/accounts", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/accounts["'`]/);
  });
  test("accounts edit form PATCHes /api/admin/tuition/accounts/{student_id}", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/accounts\/\$\{encodeURIComponent/);
    expect(apiSrc).toMatch(/method:\s*["']PATCH["']/);
  });
  test("accounts form has monthly_amount field", () => {
    expect(src).toMatch(/monthly_amount/);
  });
  test("accounts form has billing_anchor_day field", () => {
    expect(src).toMatch(/billing_anchor_day/);
  });
  test("accounts form has next_due_date field", () => {
    expect(src).toMatch(/next_due_date/);
  });
  test("accounts form has tuition_enabled toggle", () => {
    expect(src).toMatch(/tuition_enabled/);
  });
  test("accounts form has per-student reward_override_points field", () => {
    expect(src).toMatch(/reward_override_points/);
  });

  /* ── Global config: wired PUT (endpoint in tuitionAdminApi.js) ── */
  test("global config tab calls GET /api/admin/tuition/config", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/config["'`]/);
  });
  test("global config saves via PUT /api/admin/tuition/config", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/config.*PUT|PUT.*\/api\/admin\/tuition\/config/s);
  });
  test("global config has default_monthly_amount field", () => {
    expect(src).toMatch(/default_monthly_amount/);
  });
  test("global config has default_reward_points field", () => {
    expect(src).toMatch(/default_reward_points/);
  });
  test("global config has payment_push_enabled toggle", () => {
    expect(src).toMatch(/payment_push_enabled/);
  });
  test("global config has reward_push_enabled toggle", () => {
    expect(src).toMatch(/reward_push_enabled/);
  });

  /* ── Reminder builder: wired PUT (endpoint in tuitionAdminApi.js) ── */
  test("reminder config calls GET /api/admin/tuition/reminder/config", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/reminder\/config["'`]/);
  });
  test("reminder config saves via PUT /api/admin/tuition/reminder/config", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/reminder\/config.*PUT|PUT.*\/api\/admin\/tuition\/reminder\/config/s);
  });
  test("reminder builder has audience selector", () => {
    expect(src).toMatch(/audience/);
  });
  test("reminder builder has due_window_days field", () => {
    expect(src).toMatch(/due_window_days/);
  });
  test("reminder builder has bilingual title fields (title_km, title_en)", () => {
    expect(src).toMatch(/title_km/);
    expect(src).toMatch(/title_en/);
  });
  test("reminder builder has bilingual body fields (body_km, body_en)", () => {
    expect(src).toMatch(/body_km/);
    expect(src).toMatch(/body_en/);
  });
  test("reminder builder has frequency_hours field", () => {
    expect(src).toMatch(/frequency_hours/);
  });
  test("reminder builder has dismiss_strategy selector", () => {
    expect(src).toMatch(/dismiss_strategy/);
  });
  test("reminder builder has snooze_hours field", () => {
    expect(src).toMatch(/snooze_hours/);
  });
  test("reminder builder has mobile preview section", () => {
    expect(src).toMatch(/Mobile Preview/);
    expect(src).toMatch(/rConfigForm\.title_km/);
    expect(src).toMatch(/rConfigForm\.body_km/);
  });

  /* ── Manual payment: wired POST (endpoint in tuitionAdminApi.js) ── */
  test("manual payment POSTs to /api/admin/tuition/manual-payment", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/manual-payment/);
    expect(apiSrc).toMatch(/method:\s*["']POST["']/);
  });
  test("manual payment form has student_id field", () => {
    expect(src).toMatch(/student_id.*manualForm|manualForm.*student_id/s);
  });
  test("manual payment form has amount_usd field", () => {
    expect(src).toMatch(/amount_usd.*manualForm|manualForm.*amount_usd/s);
  });
  test("manual payment form has months_covered field (multi-month support)", () => {
    expect(src).toMatch(/months_covered/);
  });

  /* ── Migration: all three steps wired (endpoints in tuitionAdminApi.js) ── */
  test("migration dry-run POSTs to /api/admin/tuition/migration/dry-run", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/migration\/dry-run/);
  });
  test("migration import POSTs to /api/admin/tuition/migration/import", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/migration\/import/);
  });
  test("migration cutover POSTs to /api/admin/tuition/cutover with confirm: true", () => {
    expect(apiSrc).toMatch(/\/api\/admin\/tuition\/cutover/);
    // confirm: true payload is assembled in TuitionReminderStudio.jsx
    expect(src).toMatch(/confirm:\s*true/);
  });
  test("cutover requires armed confirmation (two-step)", () => {
    expect(src).toMatch(/cutoverArmed/);
    expect(src).toMatch(/setCutoverArmed\s*\(\s*true\s*\)/);
  });
  test("dry-run result shows new/conflict/invalid/missing breakdown", () => {
    expect(src).toMatch(/dryRunResult/);
    expect(src).toMatch(/"conflict"/);
    expect(src).toMatch(/"invalid"/);
    expect(src).toMatch(/"missing"/);
  });

  /* ── Receipt history: immutable display ── */
  test("receipt history is displayed and labelled immutable", () => {
    expect(src).toMatch(/immutable/i);
  });
  test("receipt history shows acknowledged status", () => {
    expect(src).toMatch(/acknowledged_at/);
  });
});

/* ── Safety: protected systems untouched ── */
describe("MongoPanel — Gate 14: protected systems untouched", () => {
  test("TuitionReminderStudio does not modify wallet_service", () => {
    const src = readSrc(STUDIO_SRC);
    expect(src).not.toMatch(/wallet_service/);
  });

  test("MongoPanel uses admin token (getToken), not student token", () => {
    const src = readSrc(STUDIO_SRC);
    expect(src).toMatch(/getToken\s*\(\s*\)/);
  });

  test("MongoPanel does not call lucky_draw or attendance reward endpoints", () => {
    const src = readSrc(STUDIO_SRC);
    expect(src).not.toMatch(/lucky_draw/);
    expect(src).not.toMatch(/attendance.*reward|reward.*attendance/i);
  });
});

/* ── API wiring: _aFetch removed, tuitionAdminApi used ── */
describe("MongoPanel — API wiring: tuitionAdminApi replaces inline _aFetch", () => {
  let src;
  beforeAll(() => { src = readSrc(STUDIO_SRC); });

  test("no _aFetch call remains (undeclared variable eliminated)", () => {
    expect(src).not.toMatch(/_aFetch\s*\(/);
  });
  test("no __aFetch declaration remains", () => {
    expect(src).not.toMatch(/async function __aFetch/);
  });
  test("no _aHeaders declaration remains", () => {
    expect(src).not.toMatch(/function _aHeaders/);
  });
  test("imports from tuitionAdminApi", () => {
    expect(src).toMatch(/from.*tuitionAdminApi/);
  });
  test("uses getTuitionAccounts loader", () => {
    expect(src).toMatch(/getTuitionAccounts\s*\(\s*\)/);
  });
  test("uses updateTuitionAccount for account PATCH", () => {
    expect(src).toMatch(/updateTuitionAccount\s*\(/);
  });
  test("uses getTuitionConfig loader", () => {
    expect(src).toMatch(/getTuitionConfig\s*\(\s*\)/);
  });
  test("uses saveTuitionConfig for PUT", () => {
    expect(src).toMatch(/saveTuitionConfig\s*\(/);
  });
  test("uses getReminderConfig loader", () => {
    expect(src).toMatch(/getReminderConfig\s*\(\s*\)/);
  });
  test("uses saveReminderConfig for PUT", () => {
    expect(src).toMatch(/saveReminderConfig\s*\(/);
  });
  test("uses recordManualPayment for POST", () => {
    expect(src).toMatch(/recordManualPayment\s*\(/);
  });
  test("uses getTuitionDashboard, getTuitionReceipts, getMigrationStatus in Promise.all", () => {
    expect(src).toMatch(/getTuitionDashboard\s*\(\s*\)/);
    expect(src).toMatch(/getTuitionReceipts\s*\(\s*\)/);
    expect(src).toMatch(/getMigrationStatus\s*\(\s*\)/);
  });
  test("uses runMigrationDryRun for dry-run POST", () => {
    expect(src).toMatch(/runMigrationDryRun\s*\(\s*\)/);
  });
  test("uses runMigrationImport for import POST", () => {
    expect(src).toMatch(/runMigrationImport\s*\(\s*\)/);
  });
  test("uses runTuitionCutover with confirm payload", () => {
    expect(src).toMatch(/runTuitionCutover\s*\(/);
    expect(src).toMatch(/confirm:\s*true/);
  });
  test("dashboard error message is user-readable, not a raw JS error", () => {
    expect(src).toMatch(/Unable to load tuition data|Session expired/);
  });
});
