/**
 * roster.js — leaderboard source-of-truth tests.
 *
 * Architecture continuation: fetchRosterPoints() is documented as "the
 * single, central place every leaderboard/Top N UI consults" (4 known
 * consumers). It must now try the backend's Mongo-ledger leaderboard
 * FIRST, falling back to the legacy Google Sheets CSV export only when
 * the backend reports disabled/unreachable — never the other way
 * around, and never a silent crash either way.
 *
 * RENDER_BASE is captured at module-load time (matches speakingLabApi.ts's
 * own tested convention), so REACT_APP_BACKEND_URL must be set BEFORE the
 * module is (re-)imported for each test.
 */

describe("fetchRosterPoints — backend-first with Sheets fallback", () => {
  const originalEnv = process.env.REACT_APP_BACKEND_URL;

  beforeEach(() => {
    process.env.REACT_APP_BACKEND_URL = "https://backend.example.test";
    jest.resetModules();
  });

  afterEach(() => {
    process.env.REACT_APP_BACKEND_URL = originalEnv;
    jest.restoreAllMocks();
  });

  test("uses backend leaderboard data when mode is mongo", async () => {
    const mod = require("../roster");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "mongo",
        entries: [
          { rank: 1, student_id: "stu2", display_name: "Bob", points: 500 },
          { rank: 2, student_id: "stu1", display_name: "Alice", points: 100 },
        ],
      }),
    });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([
      { name: "Bob", points: 500, studentId: "stu2" },
      { name: "Alice", points: 100, studentId: "stu1" },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/student/points/leaderboard"),
      expect.any(Object),
    );
  });

  test("passes through clean_id as studentId when student_id is absent", async () => {
    const mod = require("../roster");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "mongo",
        entries: [{ clean_id: "stu9", display_name: "Cara", points: 42 }],
      }),
    });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Cara", points: 42, studentId: "stu9" }]);
  });

  test("studentId is null when the backend entry has neither student_id nor clean_id", async () => {
    const mod = require("../roster");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "mongo",
        entries: [{ display_name: "Dara", points: 7 }],
      }),
    });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Dara", points: 7, studentId: null }]);
  });

  test("falls back to Sheets CSV when backend reports mode=disabled", async () => {
    const mod = require("../roster");
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ mode: "disabled", entries: [] }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "Name,Points\nAlice,100\nBob,200\n" });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Alice", points: 100 }, { name: "Bob", points: 200 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("falls back to Sheets CSV when the backend call throws", async () => {
    const mod = require("../roster");
    jest.spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, text: async () => "Name,Points\nAlice,100\n" });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Alice", points: 100 }]);
  });

  test("falls back to Sheets CSV when the backend responds non-ok", async () => {
    const mod = require("../roster");
    jest.spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, text: async () => "Name,Points\nAlice,100\n" });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Alice", points: 100 }]);
  });

  test("filters SKIP_NAMES entries out of backend leaderboard results", async () => {
    const mod = require("../roster");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "mongo",
        entries: [
          { student_id: "stu092", display_name: "Treasury Wallet", points: 99999 },
          { student_id: "stu1", display_name: "Alice", points: 100 },
        ],
      }),
    });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Alice", points: 100, studentId: "stu1" }]);
  });

  test("skips the backend call entirely when REACT_APP_BACKEND_URL is unset", async () => {
    process.env.REACT_APP_BACKEND_URL = "";
    jest.resetModules();
    const mod = require("../roster");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true, text: async () => "Name,Points\nAlice,100\n",
    });
    const rows = await mod.fetchRosterPoints();
    expect(rows).toEqual([{ name: "Alice", points: 100 }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("parseRosterCsv — unchanged legacy CSV parsing", () => {
  test("parses rows and skips the header + blank lines", () => {
    const { parseRosterCsv } = require("../roster");
    const rows = parseRosterCsv("Name,Points\nAlice,100\n\nBob,200\n");
    expect(rows).toEqual([{ name: "Alice", points: 100 }, { name: "Bob", points: 200 }]);
  });

  test("skips SKIP_NAMES entries case-insensitively", () => {
    const { parseRosterCsv } = require("../roster");
    const rows = parseRosterCsv("Name,Points\nAlice,100\nTreasury Wallet,999\n");
    expect(rows).toEqual([{ name: "Alice", points: 100 }]);
  });
});
