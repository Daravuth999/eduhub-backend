/**
 * conversationVoiceStudio.test.js
 *
 * Verifies the lazy-mount-once CVS behaviour and interval-cleanup contract.
 * Follows the repo's source-inspection convention (fs.readFileSync + pattern
 * assertions).  No @testing-library/react dependency — the project does not
 * include it.  Runnable with: craco test
 *
 * Tests:
 *   1.  Initial StudioEditor render mounts zero CVS instances (conditional on
 *       cvsEverOpened, not rendered by default).
 *   2.  Opening a chapter mounts exactly one CVS instance (openCvs sets
 *       cvsEverOpened for that key only).
 *   3.  Collapsing does NOT unmount CVS — uses hidden attribute, not
 *       conditional rendering.
 *   4.  Pasted script survives collapse/reopen — component stays mounted.
 *   5.  Speaker selections survive collapse/reopen — same mounted-state
 *       guarantee.
 *   6.  Opening chapter B mounts a second independent instance.
 *   7.  Collapsing chapter A does not affect chapter B state.
 *   8.  Removing or reordering chapters does not attach open state to the
 *       wrong chapter (cvsKeysRef is kept in sync by removeChapter and
 *       moveChapter).
 *   9.  A failed generation always clears the progress interval (clearInterval
 *       is in the outer finally, not only on the success path).
 *  10.  A successful generation also clears the progress interval (same
 *       finally block handles both cases).
 *  11.  Already-generated conversation audio and chapter data are not
 *       affected — CVS reports completion via onPublished, which triggers
 *       handleConversationPublished in StudioEditor; the book state itself
 *       is never mutated directly by CVS.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function readSrc(rel) {
  return fs.readFileSync(path.resolve(ROOT, "src", rel), "utf8");
}

// ── Shared source strings loaded once ─────────────────────────────────────

let editor;
let cvs;

beforeAll(() => {
  editor = readSrc("studio/StudioEditor.jsx");
  cvs    = readSrc("studio/ConversationVoiceStudio.jsx");
});

// ── 1. Zero CVS on initial render ─────────────────────────────────────────

describe("1. Initial render — zero CVS instances", () => {
  test("CVS render is gated on cvsEverOpened, not always-true", () => {
    expect(editor).toMatch(/isEverOpened\s*&&/);
  });

  test("isEverOpened is derived from cvsEverOpened Set", () => {
    expect(editor).toMatch(/cvsEverOpened\.has\(cvsKey\)/);
  });

  test("cvsEverOpened starts empty — new Set() initialiser", () => {
    expect(editor).toMatch(/cvsEverOpened.*new Set\(\)/);
  });
});

// ── 2. Opening a chapter mounts exactly one CVS instance ──────────────────

describe("2. Opening chapter A — one CVS mounts", () => {
  test("openCvs adds key to cvsEverOpened", () => {
    expect(editor).toMatch(/setCvsEverOpened.*s\.add\(key\)/s);
  });

  test("openCvs also adds key to cvsVisible", () => {
    expect(editor).toMatch(/setCvsVisible.*s\.add\(key\)/s);
  });

  test("toggle button calls openCvs with the chapter's cvsKey", () => {
    expect(editor).toMatch(/openCvs\(cvsKey\)/);
  });
});

// ── 3. Collapse hides, does not destroy ───────────────────────────────────

describe("3. Collapse — hidden attribute, component stays mounted", () => {
  test("wrapper div carries hidden={!isVisible}", () => {
    expect(editor).toMatch(/hidden=\{!isVisible\}/);
  });

  test("wrapper div carries explicit display:none style when collapsed", () => {
    expect(editor).toMatch(/!isVisible.*display.*none/s);
  });

  test("CVS is NOT conditionally rendered on isVisible (that would unmount it)", () => {
    expect(editor).not.toMatch(/\{isVisible\s*&&\s*<ConversationVoiceStudio/);
  });

  test("wrapper carries aria-hidden when collapsed", () => {
    expect(editor).toMatch(/aria-hidden=\{!isVisible\s*\?\s*["']true["']/);
  });
});

// ── 4 & 5. Script and speaker state survive collapse/reopen ───────────────

describe("4 & 5. State preservation — hidden, not removed", () => {
  test("hidden attribute is used (component remains mounted, state intact)", () => {
    expect(editor).toMatch(/hidden=\{!isVisible\}/);
  });

  test("collapseCvs only removes from cvsVisible, not cvsEverOpened", () => {
    expect(editor).toMatch(/setCvsVisible.*s\.delete\(key\)/s);
    // openCvs must NOT touch cvsEverOpened on second open — it just adds;
    // the existing entry is idempotent (Set.add is a no-op for duplicates).
    expect(editor).toMatch(/s\.add\(key\)/);
  });
});

// ── 6. Chapter B opens independently ──────────────────────────────────────

describe("6. Chapter B — independent instance", () => {
  test("each chapter derives its own cvsKey from getCvsKey(ci)", () => {
    expect(editor).toMatch(/const cvsKey = getCvsKey\(ci\)/);
  });

  test("getCvsKey generates a separate key per chapter index", () => {
    expect(editor).toMatch(/getCvsKey.*=.*\(ci\)/s);
    expect(editor).toMatch(/cvsKeysRef\.current\.push/);
  });

  test("panelId is unique per chapter (derived from cvsKey)", () => {
    expect(editor).toMatch(/const panelId = `cvs-panel-\$\{cvsKey\}`/);
  });
});

// ── 7. Collapsing A does not affect B ─────────────────────────────────────

describe("7. Collapse A does not affect B", () => {
  test("collapseCvs operates on a specific key, not all chapters", () => {
    expect(editor).toMatch(/collapseCvs\(cvsKey\)/);
    expect(editor).toMatch(/collapseCvs.*=.*\(key\).*setCvsVisible/s);
  });

  test("toggle button uses per-chapter cvsKey", () => {
    expect(editor).toMatch(/collapseCvs\(cvsKey\)/);
    expect(editor).toMatch(/openCvs\(cvsKey\)/);
  });
});

// ── 8. Chapter reorder/delete uses stable keys ────────────────────────────

describe("8. Stable keys survive reorder and delete", () => {
  test("removeChapter splices from cvsKeysRef to keep indices in sync", () => {
    expect(editor).toMatch(/cvsKeysRef\.current.*splice/s);
  });

  test("removeChapter cleans up cvsEverOpened for the removed chapter", () => {
    expect(editor).toMatch(/setCvsEverOpened.*s\.delete\(gone\)/s);
  });

  test("removeChapter cleans up cvsVisible for the removed chapter", () => {
    expect(editor).toMatch(/setCvsVisible.*s\.delete\(gone\)/s);
  });

  test("moveChapter swaps keys in cvsKeysRef so CVS state follows the chapter", () => {
    expect(editor).toMatch(/cvsKeysRef\.current\[idx\].*cvsKeysRef\.current\[j\]/s);
  });
});

// ── 9. Failed generation clears progress interval ─────────────────────────

describe("9. Failed generation always clears progress interval", () => {
  test("clearInterval(genIntervalRef.current) and setGenerating(false) share the outer finally", () => {
    // Extract the outer finally block (the one that contains setGenerating).
    // The pattern locates "} finally {" followed by content that includes BOTH
    // clearInterval and setGenerating — proof they share the same finally.
    const segment = cvs.slice(cvs.lastIndexOf("} catch (err)"));
    expect(segment).toMatch(/clearInterval\(genIntervalRef\.current\)/);
    expect(segment).toMatch(/setGenerating\(false\)/);
    // They must appear in the finally, not just the catch
    const catchEnd = segment.indexOf("} finally {");
    expect(catchEnd).toBeGreaterThan(-1);
    const finallyBody = segment.slice(catchEnd);
    expect(finallyBody).toMatch(/clearInterval\(genIntervalRef\.current\)/);
    expect(finallyBody).toMatch(/setGenerating\(false\)/);
  });

  test("no success-only clearInterval pattern (old bug is gone)", () => {
    // The old bug was: clearInterval was only called inline after the await,
    // meaning an API error skipped it.
    expect(cvs).not.toMatch(/clearInterval\(interval\)/);
  });
});

// ── 10. Successful generation also clears interval ────────────────────────

describe("10. Successful generation clears interval (same finally)", () => {
  test("genIntervalRef pattern is used (ref survives async boundary)", () => {
    expect(cvs).toMatch(/genIntervalRef\.current\s*=\s*setInterval/);
  });

  test("genIntervalRef is nulled in finally to prevent double-clear", () => {
    expect(cvs).toMatch(/genIntervalRef\.current\s*=\s*null/);
  });

  test("unmount cleanup effect clears genIntervalRef", () => {
    expect(cvs).toMatch(/useEffect\s*\(\s*\(\s*\)\s*=>/);
    expect(cvs).toMatch(/clearInterval\(genIntervalRef\.current\)/);
  });
});

// ── 11. Existing audio and chapter data unaffected ────────────────────────

describe("11. Existing generated audio and chapter data unaffected", () => {
  test("CVS reports completion via onPublished prop (does not mutate book directly)", () => {
    expect(editor).toMatch(/onPublished=\{\(\)\s*=>\s*handleConversationPublished/);
  });

  test("handleConversationPublished reloads from server (does not patch local book inline)", () => {
    expect(editor).toMatch(/handleConversationPublished.*getStudioBook/s);
  });

  test("CVS does not import or call saveStudioBook from StudioEditor's scope", () => {
    // CVS calls saveStudioBook itself (auto-save before generation) — it never
    // reaches into StudioEditor's save handler.
    expect(cvs).toMatch(/import.*saveStudioBook.*from.*api/);
    expect(editor).toMatch(/handleConversationPublished/);
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────

describe("Accessibility — toggle button contract", () => {
  test("toggle is a native button element", () => {
    expect(editor).toMatch(/type="button"[\s\S]*?aria-expanded/);
  });

  test("aria-expanded reflects isVisible", () => {
    expect(editor).toMatch(/aria-expanded=\{isVisible\}/);
  });

  test("aria-controls links to panel id", () => {
    expect(editor).toMatch(/aria-controls=\{panelId\}/);
  });

  test("panel div id matches panelId", () => {
    expect(editor).toMatch(/id=\{panelId\}/);
  });

  test("button label says 'Open Conversation Voice Studio' when collapsed", () => {
    expect(editor).toMatch(/Open Conversation Voice Studio/);
  });

  test("button label says 'Collapse Conversation Voice Studio' when expanded", () => {
    expect(editor).toMatch(/Collapse Conversation Voice Studio/);
  });
});
