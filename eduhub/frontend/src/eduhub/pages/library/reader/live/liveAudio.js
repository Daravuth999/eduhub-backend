/**
 * liveAudio.js — Web Audio helpers for EduTalk Live Coach.
 *
 * Capture : microphone → 16 kHz mono PCM16 → base64 chunks (sent to backend).
 * Playback: base64 PCM16 @ 24 kHz (from Gemini via backend) → speakers.
 *
 * Pure browser APIs, no external deps. Fully self-contained so it cannot
 * affect the existing narration audio player or EduTalk audio cache.
 */

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(buffer, fromRate, toRate) {
  if (toRate === fromRate) return buffer;
  const ratio = fromRate / toRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLen) {
    const nextOffset = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffset;
  }
  return result;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk)
    );
  }
  return btoa(binary);
}

function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Mic capture → onChunk(base64) callback. Returns a stop() function. */
export async function startMicCapture(onChunk, onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();

  // Re-audit finding (same class of bug as the BUG 2 playback fix below):
  // startMicCapture() is invoked from armMic(), itself triggered from an
  // onWsMessage "ready"/"greeting_state" handler — several awaits and a
  // network round-trip removed from the original Start-button gesture. On
  // iOS Safari in particular this context can be created already suspended,
  // and — like the playback context — can also drift to "suspended" mid-
  // session (background tab, OS audio-focus loss). A suspended capture
  // context does not throw on use; ScriptProcessorNode simply stops
  // delivering onaudioprocess callbacks, so mic audio silently stops being
  // sent with no error anywhere. Mirror the playback context's fix: resume
  // once eagerly, and again whenever onstatechange reports "suspended".
  try {
    ctx.onstatechange = () => {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => { /* will retry on the next statechange */ });
      }
    };
  } catch { /* onstatechange unsupported — extremely old browser, no-op */ }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => { /* onstatechange listener above will retry */ });
  }

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  source.connect(processor);
  processor.connect(ctx.destination);

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // RMS level for the orb animation.
    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      onLevel(Math.sqrt(sum / input.length));
    }
    const down = downsample(input, ctx.sampleRate, INPUT_RATE);
    const pcm16 = floatTo16BitPCM(down);
    onChunk(int16ToBase64(pcm16));
  };

  function stop() {
    try { processor.disconnect(); } catch { /* noop */ }
    try { source.disconnect(); } catch { /* noop */ }
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { ctx.close(); } catch { /* noop */ }
  }
  // P0-2 fix — mic-reliability gap. The onstatechange handler above (line
  // 84-93) already tries to self-heal a suspended CAPTURE context, mirroring
  // the playback context's fix — but unlike playback, capture had no SECOND
  // line of defense: EduTalkLiveCoach.jsx's visibilitychange handler already
  // resumes the playback player as defense-in-depth for exactly this
  // scenario (documented there as "one of the most common real-world
  // triggers"), but had no way to reach into this closure to do the same
  // for the mic, since only `stop` was ever exposed. A function can carry
  // properties in JS, so attaching `resume` here is a fully backward-
  // compatible addition — every existing `stopMicRef.current()` call site
  // keeps working unchanged; only new code that checks for `.resume` sees it.
  stop.resume = () => {
    try {
      return ctx.resume().catch(() => { /* iOS "gesture required" or already running/closed — noop */ });
    } catch { /* synchronous throw (e.g. context already closed) — noop */ }
  };
  return stop;
}

/** Sequential PCM16 player. Call enqueue(base64) for each coach audio chunk.
 *
 * Phase 0A greeting drain contract (additive — see
 * EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §B.6):
 *   - Normal interaction speaking/listening behaviour (`enqueue`,
 *     `setOnSpeaking`, `resume`, `close`) is preserved byte-for-byte.
 *   - A race-safe greeting drain waiter is added. It is armed ONLY after a
 *     matching greeting `turn_complete` (`beginDrainWait`) — never before — so
 *     `active` momentarily reaching zero between streamed chunks can never be
 *     mistaken for greeting completion.
 *   - `cancelPendingPlayback()` stops tracked sources, clears the waiter,
 *     resets scheduling, and invalidates the generation so a late `onended`
 *     from a stopped/stale source can never drive `active` negative or fire a
 *     stale callback.
 */
export function createAudioPlayer() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  let nextTime = 0;
  let active = 0;
  let onSpeaking = null;
  let speaking = false;

  // BUG 2 hardening ("coach suddenly stops speaking, transcript
  // continues"): browsers can suspend an AudioContext on their own at any
  // point mid-session — a background-tab power-saving policy, an OS-level
  // audio-focus loss on mobile, or (on Safari/iOS in particular) after a
  // period with no audio output. `resume()` was previously only ever
  // called once, at connect time (ws.onopen) — nothing noticed or reacted
  // if the context drifted back to "suspended" afterward. Critically, a
  // buffer source's `start()` on a suspended context does NOT throw; it
  // schedules silently and produces no audible output, so nothing in the
  // existing try/catch around enqueue() could ever have caught this. The
  // AudioContext itself is the one authoritative source of truth for its
  // own state, so listen to it directly and resume immediately whenever
  // it drifts away from "running" — this is a react-to-fact fix, not a
  // guess at WHY the browser suspended it.
  try {
    ctx.onstatechange = () => {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => { /* will retry on the next statechange or visibilitychange */ });
      }
    };
  } catch { /* onstatechange unsupported — extremely old browser, no-op */ }

  // Greeting drain contract state.
  const sources = new Set();        // live AudioBufferSourceNode instances
  let generation = 0;               // bumped on cancel/close to invalidate
  let drainWaiter = null;           // { token, callback, generation } | null

  function emitSpeaking(val) {
    if (val === speaking) return;
    speaking = val;
    if (onSpeaking) onSpeaking(val);
  }

  function maybeFireDrain() {
    if (!drainWaiter) return;
    if (active > 0) return;
    if (drainWaiter.generation !== generation) {
      drainWaiter = null;
      return;
    }
    const cb = drainWaiter.callback;
    drainWaiter = null;
    if (typeof cb === "function") cb();
  }

  function enqueue(b64) {
    const int16 = base64ToInt16(b64);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;
    const buffer = ctx.createBuffer(1, float32.length, OUTPUT_RATE);
    buffer.getChannelData(0).set(float32);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (nextTime < now) nextTime = now;
    src.start(nextTime);
    nextTime += buffer.duration;
    active++;
    const myGen = generation;
    sources.add(src);
    emitSpeaking(true);
    src.onended = () => {
      sources.delete(src);
      // Ignore an onended that belongs to an invalidated generation (e.g. after
      // cancelPendingPlayback) so `active` is never driven negative and a stale
      // drain callback can never fire.
      if (myGen !== generation) return;
      if (active > 0) active--;
      if (active <= 0) emitSpeaking(false);
      maybeFireDrain();
    };
  }

  return {
    enqueue,
    setOnSpeaking(cb) { onSpeaking = cb; },
    resume() { try { return ctx.resume(); } catch { /* noop */ } },
    close() {
      // Invalidate the generation + any waiter BEFORE closing the context so a
      // late callback can never fire after close.
      generation++;
      drainWaiter = null;
      sources.clear();
      try { ctx.close(); } catch { /* noop */ }
    },

    // ── Greeting drain contract ────────────────────────────────────────────
    /** Arm a one-shot drain waiter. Call ONLY after a matching greeting
     *  turn_complete. One waiter at a time; the latest call replaces a prior
     *  waiter. If already idle, schedules the callback asynchronously. */
    beginDrainWait(token, callback) {
      drainWaiter = { token, callback, generation };
      if (active <= 0) {
        // Already idle after turn completion → fire on a future tick.
        const gen = generation;
        const cb = callback;
        const tk = token;
        Promise.resolve().then(() => {
          if (drainWaiter && drainWaiter.token === tk &&
              drainWaiter.generation === gen && active <= 0) {
            drainWaiter = null;
            if (typeof cb === "function") cb();
          }
        });
      }
      return token;
    },

    /** Cancel only the matching waiter. */
    cancelDrainWait(token) {
      if (drainWaiter && drainWaiter.token === token) drainWaiter = null;
    },

    /** Stop tracked sources, clear the waiter, reset scheduling, invalidate the
     *  generation, and emit onSpeaking(false) once if needed. */
    cancelPendingPlayback() {
      generation++;
      drainWaiter = null;
      for (const src of sources) {
        try { src.stop(); } catch { /* noop */ }
        try { src.disconnect(); } catch { /* noop */ }
      }
      sources.clear();
      active = 0;
      nextTime = 0;
      emitSpeaking(false);
    },

    /** Read-only generation token for tests / controller checks. */
    getGeneration() { return generation; },
  };
}
