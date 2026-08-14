/**
 * resolveExperienceConfig.test.js — the ONE resolution function every
 * experience type shares. Proves the fixed priority order the whole
 * migration's safety depends on: published > legacy > default.
 */
import { resolveExperienceConfig } from "../resolveExperienceConfig";

describe("resolveExperienceConfig", () => {
  it("prefers a published backend config over everything else", () => {
    const published = { experienceType: "welcome_dashboard", content: { title: "Live" } };
    const { config, source } = resolveExperienceConfig("welcome_dashboard", published, { title: "Sheets title" });
    expect(source).toBe("published");
    expect(config.content.title).toBe("Live");
  });

  it("falls through to the legacy Sheets adapter when no published config exists", () => {
    const { config, source } = resolveExperienceConfig("welcome_dashboard", null, { title: "Sheets title", khmerWelcome: "kh", subtitle: "sub", instructorName: "Ms. X" });
    expect(source).toBe("legacy");
    expect(config.content.title).toBe("Sheets title");
    expect(config.content.instructorLine).toBe("Ms. X");
  });

  it("falls through to hardcoded defaults when neither published nor legacy data exists", () => {
    const { config, source } = resolveExperienceConfig("welcome_dashboard", null, null);
    expect(source).toBe("default");
    expect(config.content.title).toBeTruthy();
  });

  it("a published config with no content is treated as absent, not as a valid win", () => {
    const { source } = resolveExperienceConfig("welcome_dashboard", { experienceType: "welcome_dashboard" }, null);
    expect(source).not.toBe("published");
  });

  it("an experienceType with no legacy adapter registered goes straight to defaults", () => {
    const { config, source } = resolveExperienceConfig("digital_books_hero", null, { title: "Irrelevant Sheets data" });
    expect(source).toBe("default");
    expect(config.experienceType).toBe("digital_books_hero");
  });

  it("never returns a null/undefined config, even for a totally unknown experienceType", () => {
    const { config } = resolveExperienceConfig("some_future_experience_nobody_registered", null, null);
    expect(config).toBeTruthy();
    expect(config.content).toBeTruthy();
  });
});
