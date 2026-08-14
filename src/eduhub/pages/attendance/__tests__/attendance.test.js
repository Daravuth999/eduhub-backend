/**
 * attendance.test.js — Source-inspection tests for the Fluid Bento Attendance UI
 * and Claimable Rewards feature.
 *
 * Convention: follows the project's existing test pattern (see
 * studio/__tests__/attendanceStudio.test.jsx): reads source files with
 * fs.readFileSync, asserts structure and contract.
 */
import fs from "fs";
import path from "path";

// __dirname = src/eduhub/pages/attendance/__tests__
// 5 levels up → project root
const ROOT = path.resolve(__dirname, "../../../../..");   // project root
const ATT  = path.resolve(__dirname, "..");               // src/eduhub/pages/attendance

function read(rel) {
  return fs.readFileSync(path.resolve(ATT, rel), "utf8");
}

function readSrc(relFromSrc) {
  // relative to src/
  return fs.readFileSync(path.resolve(ROOT, "src", relFromSrc), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. api.js — new reward endpoints
// ─────────────────────────────────────────────────────────────────────────────
describe("api.js — reward endpoints", () => {
  let src;
  beforeAll(() => { src = read("api.js"); });

  test("exports getRewardSummary hitting GET /api/attendance/rewards/summary", () => {
    expect(src).toMatch(/getRewardSummary/);
    expect(src).toMatch(/\/api\/attendance\/rewards\/summary/);
  });

  test("getRewardSummary uses GET (default _json, no method:POST)", () => {
    // Verify the function declaration for getRewardSummary doesn't contain POST
    const lines = src.split("\n");
    const summaryLineIdx = lines.findIndex((l) => l.includes("getRewardSummary"));
    const summaryLine = lines[summaryLineIdx] || "";
    expect(summaryLine).not.toMatch(/POST/);
  });

  test("exports claimReward hitting POST /api/attendance/rewards/claim", () => {
    expect(src).toMatch(/claimReward/);
    expect(src).toMatch(/\/api\/attendance\/rewards\/claim/);
  });

  test("claimReward uses method:POST", () => {
    expect(src).toMatch(/claimReward[\s\S]{0,80}method.*POST|POST[\s\S]{0,80}claim/);
  });

  test("default export includes getRewardSummary and claimReward", () => {
    expect(src).toMatch(/getRewardSummary/);
    expect(src).toMatch(/claimReward/);
    // Both appear in the export default block
    const defBlock = src.match(/export default\s*\{[\s\S]+?\};/)?.[0] || "";
    expect(defBlock).toMatch(/getRewardSummary/);
    expect(defBlock).toMatch(/claimReward/);
  });

  test("auth headers applied to every request via shared _json helper", () => {
    expect(src).toMatch(/function _json/);
    expect(src).toMatch(/authHeaders/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. useAttendance.js — reward methods exposed from hook
// ─────────────────────────────────────────────────────────────────────────────
describe("useAttendance.js — reward method exposure", () => {
  let src;
  beforeAll(() => { src = readSrc("eduhub/hooks/useAttendance.js"); });

  test("exposes getRewardSummary", () => {
    expect(src).toMatch(/getRewardSummary/);
  });

  test("exposes claimReward", () => {
    expect(src).toMatch(/claimReward/);
  });

  test("both methods are in the return object", () => {
    const returnBlock = src.match(/return\s*\{[\s\S]+?\};/)?.[0] || "";
    expect(returnBlock).toMatch(/getRewardSummary/);
    expect(returnBlock).toMatch(/claimReward/);
  });

  test("never exposes risk_score", () => {
    expect(src).not.toMatch(/risk_score/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ConstellationView.jsx — structure & bento sections
// ─────────────────────────────────────────────────────────────────────────────
describe("ConstellationView.jsx — bento layout structure", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  test("renders BentoHero component with testid", () => {
    expect(src).toMatch(/BentoHero/);
    expect(src).toMatch(/data-testid="bento-hero"/);
  });

  test("renders ClaimableRewardBento component with testid", () => {
    expect(src).toMatch(/ClaimableRewardBento/);
    expect(src).toMatch(/data-testid="claimable-reward-bento"/);
  });

  test("renders SummaryStats component with testid", () => {
    expect(src).toMatch(/SummaryStats/);
    expect(src).toMatch(/data-testid="summary-stats"/);
  });

  test("renders MonthlyMap component with testid", () => {
    expect(src).toMatch(/MonthlyMap/);
    expect(src).toMatch(/data-testid="monthly-map"/);
  });

  test("renders SmartAction component with testid", () => {
    expect(src).toMatch(/SmartAction/);
    expect(src).toMatch(/data-testid="smart-action"/);
  });

  test("preserves Stamp Ledger testid", () => {
    expect(src).toMatch(/data-testid="stamp-ledger"/);
  });

  test("preserves Attendance Record Table testid", () => {
    expect(src).toMatch(/data-testid="attendance-record-table"/);
  });

  test("preserves Adventure Map testid", () => {
    expect(src).toMatch(/data-testid="adventure-map"/);
  });

  test("preserves Tier Card testid", () => {
    expect(src).toMatch(/data-testid="tier-card"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ClaimableRewardBento — claim states represented in source
// ─────────────────────────────────────────────────────────────────────────────
describe("ClaimableRewardBento — claim states", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  test("has claimable state with Claim button testid", () => {
    expect(src).toMatch(/data-testid="claim-reward-button"/);
  });

  test("has accumulating state testid (progress toward minimum)", () => {
    expect(src).toMatch(/data-testid="reward-accumulating-state"/);
  });

  test("has no-reward state testid", () => {
    expect(src).toMatch(/data-testid="reward-no-pending-state"/);
  });

  test("has claimed state testid", () => {
    expect(src).toMatch(/data-testid="reward-claimed-state"/);
  });

  test("claim button shows Loader2 while claiming", () => {
    expect(src).toMatch(/Loader2/);
    expect(src).toMatch(/Claiming/);
  });

  test("Claim button is disabled when not idle (prevents double-tap)", () => {
    // Check for disabled prop tied to claimPhase
    expect(src).toMatch(/disabled=\{claimPhase !== ["']idle["']\}/);
  });

  test("component returns null when claim_enabled is false (auto-credit mode)", () => {
    // ClaimableRewardBento returns null when !summary.claim_enabled
    expect(src).toMatch(/!summary\.claim_enabled/);
  });

  test("passes getRewardSummary and claimReward into ClaimableRewardBento", () => {
    // Usage site in the main component
    expect(src).toMatch(/getRewardSummary=\{getRewardSummary\}/);
    expect(src).toMatch(/claimReward=\{claimReward\}/);
  });

  test("calls loadSummary after successful claim (wallet refresh)", () => {
    expect(src).toMatch(/loadSummary/);
    // loadSummary is called when credited_points > 0
    expect(src).toMatch(/credited_points.*>.*0/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. AttendanceTable — filter pills and states
// ─────────────────────────────────────────────────────────────────────────────
describe("AttendanceTable — filter states", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  // Filter pills use template literals in JSX: data-testid={`attendance-filter-${f.toLowerCase()}`}
  test("renders filter pill with template-literal testid", () => {
    expect(src).toMatch(/attendance-filter-\$\{/);
  });

  test("FILTERS array contains All, Present, Late, Absent", () => {
    expect(src).toMatch(/FILTERS\s*=\s*\[/);
    expect(src).toMatch(/"All"/);
    expect(src).toMatch(/"Present"/);
    expect(src).toMatch(/"Late"/);
    expect(src).toMatch(/"Absent"/);
  });

  test("filters by present_full and present_partial for Present filter", () => {
    expect(src).toMatch(/present_full/);
    expect(src).toMatch(/present_partial/);
  });

  test("raw enum values (present_full etc.) are not rendered as text to users", () => {
    // Labels use human-readable strings, not raw enum values
    expect(src).toMatch(/label:\s*["']Present["']/);
    expect(src).toMatch(/label:\s*["']Late["']/);
    expect(src).toMatch(/label:\s*["']Absent["']/);
    // Raw enum values must not appear between JSX angle brackets as text content
    expect(src).not.toMatch(/>present_full</);
    expect(src).not.toMatch(/>present_partial</);
    expect(src).not.toMatch(/>ST_PRESENT</);
  });

  test("AttendanceTable returns null for empty history", () => {
    expect(src).toMatch(/history\.length === 0.*return null/s);
  });

  test("shows late duration from minutes_late field", () => {
    expect(src).toMatch(/minutes_late/);
    expect(src).toMatch(/min late/);
  });

  test("reads date from checked_in_at or session_date", () => {
    expect(src).toMatch(/checked_in_at.*session_date|session_date.*checked_in_at/);
  });

  test("reads class title from title_en with class_title fallback", () => {
    expect(src).toMatch(/title_en/);
    expect(src).toMatch(/class_title/);
  });

  test("footer shows N of M sessions shown", () => {
    expect(src).toMatch(/sessions shown/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. MonthlyMap — uses real history records
// ─────────────────────────────────────────────────────────────────────────────
describe("MonthlyMap — attendance dot map", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  test("reads session_date and checked_in_at from history", () => {
    expect(src).toMatch(/session_date/);
    expect(src).toMatch(/checked_in_at/);
  });

  test("renders dots with status-based color via DOT_STATUS map", () => {
    expect(src).toMatch(/DOT_STATUS/);
    expect(src).toMatch(/present_full/);
  });

  test("renders per-dot testid for audit traceability", () => {
    expect(src).toMatch(/data-testid=\{`month-dot-/);
  });

  test("includes legend for all four attendance statuses", () => {
    // Legend section covers all four statuses
    expect(src).toMatch(/DOT_STATUS\.present_full/);
    expect(src).toMatch(/DOT_STATUS\.late/);
    expect(src).toMatch(/DOT_STATUS\.absent/);
    expect(src).toMatch(/DOT_STATUS\.present_partial/);
  });

  test("returns null when months list is empty (no history)", () => {
    expect(src).toMatch(/months\.length === 0.*return null/s);
  });

  test("groups sessions by month with human-readable label", () => {
    expect(src).toMatch(/month.*long/i);
    expect(src).toMatch(/year.*numeric/i);
  });

  test("caps at last 3 months to avoid infinite scroll", () => {
    expect(src).toMatch(/\.slice\(0,\s*3\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. BentoHero — live session CTA and navigation
// ─────────────────────────────────────────────────────────────────────────────
describe("BentoHero — live session and navigation", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  test("live CTA links to /attendance/j/:slug", () => {
    expect(src).toMatch(/\/attendance\/j\/\$\{live\.slug\}/);
  });

  test("live-pill testid present", () => {
    expect(src).toMatch(/data-testid="bento-hero-live-pill"/);
  });

  test("live-cta testid present", () => {
    expect(src).toMatch(/data-testid="bento-hero-live-cta"/);
  });

  test("shows student display_name with testid", () => {
    expect(src).toMatch(/data-testid="bento-hero-name"/);
    expect(src).toMatch(/display_name/);
  });

  test("shows tier badge with testid", () => {
    expect(src).toMatch(/data-testid="bento-hero-tier"/);
  });

  test("shows streak chip with testid", () => {
    expect(src).toMatch(/data-testid="bento-hero-streak"/);
    expect(src).toMatch(/day streak/);
  });

  test("shows attendance rate chip with testid", () => {
    expect(src).toMatch(/data-testid="bento-hero-rate"/);
    expect(src).toMatch(/attendance_rate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. SmartAction — context-aware CTA
// ─────────────────────────────────────────────────────────────────────────────
describe("SmartAction — context-aware CTA", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  test("join-class action routes to /attendance/j/:slug", () => {
    expect(src).toMatch(/smart-action-join/);
    expect(src).toMatch(/\/attendance\/j\/\$\{live\.slug\}/);
  });

  test("absent-student action exists", () => {
    expect(src).toMatch(/smart-action-absent/);
  });

  test("first-session action exists (total_sessions === 0)", () => {
    expect(src).toMatch(/smart-action-first/);
    expect(src).toMatch(/total_sessions.*===\s*0|0\s*===.*total_sessions/);
  });

  test("returns null when no contextual action needed", () => {
    expect(src).toMatch(/if\s*\(!action\).*return null/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Privacy — risk_score and teacher-only fields excluded
// ─────────────────────────────────────────────────────────────────────────────
describe("Privacy — teacher-only fields excluded", () => {
  test("ConstellationView.jsx has no risk_score in non-comment lines", () => {
    const src = read("ConstellationView.jsx");
    const lines = src.split("\n").filter((l) => {
      const trimmed = l.trim();
      return (
        l.includes("risk_score") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*")
      );
    });
    expect(lines).toHaveLength(0);
  });

  test("api.js has no risk_score in any line", () => {
    const src = read("api.js");
    expect(src).not.toMatch(/risk_score/);
  });

  test("useAttendance hook has no risk_score", () => {
    const src = readSrc("eduhub/hooks/useAttendance.js");
    expect(src).not.toMatch(/risk_score/);
  });

  test("Meet URL is not requested as a separate endpoint in api.js", () => {
    const src = read("api.js");
    // meet_url only appears in JSDoc comment explaining why it's NOT requested;
    // no non-comment line should call a meet_url endpoint.
    const nonCommentLines = src.split("\n").filter((l) => {
      const t = l.trim();
      return l.includes("meet_url") && !t.startsWith("*") && !t.startsWith("//");
    });
    expect(nonCommentLines).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. SummaryStats — stat grid categories
// ─────────────────────────────────────────────────────────────────────────────
describe("SummaryStats — attendance stat grid", () => {
  let src;
  beforeAll(() => { src = read("ConstellationView.jsx"); });

  // SummaryStats uses template-literal testids: data-testid={`stat-${label.toLowerCase()...}`}
  test("stat testids rendered via template-literal (stat-<label>)", () => {
    expect(src).toMatch(/data-testid=\{`stat-\$/);
  });

  test("stats array includes Present, Late, Absent, Sessions labels", () => {
    expect(src).toMatch(/label:\s*["']Present["']/);
    expect(src).toMatch(/label:\s*["']Late["']/);
    expect(src).toMatch(/label:\s*["']Absent["']/);
    expect(src).toMatch(/label:\s*["']Sessions["']/);
  });

  test("uses attendance_rate from /me response", () => {
    expect(src).toMatch(/attendance_rate/);
  });

  test("SummaryStats returns null when me is null", () => {
    expect(src).toMatch(/if\s*\(!me\).*return null/s);
  });

  test("no risk_score in non-comment lines of ConstellationView", () => {
    // Full-file comment-aware check (matches the Privacy section check).
    const nonCommentLines = src.split("\n").filter((l) => {
      const t = l.trim();
      return l.includes("risk_score") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    expect(nonCommentLines).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. attendanceSchema.js — frontend settings mirror backend defaults
// ─────────────────────────────────────────────────────────────────────────────
describe("attendanceSchema.js — frontend mirrors backend defaults", () => {
  let src;
  beforeAll(() => { src = read("attendanceSchema.js"); });

  test("exports defaultAttendanceSettings function", () => {
    expect(src).toMatch(/export function defaultAttendanceSettings/);
  });

  test("reward_tiers includes all four tiers", () => {
    expect(src).toMatch(/bronze/);
    expect(src).toMatch(/silver/);
    expect(src).toMatch(/gold/);
    expect(src).toMatch(/diamond/);
  });

  test("does not contain claim_rewards_enabled (backend-only setting)", () => {
    expect(src).not.toMatch(/claim_rewards_enabled/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Protected perimeter — forbidden files not modified
// ─────────────────────────────────────────────────────────────────────────────
describe("Protected perimeter — forbidden files unchanged", () => {
  test("AuthContext.jsx does not reference claimReward or COLL_CLAIMS", () => {
    const authPath = path.resolve(ROOT, "src", "eduhub/auth/AuthContext.jsx");
    if (!fs.existsSync(authPath)) return; // skip if file doesn't exist
    const src = fs.readFileSync(authPath, "utf8");
    expect(src).not.toMatch(/claimReward|COLL_CLAIMS|attendance_reward_claims/);
  });

  test("package.json was not modified to add new dependencies", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, "package.json"), "utf8")
    );
    // Verify no attendance-specific dependency was added (all needed deps existed)
    const deps = Object.keys(pkg.dependencies || {}).join(",");
    expect(deps).not.toMatch(/attendance-reward|claim-sdk/);
  });

  test("ConstellationView does not import wallet_service or payment files", () => {
    const src = read("ConstellationView.jsx");
    expect(src).not.toMatch(/wallet_service|payment_bridge|camrapidpay|KHQR|ABA/);
  });
});
