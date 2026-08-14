/**
 * studioEditorDirtyState.test.jsx — the dirty-state contract (§5d / §12).
 *
 * Verifies the lean fingerprint, the seed→initial-dirty rules, the save-race
 * scenario, and that a new server-confirmed slug does not produce a false
 * dirty state. Uses @testing-library/react with ./api + ./ConversationVoiceStudio
 * mocked so no network/heavy chunk is exercised.
 */
import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import StudioEditor, { buildLeanBook } from "../StudioEditor";
import { saveStudioBook } from "../api";

jest.mock("../api", () => ({
  saveStudioBook: jest.fn(),
  listVoices: jest.fn(() => Promise.resolve({ voices: [] })),
  generateAiVoice: jest.fn(),
  getStudioBook: jest.fn(),
}));
jest.mock("../ConversationVoiceStudio", () => () => null);

const SAVED_BOOK = {
  slug: "my-book",
  title: "Saved Book",
  section: "story",
  published: true,
  chapters: [{ title: "Chapter 1", blocks: [{ type: "paragraph", text: "hello" }] }],
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  saveStudioBook.mockResolvedValue({ slug: "my-book", revision: 2, book: SAVED_BOOK });
});

// ── lean fingerprint distinctness ──────────────────────────────────────────
test("buildLeanBook fingerprints differ for different media payloads", () => {
  const mk = (data) => ({ chapters: [{ blocks: [{ type: "audio", text: data }] }] });
  const a = JSON.stringify(buildLeanBook(mk("data:audio/mp3;base64,AAAAAAAAAAAAAAAAAAAA1111")));
  const b = JSON.stringify(buildLeanBook(mk("data:audio/mp3;base64,BBBBBBBBBBBBBBBBBBBBBBBB2222222")));
  expect(a).not.toEqual(b);
});

test("buildLeanBook fingerprints are identical for identical payloads", () => {
  const mk = (data) => ({ chapters: [{ blocks: [{ type: "audio", text: data }] }] });
  const same = "data:audio/mp3;base64,SAMESAMESAMESAMESAME";
  expect(JSON.stringify(buildLeanBook(mk(same)))).toEqual(JSON.stringify(buildLeanBook(mk(same))));
});

test("buildLeanBook never serializes the full base64 payload", () => {
  const big = "data:audio/mp3;base64," + "Z".repeat(5000);
  const out = JSON.stringify(buildLeanBook({ chapters: [{ blocks: [{ type: "audio", text: big }] }] }));
  expect(out).not.toContain("Z".repeat(100));
  expect(out).toContain("__media__:");
});

// ── initial dirty rules ─────────────────────────────────────────────────────
async function mountEditor(props) {
  const ref = React.createRef();
  const onDirtyChange = jest.fn();
  let api;
  await act(async () => {
    api = render(<StudioEditor ref={ref} onDirtyChange={onDirtyChange} {...props} />);
  });
  await waitFor(() => expect(ref.current).toBeTruthy());
  return { ref, onDirtyChange, ...api };
}

test("book loaded from Browse (has slug) begins clean", async () => {
  const { ref } = await mountEditor({ initialBook: SAVED_BOOK });
  expect(ref.current.isDirty()).toBe(false);
});

test("new blank book begins dirty", async () => {
  const { ref } = await mountEditor({});
  expect(ref.current.isDirty()).toBe(true);
});

test("recovered local draft begins dirty", async () => {
  localStorage.setItem("studio_draft_v1", JSON.stringify({ ...SAVED_BOOK, title: "Recovered" }));
  const { ref } = await mountEditor({}); // no initialBook → recovers from localStorage
  expect(ref.current.isDirty()).toBe(true);
});

test("Smart Paste result begins dirty", async () => {
  const { ref } = await mountEditor({ initialBook: { ...SAVED_BOOK, _seedDirty: true } });
  expect(ref.current.isDirty()).toBe(true);
});

test("Book Factory handoff result begins dirty", async () => {
  const bfBook = { title: "Generated", section: "story", _seedDirty: true,
                   chapters: [{ title: "C1", blocks: [{ type: "paragraph", text: "x" }] }] };
  const { ref } = await mountEditor({ initialBook: bfBook });
  expect(ref.current.isDirty()).toBe(true);
});

// ── save-race + false-clean ─────────────────────────────────────────────────
test("save-race: A in flight, edit to B, A succeeds, B stays dirty", async () => {
  const d = deferred();
  saveStudioBook.mockReturnValue(d.promise);
  const { ref, getByTestId } = await mountEditor({ initialBook: SAVED_BOOK });
  expect(ref.current.isDirty()).toBe(false);

  // Click save for version A (request stays in flight).
  await act(async () => { fireEvent.click(getByTestId("studio-save-btn")); });

  // Teacher edits to version B while A is in flight.
  await act(async () => {
    fireEvent.change(getByTestId("studio-chapter-title-0"), { target: { value: "EDITED B" } });
  });
  expect(ref.current.isDirty()).toBe(true);

  // Version A saves successfully.
  await act(async () => { d.resolve({ slug: "my-book", revision: 2, book: SAVED_BOOK }); await d.promise; });

  // Version B must remain dirty.
  expect(ref.current.isDirty()).toBe(true);
});

test("successful save with new server slug does not produce a false dirty state", async () => {
  saveStudioBook.mockResolvedValue({ slug: "fresh-book", revision: 1 });
  const { ref, getByTestId } = await mountEditor({}); // new blank → dirty
  expect(ref.current.isDirty()).toBe(true);

  await act(async () => { fireEvent.click(getByTestId("studio-save-btn")); await Promise.resolve(); });
  await waitFor(() => expect(ref.current.isDirty()).toBe(false));
});
