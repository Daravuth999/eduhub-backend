// useAchievements.js — shared, cached client for GET /api/achievements/me.
//
// One fetch feeds both the Dashboard preview (TrophyJourneyStrip inside the
// Learning Progress card) and any future consumer. Module-level cache means
// re-mounts render instantly from the last payload while a silent
// revalidation runs in the background. Best-effort: a failed read keeps the
// previous data (or null) — the Dashboard preview simply doesn't render,
// exactly like every other real-data-only widget on that page.
//
// Audit fix: the cache is keyed to `enabled` (== isAuthenticated), not just
// populated-and-forgotten. logoutStudent() in AuthContext.jsx is a pure
// client-side state transition (no page reload — confirmed by reading its
// implementation), so without this the module-level cache would otherwise
// survive a logout and leak the PREVIOUS student's trophy/reward data onto
// whichever student authenticates next on the same tab/session.
import { useCallback, useEffect, useRef, useState } from "react";
import { getAchievements } from "../lib/achievementApi";

let _cache = null;

export default function useAchievements(enabled = true) {
  const [data, setData] = useState(enabled ? _cache : null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const d = await getAchievements();
      _cache = d;
      if (aliveRef.current) setData(d);
    } catch {
      /* silent — preview is best-effort, Achievement Center has its own error UI */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (enabled) {
      refresh();
    } else {
      // Logged out (or not yet authenticated) — never let a previous
      // student's cached achievement data leak into whichever account is
      // authenticated next on this same tab.
      _cache = null;
      setData(null);
    }
    return () => { aliveRef.current = false; };
  }, [enabled, refresh]);

  return { data, refresh };
}
