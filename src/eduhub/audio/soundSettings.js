/**
 * soundSettings.js — persisted user preference for the Premium UI Sound
 * System (Off / Soft / Normal). Follows this codebase's established
 * localStorage convention (plain string key, `eduhub_..._v1`, wrapped in
 * try/catch — matches AudioPlayerContext.jsx's SPEED_KEY/VOLUME_KEY).
 */
import { setEngineVolumeMode } from "./uiSoundEngine";

const STORAGE_KEY = "eduhub_sound_mode_v1";
const VALID_MODES = ["off", "soft", "normal"];
const DEFAULT_MODE = "soft";

export function getSoundMode() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return VALID_MODES.includes(raw) ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function setSoundMode(mode) {
  const safe = VALID_MODES.includes(mode) ? mode : DEFAULT_MODE;
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // Private mode / quota — the in-memory engine value below still applies
    // for the rest of this session, it just won't persist across reloads.
  }
  setEngineVolumeMode(safe);
  return safe;
}

/** Call once at app startup (SoundUnlockProvider) so the engine's cached
 * volume reflects the stored preference before the first sound ever plays. */
export function initSoundModeFromStorage() {
  setEngineVolumeMode(getSoundMode());
}

export { VALID_MODES, DEFAULT_MODE };
