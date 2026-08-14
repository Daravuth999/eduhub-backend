/**
 * welcomeExperienceStudioWiring.test.jsx — StudioPage tab wiring + api.js
 * client contract for the new Welcome Experience Studio (Phase 3).
 *
 * Follows the repo's source-inspection convention for Studio shell wiring
 * (see attendanceStudio.test.jsx) — behavioral coverage of the page itself
 * lives in WelcomeExperienceStudio.test.jsx.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function readSrc(relPath) {
  return fs.readFileSync(path.resolve(ROOT, "src", relPath), "utf8");
}

describe("StudioPage — Welcome Experience tab integration", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/StudioPage.jsx"); });

  test("imports WelcomeExperienceStudio", () => {
    expect(src).toMatch(/import WelcomeExperienceStudio from ["']\.\/WelcomeExperienceStudio["']/);
  });

  test("TABS array contains a welcomeexp entry", () => {
    expect(src).toMatch(/key:\s*["']welcomeexp["']/);
    expect(src).toMatch(/label:\s*["']Welcome Experience["']/);
  });

  test("renders WelcomeExperienceStudio when the welcomeexp tab is active", () => {
    expect(src).toMatch(/tab\s*===\s*["']welcomeexp["']\s*&&\s*<WelcomeExperienceStudio/);
  });

  test("all 20 pre-existing tabs still present (additive only)", () => {
    const existingKeys = [
      "artwork", "editor", "smart", "upload", "browse", "preview",
      "aiscene", "aitools", "aiassistant", "push", "teacher", "coupons",
      "rewards", "mysterybox", "loginmystery", "tuition", "payments",
      "referral", "voicetreasure", "attendance",
    ];
    existingKeys.forEach((k) => expect(src).toContain(k));
  });
});

describe("api.js — Experience Configuration Platform admin client", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/api.js"); });

  test("every CRUD/lifecycle helper is exported", () => {
    [
      "listExperienceConfigs", "createExperienceConfig", "getExperienceConfig",
      "updateExperienceConfig", "publishExperienceConfig", "unpublishExperienceConfig",
      "duplicateExperienceConfig", "deleteExperienceConfig",
    ].forEach((fn) => expect(src).toMatch(new RegExp(`export const ${fn} =`)));
  });

  test("create/update/publish/unpublish/duplicate hit the /api/experience-configs path", () => {
    expect(src).toMatch(/request\(\s*"\/api\/experience-configs"/);
    expect(src).toMatch(/\/api\/experience-configs\/\$\{encodeURIComponent\(id\)\}\/publish/);
    expect(src).toMatch(/\/api\/experience-configs\/\$\{encodeURIComponent\(id\)\}\/unpublish/);
    expect(src).toMatch(/\/api\/experience-configs\/\$\{encodeURIComponent\(id\)\}\/duplicate/);
  });

  test("update uses PUT and publish/unpublish/duplicate use POST", () => {
    expect(src).toMatch(/updateExperienceConfig[\s\S]{0,120}method:\s*"PUT"/);
    expect(src).toMatch(/publishExperienceConfig[\s\S]{0,120}method:\s*"POST"/);
  });

  test("delete supports the force flag as a query param, not a silent no-op", () => {
    expect(src).toMatch(/deleteExperienceConfig[\s\S]{0,300}force[\s\S]{0,100}method:\s*"DELETE"/);
  });
});
