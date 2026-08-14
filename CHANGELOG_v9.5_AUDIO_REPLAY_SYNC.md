# v9.5 — AI Voice Transcript Replay-Sync Fix

**Date:** 2026-05-15
**Scope:** PWA frontend reader only. **Backend, Push Notifications, Teacher/Author Studio APIs unchanged.**

---

## TL;DR

Word-level transcript highlighting now stays synchronized with the audio
narration on replay, pause/resume, and page switching. The first-playback
behaviour (already correct) is preserved.

---

## Bug report

> **Bug:** AI voice transcript sync fails during replay.
>
> First playback syncs correctly on the Author studio's Preview. But the
> frontend book incorrectly or missed-matches the transcript when the user
> replays. Replay causes transcript delay, mismatch, freeze, or desync.

---

## Root cause

Two coupled defects in the shared audio engine
(`AudioPlayerContext.jsx`) created a one-frame state desync at the start
of every replay:

1.  **`onEnded` lied about the DOM clock.** The handler reset React
    `currentTime` to `0` with the comment *"sync React state to the 0 the
    element will seek to on replay"* — but HTML5 `<audio>` does **not**
    auto-rewind on the `ended` event. Only `loop` does. The element's
    `currentTime` stayed pinned at `duration` until the next `play()`
    call. So React state said `0` while the DOM said `duration`.

2.  **`play()` / `toggle()` relied on the browser's implicit rewind.**
    Spec-compliant browsers DO rewind a finished `<audio>` element when
    `play()` is invoked, but the event ordering around that implicit
    seek (`timeupdate` / `play` / `seeking` / `seeked`) is
    browser-dependent. In practice a final `timeupdate` could fire with
    `currentTime ≈ duration` AFTER the `play` event but BEFORE the
    auto-seek lands at 0 — flipping React `currentTime` back to
    `~duration` for one frame.

During that one frame, every `TranscriptParagraph` whose `[start, end]`
window lay before the spurious `duration` reading hit the
`t >= e` branch and set `active = words.length - 1` — every word fully
highlighted. The next clean `timeupdate` at `t≈0` cleared them again.
The visible artefact: **a flash of fully-highlighted paragraphs at the
moment of replay, followed by a brief catch-up where word highlighting
lags the actual audio.**

The Author Studio Preview was unaffected because it uses a separate
`<audio>` element (`ChapterAudioScrubber`) with no transcript-sync
coupling — which is why the bug only manifested on the frontend reader.

---

## Affected components

| File                                                                                | Role                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/eduhub/pages/library/reader/AudioPlayerContext.jsx`                            | Shared audio engine — `onEnded`, `play`, `toggle`, `retry` |
| `src/eduhub/pages/library/reader/ChapterBlocks.jsx` → `TranscriptParagraph`         | Word-by-word highlight logic (consumer of `currentTime` / `playing`) |

Not modified — explicitly verified untouched:
- `AssistantBackend.Code.gs`, `AuthorStudio.Code.gs`, `PortalBackend.Code.gs`, and every other `.gs` backend file
- Push Notification registration (`public/sw.js`)
- `StudioEditor.jsx` (Author Studio editor)
- `ChapterAudioScrubber` (Author Studio preview audio)
- `server.py`, `content_parser.py`, `restriction_realtime.py` (Python backend)

---

## Fix implementation

### `AudioPlayerContext.jsx`

**`onEnded`** — explicitly rewind the DOM `<audio>` element to 0 before
touching React state, so DOM === React from the instant playback ends.
Guarded with `Number.isFinite(el.duration)` and a try/catch so metadata-
not-loaded edge cases don't throw.

**`play()`** — defensive explicit rewind: if `currentTime` is within
0.05s of `duration`, set `currentTime = 0` and React `currentTime = 0`
before calling `el.play()`. Eliminates the browser-event-ordering race.
The 0.05s tolerance band absorbs the floating-point drift the browser's
own end-detection uses.

**`toggle()`** — same defensive rewind. This is the hot path: the
mini-player button and every in-chapter `AudioBlock` play button both
call `audio.toggle()`, so this is where 99% of replays originate.

**`retry()`** — sets React `currentTime = 0` after `el.load()` to make
sure any stale `timeupdate` from before the error doesn't leak through.

### `ChapterBlocks.jsx` — `TranscriptParagraph`

**Stale-ref cleanup**: `wordsRef.current` is now truncated when the
`words` array shrinks. Previously, when a paragraph's text was edited or
the component re-rendered with shorter content, stale refs to unmounted
`<span>`s remained — and the `scrollIntoView` effect could target a
detached node, contributing to "freeze" symptoms after a page-switch +
return cycle during playback.

**Pause/resume UX preserved**: the `!audio.playing && t === 0` reset
predicate is deliberately kept narrow (NOT widened to `!audio.playing`),
so pausing mid-paragraph still shows the current word highlighted —
matching student expectation. The companion `onEnded` fix makes the
narrow predicate fire correctly at end-of-track because it now
guarantees `t === 0` after a track finishes.

---

## Backwards compatibility

- Same `BookAudioContext` value shape — no consumer changes required.
- Same `TranscriptParagraph` props: `text`, `start`, `end`, `wordTimestamps`.
- Same DOM / CSS — `transcript-para`, `transcript-word`, `data-state`,
  `data-active` all unchanged.
- `wordTimestamps` (ElevenLabs override path) follows the same
  pause/resume + replay reset semantics as the weighted-estimation path,
  so per-word-timed paragraphs and weighted-estimation paragraphs
  behave identically on replay.
- No changes to: persisted progress format (`eduhub_reader_audio_progress`),
  speed preference (`eduhub_reader_speed`), or volume preference
  (`eduhub_reader_volume`).
- No changes to backend payloads or APIs.

---

## Tests

Added `src/__patch_audit_tests__/audio-replay-sync.test.js` covering:

- `onEnded` rewinds DOM `currentTime` and updates React state coherently
- `onEnded` is safe with `NaN` duration (metadata-not-loaded)
- `play()` rewinds at `duration`, within the 0.05s tolerance band, and
  is a no-op mid-track on pause/resume
- `play()` is a no-op when `src` is empty
- `TranscriptParagraph` clears between replays, preserves
  pause-mid-paragraph highlight, computes correct active index across
  the full lifecycle
- End-to-end replay cycle: play → end → onEnded → replay → first
  `timeupdate` — all clocks remain in sync

Runnable via the standard CRA test harness:

```bash
yarn test --testPathPattern=audio-replay-sync
```

---

## Verification checklist

- [x] First playback still syncs (regression-free)
- [x] Replay no longer flashes / freezes / desyncs word highlights
- [x] Pause/resume preserves the current word highlight
- [x] Page switching during playback keeps audio uninterrupted (existing
      `BookAudioProvider` behaviour preserved)
- [x] Mini-player scrub bar, speed pill, volume slider unaffected
- [x] Cloudflare R2, Dropbox, Drive, and direct-URL audio still resolve
      via `normalizeMediaUrl` (unchanged)
- [x] No backend changes
- [x] No Push Notification changes
- [x] No Author Studio editor / preview changes
