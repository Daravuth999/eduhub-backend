/**
 * usePlaybackMode.js — decides which entrance-sequence TIER
 * ("full" | "short" | "static") an experience should play, from its
 * resolved `playback` domain + real browser/session state.
 *
 * Deliberately separate from useExperienceConfig: this is presentation
 * TIMING logic (which of the already-resolved motion options to run),
 * not configuration RESOLUTION (where the config came from). Any
 * experience with a `playback` domain can reuse this unchanged.
 *
 * Computed ONCE per experienceType via a lazy useState initializer —
 * never re-evaluated reactively — so an in-place data refresh (e.g. a
 * poll updating unrelated content) never replays a sequence that already
 * played this mount.
 */
import { useState } from "react";
import { useReducedMotion } from "framer-motion";

function storageKeys(experienceType) {
  return {
    lastFull: `eduhub_experience_${experienceType}_last_full_play_v1`,
    session: `eduhub_experience_${experienceType}_session_played_v1`,
  };
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function computeTier(experienceType, playback) {
  if (typeof window === "undefined") return "static";
  const replayHours = Number(playback?.replayIntervalHours ?? 6);
  const { lastFull, session } = storageKeys(experienceType);
  try {
    const playedThisSession = sessionStorage.getItem(session);
    const lastFullRaw = localStorage.getItem(lastFull);
    const now = new Date();
    const last = lastFullRaw ? new Date(lastFullRaw) : null;
    const dueForFull = playback?.firstLaunchOfDay !== false && (
      !last
      || !isSameCalendarDay(last, now)
      || (now.getTime() - last.getTime()) > replayHours * 60 * 60 * 1000
    );

    if (!playedThisSession && dueForFull) {
      localStorage.setItem(lastFull, now.toISOString());
      sessionStorage.setItem(session, "1");
      return "full";
    }
    if (playback?.firstLaunchPerSession === false) {
      // This experience opted out of even the short per-session replay.
      sessionStorage.setItem(session, "1");
      return "static";
    }
    sessionStorage.setItem(session, "1");
    return "short";
  } catch {
    return "short";
  }
}

export function usePlaybackMode(experienceType, playback) {
  const prefersReducedMotion = useReducedMotion();
  const [tier] = useState(() => {
    // OS-level prefers-reduced-motion always wins, regardless of config —
    // this is a non-negotiable accessibility floor, not an admin choice.
    if (prefersReducedMotion) return "static";
    return computeTier(experienceType, playback);
  });
  return tier;
}

export default usePlaybackMode;
