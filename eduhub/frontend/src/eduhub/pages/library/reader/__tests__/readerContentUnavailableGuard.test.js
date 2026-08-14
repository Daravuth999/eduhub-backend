/**
 * readerContentUnavailableGuard.test.js — source-inspection proof for the
 * P0 audit-pass hardening addition (ReaderPage.jsx has no mountable Jest
 * harness — markdown-to-jsx dependencies; see readerPageSafePageIndex.test.js
 * for the established precedent this file follows).
 *
 * Origin: an external "Production_Recovery_Patch" bundle (reviewed during
 * an independent release audit this session) proposed the same last-resort
 * guard — an authenticated reader must never fall through to the broken
 * "0/1 · The End" shell. That patch's version was adapted in, NOT copied
 * verbatim: the patch also reverted this repo's cache-ownership
 * partitioning (guest/authenticated catalog responses sharing one
 * localStorage key) to make its own recovery mechanism work, which
 * directly contradicts this session's explicit cache-ownership decision.
 * Only the Reader-level UI guard was kept; the cache revert was not.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "ReaderPage.jsx"),
  "utf8",
);

test("contentUnavailable guard exists and is gated on isAuthenticated + empty chapters", () => {
  expect(SRC).toMatch(
    /const contentUnavailable = isAuthenticated && !\(book\?\.chapters\?\.length > 0\);/,
  );
});

test("contentUnavailable is checked AFTER the error||!book guard, so `book` is never null when it fires", () => {
  const errorGuardIdx = SRC.indexOf("if (error || !book) {");
  const contentUnavailableIdx = SRC.indexOf("const contentUnavailable =");
  expect(errorGuardIdx).toBeGreaterThan(-1);
  expect(contentUnavailableIdx).toBeGreaterThan(errorGuardIdx);
});

test("contentUnavailable and guestLocked are mutually exclusive by construction (opposite isAuthenticated polarity)", () => {
  const guestLockedLine = SRC.match(/const guestLocked = ([^\n]+);/)[1];
  const contentUnavailableLine = SRC.match(/const contentUnavailable = ([^\n]+);/)[1];
  expect(guestLockedLine).toContain("!isAuthenticated");
  expect(contentUnavailableLine).toContain("isAuthenticated &&");
  expect(contentUnavailableLine).not.toContain("!isAuthenticated");
});

test("the retry button advances retryNonce (in-place re-fetch) rather than navigating — no remount", () => {
  const cardBlock = SRC.slice(
    SRC.indexOf("data-testid=\"reader-content-unavailable\""),
    SRC.indexOf("data-testid=\"reader-content-unavailable\"") + 900,
  );
  expect(cardBlock).toMatch(/onClick=\{\(\) => setRetryNonce\(\(n\) => n \+ 1\)\}/);
  expect(cardBlock).toContain('data-testid="reader-content-retry"');
  expect(cardBlock).toContain('data-testid="reader-content-back"');
});

test("retryNonce is in the book-load effect's dependency array, so the retry button actually re-runs the fetch", () => {
  const depsMatch = SRC.match(
    /\}, \[slug, student\?\.studentId, navigate, portalUnlocksKey, isBootstrapping, isAuthenticated, retryNonce\]\);/,
  );
  expect(depsMatch).not.toBeNull();
});

test("getBookBySlug is called with { isAuthenticated } — cache-ownership partitioning is preserved (NOT reverted by the audit-pass addition)", () => {
  expect(SRC).toMatch(/getBookBySlug\(slug, \{ isAuthenticated \}\)/);
});
