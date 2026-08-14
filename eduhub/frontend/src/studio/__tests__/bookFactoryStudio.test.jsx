/**
 * bookFactoryStudio.test.jsx — Book Factory frontend contract (§4 / §12).
 *
 * Combines:
 *   • Structural assertions on the two allowed edits to existing files
 *     (StudioPage.jsx code-splitting + visible-gating + status-once + editor
 *     wiring) — this is the only reliable way to prove genuine code-splitting
 *     and that the lazy chunk is NOT eagerly bundled.
 *   • Behavioural RTL tests of the Book Factory components themselves: the
 *     fail-closed status client, the disabled-state explanation, AbortController
 *     teardown on unmount, and the dirty-confirm handoff guard.
 */
import fs from "fs";
import path from "path";
import React from "react";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";

const STUDIO_DIR = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.resolve(STUDIO_DIR, rel), "utf8");

// ── structural: genuine code-splitting + bounded StudioPage edits ──────────
describe("StudioPage wiring (structural)", () => {
  const src = read("StudioPage.jsx");

  test("BookFactoryStudio is loaded via React.lazy (own chunk), not statically", () => {
    expect(src).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(["']\.\/bookFactory\/BookFactoryStudio["']\)\s*\)/);
    // No eager default import of the component (that would bundle it into the main chunk).
    expect(src).not.toMatch(/^import\s+BookFactoryStudio\s+from/m);
  });

  test("status is fetched exactly once on mount (empty-deps effect, no polling)", () => {
    expect(src).toMatch(/getBookFactoryStatus\(\)/);
    // mount-once effect with empty dependency array
    expect(src).toMatch(/useEffect\([\s\S]*getBookFactoryStatus[\s\S]*\}, \[\]\)/);
    expect(src).not.toMatch(/setInterval|setTimeout\([^,]*getBookFactoryStatus/);
  });

  test("the Book Factory tab + render are gated on bfStatus.visible", () => {
    expect(src).toMatch(/bfStatus\.visible[\s\S]*key:\s*["']bookfactory["']/);
    expect(src).toMatch(/tab === "bookfactory" && bfStatus\.visible/);
  });

  test("StudioEditor render call additively wires ref + onDirtyChange", () => {
    expect(src).toMatch(/<StudioEditor[\s\S]*ref=\{editorRef\}[\s\S]*onDirtyChange=\{setEditorDirty\}/);
  });
});

describe("StudioEditor backward-compat (structural)", () => {
  const src = read("StudioEditor.jsx");
  test("uses forwardRef and exposes isDirty + exportCurrentDraft", () => {
    expect(src).toMatch(/forwardRef\(/);
    expect(src).toMatch(/useImperativeHandle/);
    expect(src).toMatch(/exportCurrentDraft/);
    expect(src).toMatch(/isDirty:/);
  });
  test("new props are optional (no required-prop breakage for Browse/Smart Paste)", () => {
    // onDirtyChange is always invoked optionally
    expect(src).toMatch(/onDirtyChange\?\.\(/);
  });
});

describe("BookFactoryHandoff preview uses the real Reader path (structural)", () => {
  const src = read("bookFactory/BookFactoryHandoff.jsx");
  test("imports the existing StudioPreview component (ChapterBlocks/BookCover path)", () => {
    expect(src).toMatch(/import\s+StudioPreview\s+from\s+["']\.\.\/StudioPreview["']/);
  });
});

// ── behavioural: fail-closed status client ─────────────────────────────────
describe("bookFactoryApi.getStatus fail-closed", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // Phase 2-4 additive flags default false alongside the core three.
  const FAIL_CLOSED = {
    visible: false, enabled: false, geminiEnabled: false,
    coverEnabled: false, coverProviderReady: false, coverStorageReady: false,
    narrationEnabled: false, conversationAudioEnabled: false, directPublishEnabled: false,
    premiumInteractionsEnabled: false,
  };

  test("network error → {visible:false, enabled:false}", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("network")));
    const { getStatus } = require("../bookFactory/bookFactoryApi");
    await expect(getStatus()).resolves.toEqual(FAIL_CLOSED);
  });

  test("non-200 → {visible:false, enabled:false}", async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }));
    const { getStatus } = require("../bookFactory/bookFactoryApi");
    await expect(getStatus()).resolves.toEqual(FAIL_CLOSED);
  });

  test("malformed body → fail-closed", async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) }));
    const { getStatus } = require("../bookFactory/bookFactoryApi");
    await expect(getStatus()).resolves.toEqual(FAIL_CLOSED);
  });

  test("valid body coerces to booleans", async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ visible: true, enabled: false, geminiEnabled: false }),
    }));
    const { getStatus } = require("../bookFactory/bookFactoryApi");
    await expect(getStatus()).resolves.toEqual({ ...FAIL_CLOSED, visible: true });
  });
});

// ── behavioural: BookFactoryStudio component ───────────────────────────────
jest.mock("../StudioPreview", () => () => <div data-testid="mock-preview" />);

describe("BookFactoryStudio component", () => {
  test("enabled=false renders the disabled explanation and disables Generate", async () => {
    const BookFactoryStudio = require("../bookFactory/BookFactoryStudio").default;
    await act(async () => { render(<BookFactoryStudio enabled={false} editorDirty={false} onHandoff={() => {}} />); });
    expect(screen.getByTestId("book-factory-disabled-banner")).toBeInTheDocument();
    expect(screen.getByTestId("bf-generate-btn")).toBeDisabled();
  });

  test("navigating away (unmount) aborts an in-flight /step via AbortController", async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise(() => {})); // request stays in flight
    const abortSpy = jest.spyOn(AbortController.prototype, "abort");
    const BookFactoryStudio = require("../bookFactory/BookFactoryStudio").default;

    let view;
    await act(async () => {
      view = render(<BookFactoryStudio enabled={true} geminiEnabled={true} editorDirty={false} onHandoff={() => {}} />);
    });
    // start generation (creates the AbortController + in-flight createJob)
    await act(async () => {
      fireEvent.change(screen.getByTestId("bf-title"), { target: { value: "T" } });
      fireEvent.change(screen.getByTestId("bf-topic"), { target: { value: "Topic" } });
      fireEvent.click(screen.getByTestId("bf-generate-btn"));
    });
    await act(async () => { view.unmount(); });
    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
    global.fetch = realFetch;
  });
});

describe("BookFactoryHandoff dirty guard", () => {
  test("does not silently overwrite a dirty Editor draft — requires confirmation", async () => {
    const BookFactoryHandoff = require("../bookFactory/BookFactoryHandoff").default;
    const onOpenInEditor = jest.fn();
    const book = { title: "B", chapters: [] };
    await act(async () => {
      render(<BookFactoryHandoff book={book} editorDirty={true} onOpenInEditor={onOpenInEditor} />);
    });
    // First click surfaces the confirmation instead of seeding the editor.
    await act(async () => { fireEvent.click(screen.getByTestId("bf-replace-draft")); });
    expect(onOpenInEditor).not.toHaveBeenCalled();
    expect(screen.getByTestId("bf-dirty-confirm")).toBeInTheDocument();
    // Explicit confirmation proceeds.
    await act(async () => { fireEvent.click(screen.getByTestId("bf-dirty-confirm-yes")); });
    expect(onOpenInEditor).toHaveBeenCalledWith(book);
  });

  test("clean Editor → opens immediately without a confirm dialog", async () => {
    const BookFactoryHandoff = require("../bookFactory/BookFactoryHandoff").default;
    const onOpenInEditor = jest.fn();
    const book = { title: "B", chapters: [] };
    await act(async () => {
      render(<BookFactoryHandoff book={book} editorDirty={false} onOpenInEditor={onOpenInEditor} />);
    });
    await act(async () => { fireEvent.click(screen.getByTestId("bf-replace-draft")); });
    expect(onOpenInEditor).toHaveBeenCalledWith(book);
  });
});
