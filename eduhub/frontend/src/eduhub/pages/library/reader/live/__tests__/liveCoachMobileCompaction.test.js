/**
 * liveCoachMobileCompaction.test.js — proves the mobile spacing compaction
 * pass on liveCoach.css is present, scoped to a narrow-viewport media query
 * (never changes desktop spacing), and covers every section named in the
 * request (mode grid, value list, meta rows, Start button, coupon card).
 * A CSS file has no logic to unit-test directly, so this asserts against
 * the real stylesheet source, matching this suite's existing pattern for
 * verifying additive, non-behavioral changes to this heavy-dependency
 * component's assets.
 */
import fs from "fs";
import path from "path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "liveCoach.css"), "utf8");

function mediaBlock(css) {
  const start = css.indexOf("@media (max-width: 480px)");
  expect(start).toBeGreaterThan(-1);
  // Grab up to the matching closing brace of the media block (simple
  // brace-depth scan — sufficient since there's no nested @media here).
  let depth = 0;
  let i = css.indexOf("{", start);
  const blockStart = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(blockStart, i + 1);
}

test("a mobile compaction media query exists", () => {
  expect(CSS).toMatch(/@media \(max-width: 480px\)/);
});

test("compaction covers the sheet, mode grid, value list, meta rows, button, note, and coupon card", () => {
  const block = mediaBlock(CSS);
  expect(block).toMatch(/\.etlc-sheet\s*\{/);
  expect(block).toMatch(/\.etlc-modegrid\s*\{/);
  expect(block).toMatch(/\.etlc-mode\s*\{/);
  expect(block).toMatch(/\.etlc-value\s*\{/);
  expect(block).toMatch(/\.etlc-meta-row\s*\{/);
  expect(block).toMatch(/\.etlc-btn\s*\{/);
  expect(block).toMatch(/\.etlc-note\s*\{/);
  expect(block).toMatch(/\.etlc-coupon-card\s*\{/);
});

test("compaction only overrides spacing/sizing, never introduces new colors", () => {
  const block = mediaBlock(CSS);
  expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  expect(block).not.toMatch(/rgba?\(/);
});

test("base (non-mobile) rules for the same selectors are untouched outside the media query", () => {
  const beforeMedia = CSS.slice(0, CSS.indexOf("@media (max-width: 480px)"));
  expect(beforeMedia).toMatch(/\.etlc-sheet\s*\{[^}]*padding:\s*22px/);
  expect(beforeMedia).toMatch(/\.etlc-value\s*\{[^}]*padding:\s*12px 14px/);
});

test("mode cards get a smaller title/meta font and tighter gaps (itemized checklist item 1)", () => {
  const block = mediaBlock(CSS);
  expect(block).toMatch(/\.etlc-mode__name\s*\{[^}]*font-size:\s*12px/);
  expect(block).toMatch(/\.etlc-mode__meta\s*\{[^}]*font-size:\s*10px/);
  expect(block).toMatch(/\.etlc-modegrid\s*\{[^}]*gap:\s*5px/);
});

test("benefit checklist gets tighter item gap, smaller icons, reduced line-height (item 2)", () => {
  const block = mediaBlock(CSS);
  expect(block).toMatch(/\.etlc-value li\s*\{[^}]*line-height:\s*1\.3/);
  expect(block).toMatch(/\.etlc-value li svg\s*\{[^}]*width:\s*12px/);
});

test("session summary rows get tighter margins (item 3)", () => {
  const block = mediaBlock(CSS);
  expect(block).toMatch(/\.etlc-meta-row\s*\{[^}]*margin:\s*3px 0/);
});

test("coupon card gets compact padding/title/input/button sizing (item 4)", () => {
  const block = mediaBlock(CSS);
  expect(block).toMatch(/\.etlc-coupon-card\s*\{[^}]*padding:\s*8px 10px/);
  expect(block).toMatch(/\.etlc-coupon-card__input\s*\{/);
  expect(block).toMatch(/\.etlc-coupon-card__btn\s*\{/);
});

test("on the narrowest phones (<=360px) the coupon input/button stack to avoid overflow", () => {
  expect(CSS).toMatch(/@media \(max-width: 360px\)/);
  const start = CSS.indexOf("@media (max-width: 360px)");
  const block = CSS.slice(start, start + 400);
  expect(block).toMatch(/\.etlc-coupon-card__row\s*\{[^}]*flex-direction:\s*column/);
});

test("Start button stays prominent — gradient/color untouched by the compaction pass", () => {
  const beforeMedia = CSS.slice(0, CSS.indexOf("@media (max-width: 480px)"));
  expect(beforeMedia).toMatch(/\.etlc-btn\s*\{[^}]*background:\s*linear-gradient/);
  const block = mediaBlock(CSS);
  expect(block).not.toMatch(/\.etlc-btn\s*\{[^}]*background/); // mobile block never overrides the gradient
});
