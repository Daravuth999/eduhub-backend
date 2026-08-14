/**
 * sceneAssets.js — maps a backend image_ref / scene_id to a bundled raster
 * asset (WebP). The backend assigns the scene; the client renders the
 * matching bundled image (imported so CRA fingerprints + service-worker-
 * caches it). No external URLs.
 *
 * Pipeline contract:
 *   • image_kind === "bundled"  → resolve via resolveBundledImage()
 *   • image_kind === "generated" → use the authenticated backend image_url;
 *                                  this module returns null for the asset
 *                                  so the renderer never silently
 *                                  substitutes a bundled image for a
 *                                  generated mission.
 */
import { resolveRef, isKnownScene } from "./sceneRefs";
import balloon from "./assets/scenes/scene_balloon.webp";
import picnic from "./assets/scenes/scene_picnic.webp";
import sciencefair from "./assets/scenes/scene_sciencefair.webp";
import market from "./assets/scenes/scene_market.webp";
import beachCleanup from "./assets/scenes/scene_beach_cleanup.webp";
import library from "./assets/scenes/scene_library.webp";
import zoo from "./assets/scenes/scene_zoo.webp";
import birthday from "./assets/scenes/scene_birthday.webp";

const ASSET_BY_REF = {
  "vt-scene-balloon": balloon,
  "vt-scene-picnic": picnic,
  "vt-scene-sciencefair": sciencefair,
  "vt-scene-market": market,
  "vt-scene-beach-cleanup": beachCleanup,
  "vt-scene-library": library,
  "vt-scene-zoo": zoo,
  "vt-scene-birthday": birthday,
};

/**
 * Resolve the bundled WebP for a BUNDLED mission. Returns null for an
 * unknown bundled ref OR for a generated mission (where the renderer must
 * use the backend image_url instead).
 */
export function resolveBundledImage({ imageRef, sceneId } = {}) {
  const ref = resolveRef({ imageRef, sceneId });
  return ref ? ASSET_BY_REF[ref] || null : null;
}

/**
 * Legacy export retained for tests that proved the candidate's pre-fix
 * behaviour. It now ONLY resolves bundled refs; generated/unknown refs
 * return null instead of silently substituting the balloon scene.
 */
export function resolveSceneImage({ imageRef, sceneId } = {}) {
  return resolveBundledImage({ imageRef, sceneId });
}

export function hasBundledScene({ imageRef, sceneId } = {}) {
  return isKnownScene({ imageRef, sceneId });
}

export default { resolveSceneImage, resolveBundledImage, hasBundledScene };
