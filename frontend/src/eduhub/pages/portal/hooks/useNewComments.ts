import { useEffect, useState } from "react";
import type { CommentItem } from "../types";

const KEY_PREFIX = "myportal-comments-seen-";

/**
 * Returns whether the comments list has unseen items based on the most-recent
 * comment date and a localStorage record for this student.
 *
 * Call `markSeen()` when the user has clearly viewed the comments
 * (e.g., comments section scrolled into view).
 */
export function useNewComments(
  studentId: string,
  comments: CommentItem[] | null,
) {
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    if (!comments || comments.length === 0) {
      setHasNew(false);
      return;
    }
    const latest = comments
      .map((c) => (c.date ? new Date(c.date).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    const seen = parseInt(
      localStorage.getItem(KEY_PREFIX + studentId) || "0",
      10,
    );
    setHasNew(latest > seen);
  }, [studentId, comments]);

  function markSeen() {
    if (!comments || comments.length === 0) return;
    const latest = comments
      .map((c) => (c.date ? new Date(c.date).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    localStorage.setItem(KEY_PREFIX + studentId, String(latest));
    setHasNew(false);
  }

  return { hasNew, markSeen };
}
