/**
 * useAssessmentBadge.js — real, server-backed "do I have something to do"
 * signal for the Assessment Lab, shared by Sidebar's nav badge and
 * Dashboard's pending-assessment card so both read the exact same state
 * instead of two independent guesses.
 *
 * Deliberately NOT wired through useUnifiedBadges.js — that hook reflects
 * unread PUSH/notification activity (notification_center.py categories);
 * "you have a worksheet to submit" is assignment state, not a message,
 * and has no corresponding category there. This hook reads the real
 * GET /api/student/assessments response (the same one AssessmentsListPage
 * renders) and counts only the honest case: a published assessment the
 * student has never submitted, or one whose only attempt failed to
 * process (both cases where "upload your answers" is the accurate call
 * to action). A submission still processing/needing review/scored/
 * reviewed/awarded is NOT pending — the student already acted.
 */
import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { listAssessments } from "./assessmentApi";

const PENDING_SUBMISSION_STATUSES = new Set([null, undefined, "failed"]);

export default function useAssessmentBadge() {
  const { isAuthenticated } = useAuth() || {};
  const [assessments, setAssessments] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setAssessments([]);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    listAssessments(controller.signal)
      .then((rows) => setAssessments(Array.isArray(rows) ? rows : []))
      .catch(() => setAssessments([])) // non-critical — never blocks Sidebar/Dashboard
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [isAuthenticated]);

  const pending = assessments.filter(
    (a) => PENDING_SUBMISSION_STATUSES.has(a?.mySubmission ? a.mySubmission.status : null),
  );

  return {
    loading,
    pendingCount: pending.length,
    pendingAssessment: pending[0] || null,
  };
}
