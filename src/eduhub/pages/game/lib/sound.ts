let ctx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (muted) return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

export function setMuted(value: boolean) {
  muted = value;
}

export function isMuted() {
  return muted;
}

export function playTick() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(1200, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.03);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.06, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.06);
}

export function playWin() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    const t = now + i * 0.1;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

export function playJackpot() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const seq = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
  seq.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "triangle";
    const t = now + i * 0.07;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
}

export function playSpinStart() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(420, now + 0.6);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.7);
}

// Mystery chest — rising sweep + golden chime cluster on lid open.
export function playChestOpen() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;

  // Wood-creak sweep
  const sweep = c.createOscillator();
  const sweepGain = c.createGain();
  sweep.type = "sawtooth";
  sweep.frequency.setValueAtTime(120, now);
  sweep.frequency.exponentialRampToValueAtTime(540, now + 0.45);
  sweepGain.gain.setValueAtTime(0.0001, now);
  sweepGain.gain.exponentialRampToValueAtTime(0.08, now + 0.06);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  sweep.connect(sweepGain);
  sweepGain.connect(c.destination);
  sweep.start(now);
  sweep.stop(now + 0.55);

  // Golden chime cluster (chord)
  const chord = [880, 1108.73, 1318.51, 1760];
  chord.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    const t = now + 0.32 + i * 0.04;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.75);
  });
}

// Big prize burst — uplifting ascending fanfare.
export function playPrizeBurst() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const seq = [659.25, 783.99, 987.77, 1318.51, 1568];
  seq.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "triangle";
    const t = now + i * 0.06;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
  // Sparkle high-shimmer
  const shim = c.createOscillator();
  const shimGain = c.createGain();
  shim.type = "sine";
  shim.frequency.setValueAtTime(2200, now + 0.3);
  shim.frequency.exponentialRampToValueAtTime(3400, now + 0.7);
  shimGain.gain.setValueAtTime(0.0001, now + 0.3);
  shimGain.gain.exponentialRampToValueAtTime(0.08, now + 0.32);
  shimGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
  shim.connect(shimGain);
  shimGain.connect(c.destination);
  shim.start(now + 0.3);
  shim.stop(now + 0.9);
}

// No-prize — soft minor descending "aww" (not punishing, just gentle).
export function playNoPrize() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const seq = [392, 349.23, 293.66];
  seq.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    const t = now + i * 0.16;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

// Click sound for picking a chest — short tactile pop.
export function playChestPick() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(540, now);
  osc.frequency.exponentialRampToValueAtTime(820, now + 0.08);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.13);
}
