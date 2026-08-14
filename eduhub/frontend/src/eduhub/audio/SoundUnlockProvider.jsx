/**
 * SoundUnlockProvider.jsx — headless bridge component (same pattern as
 * PointsCreditPushBridge/RealtimeSyncBridge etc. mounted in App.js):
 * renders nothing, exists purely to wire the Premium UI Sound System's
 * one-time iOS/mobile audio unlock.
 *
 * The unlock call MUST happen synchronously inside the very first real
 * user gesture, before any `await` in that same handler — this is the
 * exact rule already proven on-device in this codebase (see the comment
 * at EduTalkLiveCoach.jsx's "Start" button handler, which this mirrors).
 * A `pointerdown` capture-phase listener on `document`, `{once: true}`,
 * is the least invasive way to guarantee that regardless of which
 * element the user's first tap actually lands on.
 */
import { useEffect } from "react";
import { unlockAudio } from "./uiSoundEngine";
import { initSoundModeFromStorage } from "./soundSettings";

export default function SoundUnlockProvider() {
  useEffect(() => {
    initSoundModeFromStorage();

    const unlock = () => {
      unlockAudio(); // synchronous — no await before this line, by design
    };
    document.addEventListener("pointerdown", unlock, { capture: true, once: true, passive: true });
    document.addEventListener("touchend", unlock, { capture: true, once: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("touchend", unlock, { capture: true });
    };
  }, []);

  return null;
}
