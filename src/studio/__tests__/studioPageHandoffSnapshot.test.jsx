/**
 * studioPageHandoffSnapshot.test.jsx — §HIGH 8 integration + §PHASE E3.
 *
 * §PHASE E3: handlePreviewFromEditor must go through handleTabChange, not
 * call setTab directly.  This ensures the Editor draft snapshot is captured
 * before the tab switches to preview. Without the fix, any subsequent return
 * from Preview (e.g. to Book Factory) would serve a stale/absent snapshot.
 *
 * Renders the REAL StudioPage tab structure and proves the current unsaved
 * Editor draft remains downloadable AFTER the Editor tab unmounts (while the
 * Book Factory tab is mounted), using the on-demand snapshot captured on tab
 * change. The captured snapshot is an independent clone; no Editor ref is
 * required while Book Factory is mounted.
 */
import React from "react";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";

jest.mock("../StudioAuth", () => ({
  StudioAuthProvider: ({ children }) => <>{children}</>,
  useStudioAuth: () => ({ user: { email: "admin-a@test", is_admin: true }, loading: false, signIn: jest.fn(), signOut: jest.fn() }),
  useStudioCallback: () => {},
}));

jest.mock("../bookFactory/bookFactoryApi");
const bfApi = require("../bookFactory/bookFactoryApi");

jest.mock("../StudioEditor", () => {
  const React2 = require("react");
  return React2.forwardRef(function EditorStub({ initialBook, onPreview }, ref) {
    const [book, setBook] = React2.useState(initialBook || { title: "Draft", chapters: [] });
    React2.useImperativeHandle(ref, () => ({ exportCurrentDraft: () => JSON.parse(JSON.stringify(book)) }));
    return (
      <div data-testid="editor-stub">
        <span data-testid="editor-title">{book.title}</span>
        <button data-testid="editor-make-edit" onClick={() => setBook((b) => ({ ...b, title: "UNSAVED EDIT" }))}>edit</button>
        <button data-testid="editor-preview-btn" onClick={() => onPreview && onPreview(book)}>Preview</button>
      </div>
    );
  });
});

const stub = (name) => () => <div data-testid={`stub-${name}`} />;
[
  "StudioSmartPaste", "StudioUpload", "StudioBrowse", "StudioPreview", "PushStudio",
  "TeacherStudio", "CouponStudio", "TuitionReminderStudio", "PaymentStudio", "AiSceneBuilder",
  "AiToolsStudio", "AiAssistantStudio", "LoginRewardStudio", "MysteryBoxStudio",
  "LoginMysteryStudio", "ReferralConfig", "VoiceTreasureStudio", "ArtworkCampaignStudio", "AttendanceStudio",
  "PromotionExperienceStudio", "StudioHome",
].forEach((m) => jest.mock(`../${m}`, () => stub(m)));

const StudioPage = require("../StudioPage").default;

describe("HIGH 8 — current-draft snapshot survives Editor unmount", () => {
  let capturedBlobText;
  beforeEach(() => {
    capturedBlobText = null;
    const emptyJob = { jobId: "job1", state: "created", blueprintApprovedAt: null,
      blueprint: { state: "pending" }, chapters: {}, chapterOrder: [] };
    bfApi.getStatus.mockResolvedValue({ visible: true, enabled: true, geminiEnabled: true });
    bfApi.getJob.mockResolvedValue({ job: null });
    bfApi.listJobs.mockResolvedValue({ jobs: [] });
    bfApi.createJob.mockResolvedValue({ job: { ...emptyJob } });
    bfApi.stepJob.mockResolvedValue({ job: { ...emptyJob, state: "blueprint_ready", blueprint: { state: "completed" } } });
    bfApi.approveJob.mockResolvedValue({ job: { ...emptyJob, state: "approved", blueprintApprovedAt: "t", blueprint: { state: "completed" } } });
    bfApi.exportJob.mockResolvedValue({ book: { title: "Generated", chapters: [] }, completedChapters: 0, totalChapters: 0, incomplete: false });
    const OrigBlob = global.Blob;
    global.Blob = function (parts, opts) { capturedBlobText = (parts && parts[0]) || null; return new OrigBlob(parts, opts); };
    global.URL.createObjectURL = jest.fn(() => "blob:mock");
    global.URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = jest.fn();
    localStorage.clear();
  });

  test("edit → leave Editor (unmount) → Book Factory handoff downloads the captured unsaved draft", async () => {
    await act(async () => { render(<StudioPage />); });
    // Studio OS — Home is the default landing view now (not Editor); jump
    // into Editor first via the same handleTabChange every nav trigger uses.
    await act(async () => { fireEvent.click(screen.getByTestId("studio-tab-editor")); });
    expect(await screen.findByTestId("editor-stub")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId("editor-make-edit")); });
    expect(screen.getByTestId("editor-title").textContent).toBe("UNSAVED EDIT");

    // leave the Editor tab → snapshot captured, Editor unmounts
    await act(async () => { fireEvent.click(screen.getByTestId("studio-tab-bookfactory")); });
    await waitFor(() => expect(screen.queryByTestId("editor-stub")).not.toBeInTheDocument());
    await screen.findByTestId("book-factory-studio");

    // drive Book Factory to the handoff screen (no live Editor ref exists now)
    await act(async () => { fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "My Book" } }); });
    await act(async () => { fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Travel" } }); });
    await waitFor(() => expect(screen.getByTestId("bf-generate-btn")).not.toBeDisabled());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-btn")); });
    await waitFor(() => expect(screen.getByTestId("bf-plan-confirm")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-plan-confirm")); });
    await waitFor(() => expect(screen.getByTestId("bf-approve-generate")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-approve-generate")); });
    await waitFor(() => expect(screen.getByTestId("bf-prepare-handoff")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-prepare-handoff")); });
    await waitFor(() => expect(screen.getByTestId("bf-advanced-toggle")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-advanced-toggle")); });
    await waitFor(() => expect(screen.getByTestId("bf-download-current")).toBeInTheDocument());

    // download the current draft — served from the captured snapshot
    await act(async () => { fireEvent.click(screen.getByTestId("bf-download-current")); });
    await waitFor(() => expect(capturedBlobText).toBeTruthy());
    const parsed = JSON.parse(capturedBlobText);
    expect(parsed.title).toBe("UNSAVED EDIT"); // the unsaved draft, not "Generated"
  });
});

// §PHASE E3: handlePreviewFromEditor must go through handleTabChange so the
// Editor draft is captured on tab exit.  If setTab is called directly, the
// snapshot is absent and a later Book Factory download serves the wrong draft.
describe("PHASE E3 — preview tab exit captures Editor snapshot", () => {
  let capturedBlobText;
  beforeEach(() => {
    capturedBlobText = null;
    const emptyJob = { jobId: "job1", state: "created", blueprintApprovedAt: null,
      blueprint: { state: "pending" }, chapters: {}, chapterOrder: [] };
    bfApi.getStatus.mockResolvedValue({ visible: true, enabled: true, geminiEnabled: true });
    bfApi.getJob.mockResolvedValue({ job: null });
    bfApi.listJobs.mockResolvedValue({ jobs: [] });
    bfApi.createJob.mockResolvedValue({ job: { ...emptyJob } });
    bfApi.stepJob.mockResolvedValue({ job: { ...emptyJob, state: "blueprint_ready", blueprint: { state: "completed" } } });
    bfApi.approveJob.mockResolvedValue({ job: { ...emptyJob, state: "approved", blueprintApprovedAt: "t", blueprint: { state: "completed" } } });
    bfApi.exportJob.mockResolvedValue({ book: { title: "Generated", chapters: [] }, completedChapters: 0, totalChapters: 0, incomplete: false });
    const OrigBlob = global.Blob;
    global.Blob = function (parts, opts) { capturedBlobText = (parts && parts[0]) || null; return new OrigBlob(parts, opts); };
    global.URL.createObjectURL = jest.fn(() => "blob:mock");
    global.URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = jest.fn();
    localStorage.clear();
  });

  test("clicking Preview from Editor captures the draft so Book Factory download has the right content", async () => {
    await act(async () => { render(<StudioPage />); });
    // Studio OS — Home is the default landing view now (not Editor); jump
    // into Editor first via the same handleTabChange every nav trigger uses.
    await act(async () => { fireEvent.click(screen.getByTestId("studio-tab-editor")); });
    expect(await screen.findByTestId("editor-stub")).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByTestId("editor-make-edit")); });
    expect(screen.getByTestId("editor-title").textContent).toBe("UNSAVED EDIT");

    // Author clicks Preview — goes through handleTabChange → snapshot captured.
    await act(async () => { fireEvent.click(screen.getByTestId("editor-preview-btn")); });
    // Navigate to Book Factory — Editor has unmounted, snapshot must survive.
    await act(async () => { fireEvent.click(screen.getByTestId("studio-tab-bookfactory")); });
    await screen.findByTestId("book-factory-studio");

    await act(async () => { fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "My Book" } }); });
    await act(async () => { fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Travel" } }); });
    await waitFor(() => expect(screen.getByTestId("bf-generate-btn")).not.toBeDisabled());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-generate-btn")); });
    await waitFor(() => expect(screen.getByTestId("bf-plan-confirm")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-plan-confirm")); });
    await waitFor(() => expect(screen.getByTestId("bf-approve-generate")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-approve-generate")); });
    await waitFor(() => expect(screen.getByTestId("bf-prepare-handoff")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-prepare-handoff")); });
    await waitFor(() => expect(screen.getByTestId("bf-advanced-toggle")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("bf-advanced-toggle")); });
    await waitFor(() => expect(screen.getByTestId("bf-download-current")).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByTestId("bf-download-current")); });
    await waitFor(() => expect(capturedBlobText).toBeTruthy());
    const parsed = JSON.parse(capturedBlobText);
    expect(parsed.title).toBe("UNSAVED EDIT");
  });
});
