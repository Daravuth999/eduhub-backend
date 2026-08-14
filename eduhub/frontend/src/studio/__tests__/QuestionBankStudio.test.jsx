/**
 * QuestionBankStudio.test.jsx — Author Studio's "Question Bank" screen.
 * Mocks ./api entirely (network layer covered by question_bank.py's own
 * backend test suite). Asserts the UI CONTRACT:
 *   • lists questions + categories on mount
 *   • creates a new question
 *   • edits a draft question
 *   • publishes / unpublishes / archives / deletes a question
 *   • imports from pasted JSON (legacy or new shape)
 *   • exports triggers a download without throwing
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import QuestionBankStudio from "../QuestionBankStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listQuestions: jest.fn(),
  listQuestionCategories: jest.fn(),
  getQuestion: jest.fn(),
  createQuestion: jest.fn(),
  updateQuestion: jest.fn(),
  publishQuestion: jest.fn(),
  unpublishQuestion: jest.fn(),
  archiveQuestion: jest.fn(),
  deleteQuestion: jest.fn(),
  importQuestions: jest.fn(),
  exportQuestions: jest.fn(),
}));

const QUESTION = {
  _id: "qb_abc123",
  category: "beginner",
  text: "What is your name?",
  tags: ["intro"],
  status: "draft",
  version: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  api.listQuestions.mockResolvedValue({ questions: [] });
  api.listQuestionCategories.mockResolvedValue({ categories: [] });
});

test("loads and lists questions + categories on mount", async () => {
  api.listQuestions.mockResolvedValue({ questions: [QUESTION] });
  api.listQuestionCategories.mockResolvedValue({ categories: [{ category: "beginner", count: 1 }] });
  render(<QuestionBankStudio />);
  await waitFor(() => expect(api.listQuestions).toHaveBeenCalled());
  expect(await screen.findByTestId(`question-bank-row-${QUESTION._id}`)).toHaveTextContent("What is your name?");
});

test("shows an empty state when no questions exist yet", async () => {
  render(<QuestionBankStudio />);
  expect(await screen.findByText(/No questions match these filters yet/i)).toBeInTheDocument();
});

test("creates a new question", async () => {
  api.createQuestion.mockResolvedValue({ ok: true, question: QUESTION });
  render(<QuestionBankStudio />);
  fireEvent.change(await screen.findByTestId("question-bank-new-category-input"), { target: { value: "beginner" } });
  fireEvent.change(screen.getByTestId("question-bank-new-text-input"), { target: { value: "What is your name?" } });
  fireEvent.click(screen.getByTestId("question-bank-create-button"));
  await waitFor(() => expect(api.createQuestion).toHaveBeenCalledWith({
    category: "beginner", text: "What is your name?", tags: [],
  }));
});

test("edits a draft question", async () => {
  api.listQuestions.mockResolvedValue({ questions: [QUESTION] });
  api.updateQuestion.mockResolvedValue({ ok: true, question: { ...QUESTION, text: "Edited?" } });
  render(<QuestionBankStudio />);
  fireEvent.click(await screen.findByTestId(`question-bank-edit-${QUESTION._id}`));
  fireEvent.change(screen.getByTestId(`question-bank-edit-text-${QUESTION._id}`), { target: { value: "Edited?" } });
  fireEvent.click(screen.getByTestId(`question-bank-save-${QUESTION._id}`));
  await waitFor(() => expect(api.updateQuestion).toHaveBeenCalledWith(QUESTION._id, { text: "Edited?", category: "beginner" }));
});

test("publishes, unpublishes, archives a question", async () => {
  api.listQuestions.mockResolvedValue({ questions: [QUESTION] });
  api.publishQuestion.mockResolvedValue({ ok: true, question: { ...QUESTION, status: "published" } });
  render(<QuestionBankStudio />);
  fireEvent.click(await screen.findByTestId(`question-bank-publish-${QUESTION._id}`));
  await waitFor(() => expect(api.publishQuestion).toHaveBeenCalledWith(QUESTION._id));
});

test("deletes a draft question", async () => {
  api.listQuestions.mockResolvedValue({ questions: [QUESTION] });
  api.deleteQuestion.mockResolvedValue({ ok: true, deleted: true });
  render(<QuestionBankStudio />);
  fireEvent.click(await screen.findByTestId(`question-bank-delete-${QUESTION._id}`));
  await waitFor(() => expect(api.deleteQuestion).toHaveBeenCalledWith(QUESTION._id));
});

test("imports questions from pasted JSON", async () => {
  api.importQuestions.mockResolvedValue({ imported: 2, skipped: 0, ids: ["qb_1", "qb_2"] });
  render(<QuestionBankStudio />);
  fireEvent.change(await screen.findByTestId("question-bank-import-textarea"), {
    target: { value: '{"beginner": ["What is your name?", "How old are you?"]}' },
  });
  fireEvent.click(screen.getByTestId("question-bank-import-button"));
  await waitFor(() => expect(api.importQuestions).toHaveBeenCalledWith({
    beginner: ["What is your name?", "How old are you?"],
  }));
  expect(await screen.findByTestId("question-bank-import-result")).toHaveTextContent("Imported 2, skipped 0.");
});

test("export button calls the export API without throwing", async () => {
  api.exportQuestions.mockResolvedValue({ items: [], count: 0 });
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:mock");
  URL.revokeObjectURL = jest.fn();
  render(<QuestionBankStudio />);
  fireEvent.click(await screen.findByTestId("question-bank-export-button"));
  await waitFor(() => expect(api.exportQuestions).toHaveBeenCalled());
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});
