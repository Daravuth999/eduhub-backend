/**
 * legacyWelcomeAdapter.test.js — the ONLY place in the platform that knows
 * Google Sheets field names exist. Proves it maps them correctly into the
 * generic `content` shape and never writes anywhere, and that it's
 * correctly null-safe (missing/absent Sheets data is a normal, expected
 * migration-period state, not an error).
 */
import { adaptLegacyWelcomeSheetsConfig } from "../legacyWelcomeAdapter";

describe("adaptLegacyWelcomeSheetsConfig", () => {
  it("maps every legacy Sheets field into the structured content domain", () => {
    const config = adaptLegacyWelcomeSheetsConfig({
      title: "Welcome to Our Classroom",
      khmerWelcome: "ស្វាគមន៍",
      subtitle: "Interactive Learning Portal",
      instructorName: "Daravuth.Y",
    });
    expect(config.experienceType).toBe("welcome_dashboard");
    expect(config.content.title).toBe("Welcome to Our Classroom");
    expect(config.content.khmerSubtitle).toBe("ស្វាគមន៍");
    expect(config.content.description).toBe("Interactive Learning Portal");
    expect(config.content.instructorLine).toBe("Daravuth.Y");
  });

  it("returns null when there is no usable Sheets data at all", () => {
    expect(adaptLegacyWelcomeSheetsConfig(null)).toBeNull();
    expect(adaptLegacyWelcomeSheetsConfig({})).toBeNull();
  });

  it("never mutates the input object", () => {
    const input = { title: "T", khmerWelcome: "K", subtitle: "S", instructorName: "I" };
    const frozen = Object.freeze({ ...input });
    expect(() => adaptLegacyWelcomeSheetsConfig(frozen)).not.toThrow();
  });

  it("carries appearance/motion/playback from the default, never invents visual settings", () => {
    // Explicit product decision: Sheets is content-only, never expanded
    // with new visual/motion fields during migration.
    const config = adaptLegacyWelcomeSheetsConfig({ title: "T" });
    expect(config.appearance.paletteId).toBe("morningEmerald");
    expect(config.motion.presetId).toBe("cinematicRise");
  });
});
