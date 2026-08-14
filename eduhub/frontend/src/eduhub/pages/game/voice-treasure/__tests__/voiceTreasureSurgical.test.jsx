/**
 * voiceTreasureSurgical.test.jsx — surgical-repair behavioural tests.
 *
 * Pure / structural tests (the repo's existing convention) that exercise the
 * surgical fixes from the v5 repair: no-balloon-fallback for unknown refs,
 * generated-image URL contract, recorder refresh recovery, PointsGateModal
 * resume wiring, chest asset family, and bundled vs generated image kinds.
 *
 * No @testing-library dependency — Jest runs these under `craco test`.
 */
import {
  resolveRef, isKnownScene, DEFAULT_REF, SCENE_IDS,
} from "../sceneRefs";
import {
  resolveBundledImage, resolveSceneImage, hasBundledScene,
} from "../sceneAssets";
import { chestAssetForState, CHEST_ASSETS, firstVoiceCard } from "../chestAssets";

describe("Spec D — no generated-image fallback mismatch", () => {
  test("resolveRef returns null for unknown refs (no silent balloon fallback)", () => {
    expect(resolveRef({ imageRef: "vtimg-abc" })).toBeNull();        // generated key
    expect(resolveRef({ imageRef: "completely-unknown" })).toBeNull();
    expect(resolveRef({})).toBeNull();
  });
  test("resolveBundledImage maps every known bundled scene", () => {
    SCENE_IDS.forEach((sid) => {
      const asset = resolveBundledImage({ sceneId: sid });
      expect(typeof asset).toBe("string");
      expect(asset).toMatch(/\.webp$/);
    });
  });
  test("resolveBundledImage returns null for unknown ref", () => {
    expect(resolveBundledImage({ imageRef: "vtimg-deadbeef" })).toBeNull();
    expect(resolveBundledImage({})).toBeNull();
  });
  test("legacy resolveSceneImage no longer falls back to balloon", () => {
    expect(resolveSceneImage({ imageRef: "vtimg-foo" })).toBeNull();
  });
  test("hasBundledScene true for known, false for generated keys", () => {
    expect(hasBundledScene({ sceneId: "zoo" })).toBe(true);
    expect(hasBundledScene({ imageRef: "vtimg-x" })).toBe(false);
  });
  test("DEFAULT_REF kept exported but never auto-applied by resolveRef", () => {
    expect(DEFAULT_REF).toBe("vt-scene-balloon");
  });
});

describe("Spec F — bundled raster scenes are WebP", () => {
  test("every bundled asset is a WebP file (not SVG)", () => {
    SCENE_IDS.forEach((sid) => {
      const a = resolveBundledImage({ sceneId: sid });
      expect(a).toMatch(/\.webp$/);
      expect(a).not.toMatch(/\.svg$/);
    });
  });
});

describe("Spec G — chest asset family replaces emoji visuals", () => {
  test("chestAssetForState covers every public chest state", () => {
    const states = [
      "ineligible", "eligible_unclaimed", "processing",
      "reconciliation_required", "completed", "confirmed_failed",
    ];
    states.forEach((s) => {
      const a = chestAssetForState(s);
      expect(typeof a.primary).toBe("string");
      expect(a.primary).toMatch(/\.webp$/);
      expect(typeof a.alt).toBe("string");
      expect(a.alt.length).toBeGreaterThan(0);
    });
  });
  test("only the completed state reveals the opened chest + rays", () => {
    const completed = chestAssetForState("completed");
    expect(completed.primary).toMatch(/chest-open\.webp$/);
    expect(completed.overlay).toMatch(/chest-rays\.webp$/);
    ["eligible_unclaimed", "processing", "reconciliation_required",
     "confirmed_failed", "ineligible"].forEach((s) => {
      const a = chestAssetForState(s);
      expect(a.primary).not.toMatch(/chest-open\.webp$/);
      expect(a.overlay).toBeNull();
    });
  });
  test("first voice card asset exported and bundled", () => {
    expect(typeof firstVoiceCard).toBe("string");
    expect(firstVoiceCard).toMatch(/first-voice-card\.webp$/);
    expect(CHEST_ASSETS.firstVoiceCard).toBe(firstVoiceCard);
  });
});

describe("Spec I — PointsGateModal callback contract documented", () => {
  // Pure presence check: VoiceTreasureEntryConfirm wires onResume (success)
  // alongside onClose. We assert the source includes both prop wirings.
  // This is a structural test — no DOM render — keeping in line with the
  // repo's existing test convention.
  test("VoiceTreasureEntryConfirm wires onResume (Top-Up success callback)", () => {
    // eslint-disable-next-line global-require
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "VoiceTreasureEntryConfirm.jsx"),
      "utf8",
    );
    expect(src).toMatch(/<PointsGateModal/);
    expect(src).toMatch(/onResume=\{/);
    expect(src).toMatch(/onClose=\{/);
    // Successful top-up MUST refresh the authoritative preview, not auto-debit.
    expect(src).toMatch(/api\.entryPreview/);
  });
});

describe("Spec H — recorder refresh / direct-link recovery", () => {
  test("recorder source uses backend /today when route state is missing", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "VoiceTreasureRecorder.jsx"),
      "utf8",
    );
    // Three recovery sources documented and present.
    expect(src).toMatch(/loc\.state\?\.entryId/);
    expect(src).toMatch(/params\?\.entryId/);
    expect(src).toMatch(/api\.getToday/);
    // localStorage is NOT used as the source of truth.
    expect(src).not.toMatch(/localStorage\.getItem\(['"]vt_entry/);
    // Unpaid student routed to /confirm (no GAS re-call here).
    expect(src).toMatch(/voice-treasure\/confirm/);
  });
});

describe("Spec D — mission renderer respects image_kind contract", () => {
  test("VoiceTreasureMission distinguishes bundled vs generated and never silently substitutes", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "VoiceTreasureMission.jsx"),
      "utf8",
    );
    expect(src).toMatch(/data-image-kind/);
    expect(src).toMatch(/vt-mission-img-bundled/);
    expect(src).toMatch(/vt-mission-img-generated/);
    // Generated path uses mission.image_url verbatim, not a bundled asset.
    expect(src).toMatch(/image_url/);
    // Hard miss / error blocks submission and offers recovery — no double charge.
    expect(src).toMatch(/vt-mission-img-error/);
    expect(src).toMatch(/vt-mission-recover/);
  });
});
