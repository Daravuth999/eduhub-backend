import confetti from "canvas-confetti";

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const SCHOLAR_PALETTE = ["#1F4E4A", "#C77B5C", "#C8941A", "#2F7D5A", "#EDE6D6"];
const WARM_PALETTE = ["#C77B5C", "#C8941A", "#E8A062", "#EDE6D6", "#2F7D5A"];

/** Top-Performer celebration — short, classy paper-confetti burst. */
export function celebrateTopPerformer() {
  if (reducedMotion()) return;
  const burst = (origin: { x: number; y: number }) =>
    confetti({
      particleCount: 70,
      spread: 70,
      startVelocity: 38,
      ticks: 220,
      gravity: 0.9,
      scalar: 0.95,
      colors: SCHOLAR_PALETTE,
      origin,
    });
  burst({ x: 0.2, y: 0.35 });
  setTimeout(() => burst({ x: 0.8, y: 0.35 }), 220);
  setTimeout(() => burst({ x: 0.5, y: 0.25 }), 440);
}

/** "Big" tier — dual focused bursts near the points pill area (top-right). */
export function celebrateBigPoints() {
  if (reducedMotion()) return;
  const opts: confetti.Options = {
    particleCount: 35,
    spread: 55,
    startVelocity: 30,
    ticks: 160,
    gravity: 1,
    scalar: 0.85,
    colors: WARM_PALETTE,
  };
  confetti({ ...opts, origin: { x: 0.92, y: 0.18 } });
  setTimeout(
    () => confetti({ ...opts, origin: { x: 0.85, y: 0.22 } }),
    140,
  );
}

/** "Huge" tier — full-screen, dramatic, stays for a beat. */
export function celebrateHugePoints() {
  if (reducedMotion()) return;
  // Side cannons firing inward
  const end = Date.now() + 1200;
  (function frame() {
    confetti({
      particleCount: 4,
      angle: 60,
      spread: 70,
      origin: { x: 0, y: 0.7 },
      colors: WARM_PALETTE,
    });
    confetti({
      particleCount: 4,
      angle: 120,
      spread: 70,
      origin: { x: 1, y: 0.7 },
      colors: WARM_PALETTE,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
  // Center burst
  setTimeout(
    () =>
      confetti({
        particleCount: 120,
        spread: 110,
        startVelocity: 45,
        ticks: 250,
        gravity: 0.8,
        scalar: 1.05,
        colors: SCHOLAR_PALETTE,
        origin: { x: 0.5, y: 0.4 },
      }),
    400,
  );
}
