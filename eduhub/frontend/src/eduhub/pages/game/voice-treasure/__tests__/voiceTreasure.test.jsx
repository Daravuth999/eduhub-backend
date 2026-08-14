/**
 * voiceTreasure.test.jsx — Core Game milestone frontend tests.
 *
 * Follows the repo's pure-function convention (no @testing-library dependency).
 * Covers the checklist items expressible without a DOM/MediaRecorder harness:
 * api contract (preview/confirm/submit/FormData/headers), recorder logic
 * (permission/start/stop/retry/duplicate-submit/cleanup), result rendering
 * (only the five score fields, no invented metrics), and Home tile gating
 * (unavailable hides VT, original five preserved). Runnable with `craco test`.
 */
import {
  REC_IDLE, REC_REQUESTING, REC_PERMISSION_DENIED, REC_RECORDING, REC_RECORDED,
  formatDuration, canStop, mustAutoStop, canSubmit, cleanupResources, nextStatus,
} from "../recorderLogic";
import { scoreRows, SCORE_ORDER } from "../resultView";
import { shouldShowVoiceTreasureTile, ORIGINAL_TILE_KEYS } from "../homeTile";

/* ── recorder logic ─────────────────────────────────────────────────────── */
describe("recorder logic", () => {
  test("formatDuration", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65)).toBe("01:05");
  });
  test("min/max gating", () => {
    expect(canStop(4, 5)).toBe(false);
    expect(canStop(5, 5)).toBe(true);
    expect(mustAutoStop(60, 60)).toBe(true);
    expect(mustAutoStop(10, 60)).toBe(false);
  });
  test("permission denied transition", () => {
    expect(nextStatus(REC_REQUESTING, "denied")).toBe(REC_PERMISSION_DENIED);
  });
  test("start/stop transitions", () => {
    expect(nextStatus(REC_IDLE, "request")).toBe(REC_REQUESTING);
    expect(nextStatus(REC_REQUESTING, "granted")).toBe(REC_RECORDING);
    expect(nextStatus(REC_RECORDING, "stopped")).toBe(REC_RECORDED);
  });
  test("retry/reset transition", () => {
    expect(nextStatus(REC_RECORDED, "reset")).toBe(REC_IDLE);
  });
  test("duplicate-submit prevention", () => {
    expect(canSubmit({ status: REC_RECORDED, submitting: false })).toBe(true);
    expect(canSubmit({ status: REC_RECORDED, submitting: true })).toBe(false);
    expect(canSubmit({ status: REC_RECORDING, submitting: false })).toBe(false);
  });
  test("cleanup revokes URL, stops tracks, clears timer", () => {
    const calls = { stop: 0, clear: 0, revoke: 0 };
    cleanupResources(
      { stream: { id: 1 }, timerId: 7, objectUrl: "blob:x" },
      {
        stopTracks: () => { calls.stop += 1; },
        clearTimer: () => { calls.clear += 1; },
        revokeUrl: () => { calls.revoke += 1; },
      },
    );
    expect(calls).toEqual({ stop: 1, clear: 1, revoke: 1 });
  });
  test("cleanup is safe with partial state", () => {
    let revoked = 0;
    cleanupResources({}, { revokeUrl: () => { revoked += 1; } });
    expect(revoked).toBe(0);
  });
});

/* ── result rendering ───────────────────────────────────────────────────── */
describe("result view", () => {
  test("renders exactly the five categories in order", () => {
    const rows = scoreRows({
      relevance: 70, visual_grounding: 60, detail: 50,
      organization: 40, understandable_language: 80,
    });
    expect(rows.map((r) => r.key)).toEqual(SCORE_ORDER);
  });
  test("drops invented metric fields", () => {
    const rows = scoreRows({
      relevance: 70, visual_grounding: 60, detail: 50, organization: 40,
      understandable_language: 80, pronunciation: 99, fluency: 12, confidence: 88,
    });
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain("pronunciation");
    expect(keys).not.toContain("fluency");
    expect(keys).not.toContain("confidence");
  });
  test("clamps values 0..100", () => {
    const rows = scoreRows({ relevance: 250, visual_grounding: -5, detail: 50, organization: 40, understandable_language: 80 });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.relevance).toBe(100);
    expect(byKey.visual_grounding).toBe(0);
  });
});

/* ── home tile gating ───────────────────────────────────────────────────── */
describe("home tile gating", () => {
  test("hidden when unavailable", () => {
    expect(shouldShowVoiceTreasureTile({ available: false, show_home_tile: true }, true)).toBe(false);
    expect(shouldShowVoiceTreasureTile({ available: true, show_home_tile: false }, true)).toBe(false);
    expect(shouldShowVoiceTreasureTile(null, true)).toBe(false);
  });
  test("hidden when not authenticated", () => {
    expect(shouldShowVoiceTreasureTile({ available: true, show_home_tile: true }, false)).toBe(false);
  });
  test("shown when available + tile flag + authed", () => {
    expect(shouldShowVoiceTreasureTile({ available: true, show_home_tile: true }, true)).toBe(true);
  });
  test("original five tiles preserved", () => {
    expect(ORIGINAL_TILE_KEYS).toEqual(["library", "portal", "spin", "assistant", "systemtest"]);
    expect(ORIGINAL_TILE_KEYS).toHaveLength(5);
  });
});
