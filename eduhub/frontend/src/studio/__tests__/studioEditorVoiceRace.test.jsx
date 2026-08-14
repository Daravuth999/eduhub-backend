/**
 * studioEditorVoiceRace.test.jsx — §MEDIUM 15 (item N).
 *
 * The existing ElevenLabs voice / conversation-publish behaviour is preserved;
 * only the dirty-state interaction is corrected so an in-flight local edit is
 * never overwritten and never falsely marked clean, and a failed operation
 * never advances the saved baseline.
 */
import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import StudioEditor from "../StudioEditor";
import { saveStudioBook, generateAiVoice, getStudioBook } from "../api";

jest.mock("../api", () => ({
  saveStudioBook: jest.fn(),
  generateAiVoice: jest.fn(),
  getStudioBook: jest.fn(),
  listVoices: jest.fn(() => Promise.resolve({ voices: [] })),
}));
// CVS mock exposes onPublished via a button so we can drive the publish path.
jest.mock("../ConversationVoiceStudio", () => (props) => (
  <button data-testid="cvs-publish" onClick={() => props.onPublished && props.onPublished(props.slug || "my-book")} />
));
jest.mock("../StudioPreview", () => () => null);

const SAVED_BOOK = {
  slug: "my-book", title: "Saved Book", section: "story", published: true,
  chapters: [{ title: "Chapter 1", blocks: [{ type: "paragraph", text: "hello" }] }],
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  window.alert = jest.fn();
  saveStudioBook.mockResolvedValue({ slug: "my-book", revision: 2, book: SAVED_BOOK });
  generateAiVoice.mockResolvedValue({ wordCount: 3 });
  getStudioBook.mockResolvedValue({ book: { ...SAVED_BOOK } });
});

async function mount(props) {
  const ref = React.createRef();
  let view;
  await act(async () => { view = render(<StudioEditor ref={ref} onDirtyChange={jest.fn()} {...props} />); });
  await waitFor(() => expect(ref.current).toBeTruthy());
  return { ref, ...view };
}

// 1. successful chapter voice generation, no edits → clean
test("voice generation with no edits ends clean", async () => {
  const { ref, getByTestId } = await mount({ initialBook: SAVED_BOOK });
  expect(ref.current.isDirty()).toBe(false);
  await act(async () => { fireEvent.click(getByTestId("studio-chapter-0-elevenlabs")); });
  await waitFor(() => expect(getStudioBook).toHaveBeenCalled());
  expect(ref.current.isDirty()).toBe(false);
});

// 2. successful conversation publish, no edits → clean
test("conversation publish with no edits ends clean", async () => {
  const { ref, getByText, getByTestId } = await mount({ initialBook: SAVED_BOOK });
  await act(async () => { fireEvent.click(getByText("Open Conversation Voice Studio")); });
  await act(async () => { fireEvent.click(getByTestId("cvs-publish")); });
  await waitFor(() => expect(getStudioBook).toHaveBeenCalled());
  expect(ref.current.isDirty()).toBe(false);
});

// 3 + 5. local edit during voice op → not overwritten, stays dirty
test("local edit during voice operation is not overwritten and stays dirty", async () => {
  const gen = deferred();
  generateAiVoice.mockReturnValue(gen.promise);
  getStudioBook.mockResolvedValue({ book: { ...SAVED_BOOK, title: "SERVER-OVERWRITE" } });
  const { ref, getByTestId } = await mount({ initialBook: SAVED_BOOK });

  await act(async () => { fireEvent.click(getByTestId("studio-chapter-0-elevenlabs")); });
  // edit while the voice request is in flight
  await act(async () => {
    fireEvent.change(getByTestId("studio-chapter-title-0"), { target: { value: "LOCAL EDIT" } });
  });
  await act(async () => { gen.resolve({ wordCount: 3 }); await gen.promise; });
  await waitFor(() => expect(getByTestId("studio-sync-warning")).toBeInTheDocument());
  // local edit preserved (server book NOT applied) and still dirty
  expect(getByTestId("studio-chapter-title-0").value).toBe("LOCAL EDIT");
  expect(ref.current.isDirty()).toBe(true);
});

// 4. local edit during conversation op → not overwritten
test("local edit during conversation publish is not overwritten", async () => {
  const fresh = deferred();
  getStudioBook.mockReturnValue(fresh.promise);
  const { ref, getByText, getByTestId } = await mount({ initialBook: SAVED_BOOK });
  await act(async () => { fireEvent.click(getByText("Open Conversation Voice Studio")); });
  await act(async () => { fireEvent.click(getByTestId("cvs-publish")); });
  await act(async () => {
    fireEvent.change(getByTestId("studio-chapter-title-0"), { target: { value: "LOCAL EDIT 2" } });
  });
  await act(async () => { fresh.resolve({ book: { ...SAVED_BOOK, title: "SERVER" } }); await fresh.promise; });
  await waitFor(() => expect(getByTestId("studio-sync-warning")).toBeInTheDocument());
  expect(getByTestId("studio-chapter-title-0").value).toBe("LOCAL EDIT 2");
  expect(ref.current.isDirty()).toBe(true);
});

// 6. failed operation does not advance the saved baseline
test("failed voice operation does not advance baseline (stays dirty)", async () => {
  generateAiVoice.mockRejectedValue(new Error("boom"));
  const { ref, getByTestId } = await mount({ initialBook: { ...SAVED_BOOK, _seedDirty: true } });
  expect(ref.current.isDirty()).toBe(true);
  await act(async () => { fireEvent.click(getByTestId("studio-chapter-0-elevenlabs")); });
  await waitFor(() => expect(generateAiVoice).toHaveBeenCalled());
  expect(ref.current.isDirty()).toBe(true);
});

// §PHASE F2: pre-existing dirty state before CV publish → warn, not replace.
// The old code checked `currentSignature !== operationStartSignature` which
// only caught edits DURING the async fetch.  With pre-existing dirty state
// (edit before publish fires), both signatures are equal (no change during the
// fetch) so the old guard would silently overwrite the author's work.
// The fix checks dirty-vs-saved-baseline instead.
test("PHASE F2: pre-existing dirty edit before publish is not overwritten", async () => {
  getStudioBook.mockResolvedValue({ book: { ...SAVED_BOOK, title: "SERVER-OVERWRITE" } });
  const { ref, getByText, getByTestId } = await mount({ initialBook: SAVED_BOOK });
  // Author edits BEFORE publish fires.
  await act(async () => {
    fireEvent.change(getByTestId("studio-chapter-title-0"), { target: { value: "PRE-EDIT" } });
  });
  expect(ref.current.isDirty()).toBe(true);
  // Now CV publishes. The async fetch resolves without any in-flight edit
  // (pre-existing dirty state is the only signal).
  await act(async () => { fireEvent.click(getByText("Open Conversation Voice Studio")); });
  await act(async () => { fireEvent.click(getByTestId("cvs-publish")); });
  await waitFor(() => expect(getStudioBook).toHaveBeenCalled());
  // Warning must be shown and local edit must be preserved.
  await waitFor(() => expect(getByTestId("studio-sync-warning")).toBeInTheDocument());
  expect(getByTestId("studio-chapter-title-0").value).toBe("PRE-EDIT");
  expect(ref.current.isDirty()).toBe(true);
});

// 7. edit after successful completion becomes dirty normally
test("edit after successful completion becomes dirty", async () => {
  const { ref, getByTestId } = await mount({ initialBook: SAVED_BOOK });
  await act(async () => { fireEvent.click(getByTestId("studio-chapter-0-elevenlabs")); });
  await waitFor(() => expect(getStudioBook).toHaveBeenCalled());
  expect(ref.current.isDirty()).toBe(false);
  await act(async () => {
    fireEvent.change(getByTestId("studio-chapter-title-0"), { target: { value: "post-edit" } });
  });
  expect(ref.current.isDirty()).toBe(true);
});
