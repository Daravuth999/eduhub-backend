/**
 * homeTile.js — pure helper deciding whether the Voice Treasure Home tile
 * should show. Kept separate so the rule is unit-testable without the DOM.
 * The original five EduHub tiles are never affected by this.
 */
export const ORIGINAL_TILE_KEYS = ["library", "portal", "spin", "assistant", "systemtest"];

export function shouldShowVoiceTreasureTile(cfgPublic, isAuthenticated) {
  if (!isAuthenticated) return false;
  if (!cfgPublic) return false;
  return !!(cfgPublic.available && cfgPublic.show_home_tile);
}
