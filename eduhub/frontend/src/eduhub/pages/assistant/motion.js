// motion.js — the ONE motion language for the AI Assistant page.
//
// Every fade/slide in this feature (bubbles, banners, the landing
// state, the header collapsing away once a conversation starts) shares
// this single duration + easing curve. No component invents its own
// timing — that's what made the page feel like several UI widgets
// animating independently instead of one coordinated surface.
//
// EASE is a standard "ease-out" cubic-bezier (fast start, gentle
// landing) — the same curve native iOS/Android UI transitions use for
// content entering the screen. DURATION is short enough to feel
// immediate, long enough to read as intentional rather than a flicker.

export const EASE = [0.4, 0, 0.2, 1];
export const DURATION = 0.22;

// Shared variants for the most common case — fade + small upward
// settle. Components pass `reduced` (from useReducedMotion()) to get
// an instant, transform-free version for motion-sensitive users.
export function fadeUp(reduced, distance = 6) {
  return {
    initial: reduced ? false : { opacity: 0, y: distance },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -distance },
    transition: { duration: reduced ? 0 : DURATION, ease: EASE },
  };
}

// Message-bubble entrance — fade + 4-6px rise + 98%→100% scale, the
// exact recipe for "appear naturally, never pop, never jump" (chat
// bubbles, the typing indicator). Distinct from fadeUp() only in that
// it adds the subtle scale settle a full-width banner doesn't need.
export function bubbleEnter(reduced, distance = 5) {
  return {
    initial: reduced ? false : { opacity: 0, y: distance, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: reduced ? 0 : DURATION, ease: EASE },
  };
}
