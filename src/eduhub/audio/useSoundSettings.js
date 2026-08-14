/**
 * useSoundSettings.js — reactive hook for the ONE settings control this
 * milestone adds (Profile & Settings > Preferences > Sound Effects).
 *
 * Regular call sites that just want to PLAY a sound should import
 * `playUiSound` from uiSoundEngine.js directly — no hook, no re-render
 * needed. This hook exists only for the settings UI itself.
 */
import { useCallback, useState } from "react";
import { getSoundMode, setSoundMode } from "./soundSettings";

export function useSoundSettings() {
  const [mode, setModeState] = useState(() => getSoundMode());

  const setMode = useCallback((next) => {
    setModeState(setSoundMode(next));
  }, []);

  return { mode, setMode };
}

export default useSoundSettings;
