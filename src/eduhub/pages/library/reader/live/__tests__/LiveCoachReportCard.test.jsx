/**
 * LiveCoachReportCard.test.jsx — BUG 5/6 upgrade regression coverage: no
 * prior test file exercised this component at all (a real coverage gap
 * flagged during investigation). Covers the new EN/KM toggle, the new
 * mistake_explanation/coaching_note sections, and backward compatibility
 * with an OLDER report that has none of the new bilingual fields.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import LiveCoachReportCard from "../LiveCoachReportCard";

const BILINGUAL_REPORT = {
  confidence_score: 80, clarity_score: 75,
  pronunciation_focus: "past tense -ed", pronunciation_focus_km: "អតីតកាល -ed",
  corrected_sentences: ["I go -> I went"],
  best_sentence: "I went to school yesterday.",
  improved_sentence: "I went to school yesterday and I was happy.",
  mistake_explanation: "Missing 'was' before an adjective.",
  mistake_explanation_km: "បាត់ 'was' មុនគុណនាម។",
  coaching_note: "Practice 'was/were + adjective' patterns.",
  coaching_note_km: "អនុវត្តទម្រង់ 'was/were + គុណនាម'។",
  next_mission: "Say 5 sentences using 'was very happy'.",
  next_mission_km: "និយាយ៥ប្រយោគប្រើ 'was very happy'។",
  summary: "Good effort today!",
  summary_km: "ការខិតខំល្អថ្ងៃនេះ!",
  engine: "gemini",
};

const LEGACY_REPORT = {
  confidence_score: 60, clarity_score: 55,
  pronunciation_focus: "final consonants",
  corrected_sentences: [],
  best_sentence: "hello there",
  improved_sentence: "",
  next_mission: "practice more",
  summary: "nice job",
  engine: "heuristic",
};

test("renders nothing-report empty state and its Close button", () => {
  const onClose = jest.fn();
  render(<LiveCoachReportCard report={null} onClose={onClose} />);
  expect(screen.getByTestId("live-report-empty")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Close"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a bilingual report shows the EN/KM toggle and defaults to English content", () => {
  render(<LiveCoachReportCard report={BILINGUAL_REPORT} explainLang="en" onClose={() => {}} onPracticeAgain={() => {}} />);
  expect(screen.getByTestId("live-report-lang-toggle")).toBeInTheDocument();
  expect(screen.getByTestId("live-report-pronunciation-focus")).toHaveTextContent("past tense -ed");
  expect(screen.getByTestId("live-report-mistake-explanation")).toHaveTextContent("Missing 'was' before an adjective.");
  expect(screen.getByTestId("live-report-coaching-note")).toHaveTextContent("Practice 'was/were + adjective' patterns.");
});

test("explainLang='km' defaults the toggle to Khmer content", () => {
  render(<LiveCoachReportCard report={BILINGUAL_REPORT} explainLang="km" onClose={() => {}} onPracticeAgain={() => {}} />);
  expect(screen.getByTestId("live-report-pronunciation-focus")).toHaveTextContent("អតីតកាល -ed");
  expect(screen.getByTestId("live-report-lang-km")).toHaveAttribute("aria-pressed", "true");
});

test("clicking the language toggle switches all bilingual fields together", () => {
  render(<LiveCoachReportCard report={BILINGUAL_REPORT} explainLang="en" onClose={() => {}} onPracticeAgain={() => {}} />);
  fireEvent.click(screen.getByTestId("live-report-lang-km"));

  expect(screen.getByTestId("live-report-pronunciation-focus")).toHaveTextContent("អតីតកាល -ed");
  expect(screen.getByTestId("live-report-mistake-explanation")).toHaveTextContent("បាត់ 'was' មុនគុណនាម។");
  expect(screen.getByTestId("live-report-coaching-note")).toHaveTextContent("អនុវត្តទម្រង់ 'was/were + គុណនាម'។");

  fireEvent.click(screen.getByTestId("live-report-lang-en"));
  expect(screen.getByTestId("live-report-pronunciation-focus")).toHaveTextContent("past tense -ed");
});

test("an older report with no *_km fields renders exactly as before — no broken toggle, no 'undefined'", () => {
  const { container } = render(
    <LiveCoachReportCard report={LEGACY_REPORT} explainLang="km" onClose={() => {}} onPracticeAgain={() => {}} />,
  );
  // No language toggle — nothing to switch between.
  expect(screen.queryByTestId("live-report-lang-toggle")).not.toBeInTheDocument();
  // Falls back to the only variant that exists (English), never blank/undefined.
  expect(screen.getByText("final consonants")).toBeInTheDocument();
  expect(screen.getByText("nice job")).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/undefined/);
  // New sections that have no data on this legacy report simply don't render.
  expect(screen.queryByTestId("live-report-mistake-explanation")).not.toBeInTheDocument();
  expect(screen.queryByTestId("live-report-coaching-note")).not.toBeInTheDocument();
});

test("Practice again and Close both still fire their callbacks", () => {
  const onClose = jest.fn();
  const onPracticeAgain = jest.fn();
  render(<LiveCoachReportCard report={LEGACY_REPORT} onClose={onClose} onPracticeAgain={onPracticeAgain} />);
  fireEvent.click(screen.getByTestId("live-report-close"));
  fireEvent.click(screen.getByTestId("live-report-again"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onPracticeAgain).toHaveBeenCalledTimes(1);
});

test("still shows corrected sentences and points charged unchanged", () => {
  render(<LiveCoachReportCard report={BILINGUAL_REPORT} pointsCharged={25} onClose={() => {}} onPracticeAgain={() => {}} />);
  expect(screen.getByTestId("live-report-corrections")).toHaveTextContent("I go -> I went");
  expect(screen.getByTestId("live-report-charged")).toHaveTextContent("25 points");
});
