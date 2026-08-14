/**
 * shellStyles.js — scoped CSS for the Reward Experience Shell.
 * Everything is namespaced under .rxp-scope / .rxp-* so nothing leaks
 * into the rest of the app. The shell re-skins the EXISTING .lrp-*
 * popup classes purely with CSS (glass, ink, choreography) — the popup
 * component's markup and logic are untouched.
 */
export const SHELL_CSS = `
/* ── layers ─────────────────────────────────────────────────────────── */
.rxp-env, .rxp-particles-layer, .rxp-decor {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
}
.rxp-env { z-index: 9997; }
.rxp-particles-layer { z-index: 9998; }
.rxp-decor-back { z-index: 9998; }
.rxp-decor-front { z-index: 10000; }
.rxp-celebrate { position: fixed; inset: 0; z-index: 10001; pointer-events: none; overflow: hidden; }
.rxp-contained .rxp-env, .rxp-contained .rxp-particles-layer,
.rxp-contained .rxp-decor, .rxp-contained .rxp-celebrate { position: absolute; }
.rxp-contained .rxp-env { z-index: 0; }
.rxp-contained .rxp-particles-layer { z-index: 1; }
.rxp-contained .rxp-decor-back { z-index: 1; }
.rxp-contained .rxp-decor-front { z-index: 4; }
.rxp-contained .rxp-celebrate { z-index: 5; }

/* ── environment ────────────────────────────────────────────────────── */
.rxp-env-bg { position: absolute; inset: 0; }
.rxp-glow, .rxp-bokeh {
  position: absolute; border-radius: 50%;
  transform: translate(-50%, -50%);
  will-change: transform, opacity;
}
.rxp-glow-drift { animation: rxp-drift 14s ease-in-out infinite alternate; }
.rxp-glow-slow { animation-duration: 22s; }
.rxp-bokeh { animation: rxp-bokeh-pulse 8s ease-in-out infinite; filter: blur(2px); }
.rxp-silhouette {
  position: absolute; left: 0; right: 0; bottom: 0;
  width: 100%; height: 32%;
}
.rxp-ambient { position: absolute; inset: 0; }
.rxp-beams {
  position: absolute; inset: -10% 0 0 0;
  background:
    linear-gradient(100deg, transparent 18%, rgba(255,240,200,0.10) 22%, transparent 30%),
    linear-gradient(100deg, transparent 44%, rgba(255,240,200,0.08) 48%, transparent 56%),
    linear-gradient(100deg, transparent 70%, rgba(255,240,200,0.10) 74%, transparent 82%);
}
.rxp-light { position: absolute; inset: 0; }
.rxp-light-soft { background: radial-gradient(ellipse at 50% 30%, rgba(255,255,255,0.10) 0%, transparent 60%); }
.rxp-light-golden { background: radial-gradient(ellipse at 50% 68%, rgba(255,196,96,0.20) 0%, transparent 62%); }
.rxp-light-spotlight { background: radial-gradient(ellipse at 50% 42%, rgba(255,244,214,0.16) 0%, transparent 42%), radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.30) 100%); }
.rxp-light-aurora {
  background: linear-gradient(115deg, rgba(94,224,255,0.10) 0%, transparent 34%, rgba(255,120,180,0.10) 62%, transparent 88%);
  animation: rxp-aurora 12s ease-in-out infinite alternate;
}

/* ── particles ──────────────────────────────────────────────────────── */
.rxp-p {
  position: absolute; border-radius: 50%; opacity: 0;
  will-change: transform, opacity;
  animation-name: rxp-float-up; animation-timing-function: ease-in-out; animation-iteration-count: infinite;
}
.rxp-p-dust, .rxp-p-sparkles { box-shadow: 0 0 8px currentColor; }
.rxp-p-sparkles {
  border-radius: 0;
  clip-path: polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
}
.rxp-p-fireflies { box-shadow: 0 0 10px currentColor; animation-name: rxp-firefly; }
.rxp-p-petals { border-radius: 60% 40% 55% 45%; animation-name: rxp-fall; }
.rxp-p-confetti { border-radius: 2px; animation-name: rxp-fall; }

/* ── decorations ────────────────────────────────────────────────────── */
.rxp-decor-item { position: absolute; height: auto; will-change: transform; user-select: none; }

/* ── glass re-skin of the existing popup (CSS-only, wraps production) ── */
.rxp-scope [data-testid="login-reward-popup"], .rxp-scope .rxp-veil-target {
  background: var(--rxp-veil) !important;
  backdrop-filter: blur(var(--rxp-veil-blur)) !important;
  -webkit-backdrop-filter: blur(var(--rxp-veil-blur)) !important;
}
.rxp-scope .lrp-card {
  background: var(--rxp-glass-bg) !important;
  backdrop-filter: blur(var(--rxp-glass-blur)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--rxp-glass-blur)) saturate(150%);
  border: 1px solid var(--rxp-glass-border);
  border-radius: var(--rxp-glass-radius) !important;
  opacity: var(--rxp-glass-opacity);
  box-shadow:
    var(--rxp-card-shadow),
    0 1px 0 var(--rxp-reflection) inset,
    0 0 0 0.5px rgba(255,255,255,0.08) inset !important;
  color: var(--rxp-ink) !important;
  max-width: var(--rxp-card-w) !important;
}
.rxp-scope .lrp-card .text-center { text-align: var(--rxp-text-align) !important; }
.rxp-scope .lrp-title {
  color: var(--rxp-title-color);
  font-family: var(--rxp-title-font);
  font-weight: var(--rxp-title-weight);
  letter-spacing: var(--rxp-title-spacing);
  text-shadow: var(--rxp-title-shadow);
}
.rxp-scope .lrp-subtitle, .rxp-scope .lrp-success-msg { color: var(--rxp-ink-soft); }
.rxp-scope .lrp-maybe-later { color: var(--rxp-ink-soft); }
.rxp-scope .lrp-close-btn { background: var(--rxp-chip-bg) !important; color: var(--rxp-ink) !important; }
.rxp-scope .lrp-countdown {
  background: var(--rxp-chip-bg); border-color: var(--rxp-chip-border); color: var(--rxp-ink-soft);
}
.rxp-scope .lrp-countdown-clock { background: var(--rxp-clock-bg); color: var(--rxp-ink); }

/* ── CTA design system (V2) ─────────────────────────────────────────── */
.rxp-scope .lrp-claim-btn {
  border-radius: var(--rxp-cta-radius) !important;
  box-shadow: var(--rxp-cta-shadow) !important;
  filter: drop-shadow(0 0 calc(var(--rxp-cta-glow) * 14px) var(--rxp-accent));
}
.rxp-scope[data-cta="gradient"] .lrp-claim-btn {
  background: linear-gradient(135deg, var(--rxp-accent) 0%, #ffe6ae 55%, var(--rxp-accent) 100%) !important;
}
.rxp-scope[data-cta="glass"] .lrp-claim-btn {
  background: rgba(255,255,255,0.14) !important;
  border: 1px solid var(--rxp-accent) !important;
  color: var(--rxp-ink) !important;
  backdrop-filter: blur(8px);
}
.rxp-scope[data-cta="outline"] .lrp-claim-btn {
  background: transparent !important;
  border: 1.5px solid var(--rxp-accent) !important;
  color: var(--rxp-accent) !important;
}
.rxp-scope[data-cta-anim="none"] .lrp-shimmer { display: none; }
.rxp-scope[data-cta-anim="pulse"] .lrp-claim-btn { animation: rxp-cta-pulse 2.2s ease-in-out infinite; }

/* ── decoration animations (V2, on the positioning wrapper) ─────────── */
.rxp-decor-wrap { position: absolute; transform: translate(-50%,-50%); will-change: transform; }
.rxp-decor-wrap > img { display: block; height: auto; user-select: none; }
.rxp-danim-float { animation: rxp-danim-float 5s ease-in-out infinite; }
.rxp-danim-pulse { animation: rxp-danim-pulse 3s ease-in-out infinite; }
.rxp-danim-spin  { animation: rxp-danim-spin 14s linear infinite; }
.rxp-danim-drift { animation: rxp-danim-drift 7s ease-in-out infinite alternate; }
.rxp-danim-sway  { animation: rxp-danim-sway 4.5s ease-in-out infinite; }

/* ── reveal choreography (cinematic ≈ 1.2s total) ───────────────────── */
.rxp-scope[data-reveal="cinematic"] .lrp-card,
.rxp-scope[data-reveal="float"] .lrp-card,
.rxp-scope[data-reveal="bloom"] .lrp-card {
  animation: rxp-card-in 0.8s cubic-bezier(0.16, 1, 0.3, 1) both !important;
}
.rxp-scope[data-reveal="bloom"] .lrp-card { animation-name: rxp-card-bloom !important; }
.rxp-scope[data-reveal="cinematic"] .lrp-hero { animation: rxp-rise 0.6s 0.14s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-badge { animation: rxp-rise 0.55s 0.30s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-title { animation: rxp-rise 0.55s 0.38s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-subtitle { animation: rxp-rise 0.55s 0.46s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-points-wrap,
.rxp-scope[data-reveal="cinematic"] [data-testid="lrp-voucher-teaser"] { animation: rxp-rise 0.55s 0.56s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-countdown { animation: rxp-rise 0.55s 0.68s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-claim-btn { animation: rxp-rise 0.6s 0.80s cubic-bezier(0.16,1,0.3,1) both; }
.rxp-scope[data-reveal="cinematic"] .lrp-maybe-later { animation: rxp-rise 0.6s 0.94s cubic-bezier(0.16,1,0.3,1) both; }

/* ── success: voucher flip + elegant celebration ────────────────────── */
.rxp-scope[data-phase="success"] [data-testid="lrp-voucher-reveal"] {
  animation: rxp-flip-in 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
  transform-style: preserve-3d;
}
.rxp-cel-mote {
  position: absolute; border-radius: 50%;
  box-shadow: 0 0 10px currentColor; opacity: 0;
  animation: rxp-cel-rise 1.6s ease-out both;
}
.rxp-cel-bloom {
  position: absolute; left: 50%; top: 50%;
  width: 40vmin; height: 40vmin; border-radius: 50%;
  transform: translate(-50%, -50%);
  animation: rxp-cel-bloom 1.1s ease-out both;
}

/* ── keyframes (transform/opacity only — GPU) ───────────────────────── */
@keyframes rxp-drift {
  0%   { transform: translate(-50%,-50%) scale(1); }
  100% { transform: translate(-46%,-54%) scale(1.12); }
}
@keyframes rxp-bokeh-pulse {
  0%, 100% { transform: translate(-50%,-50%) scale(1); }
  50%      { transform: translate(-50%,-52%) scale(1.15); }
}
@keyframes rxp-aurora {
  0%   { transform: translateX(-3%); }
  100% { transform: translateX(3%); }
}
@keyframes rxp-float-up {
  0%   { opacity: 0; transform: translate3d(0, 14px, 0) scale(0.6); }
  18%  { opacity: 0.95; }
  80%  { opacity: 0.6; }
  100% { opacity: 0; transform: translate3d(var(--rxp-drift, 0), -80px, 0) scale(1.05); }
}
@keyframes rxp-firefly {
  0%   { opacity: 0; transform: translate3d(0,0,0); }
  25%  { opacity: 1; }
  50%  { opacity: 0.25; transform: translate3d(var(--rxp-drift, 20px), -26px, 0); }
  75%  { opacity: 0.9; }
  100% { opacity: 0; transform: translate3d(calc(var(--rxp-drift, 20px) * -0.6), -60px, 0); }
}
@keyframes rxp-fall {
  0%   { opacity: 0; transform: translate3d(0, -30px, 0) rotate(var(--rxp-spin, 0deg)); }
  12%  { opacity: 0.95; }
  88%  { opacity: 0.7; }
  100% { opacity: 0; transform: translate3d(var(--rxp-drift, 0), 110px, 0) rotate(calc(var(--rxp-spin, 0deg) + 200deg)); }
}
@keyframes rxp-card-in {
  0%   { opacity: 0; transform: translateY(42px) scale(0.94); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes rxp-card-bloom {
  0%   { opacity: 0; transform: scale(0.82); filter: brightness(1.35); }
  100% { opacity: 1; transform: scale(1); filter: brightness(1); }
}
@keyframes rxp-rise {
  0%   { opacity: 0; transform: translateY(16px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes rxp-flip-in {
  0%   { opacity: 0; transform: perspective(700px) rotateX(-58deg) translateY(10px); }
  100% { opacity: 1; transform: perspective(700px) rotateX(0deg) translateY(0); }
}
@keyframes rxp-cel-rise {
  0%   { opacity: 0; transform: translate3d(0, 30px, 0) scale(0.5); }
  20%  { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--rxp-drift, 0), -46vh, 0) scale(1.1); }
}
@keyframes rxp-cel-bloom {
  0%   { opacity: 0.9; transform: translate(-50%,-50%) scale(0.3); }
  100% { opacity: 0;   transform: translate(-50%,-50%) scale(1.6); }
}
@keyframes rxp-card-fade {
  0%   { opacity: 0; }
  100% { opacity: 1; }
}
@keyframes rxp-card-scale {
  0%   { opacity: 0; transform: scale(0.7); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes rxp-card-slide {
  0%   { opacity: 0; transform: translateY(90px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes rxp-cta-pulse {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.03); }
}
@keyframes rxp-danim-float {
  0%, 100% { transform: translate(-50%,-50%) translateY(0); }
  50%      { transform: translate(-50%,-50%) translateY(-9px); }
}
@keyframes rxp-danim-pulse {
  0%, 100% { transform: translate(-50%,-50%) scale(1); opacity: 1; }
  50%      { transform: translate(-50%,-50%) scale(1.09); opacity: 0.85; }
}
@keyframes rxp-danim-spin {
  0%   { transform: translate(-50%,-50%) rotate(0deg); }
  100% { transform: translate(-50%,-50%) rotate(360deg); }
}
@keyframes rxp-danim-drift {
  0%   { transform: translate(-50%,-50%) translateX(-8px); }
  100% { transform: translate(-50%,-50%) translateX(8px); }
}
@keyframes rxp-danim-sway {
  0%, 100% { transform: translate(-50%,-50%) rotate(-5deg); }
  50%      { transform: translate(-50%,-50%) rotate(5deg); }
}
@keyframes rxp-mist {
  0%   { opacity: 0; transform: translate3d(-30px, 0, 0) scale(1); }
  25%  { opacity: 0.5; }
  75%  { opacity: 0.35; }
  100% { opacity: 0; transform: translate3d(60px, -14px, 0) scale(1.25); }
}
@keyframes rxp-ray-pulse {
  0%, 100% { opacity: 0.12; }
  50%      { opacity: 0.34; }
}

/* ── accessibility: honour reduced motion completely ────────────────── */
@media (prefers-reduced-motion: reduce) {
  .rxp-scope *, .rxp-scope *::before, .rxp-scope *::after {
    animation: none !important;
    transition: none !important;
  }
}
`;
