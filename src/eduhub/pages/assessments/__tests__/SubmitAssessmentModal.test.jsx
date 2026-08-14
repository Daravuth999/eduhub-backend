/**
 * SubmitAssessmentModal.test.jsx — the student worksheet-submission phase
 * machine (pick -> preview -> uploading -> result/error). The backend
 * (assessment_tools.py) is the only authority on scoring; these tests
 * prove the modal renders exactly what the mocked API response says and
 * never fabricates a score client-side.
 *
 * 2026-08 one-device fix: the old single "Choose Photo or PDF" button
 * forced capture="environment", which on iOS Safari skips straight to the
 * camera and makes it impossible to pick an existing photo. These tests
 * cover all three entry points (Take Photo / Choose from Photos / Upload
 * a File) converging on the SAME handleFile()/submitAssessment() path.
 */
jest.mock("../assessmentApi", () => ({ submitAssessment: jest.fn() }));

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import SubmitAssessmentModal from "../SubmitAssessmentModal";
import { submitAssessment } from "../assessmentApi";

const ASSESSMENT = { assessmentId: "asmt_1", title: "Long & Short Sound Listening Challenge", totalPoints: 15 };

beforeEach(() => {
  jest.clearAllMocks();
  // CRA's jest preset sets resetMocks:true, which wipes a jest.fn()'s
  // implementation before every test — so this must be (re)assigned here,
  // not in beforeAll, or every test after the first sees createObjectURL
  // return undefined despite still being "a function" (see
  // ReceiptManagementStudio.test.jsx's identical beforeEach placement).
  global.URL.createObjectURL = jest.fn(() => "blob:mock-preview");
  global.URL.revokeObjectURL = jest.fn();
});

function renderModal(props = {}) {
  return render(
    <SubmitAssessmentModal open assessment={ASSESSMENT} onClose={jest.fn()} onSubmitted={jest.fn()} {...props} />,
  );
}

function pngFile(name = "worksheet.png") {
  return new File(["fake-bytes"], name, { type: "image/png" });
}

function pdfFile(name = "worksheet.pdf") {
  return new File(["%PDF-fake"], name, { type: "application/pdf" });
}

test("renders nothing when closed", () => {
  render(<SubmitAssessmentModal open={false} assessment={ASSESSMENT} onClose={jest.fn()} />);
  expect(screen.queryByTestId("assessment-submit-modal")).not.toBeInTheDocument();
});

test("pick screen shows the assessment title and all three entry points", () => {
  renderModal();
  expect(screen.getByText(ASSESSMENT.title)).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-take-photo")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-choose-photos")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-upload-file")).toBeInTheDocument();
});

test("Take Photo forces the rear camera via capture=environment", () => {
  renderModal();
  const input = screen.getByTestId("assessment-submit-take-photo-input");
  expect(input).toHaveAttribute("capture", "environment");
  expect(input).toHaveAttribute("accept", expect.stringContaining("image/jpeg"));
});

test("Choose from Photos omits capture so the OS opens the photo library, not the camera", () => {
  renderModal();
  const input = screen.getByTestId("assessment-submit-choose-photos-input");
  expect(input).not.toHaveAttribute("capture");
  expect(input).toHaveAttribute("accept", expect.stringContaining("image/jpeg"));
});

test("Upload a File omits capture and accepts PDF in addition to images", () => {
  renderModal();
  const input = screen.getByTestId("assessment-submit-upload-file-input");
  expect(input).not.toHaveAttribute("capture");
  expect(input).toHaveAttribute("accept", expect.stringContaining("application/pdf"));
});

test("selecting a file cancelled by the OS picker (empty FileList) stays on the pick screen quietly", () => {
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-choose-photos-input"), { target: { files: [] } });
  expect(screen.getByTestId("assessment-submit-take-photo")).toBeInTheDocument();
  expect(screen.queryByTestId("assessment-submit-file-error")).not.toBeInTheDocument();
});

test("rejects an unsupported file type from any entry point, without ever calling the API", () => {
  renderModal();
  const badFile = new File(["x"], "answers.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  fireEvent.change(screen.getByTestId("assessment-submit-upload-file-input"), { target: { files: [badFile] } });
  expect(screen.getByTestId("assessment-submit-file-error")).toHaveTextContent(/JPG|PNG|PDF/i);
  expect(submitAssessment).not.toHaveBeenCalled();
});

test("selecting a valid photo via Choose from Photos shows the selected-file preview", () => {
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-choose-photos-input"), { target: { files: [pngFile()] } });
  expect(screen.getByTestId("assessment-submit-selected-file")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-selected-file-name")).toHaveTextContent("worksheet.png");
  expect(screen.getByTestId("assessment-submit-selected-file-meta")).toHaveTextContent("PNG photo");
  expect(screen.getByTestId("assessment-submit-preview-image")).toHaveAttribute("src", "blob:mock-preview");
  expect(screen.getByTestId("assessment-submit-confirm-button")).toHaveTextContent("Submit for AI Checking");
});

test("selecting a PDF via Upload a File shows a file-type meta line, no image thumbnail", () => {
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-upload-file-input"), { target: { files: [pdfFile()] } });
  expect(screen.getByTestId("assessment-submit-selected-file-meta")).toHaveTextContent("PDF document");
  expect(screen.queryByTestId("assessment-submit-preview-image")).not.toBeInTheDocument();
});

test("the remove-file action clears the selection and returns to the three entry points", () => {
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-take-photo-input"), { target: { files: [pngFile()] } });
  expect(screen.getByTestId("assessment-submit-selected-file")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("assessment-submit-remove-file-button"));
  expect(screen.getByTestId("assessment-submit-take-photo")).toBeInTheDocument();
  expect(screen.queryByTestId("assessment-submit-selected-file")).not.toBeInTheDocument();
});

test("successful submission renders the backend's own score — never a fabricated one", async () => {
  submitAssessment.mockResolvedValue({
    ok: true,
    submission: {
      submissionId: "asub_1", status: "scored",
      score: { correct: 29, total: 30, scorePct: 96.7, pointsEarned: 14.5 },
    },
  });
  const onSubmitted = jest.fn();
  renderModal({ onSubmitted });
  fireEvent.change(screen.getByTestId("assessment-submit-choose-photos-input"), { target: { files: [pngFile()] } });
  fireEvent.click(screen.getByTestId("assessment-submit-confirm-button"));

  expect(await screen.findByTestId("assessment-submit-result")).toBeInTheDocument();
  expect(submitAssessment).toHaveBeenCalledWith("asmt_1", expect.any(File));
  expect(screen.getByTestId("assessment-submit-score")).toHaveTextContent("29 / 30 correct");
  expect(screen.getByTestId("assessment-submit-score")).toHaveTextContent("96.7%");
  // Score (what was answered correctly) and points awarded (whether the
  // teacher has credited the wallet) are two different facts — this is a
  // freshly-scored, not-yet-awarded submission, so points awarded is 0.
  expect(screen.getByTestId("assessment-submit-points-preview")).toHaveTextContent("14.5 / 15 pts calculated");
  expect(screen.getByTestId("assessment-submit-points-awarded-note")).toHaveTextContent(/waiting for your teacher's approval/i);
  expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ submissionId: "asub_1" }));
});

test("a needs_review result is shown honestly, not as a final score", async () => {
  submitAssessment.mockResolvedValue({
    ok: true,
    submission: { submissionId: "asub_2", status: "needs_review", score: { correct: 20, total: 30, scorePct: 66.7, pointsEarned: 10 } },
  });
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-upload-file-input"), { target: { files: [pdfFile()] } });
  fireEvent.click(screen.getByTestId("assessment-submit-confirm-button"));
  await screen.findByTestId("assessment-submit-result");
  expect(screen.getByText(/worksheet submitted/i)).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-teacher-review-pill")).toHaveTextContent(/teacher review/i);
});

test("a failed submit shows an error state with a working retry", async () => {
  submitAssessment.mockRejectedValueOnce(new Error("network drop"));
  submitAssessment.mockResolvedValueOnce({
    ok: true,
    submission: { submissionId: "asub_3", status: "scored", score: { correct: 30, total: 30, scorePct: 100, pointsEarned: 15 } },
  });
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-take-photo-input"), { target: { files: [pngFile()] } });
  fireEvent.click(screen.getByTestId("assessment-submit-confirm-button"));
  expect(await screen.findByTestId("assessment-submit-error")).toHaveTextContent("network drop");

  fireEvent.click(screen.getByTestId("assessment-submit-retry-button"));
  expect(await screen.findByTestId("assessment-submit-result")).toBeInTheDocument();
  expect(submitAssessment).toHaveBeenCalledTimes(2);
});

test("Escape closes the modal unless mid-upload", () => {
  const onClose = jest.fn();
  renderModal({ onClose });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("while the worksheet is in flight, the staged progress journey is shown (upload → read → check → calculate)", async () => {
  let resolveSubmit;
  submitAssessment.mockImplementation(() => new Promise((res) => { resolveSubmit = res; }));
  renderModal();
  fireEvent.change(screen.getByTestId("assessment-submit-upload-file-input"), { target: { files: [pngFile()] } });
  fireEvent.click(screen.getByTestId("assessment-submit-confirm-button"));

  const progress = await screen.findByTestId("assessment-submit-uploading");
  expect(progress).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-stage-uploading")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-stage-reading")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-stage-checking")).toBeInTheDocument();
  expect(screen.getByTestId("assessment-submit-stage-calculating")).toBeInTheDocument();

  // Only the SERVER response ever ends the journey — resolve it now.
  await act(async () => {
    resolveSubmit({ ok: true, submission: { status: "scored", score: { correct: 30, total: 30, scorePct: 100, pointsEarned: 15 } } });
  });
  expect(await screen.findByTestId("assessment-submit-result")).toBeInTheDocument();
});
