import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { PerformanceHistoryItem } from "../types";

export function useHistory(studentId: string, enrolledAt?: string) {
  const [data, setData] = useState<PerformanceHistoryItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .history(studentId, enrolledAt)
      .then((h) => {
        if (cancelled) return;
        setData(Array.isArray(h) ? h : []);
      })
      .catch(() => !cancelled && setData([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [studentId, enrolledAt]);

  return { data, loading };
}
