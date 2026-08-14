/**
 * dashboardStudioWiring.test.js — Dashboard Studio framework contract.
 *
 * Follows the repo's source-inspection convention for Studio shell wiring
 * (see welcomeExperienceStudioWiring.test.jsx / attendanceStudio.test.jsx).
 * Asserts the FRAMEWORK properties this task requires: the shell is
 * generic over a registry (not hardcoded to "daily_discovery"), reuses
 * the existing Experience Configuration Platform CRUD verbatim, and
 * introduces no parallel config/CRUD/upload system.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function readSrc(relPath) {
  return fs.readFileSync(path.resolve(ROOT, "src", relPath), "utf8");
}

describe("StudioPage — Dashboard Studio tab integration", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/StudioPage.jsx"); });

  test("imports DashboardStudio", () => {
    expect(src).toMatch(/import DashboardStudio from ["']\.\/DashboardStudio["']/);
  });

  test("TABS array contains a dashboardstudio entry", () => {
    expect(src).toMatch(/key:\s*["']dashboardstudio["']/);
    expect(src).toMatch(/label:\s*["']Dashboard Studio["']/);
  });

  test("renders DashboardStudio when the dashboardstudio tab is active", () => {
    expect(src).toMatch(/tab\s*===\s*["']dashboardstudio["']\s*&&\s*<DashboardStudio/);
  });

  test("pre-existing Welcome / Achievement / Promotion Experience tabs are untouched", () => {
    // Note: "dashboardenv" (DashboardEnvironmentStudio, a V3-era panel) is
    // deliberately NOT asserted here — its source file was removed from
    // master by a revert predating this project (see the merge notes in
    // docs/implementation/dashboard-reconstruction-handover.md), so its
    // tab was removed alongside it during the release merge.
    ["welcomeexp", "achievementexp", "promotionexp"].forEach((k) => {
      expect(src).toMatch(new RegExp(`key:\\s*["']${k}["']`));
    });
  });
});

describe("DashboardStudio.jsx — generic framework, not a one-off editor", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/DashboardStudio.jsx"); });

  test("reads its type list from the registry, not a hardcoded single type", () => {
    expect(src).toMatch(/import \{ DASHBOARD_EXPERIENCE_TYPES \} from ["']\.\/dashboardExperiences\/dashboardExperienceRegistry["']/);
    expect(src).not.toMatch(/daily_discovery/);
  });

  test("uses the EXISTING generic Experience Configuration Platform CRUD, not a new endpoint", () => {
    [
      "listExperienceConfigs", "createExperienceConfig", "updateExperienceConfig",
      "publishExperienceConfig", "unpublishExperienceConfig", "duplicateExperienceConfig",
      "deleteExperienceConfig",
    ].forEach((fn) => expect(src).toMatch(new RegExp(`\\b${fn}\\b`)));
    expect(src).toMatch(/from ["']\.\/api["']/);
  });

  test("no Dashboard-specific fetch/axios/XHR call — every network op goes through ./api", () => {
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/axios\./);
  });

  test("delegates content-specific rendering to the active type's FormFields/Preview, never inspecting field shape itself", () => {
    expect(src).toMatch(/type\.FormFields/);
    expect(src).toMatch(/type\.Preview/);
    expect(src).not.toMatch(/content\.items/); // that's Discovery-specific; the shell must not know it
  });

  test("type switcher renders one nav entry per registered type (not a fixed count)", () => {
    expect(src).toMatch(/DASHBOARD_EXPERIENCE_TYPES\.map/);
  });
});

describe("dashboardExperienceRegistry.js — the one file a new type needs to touch", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/dashboardExperiences/dashboardExperienceRegistry.js"); });

  test("exports DASHBOARD_EXPERIENCE_TYPES with the required descriptor shape", () => {
    expect(src).toMatch(/export const DASHBOARD_EXPERIENCE_TYPES/);
    expect(src).toMatch(/id:\s*["']daily_discovery["']/);
    expect(src).toMatch(/FormFields:/);
    expect(src).toMatch(/Preview:/);
    expect(src).toMatch(/defaultConfig:/);
  });
});

describe("DailyDiscoveryFields.jsx — reuses the existing asset picker, no new upload path", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/dashboardExperiences/DailyDiscoveryFields.jsx"); });

  test("imports the EXISTING HeroArtworkPanel rather than building a new uploader", () => {
    expect(src).toMatch(/import HeroArtworkPanel from ["']\.\.\/HeroArtworkPanel["']/);
  });

  test("no direct upload/media-library API calls in this file (HeroArtworkPanel owns that)", () => {
    expect(src).not.toMatch(/uploadHeroArtwork|listHeroArtworkLibrary|deleteHeroArtworkAsset/);
  });
});

describe("DailyDiscoveryPreview.jsx — real rendering, not a mock", () => {
  let src;
  beforeAll(() => { src = readSrc("studio/dashboardExperiences/DailyDiscoveryPreview.jsx"); });

  test("renders the ACTUAL student-facing DiscoveryCard component", () => {
    expect(src).toMatch(/import DiscoveryCard from ["']\.\.\/\.\.\/eduhub\/components\/dashboard\/DiscoveryCard["']/);
    expect(src).toMatch(/<DiscoveryCard previewConfig=\{config\}/);
  });
});

describe("DiscoveryCard.jsx — accepts a Studio preview override without changing production behavior", () => {
  let src;
  beforeAll(() => { src = readSrc("eduhub/components/dashboard/DiscoveryCard.jsx"); });

  test("previewConfig is optional and defaults to the normal self-fetching hook", () => {
    expect(src).toMatch(/function DiscoveryCard\(\{ previewConfig \}/);
    expect(src).toMatch(/useExperienceConfig\("daily_discovery"\)/);
  });

  test("Dashboard.jsx never passes previewConfig — production path is unchanged", () => {
    const dashboard = readSrc("eduhub/pages/Dashboard.jsx");
    expect(dashboard).toMatch(/<DiscoveryCard \/>/);
    expect(dashboard).not.toMatch(/previewConfig/);
  });
});
