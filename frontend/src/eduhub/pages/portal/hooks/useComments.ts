import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { CommentItem } from "../types";

export function useComments(studentId: string) {
  const [data, setData] = useState<CommentItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .comments(studentId)
      .then((c) => {
        if (cancelled) return;
        setData(Array.isArray(c) ? c : []);
      })
      .catch(() => !cancelled && setData([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  return { data, loading };
}
