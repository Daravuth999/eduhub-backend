import { useEffect, useMemo, useRef, useState } from "react";
import { fetchRosterPoints } from "../lib/roster";

const POLL_MS = 12_000;
const RETRY_DELAYS = [2_000, 4_000, 8_000]; // exponential backoff on failure

/**
 * Polls the public Google Sheet every 12s and returns sorted earners split
 * into a primary "top" group (first N, default 5) and a "rest" group
 * (everyone else, ranked but outside the spotlight).
 *
 * Inactive students (filtered in roster.js via SKIP_NAMES) are already
 * excluded before they reach this hook.
 *
 * Shape:
 *   { loading, error, lastUpdated, connectionOk, top, rest, all, totalCount }
 */
export function useTopEarners(limit = 5) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    lastUpdated: null,
    connectionOk: true,
    all: [],
  });
  const aliveRef = useRef(true);
  const retryTimerRef = useRef(null);
  const retryStepRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;

    const tick = async () => {
      try {
        const rows = await fetchRosterPoints();
        if (!aliveRef.current) return;
        retryStepRef.current = 0; // reset backoff on success
        setState({
          loading: false,
          error: null,
          lastUpdated: Date.now(),
          connectionOk: true,
          all: rows,
        });
      } catch (e) {
        if (!aliveRef.current) return;
        setState((s) => ({
          ...s,
          loading: false,
          connectionOk: false,
          error: e?.message || "fetch failed",
        }));
        // schedule a faster retry while we're still in failure mode
        const step = Math.min(retryStepRef.current, RETRY_DELAYS.length - 1);
        const delay = RETRY_DELAYS[step];
        retryStepRef.current = step + 1;
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(tick, delay);
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      aliveRef.current = false;
      clearInterval(id);
      clearTimeout(retryTimerRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Sort + rank once per state change.
  const { top, rest, sorted } = useMemo(() => {
    const s = [...state.all].sort((a, b) => b.points - a.points);
    const ranked = s.map((r, i) => ({ ...r, rank: i + 1 }));
    return {
      sorted: ranked,
      top: ranked.slice(0, limit),
      rest: ranked.slice(limit),
    };
  }, [state.all, limit]);

  return {
    ...state,
    top,
    rest,
    all: sorted,
    totalCount: state.all.length,
  };
}
