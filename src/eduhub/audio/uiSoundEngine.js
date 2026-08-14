/**
 * uiSoundEngine.js — Premium UI Sound System, core engine.
 *
 * Architecture mirrors the proven, already-shipped pattern in
 * src/eduhub/pages/game/lib/sound.ts: a module-level singleton
 * AudioContext, live oscillator+gain synthesis per play (no audio FILES,
 * so there is no decode step at all — the latency this milestone must
 * avoid simply doesn't exist in this design). What's added here that the
 * game module doesn't need: a master GainNode for the 3-level user
 * volume setting (Off/Soft/Normal), and an explicit unlockAudio() the
 * app calls synchronously on the first real user gesture — the same
 * "resume() before the first await" rule already proven on-device in
 * EduTalkLiveCoach.jsx (search that file for the exact comment this
 * mirrors).
 *
 * Sound identity: every tone in SOUND_DEFS is built from the same one
 * low-level helper (_tone) — pure sine partials, fast attack, smooth
 * exponential decay, modest peak gain, 30-220ms total. No square/
 * sawtooth waveforms (those read as arcade/buzzy — reserved for the
 * Lucky Spin game's own, deliberately more playful sound.ts) and no
 * sound exceeds ~0.09 peak gain before the master volume scaler is
 * even applied. This is what keeps the whole set "calm" rather than
 * "noticeable" — same family, same restraint, every time.
 */

const VOLUME_BY_MODE = {
  off: 0,
  soft: 0.55,
  normal: 1,
};

let ctx = null;
let masterGain = null;
let cachedMode = "soft"; // overwritten by soundSettings.js on app start

function getAudioContextClass() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function ensureContext() {
  if (ctx) return ctx;
  const AC = getAudioContextClass();
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = VOLUME_BY_MODE[cachedMode] ?? VOLUME_BY_MODE.soft;
  masterGain.connect(ctx.destination);
  return ctx;
}

/**
 * Must be called SYNCHRONOUSLY inside the very first real user gesture
 * (pointerdown/touchend/click), before any `await` in that same handler —
 * iOS Safari only honors an AudioContext resume() as "user-initiated" if
 * it happens in the synchronous portion of the event's call stack. See
 * SoundUnlockProvider.jsx, which wires this to a one-time document
 * listener at app root.
 */
export function unlockAudio() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === "suspended") {
    void c.resume();
  }
}

/** Read by soundSettings.js at startup and whenever the user changes the
 * setting — kept as a plain module variable (not localStorage-backed
 * here) so play() never touches storage on the hot path. */
export function setEngineVolumeMode(mode) {
  cachedMode = mode in VOLUME_BY_MODE ? mode : "soft";
  if (masterGain) {
    masterGain.gain.value = VOLUME_BY_MODE[cachedMode];
  }
}

function _tone(c, dest, { freq, start, duration, peakGain, type = "sine", attack = 0.012 }) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.00001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.00001, start + duration);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function _glide(c, dest, { from, to, start, duration, peakGain, type = "sine", attack = 0.012 }) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(to, start + duration);
  gain.gain.setValueAtTime(0.00001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.00001, start + duration);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// Every entry: (c, dest, now) => void. `dest` is always masterGain — never
// c.destination directly, so the volume setting always applies uniformly.
const SOUND_DEFS = {
  click: (c, dest, now) => {
    _tone(c, dest, { freq: 900, start: now, duration: 0.035, peakGain: 0.05 });
  },
  toggle: (c, dest, now) => {
    _tone(c, dest, { freq: 720, start: now, duration: 0.05, peakGain: 0.05 });
    _tone(c, dest, { freq: 860, start: now + 0.03, duration: 0.045, peakGain: 0.04 });
  },
  drawer_open: (c, dest, now) => {
    _glide(c, dest, { from: 500, to: 680, start: now, duration: 0.09, peakGain: 0.055 });
  },
  drawer_close: (c, dest, now) => {
    _glide(c, dest, { from: 680, to: 500, start: now, duration: 0.08, peakGain: 0.05 });
  },
  profile_open: (c, dest, now) => {
    _tone(c, dest, { freq: 523.25, start: now, duration: 0.09, peakGain: 0.055 });
    _tone(c, dest, { freq: 659.25, start: now + 0.06, duration: 0.09, peakGain: 0.06 });
  },
  save: (c, dest, now) => {
    _tone(c, dest, { freq: 780, start: now, duration: 0.055, peakGain: 0.06 });
  },
  success: (c, dest, now) => {
    _tone(c, dest, { freq: 659.25, start: now, duration: 0.09, peakGain: 0.06 });
    _tone(c, dest, { freq: 880, start: now + 0.07, duration: 0.11, peakGain: 0.065 });
  },
  error: (c, dest, now) => {
    _tone(c, dest, { freq: 320, start: now, duration: 0.14, peakGain: 0.05, attack: 0.02 });
  },
  notification: (c, dest, now) => {
    _tone(c, dest, { freq: 700, start: now, duration: 0.1, peakGain: 0.05 });
    _tone(c, dest, { freq: 550, start: now + 0.08, duration: 0.11, peakGain: 0.045 });
  },
  reward: (c, dest, now) => {
    _tone(c, dest, { freq: 523.25, start: now, duration: 0.1, peakGain: 0.07 });
    _tone(c, dest, { freq: 659.25, start: now + 0.07, duration: 0.1, peakGain: 0.08 });
    _tone(c, dest, { freq: 784, start: now + 0.14, duration: 0.14, peakGain: 0.085 });
  },
};

export const SOUND_NAMES = Object.freeze(Object.keys(SOUND_DEFS));

/**
 * Plays a semantic UI sound by name. Never throws, never blocks —
 * safe to call from any event handler. No-ops entirely (never even
 * touches the AudioContext) when the user's sound mode is "off", and
 * silently no-ops if Web Audio isn't available or the name is unknown.
 */
export function playUiSound(name) {
  if (cachedMode === "off") return;
  const def = SOUND_DEFS[name];
  if (!def) return;
  const c = ensureContext();
  if (!c) return;
  if (c.state === "suspended") {
    // Best-effort — normally already resumed via unlockAudio() on first
    // gesture; this just self-heals if something suspended it since.
    void c.resume();
  }
  try {
    def(c, masterGain, c.currentTime);
  } catch {
    // Never let a synthesis edge case break the calling interaction.
  }
}

// Test-only accessors (not part of the public API surface used by app code).
export function _resetForTests() {
  ctx = null;
  masterGain = null;
  cachedMode = "soft";
}
