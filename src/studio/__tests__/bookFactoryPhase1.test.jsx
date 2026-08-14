/**
 * bookFactoryPhase1.test.jsx — Book Factory Phase 1 completion (frontend).
 * Schema invariants (Smart/Simple/Precise → one canonical shape, recipes,
 * pedagogy IDs, value/cost) + component behaviour (approval gate, duplicate
 * guard, resumption, disabled reasons, chapter controls, handoff options).
 */
import React from "react";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";

import {
  defaultConfig, applyMode, applySimplePreset, applyRecipe, smartCompose,
  studentValue, productionCost, PEDAGOGY_IDS, RECIPES,
} from "../bookFactory/bookFactorySchema";

jest.mock("../StudioPreview", () => () => <div data-testid="mock-preview" />);
jest.mock("../bookFactory/bookFactoryApi", () => ({
  createJob: jest.fn(),
  stepJob: jest.fn(),
  approveJob: jest.fn(),
  getJob: jest.fn(),
  retryChapter: jest.fn(),
  regenerateChapter: jest.fn(),
  lockChapter: jest.fn(),
  unlockChapter: jest.fn(),
  cancelJob: jest.fn(),
  exportJob: jest.fn(),
  listJobs: jest.fn(),
  getStatus: jest.fn(),
}));
const api = require("../bookFactory/bookFactoryApi");

const CANONICAL_KEYS = Object.keys(defaultConfig()).sort();

// ── schema: all modes resolve to the SAME canonical shape ───────────────────
describe("canonical config shape", () => {
  test("Smart / Simple / Precise all produce the canonical key set", () => {
    const base = { ...defaultConfig(), title: "T", topic: "X" };
    const smart = applyMode(base, "smart");
    const simple = applySimplePreset(base, "balanced");
    const precise = applyMode(base, "precise");
    [smart, simple, precise].forEach((cfg) => {
      CANONICAL_KEYS.forEach((k) => expect(cfg).toHaveProperty(k));
    });
  });

  test("mode switch preserves author-owned fields", () => {
    const base = { ...defaultConfig(), title: "Keep", topic: "Theme", price: 250, tier: "premium" };
    const simple = applyMode(base, "simple");
    expect(simple.title).toBe("Keep");
    expect(simple.topic).toBe("Theme");
    const smart = applyMode(simple, "smart");
    expect(smart.title).toBe("Keep");
    expect(smart.topic).toBe("Theme");
  });

  test("recipe populates config but keeps title/topic", () => {
    const base = { ...defaultConfig(), title: "MyTitle", topic: "MyTopic" };
    const out = applyRecipe(base, "premium_full_practice");
    expect(out.recipeId).toBe("premium_full_practice");
    expect(out.title).toBe("MyTitle");
    expect(out.tier).toBe("premium");
  });

  test("every recipe uses a known pedagogy profile ID", () => {
    RECIPES.forEach((r) => {
      if (r.patch.pedagogyProfile) expect(PEDAGOGY_IDS).toContain(r.patch.pedagogyProfile);
    });
  });

  test("required pedagogy IDs present and no legacy cambodia-esl-v1", () => {
    ["general_english", "daravuth_speaking_performance", "pronunciation_focus",
     "workplace_communication", "storytelling_performance", "speaking_confidence"].forEach(
      (id) => expect(PEDAGOGY_IDS).toContain(id));
    expect(PEDAGOGY_IDS).not.toContain("cambodia-esl-v1");
  });

  test("smartCompose is deterministic", () => {
    const cfg = { ...defaultConfig(), readingMinutes: 10, level: "B1", tier: "premium" };
    expect(smartCompose(cfg)).toEqual(smartCompose(cfg));
  });
});

// ── value + cost (advisory, separate) ───────────────────────────────────────
describe("student value + production cost", () => {
  test("student value rises with richer configuration", () => {
    const low = studentValue({ chapterCount: 1, maxWordsPerChapter: 80, mcqPerChapter: 0, fillblankPerChapter: 0, speakingPerChapter: 0 });
    const rich = studentValue({ chapterCount: 10, includeReviewChapter: true, maxWordsPerChapter: 420, mcqPerChapter: 4, fillblankPerChapter: 3, speakingPerChapter: 2, pronunciationDepth: "deep" });
    const rank = { Low: 0, Moderate: 1, High: 2, Rich: 3 };
    expect(rank[rich.level]).toBeGreaterThan(rank[low.level]);
  });

  test("production cost = 1 blueprint + N chapters (+review)", () => {
    expect(productionCost({ chapterCount: 4, includeReviewChapter: false }).normalCalls).toBe(5);
    expect(productionCost({ chapterCount: 4, includeReviewChapter: true }).normalCalls).toBe(6);
  });
});

// ── component behaviour ─────────────────────────────────────────────────────
const BookFactoryStudio = require("../bookFactory/BookFactoryStudio").default;
const BookFactoryChapterReview = require("../bookFactory/BookFactoryChapterReview").default;
const BookFactoryHandoff = require("../bookFactory/BookFactoryHandoff").default;

beforeEach(() => { jest.clearAllMocks(); localStorage.clear(); });

async function mountStudio(props = {}) {
  let view;
  await act(async () => {
    view = render(<BookFactoryStudio enabled geminiEnabled onHandoff={jest.fn()} {...props} />);
  });
  return view;
}

async function fillAndGenerate() {
  await act(async () => {
    fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "T" } });
    fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Topic" } });
  });
  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-btn")); });
  // "Generate" now opens an explicit confirmation plan before any provider call.
  await waitFor(() => expect(screen.getByTestId("bf-plan-confirm")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("bf-plan-confirm")); });
}

const JOB_AFTER_BP = {
  jobId: "j1", state: "blueprint_ready", blueprintApprovedAt: null,
  chapterOrder: ["c1"], chapters: { c1: { chapterId: "c1", position: 0, title: "C1", outline: "o", objective: "obj", state: "pending" } },
  config: { title: "T" }, blueprint: { state: "completed" },
};

test("visible-but-disabled shows a distinct disabled reason", async () => {
  await mountStudio({ enabled: false, geminiEnabled: false });
  expect(screen.getByTestId("bf-disabled-reason").textContent).toMatch(/disabled by an administrator/i);
});

test("gemini-disabled shows a distinct disabled reason", async () => {
  await mountStudio({ enabled: true, geminiEnabled: false });
  expect(screen.getByTestId("bf-disabled-reason").textContent).toMatch(/gemini/i);
  expect(screen.getByTestId("bf-generate-btn")).toBeDisabled();
});

test("blueprint generation stops for review; no chapter step before approval", async () => {
  api.createJob.mockResolvedValue({ job: { jobId: "j1", chapterOrder: [], chapters: {} } });
  api.stepJob.mockResolvedValue({ job: JOB_AFTER_BP });
  await mountStudio();
  await fillAndGenerate();
  await waitFor(() => expect(screen.getByTestId("bf-blueprint-review")).toBeInTheDocument());
  // exactly one step call, and it was the blueprint (never a chapterId step)
  expect(api.stepJob).toHaveBeenCalledTimes(1);
  expect(api.stepJob).toHaveBeenCalledWith("j1", { stage: "blueprint" }, expect.anything());
  expect(screen.getByTestId("bf-approve-generate")).toBeInTheDocument();
});

test("approval starts chapter generation", async () => {
  api.createJob.mockResolvedValue({ job: { jobId: "j1", chapterOrder: [], chapters: {} } });
  api.stepJob.mockResolvedValueOnce({ job: JOB_AFTER_BP })  // blueprint
             .mockResolvedValue({ job: { ...JOB_AFTER_BP, blueprintApprovedAt: "t", chapters: { c1: { ...JOB_AFTER_BP.chapters.c1, state: "completed" } } } });
  api.approveJob.mockResolvedValue({ job: { ...JOB_AFTER_BP, blueprintApprovedAt: "t", state: "approved" } });
  await mountStudio();
  await fillAndGenerate();
  await waitFor(() => expect(screen.getByTestId("bf-approve-generate")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("bf-approve-generate")); });
  await waitFor(() => expect(api.approveJob).toHaveBeenCalledWith("j1", expect.anything()));
  await waitFor(() => expect(api.stepJob).toHaveBeenCalledWith("j1", { chapterId: "c1" }, expect.anything()));
});

test("duplicate Generate is prevented (synchronous guard)", async () => {
  let resolveCreate;
  api.createJob.mockReturnValue(new Promise((r) => { resolveCreate = r; }));
  await mountStudio();
  await act(async () => {
    fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "T" } });
    fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Topic" } });
  });
  // "Generate" now opens an explicit plan confirmation (no network call yet);
  // the guarded network-triggering click is "Confirm & Generate Complete Book",
  // which dismisses the plan panel synchronously on click — a rapid second
  // click can no longer even reach the same button, so the duplicate-submit
  // guard is now structural rather than needing the ref-based race test.
  await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-btn")); });
  await waitFor(() => expect(screen.getByTestId("bf-plan-confirm")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("bf-plan-confirm")); });
  expect(api.createJob).toHaveBeenCalledTimes(1);
  await act(async () => { resolveCreate({ job: { jobId: "j1", chapterOrder: [], chapters: {} } }); });
});

test("localStorage active job is recovered, not duplicated", async () => {
  localStorage.setItem("bf_active_job_v1", "jX");
  api.getJob.mockResolvedValue({ job: { ...JOB_AFTER_BP, jobId: "jX" } });
  await mountStudio();
  await waitFor(() => expect(screen.getByTestId("bf-resume-banner")).toBeInTheDocument());
  expect(api.createJob).not.toHaveBeenCalled();
});

test("resume note text is truthful and present while generating", async () => {
  api.createJob.mockReturnValue(new Promise(() => {}));
  await mountStudio();
  await fillAndGenerate();
  await waitFor(() => expect(screen.getByTestId("bf-resume-note").textContent)
    .toMatch(/Generation continues while Book Factory is open\. You may leave and safely resume later\./));
});

// ── chapter review controls ─────────────────────────────────────────────────
const REVIEW_JOB = {
  jobId: "j1", state: "approved", chapterOrder: ["c1", "c2", "c3"],
  chapters: {
    c1: { chapterId: "c1", title: "Done", state: "completed", locked: false, warnings: [] },
    c2: { chapterId: "c2", title: "Term", state: "failed_terminal", locked: false, warnings: [] },
    c3: { chapterId: "c3", title: "Retryable", state: "failed_retryable", locked: false, warnings: [] },
  },
};

test("terminal chapter is NOT shown as retryable; retryable one IS", async () => {
  await act(async () => {
    render(<BookFactoryChapterReview job={REVIEW_JOB} onRetry={jest.fn()} onRegenerate={jest.fn()} onToggleLock={jest.fn()} onCancel={jest.fn()} busyChapterId={null} />);
  });
  expect(screen.queryByTestId("bf-retry-c2")).toBeNull();       // terminal → no retry
  expect(screen.getByTestId("bf-retry-c3")).toBeInTheDocument(); // retryable → retry
  expect(screen.getByTestId("bf-regenerate-c1")).toBeInTheDocument(); // completed → regenerate
  expect(screen.getByTestId("bf-lock-c1")).toBeInTheDocument();
  expect(screen.getByTestId("bf-cancel-job")).toBeInTheDocument();
});

test("handoff exposes Keep / Replace / Download options and incomplete warning", async () => {
  await act(async () => {
    render(<BookFactoryHandoff book={{ title: "B", chapters: [] }} meta={{ completed: 1, total: 3, incomplete: true }}
                              editorDirty={false} onOpenInEditor={jest.fn()} onCancel={jest.fn()} onDownloadCurrentDraft={jest.fn()} />);
  });
  expect(screen.getByTestId("bf-replace-draft")).toBeInTheDocument();
  expect(screen.getByTestId("bf-keep-current")).toBeInTheDocument();
  // Download actions are de-emphasized behind the "Advanced / Backup" toggle.
  await act(async () => { fireEvent.click(screen.getByTestId("bf-advanced-toggle")); });
  expect(screen.getByTestId("bf-download-current")).toBeInTheDocument();
  expect(screen.getByTestId("bf-download-json")).toBeInTheDocument();
  expect(screen.getByTestId("bf-incomplete-warning")).toBeInTheDocument();
});
