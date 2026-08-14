/**
 * useCoachPack.js — single hook for SLP + briefing + progress state.
 * Failure-safe: every fetch returns `{ success: false, ... }` on error, which
 * the hook converts to a degraded-but-renderable state.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getSLP, getCoachBriefing, getProgress, getContinueCard, touchActiveDay,
} from "../../../../lib/coachPackApi";

const _empty = {
  slp: null,
  briefing: "",
  envelope: null,
  progress: null,
  continueCard: null,
  loading: true,
  error: null,
};

export default function useCoachPack({ bookSlug, chapterIdx = -1, student }) {
  const [state, setState] = useState(_empty);
  const refresh = useCallback(async () => {
    if (!student?.studentId || !bookSlug) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [slpRes, briefingRes, progressRes, continueRes] = await Promise.all([
        getSLP(),
        getCoachBriefing({ bookSlug, chapterIdx }),
        getProgress(bookSlug),
        getContinueCard(),
      ]);
      // Fire-and-forget streak ping.
      touchActiveDay().catch(() => {});
      setState({
        slp: slpRes?.slp || null,
        briefing: briefingRes?.briefing || "",
        envelope: briefingRes?.envelope || null,
        progress: progressRes || null,
        continueCard: continueRes || null,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState({ ..._empty, loading: false, error: err?.message || "unknown" });
    }
  }, [bookSlug, chapterIdx, student?.studentId]);

  useEffect(() => { refresh(); }, [refresh]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
