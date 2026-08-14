/**
 * useAttendance.js — student-side Smart Attendance hook.
 *
 * Mirrors the structure of useTopEarners.js / usePushNotifications.js:
 * lazy fetch on mount, polling for the live-session state, and resilient
 * error handling that never throws into the render tree. Fully fail-safe so a
 * dropped connection never breaks the dashboard or blocks class access.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import attendanceApi from "../pages/attendance/api";

const LIVE_POLL_MS = 30_000;

export function useAttendance({ enabled = true, pollLive = true } = {}) {
  const [me, setMe] = useState(null);
  const [live, setLive] = useState({ live: false });
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await attendanceApi.getMe();
      if (aliveRef.current) {
        setMe(data);
        setError(null);
      }
    } catch (e) {
      if (aliveRef.current) setError(e?.message || "failed");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [enabled]);

  const refreshLive = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await attendanceApi.getLive();
      if (aliveRef.current) setLive(data || { live: false });
    } catch {
      /* never block the UI on a live-state poll failure */
    }
  }, [enabled]);

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    refresh();
    refreshLive();
    let id;
    if (pollLive) {
      id = setInterval(refreshLive, LIVE_POLL_MS);
    }
    return () => {
      aliveRef.current = false;
      if (id) clearInterval(id);
    };
  }, [enabled, pollLive, refresh, refreshLive]);

  const checkin = useCallback(
    (slug, asStudentId) =>
      attendanceApi.checkinWithRetry({ slug, asStudentId }),
    [],
  );

  const confirmMid = useCallback(
    (sessionId) => attendanceApi.midSessionConfirm(sessionId),
    [],
  );

  const reportMiss = useCallback(
    (sessionId, reason) => attendanceApi.missReason(sessionId, reason),
    [],
  );

  const getRewardSummary = useCallback(() => attendanceApi.getRewardSummary(), []);
  const claimReward = useCallback(() => attendanceApi.claimReward(), []);

  return {
    me,
    live,
    loading,
    error,
    refresh,
    refreshLive,
    checkin,
    confirmMid,
    reportMiss,
    getRewardSummary,
    claimReward,
    currentStreak: me ? me.current_streak : 0,
    tier: me ? me.reliability_tier : "bronze",
  };
}

export default useAttendance;
