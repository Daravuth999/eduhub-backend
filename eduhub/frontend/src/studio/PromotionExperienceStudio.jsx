/**
 * PromotionExperienceStudio.jsx — Campaign Design Studio 2.0 entry point.
 *
 * The form-based Promotion Experience Studio (Phase 1-5) has been
 * reconstructed as the canvas-first Campaign Design Studio 2.0. This file
 * keeps the SAME export and StudioPage tab ("promotionexp") so navigation,
 * auth and the experience-configs data contract are unchanged — one
 * authoring experience, same route.
 *
 * Backward compatibility:
 *   • Legacy configs (no content.canvas) still list and open — the editor
 *     converts them to canvas non-destructively (nothing is stored until
 *     the author explicitly saves).
 *   • Published legacy configs keep rendering byte-identically on the
 *     Dashboard (PromotionPanel's legacy path is untouched).
 */
import CampaignDesignStudio from "./campaignStudio/CampaignDesignStudio";

export default function PromotionExperienceStudio() {
  return <CampaignDesignStudio />;
}
