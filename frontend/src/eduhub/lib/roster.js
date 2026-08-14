// Public Google Sheet CSV export — column A: Name, column B: Points
const SHEET_ID = "1-2XB_IbSySMTeTnk14XZWZyJ_AuGFZOOu7_mo2lNCAw";
export const ROSTER_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

const SKIP_NAMES = new Set(["inactive", "developer team", "developer_team", "test"]);

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
  // Cache-buster to bypass Google/CDN caching
  const url = `${ROSTER_CSV_URL}&t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return parseRosterCsv(text);
}
