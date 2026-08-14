/**
 * readerPageLiveCoachKeyPin.test.js — Issue 1 fix proof.
 *
 * Root cause: EduTalkLiveCoach was keyed by `live-${currentPage.chapterIdx}`
 * so React fully unmounts + remounts it every time the student turns a
 * page into a new chapter. Unmounting a "live" (in-progress, paid)
 * session runs its cleanup(), which closes the WebSocket — and per the
 * Issue 3 fix, ws.onclose then finalizes the session via restEnd(),
 * refunding/charging as if the student had explicitly ended it. A page
 * turn should never be able to silently end a paid Live Coach session.
 *
 * Fix (additive, no redesign): the render-site key is pinned to its last
 * value for as long as `hasActiveSession()` is true (the same registry
 * EduTalkLiveCoach itself registers into while "live" — see the Issue 4
 * fix). The moment the session ends, the next chapter's key takes effect
 * normally — chapter-scoped remounting (fresh config/state per chapter)
 * is otherwise UNCHANGED.
 *
 * ReaderPage.jsx has no existing test harness (it composes booksService,
 * purchaseService, AudioPlayerContext, and heavy pagination math with no
 * mocks set up anywhere in this repo) and a full mount is out of
 * proportion to this fix's scope. This file follows the same repo
 * convention as liveCoachStaleGenerationGuard.test.js: source-level
 * structural assertions against the actual production component.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "ReaderPage.jsx"), "utf8");

describe("Issue 1 fix — EduTalk Live Coach key pinned while a session is active", () => {
  test("imports the shared active-session registry (read-only, no billing/auth coupling)", () => {
    expect(COMPONENT).toMatch(
      /import\s*\{\s*hasActiveSession\s*\}\s*from\s*"\.\.\/\.\.\/\.\.\/lib\/activeSessionRegistry"/);
  });

  test("a dedicated ref holds the pinned key, declared unconditionally (before any early return)", () => {
    const refPos = COMPONENT.indexOf("const liveCoachKeyRef = useRef(null);");
    expect(refPos).toBeGreaterThan(-1);
    // Sanity: the ref must be declared textually before `currentPage` is
    // computed (which itself sits after every conditional early return in
    // this component), never inside a conditionally-executed branch.
    const currentPagePos = COMPONENT.indexOf("const currentPage = pages[safePageIndex];");
    expect(currentPagePos).toBeGreaterThan(-1);
    expect(refPos).toBeLessThan(currentPagePos);
  });

  test("the pin only updates while no session is active, and falls back to the raw chapter key", () => {
    const start = COMPONENT.indexOf("const rawLiveCoachKey =");
    expect(start).toBeGreaterThan(-1);
    const body = COMPONENT.slice(start, start + 400);
    expect(body).toMatch(/if\s*\(\s*!hasActiveSession\(\)\s*\)\s*\{/);
    expect(body).toMatch(/liveCoachKeyRef\.current\s*=\s*rawLiveCoachKey/);
    expect(body).toMatch(
      /const\s+liveCoachKey\s*=\s*liveCoachKeyRef\.current\s*\?\?\s*rawLiveCoachKey/);
    // Order: compute raw value → guard → assign → resolve. The guard must
    // come BEFORE the assignment it protects.
    const guardPos = body.indexOf("!hasActiveSession()");
    const assignPos = body.indexOf("liveCoachKeyRef.current = rawLiveCoachKey");
    expect(guardPos).toBeGreaterThan(-1);
    expect(assignPos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(assignPos);
  });

  test("EduTalkLiveCoach's key prop uses the pinned value, not the raw chapter index", () => {
    expect(COMPONENT).not.toMatch(/key=\{`live-\$\{currentPage\.chapterIdx\}`\}/);
    const launcherPos = COMPONENT.indexOf("<EduTalkLiveCoach");
    expect(launcherPos).toBeGreaterThan(-1);
    const block = COMPONENT.slice(launcherPos, launcherPos + 200);
    expect(block).toMatch(/key=\{liveCoachKey\}/);
  });

  test("EduTalkLauncher's chapter-scoped key is untouched (Issue 1 fix is scoped to Live Coach only)", () => {
    expect(COMPONENT).toMatch(/key=\{currentPage\.chapterIdx\}/);
  });
});
