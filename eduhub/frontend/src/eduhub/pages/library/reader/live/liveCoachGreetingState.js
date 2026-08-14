/**
 * liveCoachGreetingState.js — PURE attempt-scoped greeting lifecycle controller
 * for the EduTalk Live Coach.
 *
 * NO React dependency. NO timers. NO side effects. The controller is the single
 * source of truth that decides WHEN the microphone may be armed for a greeting
 * attempt. `EduTalkLiveCoach.jsx` owns the actual sockets/timers/mic and feeds
 * frames + watchdog events into this controller; the controller returns whether
 * an action (notably mic arming) should happen, and guarantees mic arming is
 * idempotent and can never happen from a stale attempt or stale connection
 * generation.
 *
 * Locked behaviour (see EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §B.1–B.5):
 *   - Every `ws.onopen` increments a connection generation and creates a fresh
 *     pending greeting slot (`onConnectionOpen`). All prior attempts, timers,
 *     and callbacks for the old generation are invalidated.
 *   - `greeting_state=requested` (authoritative, carries a server attempt id) is
 *     authoritative for the generation. A legacy `coach_greeting_sent` frame is
 *     ONLY ever treated as `requested` and NEVER arms the mic. When no
 *     authoritative attempt is active the legacy frame creates a synthetic
 *     `legacy:<generation>` attempt id; when an authoritative attempt is already
 *     active the later legacy frame must not reset/replace it.
 *   - Mic arms only after matching greeting `turn_complete` AND a safe playback
 *     drain — or via a controlled fallback that first cancels local greeting
 *     playback (and, on the new backend, waits for the matching
 *     `greeting_state=cancelled` acknowledgement).
 *   - Stale attempt ids / stale connection generations can never arm the mic.
 *   - A generic interaction `turn_complete` after the greeting boundary can
 *     never reopen the gate.
 */

/** Watchdog timeout constants (ms). Owned here so the controller + component +
 *  tests share one source of truth. Replaces the single 4s blanket timer. */
export const GREETING_TIMEOUTS = Object.freeze({
  GREETING_REQUEST_TIMEOUT_MS: 5000,
  GREETING_FIRST_AUDIO_TIMEOUT_MS: 8000,
  GREETING_TURN_COMPLETE_TIMEOUT_MS: 20000,
  GREETING_PLAYBACK_DRAIN_TIMEOUT_MS: 10000,
});

export const GREETING_STATUS = Object.freeze({
  IDLE: "idle",
  AWAITING_REQUEST: "awaiting_request",
  REQUESTED: "requested",
  FIRST_AUDIO: "first_audio",
  TURN_COMPLETE: "turn_complete",
  DRAINED: "drained",
  ARMED: "armed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  SKIPPED: "skipped",
});

const ARM_TRIGGER = Object.freeze({
  PLAYBACK_COMPLETE: "playback_complete",
  CONTROLLED_FALLBACK: "controlled_fallback",
  SKIP: "skip",
});

/**
 * Create a fresh greeting controller. Returns an imperative API; every method
 * is pure with respect to external systems (only mutates internal state) and
 * returns a small descriptor of what the caller should do.
 */
export function createGreetingController() {
  let generation = 0;
  let destroyed = false;

  // Per-attempt state (reset on every connection open).
  let s = freshAttemptState();

  function freshAttemptState() {
    return {
      attemptId: null,
      isAuthoritative: false, // true once an authoritative `requested` arrives
      status: GREETING_STATUS.IDLE,
      firstAudioSeen: false,
      turnCompleteSeen: false,
      playbackDrained: false,
      fallbackRequested: false,
      fallbackReason: "",
      cancelled: false,
      playbackCancelled: false,
      awaitingCancelAck: false,
      cancelAckReceived: false,
      micArmed: false,
      skipped: false,
    };
  }

  /** A frame/event is stale if its generation or attempt id does not match the
   *  controller's currently-active generation/attempt. */
  function isStale(p) {
    if (destroyed) return true;
    if (!p) return false;
    if (p.connectionGeneration != null && p.connectionGeneration !== generation) {
      return true;
    }
    // If we already have an active attempt id and the event names a different
    // one, it is stale. (Untagged events — attemptId undefined — belong to the
    // active attempt during a pending greeting.)
    if (p.attemptId != null && s.attemptId != null && p.attemptId !== s.attemptId) {
      return true;
    }
    return false;
  }

  /** Decide whether the mic should be armed now. Idempotent: arms at most once. */
  function evaluateArm() {
    if (s.micArmed) return { armMic: false };
    // Normal success path.
    if (s.turnCompleteSeen && s.playbackDrained && !s.cancelled) {
      s.micArmed = true;
      s.status = GREETING_STATUS.ARMED;
      return { armMic: true, trigger: ARM_TRIGGER.PLAYBACK_COMPLETE };
    }
    // Controlled fallback path: local playback must be cancelled first, and on
    // the authoritative (new backend) path the server `cancelled` ack must have
    // arrived before we arm.
    if (
      s.fallbackRequested &&
      s.playbackCancelled &&
      (!s.awaitingCancelAck || s.cancelAckReceived)
    ) {
      s.micArmed = true;
      s.status = GREETING_STATUS.ARMED;
      return { armMic: true, trigger: ARM_TRIGGER.CONTROLLED_FALLBACK };
    }
    return { armMic: false };
  }

  return {
    /** New socket open: bump generation, invalidate prior attempt, fresh slot. */
    onConnectionOpen() {
      destroyed = false;
      generation += 1;
      s = freshAttemptState();
      s.status = GREETING_STATUS.AWAITING_REQUEST;
      return { connectionGeneration: generation };
    },

    /** Authoritative greeting request (server attempt id). Never arms. */
    onServerRequested(p = {}) {
      if (isStale(p)) return { stale: true };
      if (s.micArmed || s.cancelled) return { ignored: true };
      s.attemptId = p.attemptId != null ? p.attemptId : s.attemptId;
      s.isAuthoritative = true;
      if (s.status === GREETING_STATUS.IDLE || s.status === GREETING_STATUS.AWAITING_REQUEST) {
        s.status = GREETING_STATUS.REQUESTED;
      }
      return { status: GREETING_STATUS.REQUESTED, attemptId: s.attemptId, authoritative: true };
    },

    /** Bug 6 — authoritative `greeting_state=skipped` (reconnect skip). The
     *  backend proved a prior attempt was acknowledged complete
     *  (mic_armed / playback_complete), so there is NO greeting replay this
     *  generation. Adopt/validate the authoritative attempt id for the current
     *  generation, mark the greeting boundary already complete, and arm the
     *  mic EXACTLY ONCE through the explicit skip path — never via a timeout.
     *  A stale skipped frame from an old socket generation can never arm. */
    onSkipped(p = {}) {
      if (isStale(p)) return { stale: true, armMic: false };
      if (s.micArmed) {
        return { ignored: true, armMic: false, attemptId: s.attemptId };
      }
      // Adopt the authoritative attempt id for THIS generation.
      if (p.attemptId != null) s.attemptId = p.attemptId;
      s.skipped = true;
      s.isAuthoritative = true;
      // The greeting boundary is already complete on a skip — record it so a
      // late/duplicate greeting frame can never reopen the gate.
      s.turnCompleteSeen = true;
      s.playbackDrained = true;
      s.micArmed = true;
      s.status = GREETING_STATUS.ARMED;
      return { armMic: true, trigger: ARM_TRIGGER.SKIP, attemptId: s.attemptId };
    },

    /** Legacy `coach_greeting_sent`. Treated ONLY as requested; never arms. */
    onLegacyGreetingSent(p = {}) {
      if (p && p.connectionGeneration != null && p.connectionGeneration !== generation) {
        return { stale: true };
      }
      if (destroyed) return { stale: true };
      if (s.micArmed || s.cancelled) return { ignored: true };
      if (s.isAuthoritative) {
        // An authoritative attempt is active — the later legacy frame must not
        // reset or replace it. Treat as requested only.
        return { treatedAs: GREETING_STATUS.REQUESTED, replaced: false };
      }
      // No authoritative attempt → synthesise a local attempt id.
      if (s.attemptId == null) {
        s.attemptId = p.attemptId != null ? p.attemptId : `legacy:${generation}`;
      }
      s.isAuthoritative = false;
      if (s.status === GREETING_STATUS.IDLE || s.status === GREETING_STATUS.AWAITING_REQUEST) {
        s.status = GREETING_STATUS.REQUESTED;
      }
      return { treatedAs: GREETING_STATUS.REQUESTED, attemptId: s.attemptId, legacy: true };
    },

    /** First greeting audio for the attempt. Never arms. */
    onFirstAudio(p = {}) {
      if (isStale(p)) return { stale: true };
      if (s.cancelled || s.micArmed) return { ignored: true };
      // Untagged audio during a pending greeting belongs to the active attempt.
      if (s.attemptId == null && p.attemptId != null) s.attemptId = p.attemptId;
      s.firstAudioSeen = true;
      if (s.status === GREETING_STATUS.REQUESTED) s.status = GREETING_STATUS.FIRST_AUDIO;
      return { firstAudioSeen: true };
    },

    /** Matching greeting turn completion. Marks the greeting boundary; arms the
     *  drain waiter in the caller. Does NOT arm the mic by itself. Idempotent
     *  (explicit + legacy generic both acceptable). A turn_complete after the
     *  gate already armed can never reopen it. */
    onTurnComplete(p = {}) {
      if (isStale(p)) return { stale: true };
      if (s.micArmed) return { ignored: true, reason: "already_armed" };
      if (s.cancelled) return { ignored: true, reason: "cancelled" };
      if (s.turnCompleteSeen) {
        return { turnCompleteSeen: true, accepted: false, alreadyComplete: true };
      }
      s.turnCompleteSeen = true;
      s.status = GREETING_STATUS.TURN_COMPLETE;
      // Adopt a synthetic attempt id if none yet (pure-legacy generic boundary).
      if (s.attemptId == null) s.attemptId = `legacy:${generation}`;
      return { turnCompleteSeen: true, accepted: true, armDrainWait: true, attemptId: s.attemptId };
    },

    /** Playback fully drained after the greeting turn. May arm the mic. */
    onPlaybackDrained(p = {}) {
      if (isStale(p)) return { stale: true, armMic: false };
      if (s.cancelled || s.micArmed) return { ignored: true, armMic: false };
      if (!s.turnCompleteSeen) {
        // A drain that completes BEFORE turn completion must never arm.
        return { ignored: true, armMic: false, reason: "no_turn_complete" };
      }
      s.playbackDrained = true;
      if (s.status === GREETING_STATUS.TURN_COMPLETE) s.status = GREETING_STATUS.DRAINED;
      return evaluateArm();
    },

    /** A watchdog (or backend `failed`) requests a controlled fallback. The
     *  caller MUST cancel local greeting playback before the mic can arm. */
    requestFallback(p = {}) {
      if (p && p.connectionGeneration != null && p.connectionGeneration !== generation) {
        return { stale: true };
      }
      if (destroyed) return { stale: true };
      if (s.micArmed) return { ignored: true };
      // A request-timeout fallback may fire before any attempt id exists.
      if (s.attemptId == null) {
        s.attemptId = `legacy:${generation}`;
        s.isAuthoritative = false;
      }
      s.fallbackRequested = true;
      s.cancelled = true;
      s.fallbackReason = p.reason || "fallback_requested";
      s.status = GREETING_STATUS.CANCELLED;
      // New backend (authoritative attempt) → wait for matching cancelled ack.
      s.awaitingCancelAck = s.isAuthoritative === true;
      return {
        needPlaybackCancel: true,
        awaitCancelAck: s.awaitingCancelAck,
        attemptId: s.attemptId,
        reason: s.fallbackReason,
      };
    },

    /** Backend reported the greeting `failed` (e.g. kicker_send_failed). Enter
     *  the controlled fallback path; no server `cancelled` ack will follow. */
    onFailed(p = {}) {
      if (isStale(p)) return { stale: true };
      if (s.micArmed) return { ignored: true };
      if (s.attemptId == null) {
        s.attemptId = p.attemptId != null ? p.attemptId : `legacy:${generation}`;
      }
      s.fallbackRequested = true;
      s.cancelled = true;
      s.awaitingCancelAck = false;
      s.fallbackReason = p.reason || "failed";
      s.status = GREETING_STATUS.FAILED;
      return { needPlaybackCancel: true, awaitCancelAck: false, attemptId: s.attemptId };
    },

    /** Local greeting playback cancellation finished. May arm via fallback. */
    onPlaybackCancelled(p = {}) {
      if (isStale(p)) return { stale: true };
      if (s.micArmed) return { ignored: true };
      s.playbackCancelled = true;
      return evaluateArm();
    },

    /** Server `greeting_state=cancelled` acknowledgement (new backend). */
    onCancelledAck(p = {}) {
      if (isStale(p)) return { stale: true };
      if (s.micArmed) return { ignored: true };
      s.cancelAckReceived = true;
      s.cancelled = true;
      s.fallbackRequested = true;
      return evaluateArm();
    },

    /** Read-only snapshot for the component / tests. */
    getState() {
      return { ...s, connectionGeneration: generation, destroyed };
    },

    getGeneration() {
      return generation;
    },

    getAttemptId() {
      return s.attemptId;
    },

    micIsArmed() {
      return s.micArmed;
    },

    /** Centralised teardown: invalidate generation + attempt so any in-flight
     *  timer/callback for the old generation is rejected as stale. */
    cleanup() {
      destroyed = true;
      generation += 1;
      s = freshAttemptState();
      return { connectionGeneration: generation };
    },
  };
}

export default createGreetingController;
