/**
 * readerPageSafePageIndex.test.js — Issue 2 fix proof (blank-page-on-mobile,
 * stale pageIndex half).
 *
 * Root cause: `pages` (the paginated plan) is recomputed on viewport
 * resize/orientation change — far more frequent on mobile than desktop.
 * When it shrinks, `pageIndex` can point past the end of the new array
 * for one render frame before the existing clamp *effect* runs (effects
 * run after paint). In that frame `pages[pageIndex]` is `undefined`, and
 * every content block gates on `currentPage && ...`, so the whole page
 * body renders blank.
 *
 * Fix: derive the rendered page from a clamped index computed inline
 * during render (`safePageIndex`), so there is no frame where an
 * out-of-range index reaches `pages[...]`. The existing effect is kept —
 * it still syncs the `pageIndex` state itself, which other reads (nav
 * button disabled state, progress %) compare against directly.
 *
 * ReaderPage.jsx has no existing mountable test harness (see
 * readerPageLiveCoachKeyPin.test.js for why) — this follows the same
 * source-level structural convention.
 */
import fs from "fs";
import path from "path";

const COMPONENT = fs.readFileSync(
  path.join(__dirname, "..", "ReaderPage.jsx"), "utf8");

describe("Issue 2 fix — pageIndex clamped inline before use, not just via effect", () => {
  test("safePageIndex is computed before currentPage is derived from it", () => {
    const safePos = COMPONENT.indexOf(
      "const safePageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));");
    const currentPagePos = COMPONENT.indexOf("const currentPage = pages[safePageIndex];");
    expect(safePos).toBeGreaterThan(-1);
    expect(currentPagePos).toBeGreaterThan(-1);
    expect(safePos).toBeLessThan(currentPagePos);
  });

  test("currentPage no longer reads the raw, unclamped pageIndex directly", () => {
    expect(COMPONENT).not.toMatch(/const currentPage = pages\[pageIndex\];/);
  });

  test("the pre-existing corrective effect (syncs pageIndex state itself) is untouched", () => {
    expect(COMPONENT).toMatch(
      /if\s*\(\s*pageIndex\s*>\s*pages\.length\s*-\s*1\s*\)\s*\{\s*\n\s*setPageIndex\(Math\.max\(0,\s*pages\.length\s*-\s*1\)\);/);
  });
});

describe("Issue 2 fix — Reader route is wrapped by an error boundary", () => {
  const APP = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "..", "..", "App.js"), "utf8");

  test("App.js imports ReaderErrorBoundary and wraps the /library/read/:slug route with it", () => {
    expect(APP).toMatch(
      /import ReaderErrorBoundary from "\.\/eduhub\/pages\/library\/reader\/ReaderErrorBoundary"/);
    const routeStart = APP.indexOf('path="/library/read/:slug"');
    expect(routeStart).toBeGreaterThan(-1);
    const routeBlock = APP.slice(routeStart, routeStart + 400);
    expect(routeBlock).toMatch(/<ReaderErrorBoundary>/);
    expect(routeBlock).toMatch(/<\/ReaderErrorBoundary>/);
    // The boundary must wrap Suspense (catches lazy-chunk-load failures
    // too), not sit inside it.
    const boundaryPos = routeBlock.indexOf("<ReaderErrorBoundary>");
    const suspensePos = routeBlock.indexOf("<Suspense");
    expect(boundaryPos).toBeLessThan(suspensePos);
  });
});
