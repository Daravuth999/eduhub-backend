/**
 * joinPrizePoolCss.test.js — source-inspection guard for the Join Prize
 * Pool card's CSS. jsdom has no real layout engine, so this cannot
 * measure actual rendered clipping on a mobile viewport — instead it
 * asserts the ruleset contains none of the properties that would
 * forcibly clip content (fixed narrow width/max-height, overflow:
 * hidden) regardless of viewport, which is the actual mechanism a
 * "clipped on mobile" bug would come from here.
 */
import fs from "fs";
import path from "path";

const CSS_PATH = path.resolve(
  __dirname, "../portal-theme.css",
);

describe("Join Prize Pool card CSS — no forced clipping", () => {
  let css;
  beforeAll(() => {
    css = fs.readFileSync(CSS_PATH, "utf8");
  });

  function ruleFor(selector) {
    const idx = css.indexOf(`${selector} {`);
    if (idx === -1) return "";
    const end = css.indexOf("}", idx);
    return css.slice(idx, end);
  }

  test(".join-prize-pool has no overflow:hidden or fixed clipping dimensions", () => {
    const rule = ruleFor(".join-prize-pool");
    expect(rule).not.toMatch(/overflow:\s*hidden/i);
    expect(rule).not.toMatch(/max-height:\s*\d/i);
    expect(rule).not.toMatch(/\bwidth:\s*\d+px/i);
  });

  test(".join-prize-pool uses flex layout (grows with content, doesn't fix a height)", () => {
    const rule = ruleFor(".join-prize-pool");
    expect(rule).toMatch(/display:\s*flex/i);
    expect(rule).not.toMatch(/height:\s*\d/i);
  });
});
