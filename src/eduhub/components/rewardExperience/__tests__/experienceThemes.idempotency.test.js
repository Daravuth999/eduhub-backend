/**
 * experienceThemes.idempotency.test.js — regression guard for a real bug
 * found and fixed during an audit of the reward card's rendering: the
 * "-1 = unset, use preset default" sentinel used by glass_config.frost/
 * opacity/radius did not survive being normalized more than once.
 *
 * normalizeExperience() is called at multiple nested levels in the real
 * render chain (parent form state -> RewardExperiencePreview's own
 * useMemo -> RewardExperienceShell's own useMemo), so it MUST be
 * idempotent — re-normalizing an already-normalized object must be a
 * no-op. Verified live in a browser before this fix: the second pass
 * collapsed glass_config.opacity from -1 to 0.2 and glass_config.radius
 * from -1 to 0, which made themeVars() emit
 * --rxp-glass-opacity: 0.2 (applied as `opacity` on the WHOLE card,
 * fading every child including title/points/button text) and
 * --rxp-glass-radius: 0px (square corners instead of the intended 28px
 * rounded glass card) — the actual cause of the reported "washed out,
 * detached, low-contrast" reward panel.
 */
import { normalizeExperience, normalizeGlassConfig, themeVars } from "../experienceThemes";

describe("normalizeGlassConfig / normalizeExperience idempotency", () => {
  test("re-normalizing an already-normalized glass_config leaves the -1 (auto) sentinel untouched", () => {
    const once = normalizeGlassConfig(undefined);
    expect(once.frost).toBe(-1);
    expect(once.opacity).toBe(-1);
    expect(once.radius).toBe(-1);

    const twice = normalizeGlassConfig(once);
    expect(twice).toEqual(once);

    const thrice = normalizeGlassConfig(twice);
    expect(thrice).toEqual(once);
  });

  test("a real in-range value survives repeated normalization unchanged", () => {
    const once = normalizeGlassConfig({ frost: 12, opacity: 0.6, radius: 20 });
    const twice = normalizeGlassConfig(once);
    const thrice = normalizeGlassConfig(twice);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });

  test("normalizeExperience called three times in a row (matching the real render chain: parent state -> RewardExperiencePreview's memo -> RewardExperienceShell's memo) never degrades an unset glass config", () => {
    const pass1 = normalizeExperience({ environment: "morning_angkor" });
    const pass2 = normalizeExperience(pass1);
    const pass3 = normalizeExperience(pass2);
    expect(pass3.glass_config).toEqual(pass1.glass_config);
    expect(pass3.glass_config.frost).toBe(-1);
    expect(pass3.glass_config.opacity).toBe(-1);
    expect(pass3.glass_config.radius).toBe(-1);
  });

  test("themeVars() never emits a fractional card opacity or zero radius for an unconfigured (default) experience, no matter how many times it was normalized first", () => {
    let exp = normalizeExperience({ environment: "morning_angkor" });
    exp = normalizeExperience(exp);
    exp = normalizeExperience(exp);
    const vars = themeVars(exp, "#D4A843");
    expect(vars["--rxp-glass-opacity"]).toBe("1");
    expect(vars["--rxp-glass-radius"]).toBe("28px");
  });

  test("themeVars() caps the reward card's own backdrop blur to a crisp glass range (<=6px) even when a preset or admin-set frost value is much higher", () => {
    const highFrost = normalizeExperience({
      environment: "morning_angkor",
      glass_config: { frost: 40 },
    });
    const vars = themeVars(highFrost, "#D4A843");
    expect(vars["--rxp-glass-blur"]).toBe("6px");
  });
});
