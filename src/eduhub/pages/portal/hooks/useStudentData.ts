import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { StudentData } from "../types";
import { POLL_RESTRICTION_MS } from "../config/sections";

interface State {
  data: StudentData;
  loading: boolean;
  refetch: () => Promise<void>;
}

/**
 * Returns the current student record and silently re-polls it every
 * POLL_RESTRICTION_MS. If a Restriction value appears (or changes) during
 * polling, `onRestriction` fires immediately — the parent will force-logout.
 *
 * Returns the LATEST data on every poll so the dashboard stays fresh.
 */
export function useStudentData(
  initial: StudentData,
  onRestriction: (msg: string) => void,
): State {
  const [data, setData] = useState<StudentData>(initial);
  const [loading, setLoading] = useState(false);
  const lastRestrictionRef = useRef<string>(
    (initial.Restriction || initial.restriction || "").trim(),
  );
  const stoppedRef = useRef(false);

  async function refetch() {
    setLoading(true);
    try {
      const fresh = await api.studentData(initial.StudentID);
      if (stoppedRef.current) return;
      if (fresh && !fresh.error) {
        setData((prev) => ({ ...prev, ...fresh }));
        const r = (fresh.Restriction || fresh.restriction || "").trim();
        if (r && r !== lastRestrictionRef.current) {
          lastRestrictionRef.current = r;
          onRestriction(r);
        }
      }
    } catch {
      /* ignore — connection banner already handles UI */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    stoppedRef.current = false;
    const id = setInterval(refetch, POLL_RESTRICTION_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stoppedRef.current = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.StudentID]);

  return { data, loading, refetch };
}
