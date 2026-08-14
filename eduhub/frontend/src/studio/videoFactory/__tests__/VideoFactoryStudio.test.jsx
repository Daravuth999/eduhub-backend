/**
 * VideoFactoryStudio.test.jsx — RTL tests over the real rendered screen.
 * Mocks ./videoLibraryApi entirely (network layer covered by
 * video_library_tools.py's own backend tests). Covers the production-
 * studio workflow: lesson library, create modal, stage rail, Info/Media/
 * Pipeline/Publish panels, and the Review Studio launch.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import VideoFactoryStudio from "../VideoFactoryStudio";

jest.mock("../videoLibraryApi", () => ({
  listLessonsAdmin: jest.fn(),
  createLesson: jest.fn(),
  updateLesson: jest.fn(),
  publishLesson: jest.fn(),
  unpublishLesson: jest.fn(),
  uploadLessonMedia: jest.fn(),
  uploadThumbnail: jest.fn(),
  deleteLesson: jest.fn(),
  deleteMedia: jest.fn(),
  getLessonStats: jest.fn(),
  getPipeline: jest.fn(),
  runPipeline: jest.fn(),
  getNarration: jest.fn(),
  listVoices: jest.fn(),
  renderNarrationMaster: jest.fn(),
  getVideoFactoryStatus: jest.fn(),
  getSyncAdmin: jest.fn(),
  editSync: jest.fn(),
  approveSync: jest.fn(),
  rejectSync: jest.fn(),
  undoSync: jest.fn(),
  redoSync: jest.fn(),
  listReconcilePurchases: jest.fn(),
  resolveReconcile: jest.fn(),
  resolveMediaSrc: (ref) => (ref ? `https://resolved/${ref}` : ""),
}));

import {
  listLessonsAdmin, createLesson, publishLesson, getSyncAdmin, getNarration,
  listReconcilePurchases, getLessonStats, getVideoFactoryStatus, listVoices,
} from "../videoLibraryApi";

const LESSON = {
  lessonId: "vid_1", title: "Ordering Coffee", subtitle: "Beginner",
  price: 50, tier: "standard", status: "draft", syncId: null, thumbnailUrl: "",
  category: "conversation", difficulty: "beginner",
};

beforeEach(() => {
  jest.clearAllMocks();
  listReconcilePurchases.mockResolvedValue([]);
  listLessonsAdmin.mockResolvedValue([LESSON]);
  getSyncAdmin.mockResolvedValue(null);
  getNarration.mockResolvedValue(null);
  getVideoFactoryStatus.mockResolvedValue({ visible: true, enabled: true });
  // Voice Production is now reachable by default navigation the moment a
  // lesson has media (see productionStages.js's stageStatus fix — it no
  // longer sits permanently "pending" behind AI Processing completion),
  // so its panel can mount for tests that never explicitly open it.
  listVoices.mockResolvedValue([]);
  getLessonStats.mockResolvedValue({
    lessonId: "vid_1", purchases: {}, owners: 0, revenuePoints: 0,
    learners: 0, completions: 0, avgProgress: 0, bookmarks: 0,
  });
});

test("renders the lesson library with production stage chips", async () => {
  render(<VideoFactoryStudio />);
  expect(await screen.findByTestId("video-factory-lesson-vid_1")).toBeInTheDocument();
  expect(screen.getByTestId("video-factory-lesson-vid_1-stage").textContent).toMatch(/Stage:/);
});

test("shows an empty state when there are no lessons", async () => {
  listLessonsAdmin.mockResolvedValue([]);
  render(<VideoFactoryStudio />);
  expect(await screen.findByTestId("video-factory-empty")).toBeInTheDocument();
});

test("status filters narrow the visible library", async () => {
  listLessonsAdmin.mockResolvedValue([LESSON, { ...LESSON, lessonId: "vid_2", status: "published" }]);
  render(<VideoFactoryStudio />);
  await screen.findByTestId("video-factory-lesson-vid_1");
  fireEvent.click(screen.getByTestId("video-factory-filter-published"));
  expect(screen.queryByTestId("video-factory-lesson-vid_1")).not.toBeInTheDocument();
  expect(screen.getByTestId("video-factory-lesson-vid_2")).toBeInTheDocument();
});

test("create modal collects full lesson info incl. description and tags", async () => {
  createLesson.mockResolvedValue({ ...LESSON, lessonId: "vid_new", title: "New" });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-new-button"));
  fireEvent.change(screen.getByTestId("video-factory-new-title-input"), { target: { value: "New" } });
  fireEvent.change(screen.getByTestId("video-factory-new-description-input"), { target: { value: "About coffee" } });
  fireEvent.change(screen.getByTestId("video-factory-new-tags-input"), { target: { value: "travel, coffee" } });
  fireEvent.click(screen.getByTestId("video-factory-create-button"));
  await waitFor(() => expect(createLesson).toHaveBeenCalledWith(expect.objectContaining({
    title: "New", description: "About coffee", tags: ["travel", "coffee"],
  })));
});

test("create requires a title", async () => {
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-new-button"));
  fireEvent.click(screen.getByTestId("video-factory-create-button"));
  expect(await screen.findByTestId("video-factory-create-error")).toBeInTheDocument();
  expect(createLesson).not.toHaveBeenCalled();
});

test("opening a lesson launches the staged production studio", async () => {
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  expect(await screen.findByTestId("production-studio")).toBeInTheDocument();
  for (const key of ["info", "media", "pipeline", "review", "teleprompter", "publish", "analytics"]) {
    expect(screen.getByTestId(`production-stage-${key}`)).toBeInTheDocument();
  }
});

test("the Voice Production stage is absent from the rail while the platform reports it not visible", async () => {
  getVideoFactoryStatus.mockResolvedValue({ visible: false, enabled: false });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  await screen.findByTestId("production-studio");
  await waitFor(() => expect(getVideoFactoryStatus).toHaveBeenCalled());
  expect(screen.queryByTestId("production-stage-voice")).not.toBeInTheDocument();
});

test("the Voice Production stage appears but shows an honest disabled state when visible but not enabled", async () => {
  getVideoFactoryStatus.mockResolvedValue({ visible: true, enabled: false });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  await screen.findByTestId("production-studio");
  fireEvent.click(await screen.findByTestId("production-stage-voice"));
  expect(await screen.findByTestId("voice-disabled")).toBeInTheDocument();
});

test("Info stage edits lesson metadata", async () => {
  const { updateLesson } = require("../videoLibraryApi");
  updateLesson.mockResolvedValue({ ...LESSON, title: "Renamed" });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-info"));
  fireEvent.change(screen.getByTestId("info-title-input"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByTestId("info-save-button"));
  await waitFor(() => expect(updateLesson).toHaveBeenCalledWith("vid_1",
    expect.objectContaining({ title: "Renamed" })));
});

test("Media stage shows the native drop zone (no manual URL field anywhere)", async () => {
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-media"));
  expect(await screen.findByTestId("media-drop-zone")).toBeInTheDocument();
  expect(screen.getByTestId("media-thumbnail-manager")).toBeInTheDocument();
  expect(document.querySelector('input[placeholder="https://..."]')).toBeNull();
});

test("Media stage surfaces storage info and delete for uploaded media", async () => {
  listLessonsAdmin.mockResolvedValue([{
    ...LESSON, mediaRef: "gridfs://sync_media/abc.mp4", syncId: "sync_abc", contentType: "video/mp4",
  }]);
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-media"));
  expect((await screen.findByTestId("media-storage-chip")).textContent).toMatch(/GridFS/);
  expect(screen.getByTestId("media-delete-button")).toBeInTheDocument();
});

test("Pipeline stage renders the Gemini step storyline", async () => {
  listLessonsAdmin.mockResolvedValue([{
    ...LESSON, mediaRef: "gridfs://sync_media/abc.mp4", syncId: "sync_abc",
    pipeline: {
      state: "complete", currentStep: "review_ready",
      steps: {
        media_check: { status: "complete" }, speech_recognition: { status: "complete" },
        synchronization: { status: "complete" }, educational_analysis: { status: "complete" },
        review_ready: { status: "complete" },
      },
      log: [{ at: "2026-01-01T00:00:00Z", step: "media_check", status: "complete", message: "ok" }],
    },
  }]);
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-pipeline"));
  expect(await screen.findByTestId("pipeline-steps")).toBeInTheDocument();
  expect(screen.getByTestId("pipeline-state-badge").textContent).toMatch(/Complete/i);
  fireEvent.click(screen.getByTestId("pipeline-log-toggle"));
  expect(screen.getByTestId("pipeline-log")).toBeInTheDocument();
});

test("Publish stage blocks publishing without media and publishes with it", async () => {
  publishLesson.mockResolvedValue({ ...LESSON, status: "published" });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-publish"));
  expect(await screen.findByTestId("publish-toggle-button")).toBeDisabled();
  expect(screen.getByTestId("publish-lifecycle")).toBeInTheDocument();
});

test("Review stage opens the Synchronization Review Studio", async () => {
  listLessonsAdmin.mockResolvedValue([{
    ...LESSON, mediaRef: "gridfs://sync_media/abc.mp4", syncId: "sync_abc", contentType: "video/mp4",
  }]);
  getSyncAdmin.mockResolvedValue({
    syncId: "sync_abc", alignmentStatus: "complete", reviewStatus: "pending",
    alignmentVersion: 2, paragraphs: [], speakers: [], durationSec: 10,
  });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-review"));
  expect(await screen.findByTestId("sync-review-studio")).toBeInTheDocument();
  await waitFor(() => expect(getSyncAdmin).toHaveBeenCalledWith("sync_abc"));
});

test("Analytics stage renders backend stats", async () => {
  getLessonStats.mockResolvedValue({
    lessonId: "vid_1", purchases: { succeeded: 3, reconcile: 1 }, owners: 3,
    revenuePoints: 150, learners: 5, completions: 2, avgProgress: 0.6, bookmarks: 4,
  });
  render(<VideoFactoryStudio />);
  fireEvent.click(await screen.findByTestId("video-factory-lesson-vid_1"));
  fireEvent.click(await screen.findByTestId("production-stage-analytics"));
  expect(await screen.findByTestId("production-analytics-panel")).toBeInTheDocument();
  expect(screen.getByTestId("analytics-purchase-states").textContent).toMatch(/reconcile: 1/);
});
