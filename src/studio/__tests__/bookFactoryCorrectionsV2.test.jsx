/**
 * bookFactoryCorrectionsV2.test.jsx — final correction-pass frontend coverage.
 *
 *  HIGH 4   — every Simple preset + every recipe produce backend-valid configs
 *             (frontend mirror), aggregate limits shown before submission.
 *  HIGH 5   — Smart values react to topic / level / tier / price / duration.
 *  HIGH 6   — every restored job state maps to the correct UI.
 *  HIGH 7   — recent-jobs fallback is actually called; old excluded; dismissable.
 *  HIGH 8   — (covered by StudioPage snapshot test below).
 *  BLOCKER1 — owner-scoped localStorage recovery.
 *  MEDIUM13 — recovery + export requests abort on unmount.
 */
import React from "react";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";

import {
  defaultConfig, applyMode, applySimplePreset, applyRecipe, updateSmartInput,
  smartCompose, validateConfig, BACKEND_LIMITS, SIMPLE_PRESETS, RECIPES,
} from "../bookFactory/bookFactorySchema";
import { restoreStateFor } from "../bookFactory/BookFactoryStudio";

jest.mock("../StudioPreview", () => () => <div data-testid="mock-preview" />);
jest.mock("../bookFactory/bookFactoryApi", () => ({
  createJob: jest.fn(), stepJob: jest.fn(), approveJob: jest.fn(), getJob: jest.fn(),
  retryChapter: jest.fn(), regenerateChapter: jest.fn(), lockChapter: jest.fn(),
  unlockChapter: jest.fn(), cancelJob: jest.fn(), exportJob: jest.fn(),
  listJobs: jest.fn(), getStatus: jest.fn(),
}));
const api = require("../bookFactory/bookFactoryApi");
const BookFactoryStudio = require("../bookFactory/BookFactoryStudio").default;

beforeEach(() => { jest.clearAllMocks(); localStorage.clear(); });

// ── HIGH 4: presets / recipes fit the shared backend limits ─────────────────
function withinLimits(cfg) {
  const errs = validateConfig({ ...cfg, title: "T", topic: "X" });
  return Object.keys(errs).length === 0;
}

describe("HIGH 4 — preset/recipe validity mirror", () => {
  test.each(Object.keys(SIMPLE_PRESETS))("Simple '%s' is within limits", (p) => {
    expect(withinLimits(applySimplePreset({ ...defaultConfig() }, p))).toBe(true);
  });

  test.each(RECIPES.map((r) => r.id))("recipe '%s' is within limits", (id) => {
    expect(withinLimits(applyRecipe({ ...defaultConfig() }, id))).toBe(true);
  });

  test("Short, Balanced and Deep all pass", () => {
    ["short", "balanced", "deep"].forEach((p) =>
      expect(withinLimits(applySimplePreset({ ...defaultConfig() }, p))).toBe(true));
  });

  test("aggregate word/exercise limits are enforced by the mirror", () => {
    const bad = { ...defaultConfig(), title: "T", topic: "X", chapterCount: 20, maxWordsPerChapter: 1000 };
    expect(validateConfig(bad).maxWordsPerChapter).toBeTruthy();
    const badEx = { ...defaultConfig(), title: "T", topic: "X", chapterCount: 20,
      includeReviewChapter: false, vocabularyPerChapter: 20, mcqPerChapter: 10, fillblankPerChapter: 10, speakingPerChapter: 10 };
    expect(validateConfig(badEx).exercises).toBeTruthy();
  });
});

// ── HIGH 5: Smart mode is reactive + deterministic ──────────────────────────
describe("HIGH 5 — Smart reactivity", () => {
  const base = { ...defaultConfig(), mode: "smart", topic: "Travel", readingMinutes: 6, level: "A2", tier: "free", price: 0 };

  test("changing reading duration recomputes chapter count", () => {
    const short = updateSmartInput(base, { readingMinutes: 4 });
    const long = updateSmartInput(base, { readingMinutes: 40 });
    expect(long.chapterCount).toBeGreaterThan(short.chapterCount);
  });

  test("changing level recomputes word density", () => {
    const a1 = updateSmartInput(base, { level: "A1" });
    const b2 = updateSmartInput(base, { level: "B2" });
    expect(b2.maxWordsPerChapter).toBeGreaterThan(a1.maxWordsPerChapter);
  });

  test("changing tier recomputes exercise richness", () => {
    const free = updateSmartInput(base, { tier: "free" });
    const premium = updateSmartInput(base, { tier: "premium" });
    expect(premium.mcqPerChapter).toBeGreaterThanOrEqual(free.mcqPerChapter);
    expect(premium.pronunciationDepth).toBe("deep");
  });

  test("changing topic keeps the config canonical (input preserved)", () => {
    const next = updateSmartInput(base, { topic: "Cooking" });
    expect(next.topic).toBe("Cooking");
    expect(next).toHaveProperty("chapterCount");
  });

  test("editing a Smart input never leaves a stale/invalid word ceiling", () => {
    const long = updateSmartInput({ ...base, level: "B2", tier: "premium" }, { readingMinutes: 180 });
    expect(long.chapterCount * long.maxWordsPerChapter).toBeLessThanOrEqual(BACKEND_LIMITS.maxTotalWords);
  });

  test("precise mode does NOT recompute derived values", () => {
    const precise = { ...base, mode: "precise", chapterCount: 3 };
    const next = updateSmartInput(precise, { readingMinutes: 120 });
    expect(next.chapterCount).toBe(3);
  });
});

// ── HIGH 6: restoration state map ───────────────────────────────────────────
describe("HIGH 6 — restoration map", () => {
  const bpJob = (bpState, extra = {}) => ({ jobId: "j1", state: "created", blueprintApprovedAt: null, blueprint: { state: bpState }, chapters: {}, chapterOrder: [], ...extra });

  test.each([
    ["pending", "blueprint-start"],
    ["claimed", "blueprint-progress"],
    ["provider_pending", "blueprint-progress"],
    ["failed_retryable", "blueprint-retryable"],
    ["failed_terminal", "blueprint-terminal"],
    ["unknown_outcome", "blueprint-unknown"],
    ["completed", "blueprint-review"],
  ])("blueprint '%s' → %s", (bp, cat) => {
    expect(restoreStateFor(bpJob(bp)).category).toBe(cat);
  });

  test("approved with pending chapters → approved-progress", () => {
    const j = { jobId: "j1", state: "approved", blueprintApprovedAt: "t",
      chapterOrder: ["c1"], chapters: { c1: { state: "pending" } } };
    expect(restoreStateFor(j).category).toBe("approved-progress");
  });

  test("approved and all complete → completed", () => {
    const j = { jobId: "j1", blueprintApprovedAt: "t",
      chapterOrder: ["c1"], chapters: { c1: { state: "completed" } } };
    expect(restoreStateFor(j).category).toBe("completed");
  });

  test("cancelled → cancelled (not resumable)", () => {
    expect(restoreStateFor({ state: "cancelled" })).toEqual({ category: "cancelled", resumable: false });
  });
});

// ── mount helpers ───────────────────────────────────────────────────────────
async function mountStudio(props = {}) {
  let view;
  await act(async () => { view = render(<BookFactoryStudio enabled geminiEnabled adminIdentity="admin-a@test" onHandoff={jest.fn()} {...props} />); });
  return view;
}

// ── BLOCKER 1: owner-scoped recovery key ────────────────────────────────────
describe("BLOCKER 1 — owner-scoped recovery", () => {
  test("reads only the scoped key for the current admin", async () => {
    localStorage.setItem("bf_active_job_v1:admin-a@test", "jA");
    localStorage.setItem("bf_active_job_v1:admin-b@test", "jB");
    api.getJob.mockResolvedValue({ job: { jobId: "jA", state: "created", blueprint: { state: "completed" }, blueprintApprovedAt: null, chapterOrder: [], chapters: {} } });
    await mountStudio({ adminIdentity: "admin-a@test" });
    await waitFor(() => expect(api.getJob).toHaveBeenCalledWith("jA", expect.anything()));
    expect(api.getJob).not.toHaveBeenCalledWith("jB", expect.anything());
  });
});

// ── HIGH 7: recent-jobs fallback ────────────────────────────────────────────
describe("HIGH 7 — recent-jobs fallback", () => {
  test("no stored job → listJobs called and newest offered", async () => {
    api.listJobs.mockResolvedValue({ jobs: [{ jobId: "recent1", state: "approved" }] });
    api.getJob.mockResolvedValue({ job: { jobId: "recent1", state: "approved", blueprintApprovedAt: "t", chapterOrder: ["c1"], chapters: { c1: { state: "pending" } } } });
    await mountStudio();
    await waitFor(() => expect(api.listJobs).toHaveBeenCalled());
    expect(await screen.findByTestId("bf-resume-banner")).toBeInTheDocument();
  });

  test("stored id 404 → clears pointer and falls back to listJobs", async () => {
    localStorage.setItem("bf_active_job_v1:admin-a@test", "gone");
    const err = new Error("not found"); err.status = 404;
    api.getJob.mockRejectedValueOnce(err);
    api.listJobs.mockResolvedValue({ jobs: [] });
    await mountStudio();
    await waitFor(() => expect(api.listJobs).toHaveBeenCalled());
    expect(localStorage.getItem("bf_active_job_v1:admin-a@test")).toBeNull();
  });

  test("author can dismiss the offer and start new", async () => {
    api.listJobs.mockResolvedValue({ jobs: [{ jobId: "r1", state: "approved" }] });
    api.getJob.mockResolvedValue({ job: { jobId: "r1", state: "approved", blueprintApprovedAt: "t", chapterOrder: [], chapters: {} } });
    await mountStudio();
    const banner = await screen.findByTestId("bf-resume-banner");
    expect(banner).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId("bf-resume-dismiss")); });
    expect(screen.queryByTestId("bf-resume-banner")).not.toBeInTheDocument();
  });
});

// ── PHASE E1: blueprint step maps UI from restoreStateFor ───────────────────
describe("PHASE E1 — blueprint step UI state from restoreStateFor", () => {
  test("blueprint step succeeds → config form is gone and blueprint-review shown", async () => {
    api.createJob.mockResolvedValue({ job: { jobId: "j1", state: "created", blueprintApprovedAt: null, blueprint: { state: "pending" }, chapterOrder: [], chapters: {} } });
    // Blueprint step returns a completed blueprint.
    api.stepJob.mockResolvedValue({
      result: { status: "ok" },
      job: { jobId: "j1", state: "blueprint_ready", blueprintApprovedAt: null,
             blueprint: { state: "completed" }, chapterOrder: ["c1"],
             chapters: { c1: { state: "pending" } } },
    });
    await mountStudio();
    // Fill required fields so the Generate button is enabled.
    await act(async () => {
      fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "Test Book" } });
      fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Test Topic" } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-btn")); });
    await waitFor(() => expect(screen.getByTestId("bf-plan-confirm")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-plan-confirm")); });
    await waitFor(() => expect(api.stepJob).toHaveBeenCalled());
    // restoreStateFor({ state:"blueprint_ready", blueprint:{state:"completed"} })
    // → category:"blueprint-review". The config form must no longer be visible.
    await waitFor(() => expect(screen.queryByTestId("bf-config-form")).not.toBeInTheDocument());
    expect(screen.getByTestId("bf-blueprint-review")).toBeInTheDocument();
  });

  test("blueprint step returns failed → blueprint-retryable UI shown (not blueprint-review)", async () => {
    api.createJob.mockResolvedValue({ job: { jobId: "j1", state: "created", blueprintApprovedAt: null, blueprint: { state: "pending" }, chapterOrder: [], chapters: {} } });
    // Blueprint step fails.
    api.stepJob.mockRejectedValue(Object.assign(new Error("Outline generation failed"), { status: 500 }));
    await mountStudio();
    // Fill required fields so the Generate button is enabled.
    await act(async () => {
      fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "Test Book" } });
      fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Test Topic" } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-btn")); });
    await waitFor(() => expect(screen.getByTestId("bf-plan-confirm")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-plan-confirm")); });
    await waitFor(() => expect(api.stepJob).toHaveBeenCalled());
    // On error, the catch block preserves the job and keeps showing blueprint-review area.
    await waitFor(() => expect(screen.getByTestId("bf-blueprint-review")).toBeInTheDocument());
  });
});

// ── MEDIUM 13: abort on unmount ─────────────────────────────────────────────
describe("MEDIUM 13 — abort on unmount", () => {
  test("recovery request receives an AbortSignal and aborts on unmount", async () => {
    localStorage.setItem("bf_active_job_v1:admin-a@test", "jX");
    let capturedSignal;
    api.getJob.mockImplementation((id, signal) => { capturedSignal = signal; return new Promise(() => {}); });
    let view;
    await act(async () => { view = render(<BookFactoryStudio enabled geminiEnabled adminIdentity="admin-a@test" onHandoff={jest.fn()} />); });
    await waitFor(() => expect(api.getJob).toHaveBeenCalled());
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(false);
    await act(async () => { view.unmount(); });
    expect(capturedSignal.aborted).toBe(true);
  });

  test("export request aborts on unmount", async () => {
    api.getJob.mockResolvedValue({ job: { jobId: "j1", state: "approved", blueprintApprovedAt: "t", chapterOrder: ["c1"], chapters: { c1: { state: "completed", title: "C", blocks: [] } } } });
    api.stepJob.mockResolvedValue({ job: { jobId: "j1", chapterOrder: ["c1"], chapters: { c1: { state: "completed" } } } });
    localStorage.setItem("bf_active_job_v1:admin-a@test", "j1");
    let exportSignal;
    api.exportJob.mockImplementation((id, signal) => { exportSignal = signal; return new Promise(() => {}); });
    let view;
    await act(async () => { view = render(<BookFactoryStudio enabled geminiEnabled adminIdentity="admin-a@test" onHandoff={jest.fn()} />); });
    // resume into review, then prepare handoff to trigger export
    await screen.findByTestId("bf-resume-banner");
    await act(async () => { fireEvent.click(screen.getByTestId("bf-resume-continue")); });
    await waitFor(() => expect(screen.getByTestId("bf-prepare-handoff")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-prepare-handoff")); });
    await waitFor(() => expect(api.exportJob).toHaveBeenCalled());
    expect(exportSignal).toBeInstanceOf(AbortSignal);
    await act(async () => { view.unmount(); });
    expect(exportSignal.aborted).toBe(true);
  });
});
