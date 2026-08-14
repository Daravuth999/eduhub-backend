/**
 * transcriptHighlightSmoothing.test.js — Issue 6 fix proof.
 *
 * Root cause 1 (CSS): `.transcript-word[data-state="now"]` and
 * `.sp-word[data-state="now"]` jumped straight to a heavier font-weight
 * while color/background eased in over their declared transition —
 * font-weight cannot be smoothly interpolated by any browser for a
 * static (non-variable) font, so one property snapped while the others
 * eased, reading as jumpy. Fixed by replacing the font-weight jump with a
 * transform scale using each rule's OWN already-declared transition.
 *
 * Root cause 2 (scroll jumpiness): TranscriptParagraph's scroll-follow
 * effect fired on every word change relying solely on `block: "nearest"`
 * to skip already-visible elements; back-to-back smooth-scroll calls
 * (every ~0.2-0.5s while playing) could restart/cancel an in-flight one.
 * Fixed by gating on an explicit getBoundingClientRect visibility check
 * before calling scrollIntoView — the same pattern DialogTurn's own
 * line-level scroll-follow already uses.
 */
import fs from "fs";
import path from "path";

const READER_CSS = fs.readFileSync(
  path.join(__dirname, "..", "reader.css"), "utf8");
const CONVO_CSS = fs.readFileSync(
  path.join(__dirname, "..", "conversation-premium-v7.css"), "utf8");
const CHAPTER_BLOCKS = fs.readFileSync(
  path.join(__dirname, "..", "ChapterBlocks.jsx"), "utf8");

function ruleBody(css, selector) {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  const braceStart = css.indexOf("{", start);
  const braceEnd = css.indexOf("}", braceStart);
  return css.slice(braceStart, braceEnd);
}

describe("Issue 6 fix — CSS highlight no longer snaps font-weight", () => {
  test(".transcript-word[data-state=\"now\"] no longer sets font-weight; uses transform instead", () => {
    const body = ruleBody(READER_CSS, '.transcript-word[data-state="now"] {');
    expect(body).not.toMatch(/font-weight\s*:/);
    expect(body).toMatch(/transform:\s*scale\(/);
  });

  test(".transcript-word's own transition list already covers transform (no new untransitioned property introduced)", () => {
    const body = ruleBody(READER_CSS, ".transcript-word {");
    expect(body).toMatch(/transition:[^;]*transform/);
  });

  test("reduced motion disables the new transform for .transcript-word", () => {
    expect(READER_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.transcript-word\[data-state="now"\] \{\s*transform: none;/);
  });

  test(".sp-word[data-state=\"now\"] no longer sets font-weight; uses transform instead", () => {
    const body = ruleBody(CONVO_CSS, '.sp-word[data-state="now"]    {');
    expect(body).not.toMatch(/font-weight\s*:/);
    expect(body).toMatch(/transform:\s*scale\(/);
  });

  test(".sp-word's transition list was extended to cover transform (additive, background-color/color untouched)", () => {
    const body = ruleBody(CONVO_CSS, ".sp-word {");
    expect(body).toMatch(/transition:[^;]*background-color 0\.12s linear[^;]*color 0\.12s linear[^;]*transform 0\.12s linear/);
  });

  test("reduced motion disables the new transform for .sp-word", () => {
    expect(CONVO_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.sp-word\[data-state="now"\] \{\s*transform: none;/);
  });
});

describe("Issue 6 fix — scroll-follow gated on actual visibility", () => {
  test("the per-word scroll-follow effect checks getBoundingClientRect before scrolling", () => {
    const start = CHAPTER_BLOCKS.indexOf("gently scroll its container");
    expect(start).toBeGreaterThan(-1);
    const body = CHAPTER_BLOCKS.slice(start, start + 1400);
    expect(body).toMatch(/getBoundingClientRect\(\)/);
    expect(body).toMatch(/if\s*\(\s*r\.top\s*>=\s*0\s*&&\s*r\.bottom\s*<=\s*vh\s*\)\s*return;/);
    // The scrollIntoView call itself is unchanged (same options, same
    // target) — only whether it's reached is gated differently.
    expect(body).toMatch(
      /el\.scrollIntoView\(\{ block: "nearest", inline: "nearest", behavior: "smooth" \}\);/);
  });

  test("the visibility check happens BEFORE the scrollIntoView call", () => {
    const start = CHAPTER_BLOCKS.indexOf("gently scroll its container");
    const body = CHAPTER_BLOCKS.slice(start, start + 1400);
    const checkPos = body.indexOf("getBoundingClientRect()");
    const scrollPos = body.indexOf("el.scrollIntoView(");
    expect(checkPos).toBeGreaterThan(-1);
    expect(scrollPos).toBeGreaterThan(-1);
    expect(checkPos).toBeLessThan(scrollPos);
  });
});
