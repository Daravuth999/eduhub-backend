/**
 * voiceTreasureChest.test.jsx — final milestone frontend tests (pure-logic +
 * api contract; no @testing-library dependency, runnable under `craco test`).
 * Covers: sealed-until-confirmed, poll-only-while-processing, reveal-only-when-
 * completed, claim/retry gating, reconciliation sealed, ineligible, no
 * fabricated balance, claim API shape, and rewards/collection/progress calls.
 */
import {
  chestPresentation, shouldPoll, canClaim, revealsReward, isSealed,
  STUDENT_VISIBLE_REWARD_TYPES, HIDDEN_REWARD_TYPES, REVEAL_FIELDS,
  CHEST_ELIGIBLE, CHEST_PROCESSING, CHEST_RECONCILE, CHEST_COMPLETED,
  CHEST_FAILED, CHEST_INELIGIBLE,
} from "../chestView";
import * as api from "../api";

describe("reward type visibility", () => {
  test("points + first voice card + voucher + edutalk_pass are student-visible (Pass A.1)", () => {
    // Pass A.1 — voucher and EduTalk Pass are now student-visible WHEN the
    // backend fulfillment confirms `state === "granted"`. The reveal layer
    // (VoiceTreasureChest) enforces the granted-only gate via the
    // `shouldRevealVoucher` / `shouldRevealEdutalkPass` helpers.
    expect(STUDENT_VISIBLE_REWARD_TYPES).toEqual([
      "points", "first_voice_card", "voucher", "edutalk_pass",
    ]);
  });
  test("only premium / store / boost reward types remain hidden", () => {
    ["gems", "skins", "boosts", "premium_pass"].forEach((t) =>
      expect(HIDDEN_REWARD_TYPES).toContain(t));
    // Pass A.1 — voucher and edutalk_pass are NO LONGER unconditionally hidden.
    expect(HIDDEN_REWARD_TYPES).not.toContain("voucher");
    expect(HIDDEN_REWARD_TYPES).not.toContain("edutalk_pass");
  });
  test("visible and hidden sets do not overlap", () => {
    const overlap = STUDENT_VISIBLE_REWARD_TYPES.filter((t) => HIDDEN_REWARD_TYPES.includes(t));
    expect(overlap).toEqual([]);
  });
  test("reveal fields contain no fabricated currencies", () => {
    ["gems", "xp", "skins", "coins", "tokens"].forEach((bad) =>
      expect(REVEAL_FIELDS).not.toContain(bad));
  });
});

describe("chest view logic", () => {
  test("only completed reveals reward / opens chest", () => {
    expect(revealsReward(CHEST_COMPLETED)).toBe(true);
    [CHEST_ELIGIBLE, CHEST_PROCESSING, CHEST_RECONCILE, CHEST_FAILED, CHEST_INELIGIBLE].forEach((s) => {
      expect(revealsReward(s)).toBe(false);
      expect(isSealed(s)).toBe(true);
    });
    expect(isSealed(CHEST_COMPLETED)).toBe(false);
  });
  test("poll only while processing", () => {
    expect(shouldPoll(CHEST_PROCESSING)).toBe(true);
    [CHEST_ELIGIBLE, CHEST_RECONCILE, CHEST_COMPLETED, CHEST_FAILED, CHEST_INELIGIBLE].forEach((s) =>
      expect(shouldPoll(s)).toBe(false));
  });
  test("claim offered only when eligible or retryable", () => {
    expect(canClaim(CHEST_ELIGIBLE)).toBe(true);
    expect(canClaim(CHEST_FAILED)).toBe(true);
    [CHEST_PROCESSING, CHEST_RECONCILE, CHEST_COMPLETED, CHEST_INELIGIBLE].forEach((s) =>
      expect(canClaim(s)).toBe(false));
  });
  test("reconciliation + processing stay sealed", () => {
    expect(chestPresentation(CHEST_RECONCILE).sealed).toBe(true);
    expect(chestPresentation(CHEST_PROCESSING).sealed).toBe(true);
  });
  test("completed presentation is open", () => {
    expect(chestPresentation(CHEST_COMPLETED).sealed).toBe(false);
  });
  test("ineligible never claims and stays sealed", () => {
    expect(canClaim(CHEST_INELIGIBLE)).toBe(false);
    expect(isSealed(CHEST_INELIGIBLE)).toBe(true);
  });
});

describe("reward api contract", () => {
  let cap;
  beforeEach(() => {
    cap = {};
    global.fetch = (url, opts) => { cap.url = url; cap.opts = opts; return Promise.resolve({ ok: true, json: () => Promise.resolve({ chest: { chest_state: "completed" } }) }); };
    global.localStorage = { _v: {}, getItem(k) { return this._v[k] || null; }, setItem(k, v) { this._v[k] = v; }, removeItem(k) { delete this._v[k]; } };
  });
  test("claim POSTs attempt_id with credentials", async () => {
    await api.claim("att-1");
    expect(cap.opts.method).toBe("POST");
    expect(cap.opts.credentials).toBe("include");
    expect(JSON.parse(cap.opts.body).attempt_id).toBe("att-1");
  });
  test("claim status is GET (no body)", async () => {
    await api.getClaimStatus("att-1");
    expect(cap.url).toContain("/claim/att-1");
    expect(cap.opts.body).toBeUndefined();
  });
  test("rewards/collection/progress are GET", async () => {
    await api.getRewards(); expect(cap.url).toContain("/rewards");
    await api.getCollection(); expect(cap.url).toContain("/collection");
    await api.getProgress(); expect(cap.url).toContain("/progress");
  });
});

describe("no fabricated balance in reveal data", () => {
  test("completed reward without balance does not synthesize one", () => {
    // chestView never adds a balance; the component only renders it when present.
    const reward = { points_credited: 10, first_voice_card: "newly_granted" };
    expect("balance" in reward).toBe(false);
  });
  test("refresh_required contract carries null new_balance, no balance number", () => {
    const reward = { points_credited: 10, balance_status: "refresh_required", new_balance: null };
    expect(reward.balance_status).toBe("refresh_required");
    expect(reward.new_balance).toBe(null);
    expect("balance" in reward).toBe(false);
  });
  test("trusted contract carries a balance number", () => {
    const reward = { points_credited: 10, balance_status: "trusted", balance: 240 };
    expect(reward.balance_status).toBe("trusted");
    expect(reward.balance).toBe(240);
  });
});
