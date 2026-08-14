/**
 * TopUpLottie.jsx — Premium payment Lottie player with bulletproof fallback
 * =========================================================================
 *
 * Renders /lotties/topup-payment.json via the lottie-react package that is
 * already shipped with the app (no new dependency added).
 *
 * Safety guarantees:
 *   • Lazy-fetches the JSON at runtime so the modal never blocks on it.
 *   • If the JSON 404s, errors, or lottie-react throws, falls back to a
 *     pure-CSS gold coin glow — the modal stays usable.
 *   • Respects prefers-reduced-motion (renders the static fallback).
 *   • Pure additive: no global side-effects, no portals, no listeners
 *     left behind on unmount.
 *
 * Used by: PointsPurchaseModal.jsx (Top-Up modal animation area).
 */

import { useEffect, useRef, useState } from "react";
import Lottie from "lottie-react";
import { Coins } from "lucide-react";

const LOTTIE_PATH = "/lotties/topup-payment.json";

function FallbackCoin({ size = 120 }) {
  return (
    <div
      data-testid="topup-lottie-fallback"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 35% 30%, rgba(255,225,154,0.95), rgba(212,168,67,0.7) 55%, rgba(156,122,44,0.25) 100%)",
        boxShadow:
          "0 0 0 1px rgba(212,168,67,0.45), 0 0 40px rgba(212,168,67,0.35), inset 0 -10px 24px rgba(0,0,0,0.25)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "topup-coin-pulse 2.4s ease-in-out infinite",
      }}
    >
      <Coins size={Math.round(size * 0.42)} color="#1a1420" strokeWidth={2.4} />
      <style>{`
        @keyframes topup-coin-pulse {
          0%, 100% { transform: scale(0.97); filter: brightness(1); }
          50%      { transform: scale(1.04); filter: brightness(1.12); }
        }
      `}</style>
    </div>
  );
}

export default function TopUpLottie({ size = 120 }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const reducedRef = useRef(false);

  useEffect(() => {
    try {
      reducedRef.current =
        typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reducedRef.current = false;
    }

    if (reducedRef.current) return; // skip fetch, show static fallback

    let alive = true;
    fetch(LOTTIE_PATH, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("404"))))
      .then((j) => { if (alive) setData(j); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (reducedRef.current || failed) return <FallbackCoin size={size} />;
  if (!data) return <FallbackCoin size={size} />;

  // lottie-react may throw if the JSON is malformed; wrap defensively.
  try {
    return (
      <div
        data-testid="topup-lottie-player"
        style={{ width: size, height: size, lineHeight: 0 }}
      >
        <Lottie
          animationData={data}
          loop
          autoplay
          rendererSettings={{ preserveAspectRatio: "xMidYMid meet" }}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    );
  } catch {
    return <FallbackCoin size={size} />;
  }
}
