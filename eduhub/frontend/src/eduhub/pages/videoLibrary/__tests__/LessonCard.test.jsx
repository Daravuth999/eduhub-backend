import { render, screen, fireEvent } from "@testing-library/react";
import LessonCard from "../LessonCard";

const BASE_LESSON = {
  lessonId: "vid_1",
  title: "Ordering Coffee",
  subtitle: "Beginner conversation",
  thumbnailUrl: "",
  instructor: "Ms. Sopheak",
  category: "conversation",
  difficulty: "beginner",
  cefrLevel: "A2",
  durationSec: 125,
  estimatedStudyMinutes: 15,
  price: 0,
  owned: true,
};

test("renders title, instructor, category, and CEFR level", () => {
  render(<LessonCard lesson={BASE_LESSON} onOpen={() => {}} />);
  expect(screen.getByText("Ordering Coffee")).toBeInTheDocument();
  expect(screen.getByText("Ms. Sopheak")).toBeInTheDocument();
  expect(screen.getByText("Conversation")).toBeInTheDocument();
  expect(screen.getByText("A2")).toBeInTheDocument();
  expect(screen.getByText("15 min")).toBeInTheDocument();
});

test("shows a lock indicator for an unowned paid lesson", () => {
  render(<LessonCard lesson={{ ...BASE_LESSON, price: 50, owned: false }} onOpen={() => {}} />);
  expect(screen.getByTestId("video-lesson-card-vid_1-lock")).toBeInTheDocument();
});

test("does not show a lock indicator for a free lesson", () => {
  render(<LessonCard lesson={BASE_LESSON} onOpen={() => {}} />);
  expect(screen.queryByTestId("video-lesson-card-vid_1-lock")).not.toBeInTheDocument();
});

test("does not show a lock indicator for an owned paid lesson", () => {
  render(<LessonCard lesson={{ ...BASE_LESSON, price: 50, owned: true }} onOpen={() => {}} />);
  expect(screen.queryByTestId("video-lesson-card-vid_1-lock")).not.toBeInTheDocument();
});

test("calls onOpen with the lesson when clicked", () => {
  const onOpen = jest.fn();
  render(<LessonCard lesson={BASE_LESSON} onOpen={onOpen} />);
  fireEvent.click(screen.getByTestId("video-lesson-card-vid_1"));
  expect(onOpen).toHaveBeenCalledWith(BASE_LESSON);
});

test("falls back cleanly when instructor/category/cefr are missing", () => {
  const minimal = { lessonId: "vid_2", title: "Untitled Lesson", price: 0, owned: true, durationSec: 0 };
  render(<LessonCard lesson={minimal} onOpen={() => {}} />);
  expect(screen.getByText("Untitled Lesson")).toBeInTheDocument();
});

test("renders a progress bar when progressFraction is provided", () => {
  const { container } = render(<LessonCard lesson={BASE_LESSON} progressFraction={0.4} onOpen={() => {}} />);
  const bar = container.querySelector('[style*="width: 40%"]');
  expect(bar).toBeTruthy();
});
