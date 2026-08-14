/**
 * chestAssets.js — original chest art for Voice Treasure. Replaces the
 * emoji chest visuals (🧰 / 🪙) with custom WebP renders so the chest is a
 * real game asset rather than a system emoji that varies across platforms.
 *
 * No copyrighted characters. Mobile-optimized WebP. Reduced motion is honored
 * via CSS in VoiceTreasure.css — JS never animates these assets.
 *
 * Mapping from public chest states to renderable assets:
 *   sealed                 → chest-sealed
 *   processing             → chest-processing
 *   reconciliation_required→ chest-sealed (sealed-with-pending-badge)
 *   confirmed_failed       → chest-failed
 *   eligible_unclaimed     → chest-glowing  (ready to open)
 *   completed              → chest-open + rays overlay
 *   ineligible             → chest-sealed (dim)
 */
import sealed from "./assets/chest/chest-sealed.webp";
import processing from "./assets/chest/chest-processing.webp";
import glowing from "./assets/chest/chest-glowing.webp";
import open from "./assets/chest/chest-open.webp";
import rays from "./assets/chest/chest-rays.webp";
import failed from "./assets/chest/chest-failed.webp";
import firstVoiceCard from "./assets/chest/first-voice-card.webp";

export const CHEST_ASSETS = {
  sealed, processing, glowing, open, rays, failed, firstVoiceCard,
};

export function chestAssetForState(state) {
  switch (state) {
    case "completed":
      return { primary: open, overlay: rays, alt: "Open treasure chest with golden rays" };
    case "processing":
      return { primary: processing, overlay: null, alt: "Treasure chest processing your reward" };
    case "reconciliation_required":
      return { primary: sealed, overlay: null, alt: "Sealed chest awaiting reconciliation" };
    case "confirmed_failed":
      return { primary: failed, overlay: null, alt: "Closed chest with a small failure indicator" };
    case "eligible_unclaimed":
      return { primary: glowing, overlay: null, alt: "Glowing sealed chest ready to claim" };
    case "ineligible":
    default:
      return { primary: sealed, overlay: null, alt: "Sealed treasure chest" };
  }
}

export { firstVoiceCard };
export default CHEST_ASSETS;
