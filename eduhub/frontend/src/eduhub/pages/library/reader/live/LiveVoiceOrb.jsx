/**
 * LiveVoiceOrb.jsx — v18.1 "Bloom Orb" (calc-free)
 * Presentational only. Same props: { state, level, remaining, connection }.
 * Preserves data-testid attributes ("live-orb-wrap", "live-orb",
 * "live-state-label", "live-timer", "live-connection") and CSS class roots.
 *
 * v18.1 change vs v18:
 *  All CSS multiplications removed. React computes browser-safe variables:
 *    --etlc-bloom            (raw 0..1, still exposed for debug)
 *    --etlc-bloom-opacity    (0.18..0.83)
 *    --etlc-bloom-translate  ("-30px"..."-58px")
 *    --etlc-bloom-scale      (0.78..1.33)
 *    --etlc-halo-alpha       (0.35..0.60)
 *  CSS consumes them directly — no calc(... * var(...)) anywhere.
 *
 * No backend, mic, websocket, or timer logic is touched here.
 */
import { useEffect, useMemo, useRef } from "react";

const PETALS = 6;

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function LiveVoiceOrb({
  state = "listening",
  level = 0,
  remaining = 0,
  connection = "connected",
}) {
  const coreRef = useRef(null);
  const wrapRef = useRef(null);

  // Reactive scale on the inner core.
  useEffect(() => {
    if (!coreRef.current) return;
    const scale = 1 + Math.min(0.4, level * 2.2);
    coreRef.current.style.transform = `scale(${scale})`;
  }, [level]);

  // Compute browser-safe bloom variables in JS (no CSS calc multiplication).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const bloom = Math.max(0, Math.min(1, level * 3.2));
    const opacity = 0.18 + 0.65 * bloom;
    const translatePx = -30 - 28 * bloom;
    const scale = 0.78 + 0.55 * bloom;
    const haloAlpha = 0.35 + 0.25 * bloom;
    el.style.setProperty("--etlc-bloom", bloom.toFixed(3));
    el.style.setProperty("--etlc-bloom-opacity", opacity.toFixed(3));
    el.style.setProperty("--etlc-bloom-translate", `${translatePx.toFixed(2)}px`);
    el.style.setProperty("--etlc-bloom-scale", scale.toFixed(3));
    el.style.setProperty("--etlc-halo-alpha", haloAlpha.toFixed(3));
  }, [level]);

  const petals = useMemo(
    () => Array.from({ length: PETALS }, (_, i) => i),
    []
  );

  const stateLabel =
    state === "speaking" ? "Coach speaking"
    : state === "thinking" ? "Thinking"
    : "Listening";

  return (
    <div
      className={`etlc-orb-wrap etlc-orb-wrap--v18 is-${state}`}
      data-testid="live-orb-wrap"
      ref={wrapRef}
    >
      <div className={`etlc-orb is-${state}`} data-testid="live-orb">
        <div className="etlc-orb__bloom" aria-hidden="true">
          {petals.map((i) => (
            <span
              key={i}
              className="etlc-orb__petal"
              style={{ "--i": i, "--n": PETALS }}
            />
          ))}
        </div>
        <span className="etlc-orb__ring" />
        <span className="etlc-orb__ring etlc-orb__ring--2" aria-hidden="true" />
        <span className="etlc-orb__core" ref={coreRef} />
        <span className="etlc-orb__halo" aria-hidden="true" />
      </div>
      <div className="etlc-state-label" data-testid="live-state-label">
        <span className="etlc-state-dot" aria-hidden="true" />
        {stateLabel}
      </div>
      <div className="etlc-timer" data-testid="live-timer">{fmt(remaining)}</div>
      <div
        className={`etlc-conn ${connection !== "connected" ? "is-bad" : ""}`}
        data-testid="live-connection"
      >
        {connection === "connected"
          ? "● Connected"
          : connection === "connecting"
          ? "○ Connecting…"
          // Issue 3 fix — no reconnect is actually attempted (the session
          // finalizes within a few seconds instead), so this must not
          // promise a recovery that never happens.
          : "○ Connection lost — ending session…"}
      </div>
    </div>
  );
}
