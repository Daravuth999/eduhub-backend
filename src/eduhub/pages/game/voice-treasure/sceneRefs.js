/**
 * sceneRefs.js — pure scene-reference resolution (no asset imports), so the
 * mapping rules are unit-testable without loading raster bytes.
 *
 * IMPORTANT: This module ONLY resolves BUNDLED scene refs. Generated mission
 * images (image_kind === "generated") are NEVER mapped here — they are
 * delivered via the authenticated backend content endpoint and rendered by
 * URL, not by bundled asset key. Returning a bundled DEFAULT for an unknown
 * generated reference would cause the student to see one image while Gemini
 * evaluated another, so the renderer treats an unknown ref as a hard miss.
 */
export const SCENE_IMAGE_REFS = [
  "vt-scene-balloon", "vt-scene-picnic", "vt-scene-sciencefair", "vt-scene-market",
  "vt-scene-beach-cleanup", "vt-scene-library", "vt-scene-zoo", "vt-scene-birthday",
];

export const SCENE_IDS = [
  "balloon", "picnic", "sciencefair", "market",
  "beach_cleanup", "library", "zoo", "birthday",
];

// scene_id → image_ref (canonical)
export const ID_TO_REF = {
  balloon: "vt-scene-balloon",
  picnic: "vt-scene-picnic",
  sciencefair: "vt-scene-sciencefair",
  market: "vt-scene-market",
  beach_cleanup: "vt-scene-beach-cleanup",
  library: "vt-scene-library",
  zoo: "vt-scene-zoo",
  birthday: "vt-scene-birthday",
};

// Retained for callers that want a documented fallback for a TRULY UNKNOWN
// bundled mission (never used as a fallback for a generated mission, see
// resolveRef() below).
export const DEFAULT_REF = "vt-scene-balloon";

/**
 * Resolve to a canonical BUNDLED image_ref. Returns null for unknown inputs.
 * The caller decides what to do with null (a generated mission must NOT
 * silently fall back to a bundled scene — that would create an
 * image-mismatch between student view and Gemini evaluation).
 */
export function resolveRef({ imageRef, sceneId } = {}) {
  if (imageRef && SCENE_IMAGE_REFS.includes(imageRef)) return imageRef;
  if (sceneId && ID_TO_REF[sceneId]) return ID_TO_REF[sceneId];
  return null;
}

export function isKnownScene({ imageRef, sceneId } = {}) {
  return Boolean(
    (imageRef && SCENE_IMAGE_REFS.includes(imageRef)) ||
    (sceneId && ID_TO_REF[sceneId]),
  );
}
