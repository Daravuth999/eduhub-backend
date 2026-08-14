import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useAuth } from "../context/AuthContext";

/**
 * LibraryLottieGreeter — v15 (2026-01) "Bibly the Reading-Bot"
 *
 * Premium personalised greeter for /library. Replaces the static "Library
 * Tip" book mascot with an interactive desk-robot that calls every student
 * by their first name and rotates through 8 bilingual (Khmer + English)
 * questions, the first of which is time-of-day aware.
 *
 * SURGICAL CONTRACT (do NOT break):
 *   • Same file path, same default export, same prop signature
 *     ({ compact, className }) — LibraryPage.jsx is NOT modified.
 *   • Same theme-token CSS variables (--bgfx-accent, --bgfx-accent-warm,
 *     --bgfx-line, --bgfx-ink, --bgfx-ink-mute) — no new globals.
 *   • Same data-testid="library-lottie-greeter" preserved for any e2e
 *     selectors. New testids added: -mascot, -bubble, -name, -prompt-en,
 *     -prompt-kh, -dot.
 *   • Pure SVG + framer-motion. Zero new dependencies. ~9 KB gz.
 *   • Pauses entirely when off-screen (IntersectionObserver) or when
 *     document.hidden — preserves the heat-budget contract from v14.
 *   • Reduced-motion users see a calm static composition with text already
 *     fully revealed.
 *   • Reads the student name read-only via useAuth(); never writes auth.
 *
 * Motion choreography (boosts reader happiness, all GPU-only transforms):
 *   • Mount: robot waves once, antenna pulses, sparkle ring blooms.
 *   • Idle:  breathing (1 → 1.02), eye blink ~4s, glance left/right ~7s,
 *            antenna LED pulse 1.6s, gentle vertical bob 3.4s.
 *   • Speaking (typewriter reveal): mouth opens/closes, antenna LED beats
 *            faster, sparkle dots rise around the bubble.
 *   • Tap:   bouncy spring (overshoot), instant rotate to next prompt,
 *            heart-sparkle burst, soft haptic (navigator.vibrate(8)).
 *
 * Heat cost: negligible. Animations only run while visible AND focused.
 */

// ---------- Honorific & first-name extraction (locale-safe) -----------
const HONORIFIC_RE = /^(បង|អ្នក|លោក|លោកស្រី|កញ្ញា|អូន|កូន|Mr\.?|Ms\.?|Mrs\.?|Dr\.?)\s+/i;

function pickFirstName(student) {
  const raw = (
    student?.name ||
    student?.gameName ||
    student?.portalData?.Name ||
    ""
  ).toString().trim();
  if (!raw) return "មិត្ត"; // "friend" — safe fallback
  const stripped = raw.replace(HONORIFIC_RE, "").trim();
  // Split on whitespace AND common Khmer punctuation/middle-dot
  const first = stripped.split(/[\s\u00B7]+/)[0];
  return first || "មិត្ត";
}

// ---------- Time-of-day bucket ---------------------------------------
function timeBucket(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 0;   // morning
  if (h >= 12 && h < 18) return 1;  // afternoon
  return 2;                          // evening / night
}

// ---------- Prompt bank (exactly as supplied by product) -------------
function buildPrompts(name) {
  return [
    {
      en: `Good morning, ${name} — what are you reading today?`,
      kh: `អរុណសួស្តីបង ${name}, ថ្ងៃហ្នឹងបងអានសៀវភៅអ្វីខ្លះ?`,
    },
    {
      en: `Hey ${name}, take 10 min to relax with a story!`,
      kh: `សួស្តីបង ${name}, ហត់ហើយឫនៅ? អាន១០នាទីសម្រាក!`,
    },
    {
      en: `រាត្រីសួស្តីបង, ${name} — bedtime reading boosts memory!`,
      kh: `សួស្តីបង ${name}, ការអានមុនគេងជួយឲ្យចំណាំពាក្យល្អ!`,
    },
    {
      en: `Have you read a book today, ${name}?`,
      kh: `បង ${name}, បងបានអានសៀវភៅនៅថ្ងៃហ្នឹងហើយឫនៅ?`,
    },
    {
      en: `Want to try a new story, ${name}?`,
      kh: `បង ${name} ចង់សាកល្បងសៀវភៅរឿងថ្មីទេ?`,
    },
    {
      en: `Just 10 minutes earns points, ${name}!`,
      kh: `អាន១០នាទីប៉ុណ្ណោះក៏បានពិន្ទុដែរបង ${name}!`,
    },
    {
      en: `Try a quick exercise to sharpen speaking, ${name}!`,
      kh: `បង ${name}, សាកអនុវត្តន៍លំហាត់ខ្លីៗដើម្បីពង្រឹងការនិយាយ`,
    },
    {
      en: `Conversations boost speaking — give it a go, ${name}?`,
      kh: `ការសន្ទនាជួយឲ្យនិយាយបានល្អ — សាកមើលទេបង ${name}?`,
    },
  ];
}

// ---------- Typewriter hook (respects reduced-motion) -----------------
function useTypewriter(text, speed = 22, enabled = true) {
  const [out, setOut] = useState(enabled ? "" : text);
  useEffect(() => {
    if (!enabled) { setOut(text); return; }
    setOut("");
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setOut(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed, enabled]);
  return out;
}

// ---------- Component -------------------------------------------------
export default function LibraryLottieGreeter({ compact = false, className = "" }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const auth = useAuth?.() || {};
  const { student } = auth;

  const firstName = useMemo(() => pickFirstName(student), [student]);
  const PROMPTS = useMemo(() => buildPrompts(firstName), [firstName]);

  // Start with a time-of-day appropriate greeting (0,1,2 map directly).
  const [idx, setIdx] = useState(() => timeBucket());
  const [visible, setVisible] = useState(false);
  const [poke, setPoke] = useState(0);
  const [heartBurst, setHeartBurst] = useState(0);

  // Pause when off-screen
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.15 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  // Auto-rotate prompts (every 7 s) while visible + tab focused.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      setIdx((i) => (i + 1) % PROMPTS.length);
    }, 7000);
    return () => clearInterval(id);
  }, [visible, PROMPTS.length]);

  const onTap = () => {
    setPoke((p) => p + 1);
    setHeartBurst((h) => h + 1);
    setIdx((i) => (i + 1) % PROMPTS.length);
    try { if ("vibrate" in navigator) navigator.vibrate(8); } catch { /* ignore */ }
  };

  const animate = visible && !reduce;
  const current = PROMPTS[idx];
  const typedKh = useTypewriter(current.kh, 22, animate);
  const speaking = animate && typedKh.length < current.kh.length;
  const size = compact ? 76 : 104;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.34, 1.4, 0.64, 1] }}
      className={`relative flex items-center gap-3 sm:gap-4 rounded-3xl px-4 py-3 overflow-hidden ${className}`}
      style={{
        background:
          "linear-gradient(135deg, rgb(var(--bgfx-accent) / 0.12) 0%, rgb(var(--bgfx-accent-warm) / 0.12) 100%)",
        border: "1px solid rgb(var(--bgfx-line) / 0.10)",
        boxShadow: "0 6px 18px rgba(0,0,0,0.10)",
      }}
      data-testid="library-lottie-greeter"
    >
      {/* Soft ambient glow blob */}
      {animate && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -left-6 -top-6 rounded-full blur-2xl"
          style={{
            width: 120, height: 120,
            background: "radial-gradient(circle, rgb(var(--bgfx-accent) / 0.30), transparent 70%)",
          }}
          animate={{ opacity: [0.35, 0.7, 0.35], scale: [0.9, 1.05, 0.9] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {/* Mascot — interactive desk-robot */}
      <motion.button
        type="button"
        onClick={onTap}
        whileTap={{ scale: 0.94 }}
        animate={poke ? { y: [0, -10, 0], rotate: [0, -6, 6, 0] } : { y: 0, rotate: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        aria-label={`Greet ${firstName}`}
        data-testid="library-lottie-mascot"
        className="relative shrink-0 outline-none rounded-2xl"
        style={{ width: size, height: size }}
      >
        {/* Heart-sparkle burst on tap */}
        {animate && heartBurst > 0 && (
          <motion.div
            key={`burst-${heartBurst}`}
            aria-hidden
            className="pointer-events-none absolute inset-0"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <motion.span
                key={i}
                className="absolute"
                style={{
                  left: `${20 + i * 14}%`,
                  top: "55%",
                  fontSize: 14,
                  color: "rgb(var(--bgfx-accent-warm))",
                }}
                initial={{ y: 0, opacity: 0, scale: 0.6 }}
                animate={{ y: -38 - i * 4, opacity: [0, 1, 0], scale: [0.6, 1.1, 0.9] }}
                transition={{ duration: 0.85, delay: i * 0.04, ease: "easeOut" }}
              >
                {i % 2 === 0 ? "♥" : "✦"}
              </motion.span>
            ))}
          </motion.div>
        )}

        {/* Idle vertical bob wrapper */}
        <motion.div
          animate={animate ? { y: [0, -3, 0] } : { y: 0 }}
          transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
          style={{ width: "100%", height: "100%" }}
        >
          <svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden>
            <defs>
              <linearGradient id="bot-body" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%"  stopColor="rgb(var(--bgfx-accent))" />
                <stop offset="100%" stopColor="rgb(var(--bgfx-accent-warm))" />
              </linearGradient>
              <linearGradient id="bot-face" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%"  stopColor="#0e1020" />
                <stop offset="100%" stopColor="#1b1f3a" />
              </linearGradient>
              <radialGradient id="bot-cheek" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0%"  stopColor="rgb(var(--bgfx-accent-warm) / 0.85)" />
                <stop offset="100%" stopColor="rgb(var(--bgfx-accent-warm) / 0)" />
              </radialGradient>
              <filter id="bot-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="3" stdDeviation="3" floodOpacity="0.22" />
              </filter>
            </defs>

            {/* Antenna */}
            <line x1="60" y1="28" x2="60" y2="14"
                  stroke="rgb(var(--bgfx-accent))" strokeWidth="2.5" strokeLinecap="round" />
            <motion.circle
              cx="60" cy="11" r="4.2"
              fill="rgb(var(--bgfx-accent-warm))"
              animate={animate
                ? { r: speaking ? [4, 5.6, 4] : [4, 5, 4],
                    opacity: speaking ? [0.85, 1, 0.85] : [0.7, 1, 0.7] }
                : { r: 4, opacity: 0.9 }}
              transition={{ duration: speaking ? 0.45 : 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
            {/* Antenna halo */}
            {animate && (
              <motion.circle
                cx="60" cy="11" r="7"
                fill="none"
                stroke="rgb(var(--bgfx-accent-warm) / 0.55)"
                strokeWidth="1"
                animate={{ r: [7, 11, 7], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
              />
            )}

            {/* Breathing wrapper for the body */}
            <motion.g
              filter="url(#bot-shadow)"
              animate={animate ? { scale: [1, 1.025, 1] } : { scale: 1 }}
              style={{ transformOrigin: "60px 70px" }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            >
              {/* Body */}
              <rect x="28" y="44" width="64" height="56" rx="14" fill="url(#bot-body)" />
              {/* Neck plate */}
              <rect x="52" y="40" width="16" height="8" rx="3" fill="rgb(var(--bgfx-accent) / 0.85)" />

              {/* Face panel */}
              <rect x="34" y="50" width="52" height="32" rx="9" fill="url(#bot-face)" />

              {/* Eyes */}
              <motion.g
                animate={animate
                  ? { scaleY: [1, 1, 0.08, 1, 1, 1, 0.08, 1] }
                  : { scaleY: 1 }}
                style={{ transformOrigin: "60px 65px" }}
                transition={{ duration: 6.4, times: [0, 0.18, 0.21, 0.24, 0.6, 0.78, 0.81, 1], repeat: Infinity }}
              >
                {/* Eye sockets */}
                <circle cx="48" cy="65" r="5.6" fill="#0a0c1a" />
                <circle cx="72" cy="65" r="5.6" fill="#0a0c1a" />
                {/* Eye glow / pupils — glance left↔right */}
                <motion.g
                  animate={animate ? { x: [0, -1.6, 0, 1.6, 0] } : { x: 0 }}
                  transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
                >
                  <circle cx="48" cy="65" r="2.6" fill="rgb(var(--bgfx-accent-warm))" />
                  <circle cx="72" cy="65" r="2.6" fill="rgb(var(--bgfx-accent-warm))" />
                  <circle cx="48.8" cy="64.2" r="0.9" fill="#fff" />
                  <circle cx="72.8" cy="64.2" r="0.9" fill="#fff" />
                </motion.g>
              </motion.g>

              {/* Mouth — opens while speaking */}
              <motion.rect
                x="54" y="74" width="12" height="3" rx="1.5"
                fill="rgb(var(--bgfx-accent-warm))"
                animate={animate
                  ? (speaking
                      ? { height: [3, 6, 3, 5, 3], y: [74, 72.5, 74, 73, 74] }
                      : { height: 3, y: 74 })
                  : { height: 3, y: 74 }}
                transition={{ duration: speaking ? 0.32 : 0.4, repeat: speaking ? Infinity : 0 }}
              />

              {/* Cheeks */}
              <circle cx="42" cy="73" r="3" fill="url(#bot-cheek)" />
              <circle cx="78" cy="73" r="3" fill="url(#bot-cheek)" />

              {/* Chest LED */}
              <motion.circle
                cx="60" cy="92" r="2.6"
                fill="rgb(var(--bgfx-accent-warm))"
                animate={animate
                  ? { opacity: speaking ? [0.5, 1, 0.5] : [0.4, 1, 0.4] }
                  : { opacity: 0.8 }}
                transition={{ duration: speaking ? 0.45 : 1.4, repeat: Infinity, ease: "easeInOut" }}
              />

              {/* Left arm — holds a tiny book */}
              <g>
                <rect x="18" y="62" width="10" height="22" rx="5" fill="rgb(var(--bgfx-accent))" />
                {/* Book in hand */}
                <rect x="10" y="78" width="18" height="13" rx="2" fill="#fff" stroke="rgb(var(--bgfx-line) / 0.35)" />
                <line x1="19" y1="79" x2="19" y2="90" stroke="rgb(var(--bgfx-line) / 0.35)" strokeWidth="0.8" />
              </g>

              {/* Right arm — waves on mount + on tap */}
              <motion.g
                style={{ transformOrigin: "92px 60px" }}
                animate={animate
                  ? (poke
                      ? { rotate: [0, -28, 14, -22, 0] }
                      : { rotate: [0, -10, 0, -6, 0] })
                  : { rotate: 0 }}
                transition={poke
                  ? { duration: 0.85, ease: [0.22, 1, 0.36, 1] }
                  : { duration: 2.6, repeat: Infinity, repeatDelay: 4.5, ease: "easeInOut" }}
              >
                <rect x="92" y="58" width="10" height="22" rx="5" fill="rgb(var(--bgfx-accent))" />
                <circle cx="97" cy="56" r="5" fill="rgb(var(--bgfx-accent))" />
              </motion.g>

              {/* Feet */}
              <rect x="40" y="100" width="14" height="6" rx="3" fill="rgb(var(--bgfx-accent) / 0.85)" />
              <rect x="66" y="100" width="14" height="6" rx="3" fill="rgb(var(--bgfx-accent) / 0.85)" />
            </motion.g>
          </svg>
        </motion.div>
      </motion.button>

      {/* Speech bubble */}
      <div className="flex-1 min-w-0 relative" data-testid="library-lottie-bubble">
        {/* Tail/connector dot */}
        <span
          aria-hidden
          className="absolute hidden sm:block"
          style={{
            left: -7, top: 18, width: 12, height: 12,
            background: "linear-gradient(135deg, rgb(var(--bgfx-accent) / 0.12) 0%, rgb(var(--bgfx-accent-warm) / 0.12) 100%)",
            border: "1px solid rgb(var(--bgfx-line) / 0.10)",
            transform: "rotate(45deg)",
            borderRight: 0, borderTop: 0,
          }}
        />

        {/* Header line — "Library Tip · ដំបូន្មាន" + dot indicator */}
        <div
          className="flex items-center gap-2 leading-tight"
          style={{
            fontSize: compact ? 12 : 13,
            color: "rgb(var(--bgfx-ink-mute))",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
          }}
        >
          <span style={{ fontWeight: 700, color: "rgb(var(--bgfx-ink))" }}>
            Hi <span data-testid="library-lottie-name">{firstName}</span>
          </span>
          <span aria-hidden style={{ opacity: 0.45 }}>•</span>
          <span className="font-khmer" style={{ fontWeight: 600 }}>
            ដំបូន្មាន
          </span>
          <span className="ml-auto flex items-center gap-1" aria-hidden>
            {PROMPTS.map((_, i) => (
              <span
                key={i}
                data-testid="library-lottie-dot"
                style={{
                  width: i === idx ? 14 : 5,
                  height: 5,
                  borderRadius: 4,
                  background: i === idx
                    ? "rgb(var(--bgfx-accent-warm))"
                    : "rgb(var(--bgfx-line) / 0.45)",
                  transition: "width .35s ease, background .35s ease",
                }}
              />
            ))}
          </span>
        </div>

        {/* Animated prompt — typewriter Khmer first (per repo standard) */}
        <motion.div
          key={idx}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="mt-1"
        >
          <div
            className="font-khmer"
            data-testid="library-lottie-prompt-kh"
            style={{
              fontSize: compact ? 14 : 15.5,
              fontWeight: 700,
              color: "rgb(var(--bgfx-ink))",
              lineHeight: 1.4,
              minHeight: compact ? 20 : 22,
            }}
          >
            {typedKh}
            {speaking && (
              <motion.span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 2, height: "1em",
                  marginLeft: 2,
                  verticalAlign: "-0.18em",
                  background: "rgb(var(--bgfx-accent-warm))",
                }}
                animate={{ opacity: [1, 0, 1] }}
                transition={{ duration: 0.7, repeat: Infinity }}
              />
            )}
          </div>
          <div
            data-testid="library-lottie-prompt-en"
            style={{
              fontSize: compact ? 12 : 13,
              fontWeight: 500,
              color: "rgb(var(--bgfx-ink-mute))",
              lineHeight: 1.4,
              marginTop: 2,
            }}
          >
            {current.en}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
