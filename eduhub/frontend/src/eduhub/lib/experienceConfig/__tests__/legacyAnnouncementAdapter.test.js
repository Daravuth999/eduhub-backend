/**
 * legacyAnnouncementAdapter.test.js — the "announcement" experience type's
 * tier-2 (legacy GAS) source. Mirrors legacyWelcomeAdapter.test.js's
 * discipline: proves the mapping, the null-safety, and that appearance/
 * motion/playback are never invented for a legacy-sourced config.
 */
import { adaptLegacyAnnouncementConfig } from "../legacyAnnouncementAdapter";

describe("adaptLegacyAnnouncementConfig", () => {
  it("maps announcementMessages into the structured content domain", () => {
    const config = adaptLegacyAnnouncementConfig({
      announcementMessages: ["Class starts at 5pm", "New books added"],
    });
    expect(config.experienceType).toBe("announcement");
    expect(config.content.announcementMessages).toEqual([
      "Class starts at 5pm", "New books added",
    ]);
  });

  it("filters out falsy/empty messages", () => {
    const config = adaptLegacyAnnouncementConfig({
      announcementMessages: ["Real message", "", null, undefined],
    });
    expect(config.content.announcementMessages).toEqual(["Real message"]);
  });

  it("returns null when there is no usable legacy data at all", () => {
    expect(adaptLegacyAnnouncementConfig(null)).toBeNull();
    expect(adaptLegacyAnnouncementConfig({})).toBeNull();
    expect(adaptLegacyAnnouncementConfig({ announcementMessages: [] })).toBeNull();
    expect(adaptLegacyAnnouncementConfig({ announcementMessages: [null, ""] })).toBeNull();
  });

  it("never mutates the input object", () => {
    const input = { announcementMessages: ["A", "B"] };
    const frozen = Object.freeze({ ...input, announcementMessages: Object.freeze([...input.announcementMessages]) });
    expect(() => adaptLegacyAnnouncementConfig(frozen)).not.toThrow();
  });

  it("carries appearance/motion/playback from the default, never invents visual settings", () => {
    const config = adaptLegacyAnnouncementConfig({ announcementMessages: ["A"] });
    expect(config.appearance.paletteId).toBe("morningEmerald");
    expect(config.motion.presetId).toBe("instant");
  });
});
