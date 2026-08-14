/**
 * conversationVoiceStudioSeeding.test.jsx — §AMENDMENT 8 zero-copy seeding
 * safety for ConversationVoiceStudio: the "Load generated dialogue" button
 * never auto-fires, never overwrites text the teacher already typed, and
 * resets its touched/loaded guards when the chapter identity changes.
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

jest.mock("../api", () => ({
  saveStudioBook: jest.fn(() => Promise.resolve({ slug: "s1", book: { slug: "s1", chapters: [] } })),
  generateConversationAudio: jest.fn(() => Promise.resolve({})),
}));

beforeEach(() => { localStorage.clear(); });

const ConversationVoiceStudio = require("../ConversationVoiceStudio").default;

function renderCVS(props = {}) {
  return render(
    <ConversationVoiceStudio
      slug="s1"
      chapterIndex={0}
      book={{ title: "B", chapters: [{ title: "Ch1", blocks: [] }] }}
      elevenLabsVoices={[{ voice_id: "v1", name: "Voice One" }, { voice_id: "v2", name: "Voice Two" }]}
      {...props}
    />
  );
}

test("absent initialText: no Load button, unchanged existing behavior", () => {
  renderCVS();
  expect(screen.queryByTestId("cvs-load-generated-btn")).toBeNull();
  expect(screen.getByTestId("cvs-paste-textarea").value).toBe("");
});

test("initialText present: Load button appears but text is NOT auto-filled", () => {
  renderCVS({ initialText: "Dara: Hello!\nMaya: Hi there!", initialChapterId: "ch-a" });
  expect(screen.getByTestId("cvs-load-generated-btn")).toBeInTheDocument();
  expect(screen.getByTestId("cvs-paste-textarea").value).toBe(""); // never auto-filled
});

test("clicking Load generated dialogue fills the textarea", () => {
  renderCVS({ initialText: "Dara: Hello!\nMaya: Hi there!", initialChapterId: "ch-a" });
  fireEvent.click(screen.getByTestId("cvs-load-generated-btn"));
  expect(screen.getByTestId("cvs-paste-textarea").value).toBe("Dara: Hello!\nMaya: Hi there!");
});

test("once loaded, the button disappears until new content differs", () => {
  renderCVS({ initialText: "Dara: Hello!", initialChapterId: "ch-a" });
  fireEvent.click(screen.getByTestId("cvs-load-generated-btn"));
  expect(screen.queryByTestId("cvs-load-generated-btn")).toBeNull();
});

test("teacher-typed text is never overwritten by an initialText prop change", () => {
  const { rerender } = renderCVS({ initialText: "Dara: Hello!", initialChapterId: "ch-a" });
  fireEvent.change(screen.getByTestId("cvs-paste-textarea"), { target: { value: "My own script: line one" } });
  // Regenerated content arrives (e.g. Book Factory regenerate) — same chapter identity.
  rerender(
    <ConversationVoiceStudio
      slug="s1" chapterIndex={0}
      book={{ title: "B", chapters: [{ title: "Ch1", blocks: [] }] }}
      elevenLabsVoices={[{ voice_id: "v1", name: "Voice One" }]}
      initialText="Dara: Updated line!"
      initialChapterId="ch-a"
    />
  );
  // Textarea must still show the teacher's own text — never silently replaced.
  expect(screen.getByTestId("cvs-paste-textarea").value).toBe("My own script: line one");
  // But an explicit reload affordance is offered, clearly labeled as replacing.
  expect(screen.getByTestId("cvs-load-generated-btn").textContent).toMatch(/replaces your current text/i);
});

test("switching chapter identity resets the touched/loaded guard", () => {
  const { rerender } = renderCVS({ initialText: "Dara: Hello!", initialChapterId: "ch-a" });
  fireEvent.change(screen.getByTestId("cvs-paste-textarea"), { target: { value: "typed text for chapter A" } });
  rerender(
    <ConversationVoiceStudio
      slug="s1" chapterIndex={1}
      book={{ title: "B", chapters: [{ title: "Ch1", blocks: [] }, { title: "Ch2", blocks: [] }] }}
      elevenLabsVoices={[{ voice_id: "v1", name: "Voice One" }]}
      initialText="Maya: Different chapter dialogue!"
      initialChapterId="ch-b"
    />
  );
  // New chapter identity — the previous chapter's typed text must not leak in,
  // and the Load button label must NOT warn about replacing text (untouched).
  expect(screen.getByTestId("cvs-load-generated-btn").textContent).not.toMatch(/replaces your current text/i);
});

test("initialVoiceAssignments seeds a speaker's voice on parse, preset still wins", () => {
  renderCVS({
    initialText: "Dara: Hello!\nMaya: Hi there!",
    initialChapterId: "ch-a",
    initialVoiceAssignments: { Dara: "v2", Maya: "v1" },
  });
  fireEvent.click(screen.getByTestId("cvs-load-generated-btn"));
  fireEvent.click(screen.getByTestId("cvs-parse-btn"));
  expect(screen.getByTestId("cvs-speaker-voice-Dara").value).toBe("v2");
  expect(screen.getByTestId("cvs-speaker-voice-Maya").value).toBe("v1");
});
