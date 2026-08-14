import { useEffect, useState } from "react";
import type { PerformanceHistoryItem } from "../types";
import { TOP_PERFORMER_THRESHOLD, EXCELLENT_THRESHOLD } from "../config/sections";
import { celebrateTopPerformer } from "../lib/celebrate";

interface Result {
  /** True for ~6s after a Top-Performer crossing was just detected. */
  showToast: boolean;
  dismiss: () => void;
  /** Per-criterion improvements: { pronunciation: 1.2, ... } since previous entry. */
  improvedByCriterion: Record<string, number>;
  /** Number of consecutive most-recent entries with overall ≥ 8.0. */
  excellentStreak: number;
}

const KEY_PREFIX = "myportal-celebrated-";

export function useTopPerformerCelebration(
  studentId: string,
  history: PerformanceHistoryItem[] | null,
  currentOverall: number,
): Result {
  const [showToast, setShowToast] = useState(false);
  const [improvedByCriterion, setImprovedByCriterion] = useState<Record<string, number>>({});
  const [excellentStreak, setExcellentStreak] = useState(0);

  useEffect(() => {
    if (!history) return;

    /* ----- Per-criterion improvement vs the previous history entry ----- */
    const sorted = [...history].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    const imps: Record<string, number> = {};
    if (last && prev) {
      const keys: (keyof PerformanceHistoryItem)[] = [
        "pronunciation",
        "intonation",
        "communication",
        "participation",
        "risingFalling",
        "linkingSounds",
      ];
      for (const k of keys) {
        const delta = (last[k] as number) - (prev[k] as number);
        if (delta >= 1) imps[k as string] = delta;
      }
    }
    setImprovedByCriterion(imps);

    /* ----- Excellent streak (consecutive most-recent entries ≥ 8.0) ----- */
    let streak = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].overallScore >= EXCELLENT_THRESHOLD) streak += 1;
      else break;
    }
    setExcellentStreak(streak);

    /* ----- Top-Performer crossing detection ----- */
    const lastOverall = last?.overallScore ?? 0;
    const wasBelow =
      sorted.length < 2 || (prev && prev.overallScore < TOP_PERFORMER_THRESHOLD);
    const nowAbove =
      currentOverall >= TOP_PERFORMER_THRESHOLD ||
      lastOverall >= TOP_PERFORMER_THRESHOLD;

    if (wasBelow && nowAbove) {
      const key = KEY_PREFIX + studentId + "-" + (last?.date ?? "current");
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, "1");
        setShowToast(true);
        celebrateTopPerformer();
        setTimeout(() => setShowToast(false), 6000);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, currentOverall, studentId]);

  return {
    showToast,
    dismiss: () => setShowToast(false),
    improvedByCriterion,
    excellentStreak,
  };
}
