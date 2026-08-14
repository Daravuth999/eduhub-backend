// Public Google Sheet CSV export — column A: Name, column B: Points
const SHEET_ID = "1-2XB_IbSySMTeTnk14XZWZyJ_AuGFZOOu7_mo2lNCAw";
export const ROSTER_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

// v13.2 (Treasury exclusion, Jan-2026)
// ────────────────────────────────────────────────────────────────────
// SKIP_NAMES is the single, central place every leaderboard / Top N
// UI consults. Anything listed here is excluded from the rows
// returned by `fetchRosterPoints()` and therefore is automatically
// invisible to:
//   • useTopEarners → TopFiveStrip (Top 5 / Hall of Earners)
//   • useTopEarners → TopEarnerPanel (any other panel)
//   • TopFiveHero  (its own fetcher)
//   • PortalPublic Top 10 class leaderboard
//   • the rank 6+ marquee / ticker
//   • the cycling spotlight
//
// The Treasury Wallet entry (display-name "Treasury Wallet", student
// id "stu092") is excluded ONLY from the leaderboard UI here. The
// wallet's backend behaviour, points crediting, transfer logic, and
// every other consumer (purchaseService, studio/api.js, etc.) is
// untouched because they reference the wallet by its student id, not
// by the Google-Sheet display name. This is a display-only filter.
const SKIP_NAMES = new Set([
  "inactive",
  "developer team",
  "developer_team",
  "test",
  // ── Treasury Wallet (display-layer exclusion only) ──────────────
  "treasury wallet",  // display name shown in the public roster sheet
  "stu092",           // defensive — in case the sheet ever lists the id
]);

// Architecture continuation — "leaderboards must use runtime projections,
// no duplicated calculations inside the frontend, no browser source of
// truth." Tries the backend's Mongo-ledger-backed leaderboard first
// (wallet_service.py's GET /student/points/leaderboard, "Migration Phase
// 8"); returns null on ANY failure or when the backend reports
// mode!=="mongo" (USE_MONGO_POINTS_READ still off — GAS Sheets remains
// authoritative for most students in production today) so the caller
// falls back to the existing Sheets fetch below. Same
// try-backend-then-null-on-anything-else convention as
// portal/lib/api.ts's _renderPointsLogin.
const RENDER_BASE = (
  (typeof process !== "undefined" &&
    process.env &&
    process.env.REACT_APP_BACKEND_URL) ||
  ""
).replace(/\/$/, "");

async function fetchLeaderboardFromBackend() {
  if (!RENDER_BASE) return null;
  try {
    const token =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("student_session_token")
        : null;
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${RENDER_BASE}/api/student/points/leaderboard?limit=50`, {
      method: "GET",
      credentials: "include",
      headers,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.mode !== "mongo") return null;
    return (data.entries || [])
      .filter((e) => {
        const name = (e.display_name || "").toLowerCase();
        const id = (e.student_id || e.clean_id || "").toLowerCase();
        return !SKIP_NAMES.has(name) && !SKIP_NAMES.has(id);
      })
      // studentId is passed through (when the Mongo-backed leaderboard
      // provides one) so consumers that need to identify "which row is
      // ME" — e.g. the Dashboard's MyRankCard — can join on a real id
      // instead of fuzzy name-matching. The legacy CSV Sheet path below
      // has no such id, so rows from that path simply omit the field;
      // callers must treat it as optional, not assume it's always present.
      .map((e) => ({ name: e.display_name, points: e.points, studentId: e.student_id || e.clean_id || null }));
  } catch {
    return null;
  }
}

export function parseRosterCsv(text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/);
  // drop header line (Name,Points)
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    // naive CSV split — names don't contain commas in this sheet
    const parts = raw.split(",");
    if (parts.length < 2) continue;
    const name = (parts[0] || "").trim();
    const rawPoints = (parts.slice(1).join(",") || "").trim();
    if (!name) continue;
    if (SKIP_NAMES.has(name.toLowerCase())) continue;
    const points = parseFloat(rawPoints.replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(points)) continue;
    rows.push({ name, points });
  }
  return rows;
}

export async function fetchRosterPoints() {
  const backend = await fetchLeaderboardFromBackend();
  if (backend) return backend;

  // Legacy fallback — Google Sheets stays read-only content until the
  // backend's USE_MONGO_POINTS_READ flag is deliberately flipped (a
  // separate production cutover decision; see fetchLeaderboardFromBackend).
  const url = `${ROSTER_CSV_URL}&t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return parseRosterCsv(text);
}
