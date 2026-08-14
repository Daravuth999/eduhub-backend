/**
 * voiceTreasureScenes.test.jsx — pure scene-ref resolution + balance-contract
 * presentation rules. Runnable under craco test; the pure pieces also run in
 * the offline harness (no raster imports here).
 */
import {
  resolveRef, isKnownScene, SCENE_IMAGE_REFS, SCENE_IDS, ID_TO_REF, DEFAULT_REF,
} from "../sceneRefs";

describe("scene reference resolution", () => {
  test("8 bundled refs and ids", () => {
    expect(SCENE_IMAGE_REFS).toHaveLength(8);
    expect(SCENE_IDS).toHaveLength(8);
  });
  test("resolves by image_ref", () => {
    expect(resolveRef({ imageRef: "vt-scene-zoo" })).toBe("vt-scene-zoo");
  });
  test("resolves by scene_id", () => {
    expect(resolveRef({ sceneId: "beach_cleanup" })).toBe("vt-scene-beach-cleanup");
  });
  test("unknown bundled ref now returns null (no silent balloon fallback)", () => {
    expect(resolveRef({ imageRef: "nope" })).toBeNull();
    expect(resolveRef({})).toBeNull();
    // Documented constant still exported for callers that explicitly want it.
    expect(DEFAULT_REF).toBe("vt-scene-balloon");
  });
  test("isKnownScene true/false", () => {
    expect(isKnownScene({ sceneId: "zoo" })).toBe(true);
    expect(isKnownScene({ imageRef: "x" })).toBe(false);
  });
  test("every scene_id maps to a real ref", () => {
    SCENE_IDS.forEach((id) => expect(SCENE_IMAGE_REFS).toContain(ID_TO_REF[id]));
  });
});
