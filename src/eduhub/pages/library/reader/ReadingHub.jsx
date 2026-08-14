// ReadingHub.jsx — P1: the single floating object inside ReaderPage.
//
// Replaces three independent floating widgets (book-audio mini player,
// EduTalk pill, Live Coach pill) with one AssistiveTouch/Dynamic-Island-
// style docked bubble that expands into a compact panel. This file owns
// ONLY layout, animation, docking, and visual state — it composes the
// three existing subsystems, it never replaces them:
//   • Audio module   — reads useBookAudio() directly (the SAME public hook
//     PersistentMiniPlayer already used). Zero changes to
//     AudioPlayerContext.jsx / BookAudioProvider; audio scheduling,
//     resume-position persistence, and the <audio> element itself are
//     completely untouched.
//   • EduTalk / Live Coach modules — read a small, read-only state object
//     (`{visible, label, isActive, onOpen}`) that EduTalkPanel.jsx /
//     EduTalkLiveCoach.jsx already report via their additive `onFabState`
//     prop (see those files' own comments). Tapping a row calls the EXACT
//     same `onOpen` those components' own fab always called — their
//     session/confirm/chat/overlay UI, WebSocket lifecycle, pricing, and
//     billing are entirely unmodified and continue to render themselves
//     (as an overlay) exactly as before. Reading Hub only decides whether
//     THEIR OWN small idle trigger renders (via `hideOwnFab`).
//
// State machine (per the P1 spec):
//   docked   — small circular bubble (or, while narration plays, a compact
//              player pill — Phase B "Narration Mode"), corner-anchored,
//              draggable, snaps to the nearest edge, rests partially
//              off-screen ("edge peek" — Phase B).
//   peek     — tap the bubble: compact vertical list of module rows,
//              ordered by MODULE_PRIORITY (Live Coach > EduTalk > Audio,
//              per Phase B "Context Awareness").
//   expanded — tap the Audio row: full scrub bar (play/pause/time/seek).
// Context priority — while EduTalk or Live Coach has taken over (their own
// full-screen-ish overlay is open), Hub auto-collapses to `docked` so it
// never competes with their UI ("no duplicated floating controls").
//
// Phase B module-slot design — MODULE_PRIORITY + the `rows` builder below
// are the seam future modules (Dictionary, Translation, Notes, ...) plug
// into: each module is a small `{key, priority, icon, label, sub, active,
// onTap}` descriptor. Adding one is adding a descriptor to this list, not
// redesigning the shell — the shell (bubble/peek/expanded chrome) never
// changes shape to accommodate a new module.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Play, Pause, Sparkles, MessageCircle, Mic, ChevronRight } from "lucide-react";
import { useBookAudio } from "./AudioPlayerContext";
import "./readingHub.css";

const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.9 };
const EDGE_MARGIN = 14; // px from the viewport edge once docked
// P2 audit fix — first-run discovery tooltip, dismissed forever per device.
const INTRO_SEEN_KEY = "eduhub_reading_hub_intro_seen";

// Phase B — Context Awareness §4: "Priority order: 1. Live Voice Coach
// 2. EduTalk 3. Audio." Lower number = higher priority = sorts first =
// drives both row order in `peek` and which module the docked bubble
// reflects when more than one is simultaneously available.
const MODULE_PRIORITY = { livecoach: 1, edutalk: 2, audio: 3 };

function fmtTime(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * useDockPosition — corner/edge docking. Starts bottom-right (per spec:
 * "defaults to the lower-right corner"). Drag is unconstrained during the
 * gesture; on release the bubble snaps to whichever vertical edge (left
 * or right) it ended up closer to, staying at its released height
 * (clamped to the viewport). Pure position bookkeeping — no visual state.
 */
function useDockPosition() {
  const [pos, setPos] = useState(null); // null = not yet measured; use CSS default (bottom-right)
  const dragStartedRef = useRef(false);

  const onDragStart = useCallback(() => { dragStartedRef.current = true; }, []);

  const onDragEnd = useCallback((_e, info) => {
    if (typeof window === "undefined") return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = info.point.x;
    const y = Math.min(Math.max(info.point.y, 80), vh - 80);
    const snapLeft = x < vw / 2;
    setPos({
      side: snapLeft ? "left" : "right",
      top: y,
    });
  }, []);

  return { pos, onDragStart, onDragEnd, dragStartedRef };
}

export default function ReadingHub({ eduTalk, liveCoach, celebrating = false }) {
  const audioCtx = useBookAudio();
  const prefersReducedMotion = useReducedMotion();
  const [hubState, setHubState] = useState("docked"); // docked | peek | expanded
  const { pos, onDragStart, onDragEnd, dragStartedRef } = useDockPosition();

  // P2 — Progressive Discovery: a first-time-only tooltip so a new user
  // learns the bubble exists and is safe to tap, without permanent copy
  // cluttering the reading surface. Dismissed forever (per device) after
  // the first tap, Escape, or a short timeout — never reappears for a
  // returning user, per the brief ("Disappears forever after dismissal.
  // Never repeatedly appears.").
  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(INTRO_SEEN_KEY) === "1";
    } catch {
      return true; // storage unavailable — fail toward "don't nag"
    }
  });
  const [showIntro, setShowIntro] = useState(false);
  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    setIntroDismissed(true);
    try { localStorage.setItem(INTRO_SEEN_KEY, "1"); } catch { /* noop */ }
  }, []);

  const audioHasTrack = !!audioCtx?.src;
  const audioPlaying = !!audioCtx?.playing;

  // Context priority — the moment EduTalk or Live Coach takes over (their
  // own overlay/sheet becomes the dominant UI), Hub gets out of the way.
  // `visible === false` from either module while the module itself is
  // authenticated/available means exactly that: a real session UI is open.
  const eduTalkTookOver = eduTalk && eduTalk.visible === false;
  const liveCoachTookOver = liveCoach && liveCoach.visible === false;
  useEffect(() => {
    if ((eduTalkTookOver || liveCoachTookOver) && hubState !== "docked") {
      setHubState("docked");
    }
  }, [eduTalkTookOver, liveCoachTookOver, hubState]);

  // Phase B — module descriptors, sorted by MODULE_PRIORITY. Memoized so
  // identity is stable across renders that don't actually change any
  // module's state (avoids handing AnimatePresence/row buttons fresh
  // closures every render for no reason — audit item "unnecessary
  // re-renders").
  const audioTimeLabel = audioHasTrack ? `${fmtTime(audioCtx.currentTime)} / ${fmtTime(audioCtx.duration)}` : "";
  const rows = useMemo(() => {
    const list = [
      audioHasTrack && {
        key: "audio",
        icon: audioPlaying ? Pause : Play,
        label: audioCtx?.meta?.title || "Narration",
        sub: audioTimeLabel,
        active: audioPlaying,
        onTap: () => setHubState("expanded"),
      },
      eduTalk?.visible && {
        key: "edutalk",
        icon: MessageCircle,
        label: "EduTalk",
        sub: eduTalk.label || "",
        active: !!eduTalk.isActive,
        onTap: () => { eduTalk.onOpen?.(); setHubState("docked"); },
      },
      liveCoach?.visible && {
        key: "livecoach",
        icon: Mic,
        label: "Live Coach",
        sub: liveCoach.label || "Available",
        active: false,
        onTap: () => { liveCoach.onOpen?.(); setHubState("docked"); },
      },
    ].filter(Boolean);
    // Phase B — Context Awareness §4 read literally: priority is about
    // which subsystem is ACTIVE ("Voice session active -> Coach occupies
    // primary slot... Narration only -> Compact Player"), not merely
    // available-but-idle. A genuinely active Live Coach session is never
    // in this list at all (its onFabState reports visible:false the
    // moment a session opens — see the auto-collapse effect above), so in
    // practice this tiebreak is: an active EduTalk session outranks
    // playing audio; playing audio outranks an idle-but-available
    // EduTalk/Coach row; among equally-active (or equally-idle) modules,
    // MODULE_PRIORITY (Coach > EduTalk > Audio) breaks the tie.
    list.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return MODULE_PRIORITY[a.key] - MODULE_PRIORITY[b.key];
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    audioHasTrack, audioPlaying, audioTimeLabel, audioCtx?.meta?.title,
    eduTalk?.visible, eduTalk?.label, eduTalk?.isActive, eduTalk?.onOpen,
    liveCoach?.visible, liveCoach?.label, liveCoach?.onOpen,
  ]);

  // P2 — show the intro tooltip once, a beat after the Hub first has
  // something to show (not instantly on page load — let the reading
  // surface settle first), and auto-dismiss it after a few seconds so it
  // never lingers or repeats. Only ever fires once per device (guarded by
  // `introDismissed`, which localStorage makes permanent).
  useEffect(() => {
    if (introDismissed || rows.length === 0 || hubState !== "docked" || celebrating) return;
    const showTimer = setTimeout(() => setShowIntro(true), 900);
    return () => clearTimeout(showTimer);
  }, [introDismissed, rows.length, hubState, celebrating]);
  useEffect(() => {
    if (!showIntro) return;
    const hideTimer = setTimeout(dismissIntro, 6000);
    return () => clearTimeout(hideTimer);
  }, [showIntro, dismissIntro]);

  // P2 audit fix — desktop keyboard-nav gap: peek/expanded had no
  // dismiss-via-keyboard path. Listener is scoped to only the two open
  // states and is torn down the instant hubState changes or the component
  // unmounts — no leak, matches the codebase's existing add/remove-on-
  // cleanup convention (e.g. ReaderPage's own resize/orientation listener).
  useEffect(() => {
    if (hubState === "docked") return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setHubState("docked");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hubState]);

  // P2 audit fix — a second, more serious keyboard-nav gap: AnimatePresence
  // swaps the docked bubble OUT of the DOM the instant peek/expanded mounts
  // (they're mutually-exclusive keyed children), so a keyboard user who
  // presses Enter/Space on the (now-focused) bubble to open it has their
  // focused element removed from the document entirely — focus silently
  // reverts to <body>, i.e. they lose their place and must Tab in again
  // from the top of the page. Moving focus onto the newly-opened panel
  // itself (a `tabIndex={-1}` container, the standard accessible-menu
  // pattern for "focus lands somewhere sane, not on a specific item")
  // keeps a keyboard/VoiceOver user's position continuous across the
  // transition.
  const panelRef = useRef(null);
  useEffect(() => {
    if (hubState !== "docked") panelRef.current?.focus();
  }, [hubState]);

  // Nothing to host at all (guest / feature-flags off / no audio) — render
  // nothing. This mirrors exactly what the three original widgets did
  // individually; the Hub adds no new always-on chrome.
  if (rows.length === 0) return null;

  // Phase C audit fix — "Reader always wins": the "You finished the book"
  // celebration is a real, brief (~3.2s), full-viewport moment. It renders
  // below Hub's own z-index and Hub has no way to know its content's
  // footprint, so the correct move per the audit ("does Reading Hub
  // improve this state? If not: collapse, hide, or move") is to hide
  // entirely for that one short window rather than risk floating over it.
  if (celebrating) return null;

  // Phase B — "Narration Mode": while audio is playing AND it's the
  // highest-priority thing available (no Live Coach/EduTalk row outranks
  // it), the docked bubble morphs into a compact player instead of a bare
  // icon. If Coach/EduTalk DO outrank it (per MODULE_PRIORITY), the docked
  // bubble reflects THEM instead — "the hub should automatically
  // prioritize the active subsystem."
  const primary = rows[0];
  const narrationMode = audioPlaying && primary.key === "audio";
  // P2 audit cleanup — the previous `audioHasTrack ? ... : BookOpen` fallback
  // was dead code: `primary` only ever comes from `rows`, and the only way
  // `primary.key === "audio"` is if `audioHasTrack` was already true when
  // that row was built, so the `BookOpen` branch could never execute.
  const PrimaryIcon = primary.key === "livecoach" ? Mic
    : primary.key === "edutalk" ? MessageCircle
    : (audioPlaying ? Pause : Play);

  // P2 audit fix — the previous object literal
  // `{ top, [pos.side]: EDGE_MARGIN, bottom: "auto", right: "auto", left: "auto" }`
  // had a real bug: in a JS object literal, a later LITERAL key always wins
  // over an earlier COMPUTED key of the same name, so `right: "auto"` /
  // `left: "auto"` (written after `[pos.side]`) silently overwrote whatever
  // `[pos.side]` had just set — every drag-to-edge-dock lost its horizontal
  // position entirely (verified with `node -e`, confirmed no test ever
  // asserted the resulting style). Fixed by setting both sides explicitly
  // instead of relying on a computed key, and wrapped the surviving side in
  // `max(EDGE_MARGIN, env(safe-area-inset-*))` — the CSS default already had
  // safe-area awareness for the right edge; a user-dragged dock to either
  // edge now gets the same protection (previously missing for the left
  // edge, and effectively missing everywhere due to the bug above).
  const dockStyle = pos
    ? {
        top: pos.top,
        bottom: "auto",
        left: pos.side === "left" ? `max(${EDGE_MARGIN}px, env(safe-area-inset-left))` : "auto",
        right: pos.side === "right" ? `max(${EDGE_MARGIN}px, env(safe-area-inset-right))` : "auto",
      }
    : undefined; // falls back to the CSS default (bottom-right)
  const peekSide = pos?.side || "right"; // default dock is bottom-RIGHT (see readingHub.css)
  // P2 audit fix — the icon is centered in the 46px bubble, so the previous
  // 28px peek offset (≈60% hidden) hid most of the icon itself: a first-
  // time user has no way to distinguish "intentionally docked assistant"
  // from "clipped/broken element" (the exact failure named in the brief:
  // "looks like a rendering bug rather than an intentional assistant").
  // Reduced so the icon stays legible while still reading as edge-anchored.
  const peekOffset = prefersReducedMotion ? 0 : (peekSide === "right" ? 14 : -14);

  const handleBubbleTap = () => {
    // A drag gesture also fires a click on release in some browsers;
    // suppress the tap-to-expand in that case so a drag never also opens.
    if (dragStartedRef.current) { dragStartedRef.current = false; return; }
    if (showIntro) dismissIntro();
    setHubState((s) => (s === "docked" ? "peek" : "docked"));
  };

  // P2 — Identity: at true idle (nothing active) the bubble otherwise shows
  // whichever module happens to be highest-priority-but-idle, which reads
  // as an arbitrary icon rather than a consistent "this is your reading
  // assistant" mark. A small, static, low-opacity sparkle badge (not
  // animated — the pulse already owns "something is happening") gives it a
  // stable identity without fighting the context-aware primary icon.
  const isIdle = !primary.active && !audioPlaying;

  return (
    <div
      className="reading-hub"
      data-state={hubState}
      data-testid="reading-hub"
      // Test observability only (mirrors the `data-motion-x` convention
      // used elsewhere) — jsdom's CSSOM can't parse `auto`/`env()`/`max()`
      // for top/left/right/bottom at all (confirmed: even a plain
      // `right: "auto"` string is silently dropped), so reading them back
      // via `.style.left`/`.right` is unreliable regardless of which side
      // of a real bug is being checked. `data-*` attributes accept any
      // string verbatim, so these mirror the actual JS values ReadingHub
      // computed — the drag-to-dock regression test asserts on these.
      data-dock-left={dockStyle ? String(dockStyle.left) : null}
      data-dock-right={dockStyle ? String(dockStyle.right) : null}
      style={dockStyle}
    >
      <AnimatePresence mode="wait">
        {hubState === "docked" && !narrationMode && (
          <motion.button
            key="docked"
            type="button"
            className="reading-hub__bubble"
            data-testid="reading-hub-bubble"
            aria-label="Open Reading Hub"
            drag
            dragMomentum={false}
            dragElastic={0.08}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onClick={handleBubbleTap}
            initial={prefersReducedMotion ? false : { scale: 0.6, opacity: 0, x: peekOffset }}
            animate={{ scale: 1, opacity: 1, x: peekOffset }}
            exit={prefersReducedMotion ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
            whileHover={{ x: 0 }}
            whileFocus={{ x: 0 }}
            whileTap={{ x: 0 }}
            whileDrag={{ x: 0 }}
            transition={SPRING}
          >
            <PrimaryIcon size={18} />
            {(primary.active || audioPlaying) && <span className="reading-hub__pulse" aria-hidden />}
            {isIdle && <Sparkles size={9} className="reading-hub__identity-mark" aria-hidden data-testid="reading-hub-identity-mark" />}
            {showIntro && (
              <span className="reading-hub__intro-tip" data-testid="reading-hub-intro" role="status">
                Reading Hub<br /><span className="reading-hub__intro-tip-sub">Your reading assistant</span>
              </span>
            )}
          </motion.button>
        )}

        {hubState === "docked" && narrationMode && (
          // Phase B — Narration Mode compact player. Stays fully visible
          // (no edge-peek transform) since it's actively surfacing useful
          // playback state, not just waiting to be discovered. Tapping the
          // pill (anywhere but the play/pause button) opens peek — "Coach
          // and EduTalk remain accessible from one tap."
          <motion.div
            key="narration"
            className="reading-hub__compact-player"
            data-testid="reading-hub-compact-player"
            role="button"
            tabIndex={0}
            aria-label="Now playing — open Reading Hub"
            onClick={handleBubbleTap}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleBubbleTap(); }}
            initial={prefersReducedMotion ? false : { scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { scale: 0.9, opacity: 0 }}
            transition={SPRING}
          >
            <button
              type="button"
              className="reading-hub__compact-toggle"
              data-testid="reading-hub-compact-toggle"
              aria-label={audioPlaying ? "Pause narration" : "Play narration"}
              onClick={(e) => {
                e.stopPropagation();
                (audioCtx.error ? audioCtx.retry : audioCtx.toggle)?.();
              }}
            >
              {audioPlaying ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <div className="reading-hub__compact-progress">
              <div
                className="reading-hub__compact-progress-fill"
                style={{
                  width: `${audioCtx.duration > 0 ? Math.min(100, (audioCtx.currentTime / audioCtx.duration) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="reading-hub__compact-time">{fmtTime(audioCtx.currentTime)}</span>
            {showIntro && (
              <span className="reading-hub__intro-tip" data-testid="reading-hub-intro" role="status">
                Reading Hub<br /><span className="reading-hub__intro-tip-sub">Your reading assistant</span>
              </span>
            )}
          </motion.div>
        )}

        {hubState === "peek" && (
          <motion.div
            key="peek"
            ref={panelRef}
            tabIndex={-1}
            className="reading-hub__panel reading-hub__panel--peek"
            data-testid="reading-hub-peek"
            role="menu"
            aria-label="Reading Hub"
            initial={prefersReducedMotion ? false : { scale: 0.9, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { scale: 0.9, opacity: 0, y: 8 }}
            transition={SPRING}
          >
            <div className="reading-hub__title">Reading Hub</div>
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                role="menuitem"
                className="reading-hub__row"
                data-testid={`reading-hub-row-${row.key}`}
                data-active={row.active ? "true" : "false"}
                onClick={row.onTap}
              >
                <row.icon size={15} className="reading-hub__row-icon" />
                <span className="reading-hub__row-label">{row.label}</span>
                {row.sub && <span className="reading-hub__row-sub">{row.sub}</span>}
                <ChevronRight size={13} className="reading-hub__row-chevron" />
              </button>
            ))}
            <button
              type="button"
              className="reading-hub__dismiss"
              data-testid="reading-hub-dismiss"
              onClick={() => setHubState("docked")}
              aria-label="Collapse Reading Hub"
            >
              Done
            </button>
          </motion.div>
        )}

        {hubState === "expanded" && audioHasTrack && (
          <motion.div
            key="expanded"
            ref={panelRef}
            tabIndex={-1}
            className="reading-hub__panel reading-hub__panel--expanded"
            data-testid="reading-hub-expanded"
            role="region"
            aria-label="Now playing"
            initial={prefersReducedMotion ? false : { scale: 0.9, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { scale: 0.9, opacity: 0, y: 8 }}
            transition={SPRING}
          >
            <button
              type="button"
              className="reading-hub__play-btn"
              data-testid="reading-hub-toggle"
              onClick={audioCtx.error ? audioCtx.retry : audioCtx.toggle}
              aria-label={audioPlaying ? "Pause narration" : "Play narration"}
            >
              {audioPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <div className="reading-hub__now-playing">
              <div className="reading-hub__now-playing-title">
                {audioCtx.error ? "Audio failed to load" : (audioCtx.meta?.title || "Narration")}
              </div>
              <div className="reading-hub__scrub">
                <div
                  className="reading-hub__scrub-fill"
                  style={{
                    width: `${audioCtx.duration > 0 ? Math.min(100, (audioCtx.currentTime / audioCtx.duration) * 100) : 0}%`,
                  }}
                />
              </div>
              <div className="reading-hub__time">
                {fmtTime(audioCtx.currentTime)} / {fmtTime(audioCtx.duration)}
              </div>
            </div>
            {rows.filter((r) => r.key !== "audio").map((row) => (
              <button
                key={row.key}
                type="button"
                className="reading-hub__mini-action"
                data-testid={`reading-hub-mini-${row.key}`}
                onClick={row.onTap}
                aria-label={row.label}
              >
                <row.icon size={14} />
              </button>
            ))}
            <button
              type="button"
              className="reading-hub__dismiss reading-hub__dismiss--corner"
              data-testid="reading-hub-collapse"
              onClick={() => setHubState("docked")}
              aria-label="Collapse Reading Hub"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
