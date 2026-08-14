import { useEffect, useState } from "react";
import { onNetworkEvent } from "../lib/api";

/**
 * Tracks recent api fetch failures.
 * Returns `online` = true once a fetch succeeds again. Two consecutive
 * failures within 8s flips `online` to false → connection banner shows.
 */
export function useConnectionStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let recentFails = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    const stop = onNetworkEvent((event) => {
      if (event === "ok") {
        recentFails = 0;
        setOnline(true);
      } else {
        recentFails += 1;
        if (recentFails >= 2) setOnline(false);
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          recentFails = 0;
        }, 8000);
      }
    });

    return () => {
      stop();
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, []);

  return { online };
}
