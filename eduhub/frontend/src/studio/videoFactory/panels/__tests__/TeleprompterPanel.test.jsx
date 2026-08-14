/**
 * TeleprompterPanel.test.jsx — regression guard for Bug 2 (Author Studio
 * Teleprompter preview taking over the whole screen in native fullscreen).
 * Mocks ../../videoLibraryApi entirely, same convention as
 * VideoFactoryStudio.test.jsx.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import TeleprompterPanel from "../TeleprompterPanel";

jest.mock("../../videoLibraryApi", () => ({
  updateLesson: jest.fn(),
  getSyncAdmin: jest.fn().mockResolvedValue(null),
  resolveMediaSrc: (ref) => (ref ? `https://resolved/${ref}` : ""),
}));

const LESSON = {
  lessonId: "vid_1",
  mediaRef: "https://pub-x.r2.dev/vid.mp4",
  contentType: "video/mp4",
  teleprompterConfig: {},
};

test("preview video has playsInline and a fullscreen-suppressing controlsList", async () => {
  render(<TeleprompterPanel lesson={LESSON} onChanged={() => {}} />);
  const video = await screen.findByTestId("teleprompter-preview-media");
  // React reflects `playsInline` as the DOM property, not an HTML attribute —
  // assert the property directly so this doesn't silently pass if the prop
  // is ever dropped.
  expect(video.playsInline).toBe(true);
  expect(video).toHaveAttribute("controlslist", "nofullscreen noremoteplayback");
  // jsdom's HTMLVideoElement doesn't implement the disablePictureInPicture
  // IDL property getter, but React still reflects the boolean prop as the
  // bare HTML attribute — assert that instead.
  expect(video).toHaveAttribute("disablepictureinpicture", "");
});

test("force-exits if the browser enters fullscreen on the preview video anyway", async () => {
  render(<TeleprompterPanel lesson={LESSON} onChanged={() => {}} />);
  const video = await screen.findByTestId("teleprompter-preview-media");

  const exitFullscreen = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(document, "fullscreenElement", { value: video, configurable: true });
  document.exitFullscreen = exitFullscreen;

  document.dispatchEvent(new Event("fullscreenchange"));
  expect(exitFullscreen).toHaveBeenCalledTimes(1);

  // Reset for other tests in the suite.
  Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
});

// Regression coverage for the "Teleprompter preview stuck loading forever"
// incident: the preview must never sit in a silent native spinner with no
// explanation. A real MediaError surfaces immediately; a persistent
// "waiting" (buffering) event surfaces after the stall threshold — never a
// fake "ready" state either way.
describe("honest media failure/stall surfacing", () => {
  test("a real MediaError is surfaced immediately, with no fake-ready state", async () => {
    render(<TeleprompterPanel lesson={LESSON} onChanged={() => {}} />);
    const video = await screen.findByTestId("teleprompter-preview-media");
    Object.defineProperty(video, "error", { value: { code: 2 }, configurable: true });
    fireEvent.error(video);
    const issue = await screen.findByTestId("teleprompter-media-issue");
    expect(issue).toHaveTextContent("network error");
  });

  test("a persistent buffering stall is reported after the threshold, not immediately", async () => {
    jest.useFakeTimers();
    try {
      render(<TeleprompterPanel lesson={LESSON} onChanged={() => {}} />);
      const video = await screen.findByTestId("teleprompter-preview-media");
      fireEvent.waiting(video);
      expect(screen.queryByTestId("teleprompter-media-issue")).toBeNull();
      act(() => { jest.advanceTimersByTime(8000); });
      expect(screen.getByTestId("teleprompter-media-issue")).toHaveTextContent(/taking unusually long/i);
    } finally {
      jest.useRealTimers();
    }
  });

  test("recovering (canplay) clears a pending stall report", async () => {
    jest.useFakeTimers();
    try {
      render(<TeleprompterPanel lesson={LESSON} onChanged={() => {}} />);
      const video = await screen.findByTestId("teleprompter-preview-media");
      fireEvent.waiting(video);
      fireEvent.canPlay(video);
      act(() => { jest.advanceTimersByTime(8000); });
      expect(screen.queryByTestId("teleprompter-media-issue")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
