import { STAGES, stageStatus, currentStage } from "../productionStages";

const BASE_LESSON = { title: "x", category: "conversation", mediaRef: "https://x/y.mp4", status: "draft" };
const APPROVED_SYNC = { reviewStatus: "approved" };

test("voice stage is active (not pending) once media exists, even with no narration job yet", () => {
  const statuses = stageStatus(BASE_LESSON, APPROVED_SYNC, undefined);
  expect(statuses.voice).toBe("active");
  expect(statuses.review).toBe("complete"); // unaffected by voice being untouched
});

test("voice stage is pending only when the lesson has no media yet", () => {
  const noMediaLesson = { title: "x", category: "conversation", status: "draft" };
  const statuses = stageStatus(noMediaLesson, null, undefined);
  expect(statuses.voice).toBe("pending");
});

test("voice stage is active regardless of AI Processing pipeline state — the real bug fix", () => {
  // Story Analysis only needs mediaRef/syncId (both set at upload time)
  // and tolerates an empty transcript — it must never look unavailable
  // just because the separate ASR pipeline is stuck, blocked, or was
  // honestly skipped for a silent video.
  for (const pipeline of [
    undefined,
    { state: "running" },
    { state: "failed" },
    { state: "complete" },
  ]) {
    const lesson = { ...BASE_LESSON, pipeline };
    const statuses = stageStatus(lesson, null, undefined);
    expect(statuses.voice).toBe("active");
  }
});

test("voice stage becomes active once story analysis has started", () => {
  const job = { storyAnalysis: { state: "completed" }, assembly: { state: "pending" }, published: false };
  const statuses = stageStatus(BASE_LESSON, APPROVED_SYNC, job);
  expect(statuses.voice).toBe("active");
});

test("voice stage becomes complete only once published", () => {
  const job = { storyAnalysis: { state: "completed" }, assembly: { state: "completed" }, published: true };
  const statuses = stageStatus(BASE_LESSON, APPROVED_SYNC, job);
  expect(statuses.voice).toBe("complete");
});

test("a lesson can reach published status having never touched voice production", () => {
  const publishedLesson = { ...BASE_LESSON, status: "published" };
  const statuses = stageStatus(publishedLesson, APPROVED_SYNC, undefined);
  expect(statuses.voice).not.toBe("complete"); // never touched, so never falsely "complete"
  expect(statuses.publish).toBe("complete");
});

test("currentStage never auto-jumps into an untouched voice stage", () => {
  const statuses = stageStatus(BASE_LESSON, null, undefined);
  expect(currentStage(statuses)).not.toBe("voice");
});

test("currentStage accepts a filtered stage list so a hidden stage can never be auto-selected", () => {
  const job = { storyAnalysis: { state: "completed" }, assembly: { state: "pending" }, published: false };
  const statuses = stageStatus(BASE_LESSON, APPROVED_SYNC, job); // voice would be "active" here
  const filtered = STAGES.filter((s) => s.key !== "voice");
  expect(currentStage(statuses, filtered)).not.toBe("voice");
});

test("STAGES declares voice between pipeline and review, matching the approved workflow order", () => {
  const keys = STAGES.map((s) => s.key);
  expect(keys.indexOf("voice")).toBe(keys.indexOf("pipeline") + 1);
  expect(keys.indexOf("review")).toBe(keys.indexOf("voice") + 1);
});
