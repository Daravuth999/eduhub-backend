/**
 * useWinnerShowcaseRotation.js — Automatic Winner Showcase (architecture
 * continuation: "no manual dashboard editing" — after an Event settles,
 * the backend auto-publishes an experienceType="winner_showcase" config
 * per event; the PWA auto-displays it until its own activeWindow.endsAt
 * expiration, then auto-rotates to the next one).
 *
 * Unlike useExperienceConfig (which resolves to a single "best" config),
 * a winner_showcase has one instance PER settled event and several can be
 * simultaneously active — this hook fetches the whole active list and
 * rotates through it client-side. Zero legacy source; there is no
 * pre-Event-Engine equivalent to fall back to.
 */
import { useEffect, useState } from "react";
import {
  fetchActiveExperienceConfigList, getCachedActiveExperienceConfigList,
} from "../lib/experienceConfig/experienceConfigApi";

const EXPERIENCE_TYPE = "winner_showcase";
const ROTATION_INTERVAL_MS = 8000;
const POLL_INTERVAL_MS = 60000;

export function useWinnerShowcaseRotation() {
  const [configs, setConfigs] = useState(() => getCachedActiveExperienceConfigList(EXPERIENCE_TYPE));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchActiveExperienceConfigList(EXPERIENCE_TYPE).then((list) => {
        if (!cancelled) setConfigs(list);
      });
    };
    load();
    // Re-poll periodically so a NEW settlement's showcase (or an
    // expiration the backend's own activeWindow already enforces) shows
    // up without requiring a page reload.
    const pollId = setInterval(load, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(pollId); };
  }, []);

  useEffect(() => {
    if (configs.length < 2) {
      setIndex(0);
      return;
    }
    const rotateId = setInterval(() => {
      setIndex((i) => (i + 1) % configs.length);
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(rotateId);
  }, [configs.length]);

  const safeIndex = configs.length ? index % configs.length : 0;
  return {
    current: configs[safeIndex] || null,
    count: configs.length,
    index: safeIndex,
    setIndex,
  };
}

export default useWinnerShowcaseRotation;
