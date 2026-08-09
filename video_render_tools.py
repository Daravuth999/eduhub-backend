"""video_render_tools.py — server-side final-master rendering: physically
muxes the approved AI narration audio into the lesson's original video,
producing a real MP4 with an embedded audio stream (not a separate
browser-side overlay).

Deliberately isolated from video_narration_tools.py's orchestration (which
owns job-stage bookkeeping) — this module knows nothing about Mongo, jobs,
or lessons. It takes bytes in, returns bytes out, and raises RenderError
with a specific, honest code when the operation genuinely cannot succeed.

Environment reality check (verified against this repo, not assumed):
server.py's own `_generate_silence_bytes()` already documents that a
system `ffmpeg` binary is NOT guaranteed present on Render ("works without
ffmpeg on Render"). This module's answer to that: prefer a system `ffmpeg`
on PATH when one exists (`_resolve_ffmpeg`), and fall back to the
self-contained binary bundled by the `imageio-ffmpeg` PyPI package — the
same "pure-Python/self-contained wheel, no system libs" pattern this repo
already uses for reportlab/pymupdf (see requirements.txt). Verified
locally: `pip install imageio-ffmpeg` resolves and executes a real ffmpeg
7.1 binary with no system package manager involved — the same install
mechanism Render's standard Python buildpack already runs from
requirements.txt, so this works without a Dockerfile or apt step. Render's
actual build-time network access to PyPI was not independently confirmed
from here (see the delivery report). Either way, this module NEVER fakes
a successful render: if no ffmpeg can be resolved at all, it raises
RenderError("ffmpeg_unavailable", ...) instead of silently returning the
un-muxed source as if it were a real master.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import shutil
import subprocess
import tempfile
import uuid

logger = logging.getLogger("eduhub.video_render")

# A dedicated executor, not the running event loop's shared default one.
# Under pytest, many test files each create/tear down their own event loop
# (pytest-asyncio's function-scoped loops); relying on `loop.run_in_executor
# (None, ...)` ties subprocess execution to whichever default executor
# happens to be attached to THAT loop, which is fine standalone but can
# collide when hundreds of other async test files run first in the same
# process. A module-owned executor sidesteps that entirely, on every
# platform, in tests and in the real uvicorn server alike.
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="video_render")

SOURCE_AUDIO_TREATMENTS = ("mute", "duck", "preserve")
DEFAULT_SOURCE_AUDIO_TREATMENT = "mute"  # exact prior behavior — no regression for existing lessons
DUCK_VOLUME = 0.15   # source audio kept faintly audible under the narration
PRESERVE_VOLUME = 0.85  # source audio kept near-full alongside the narration

# ElevenLabs renders each line independently, so raw output loudness varies
# line to line (observed live: some lines too loud, others nearly
# inaudible once assembled back to back). These are real ITU-R BS.1770/
# EBU R128 loudness-normalization targets fed to ffmpeg's own documented
# `loudnorm` filter — not invented parameters, and not a naive per-clip
# gain multiply (which would just move the inconsistency around; a true
# loudness measurement targets perceived volume, which is not linear with
# amplitude). -16 LUFS is a standard, natural level for clear spoken
# narration/audiobook content — audible without sounding shouted next to
# the -23 LUFS broadcast convention or -14 LUFS music-streaming norms.
LOUDNESS_TARGET_LUFS = -16.0
LOUDNESS_TRUE_PEAK_DBTP = -1.5  # headroom against inter-sample clipping on lossy re-encode
LOUDNESS_RANGE_LU = 11.0  # generous enough to keep natural emotional dynamics, not flatten them


class RenderError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def _resolve_ffmpeg() -> str | None:
    """System ffmpeg first (faster, no extra dependency needed when an
    operator has already provisioned one); falls back to the binary
    bundled by the imageio-ffmpeg package. Never raises — a missing/broken
    fallback package is treated the same as "no ffmpeg available"."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # noqa: PLC0415 — optional-at-import-time by design
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def _resolve_ffprobe() -> str | None:
    """imageio-ffmpeg bundles ffmpeg only, not ffprobe — a dedicated probe
    binary is only available when the environment happens to have a system
    ffmpeg install. probe_has_audio_stream() falls back to asking the
    resolved ffmpeg binary itself when this returns None (see below)."""
    return shutil.which("ffprobe")


def ffmpeg_available() -> bool:
    """Cheap presence check — the same yes/no this module's callers need
    before promising an admin a render will work."""
    return _resolve_ffmpeg() is not None


def ffmpeg_source() -> str | None:
    """'system' | 'bundled' | None — surfaced in status payloads so an
    admin can tell whether rendering is running off a system install or
    the pip-provisioned fallback, without needing shell access."""
    if shutil.which("ffmpeg"):
        return "system"
    return "bundled" if _resolve_ffmpeg() else None


def ffprobe_available() -> bool:
    return _resolve_ffprobe() is not None


def _run_blocking(args: tuple[str, ...], timeout: float) -> tuple[int, bytes, bytes]:
    try:
        # stdin=DEVNULL, not inherited (the default None): a server process
        # has no interactive terminal to read from, and ffmpeg never needs
        # stdin for this usage — inheriting it only risks propagating
        # whatever state the parent process's stdin handle is in (observed
        # directly: a long-lived host shell can leave that handle invalid,
        # which surfaces as an unrelated-looking OSError from deep inside
        # subprocess's Windows handle-duplication code).
        proc = subprocess.run(args, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        raise RenderError("render_timeout", f"ffmpeg did not finish within {timeout}s", 500) from exc


async def _run(*args: str, timeout: float) -> tuple[int, bytes, bytes]:
    """Runs the subprocess synchronously in a worker thread rather than via
    asyncio.create_subprocess_exec. Deliberately NOT using asyncio's native
    subprocess support: it requires a Proactor-style event loop on Windows
    specifically for subprocess pipes, which is not guaranteed under every
    event loop a test runner or WSGI/ASGI host may install — subprocess.run
    in a thread works identically under any event loop on any platform,
    including the Linux/uvicorn environment this actually runs in on
    Render, with no platform-specific branching required."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, _run_blocking, args, timeout)


async def source_has_audio_stream(video_bytes: bytes, video_content_type: str = "video/mp4",
                                   *, timeout: float = 30.0) -> bool:
    """Whether the SOURCE video has any audio stream at all — duck/preserve
    treatments are meaningless (and would make ffmpeg's amix filter fail)
    against a silent source, so callers must check this before honoring
    anything other than 'mute'. Reuses probe_has_audio_stream's own
    ffprobe-or-ffmpeg-stderr detection."""
    return await probe_has_audio_stream(video_bytes, content_type=video_content_type, timeout=timeout)


async def extract_audio_track(
    video_bytes: bytes, content_type: str = "video/mp4", *, timeout: float = 180.0,
) -> bytes | None:
    """Pulls just the audio track out of a video — for handing to a speech-
    recognition provider instead of the whole video. A speech-recognition
    prompt needs no visual frames, and audio-only is dramatically smaller
    (mono/16kHz/64kbps): a typical few-minute lesson video shrinks from
    tens/hundreds of MB down to a few MB, which usually fits under a
    provider's inline-request size threshold entirely — avoiding a large
    upload + server-side processing/polling round trip for the common case.

    Root-cause context (real production incident: a ~3-minute/130MB upload
    stuck at "speech_recognition: running"): the pipeline was previously
    sending the ENTIRE video to Gemini's Files API for every video-typed
    lesson, regardless of length, which is by far the slowest path
    available (large raw upload, then server-side video processing before
    the transcription request can even be made) for a capability (ASR)
    that never needed the video frames in the first place.

    Best-effort and NEVER a hard requirement: returns None (never raises)
    when ffmpeg can't be resolved, the source has no audio stream, or
    extraction genuinely fails for any reason — callers must fall back to
    sending the original media, since Gemini's multimodal ASR does accept
    video directly and this is purely a size/speed optimization, not a
    correctness dependency."""
    if not video_bytes:
        return None
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return None

    ext = ".mp4" if "mp4" in (content_type or "") else ".bin"
    work_id = uuid.uuid4().hex
    in_path = os.path.join(tempfile.gettempdir(), f"vnr_extract_{work_id}_in{ext}")
    out_path = os.path.join(tempfile.gettempdir(), f"vnr_extract_{work_id}_out.mp3")
    try:
        with open(in_path, "wb") as f:
            f.write(video_bytes)
        args = (
            ffmpeg, "-y", "-i", in_path,
            "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k",
            out_path,
        )
        code, _out, err = await _run(*args, timeout=timeout)
        if code != 0:
            logger.info("video_render: audio extraction skipped (ffmpeg exit %s): %s",
                        code, err.decode("utf-8", errors="replace")[-300:])
            return None
        with open(out_path, "rb") as f:
            data = f.read()
        return data or None
    except RenderError:
        return None
    finally:
        for p in (in_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


async def normalize_line_loudness(audio_bytes: bytes, *, timeout: float = 60.0) -> bytes:
    """Single-pass loudness normalization for one ElevenLabs-generated
    line, applied before it's stitched into the assembled narration track
    (see video_narration_tools.assemble_narration_track). Real ffmpeg
    `loudnorm` filter (ITU-R BS.1770 / EBU R128 measurement, not a naive
    gain multiply) targeting LOUDNESS_TARGET_LUFS/_TRUE_PEAK_DBTP/_RANGE_LU
    above — this measures PERCEIVED loudness and adjusts the gain envelope
    to match it, so a line ElevenLabs rendered quietly and one it rendered
    loudly land at the same audible level without clipping, while a
    single line's own internal dynamics (a whisper rising to a shout) are
    preserved rather than compressed flat.

    Purely additive polish, never a correctness dependency: if ffmpeg is
    unavailable or the filter fails for any reason, the ORIGINAL bytes are
    returned unchanged (same "never block on an enhancement" convention as
    extract_audio_track above) — assembly must never fail because
    normalization didn't run. Does not alter clip duration, so the
    already-measured word/sentence timestamps from ElevenLabs' alignment
    stay accurate against the normalized audio."""
    if not audio_bytes:
        return audio_bytes
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return audio_bytes
    work_id = uuid.uuid4().hex
    in_path = os.path.join(tempfile.gettempdir(), f"vnr_loud_{work_id}_in.mp3")
    out_path = os.path.join(tempfile.gettempdir(), f"vnr_loud_{work_id}_out.mp3")
    try:
        with open(in_path, "wb") as f:
            f.write(audio_bytes)
        loudnorm = f"loudnorm=I={LOUDNESS_TARGET_LUFS}:TP={LOUDNESS_TRUE_PEAK_DBTP}:LRA={LOUDNESS_RANGE_LU}"
        args = (ffmpeg, "-y", "-i", in_path, "-af", loudnorm, "-ar", "44100", out_path)
        code, _out, err = await _run(*args, timeout=timeout)
        if code != 0:
            logger.info("video_render: loudness normalization skipped (ffmpeg exit %s): %s",
                        code, err.decode("utf-8", errors="replace")[-300:])
            return audio_bytes
        with open(out_path, "rb") as f:
            data = f.read()
        return data or audio_bytes
    except RenderError:
        return audio_bytes
    finally:
        for p in (in_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


async def generate_silence_clip(duration_sec: float, *, sample_rate: int = 44100,
                                 timeout: float = 30.0) -> bytes | None:
    """Real, honest digital silence — an actual MP3-encoded silent clip
    (ffmpeg's `anullsrc` lavfi source), never a fabricated timestamp or a
    guessed-length placeholder. Used by video_narration_tools.
    assemble_narration_track to pad a genuine gap when a scene's real
    visual start (from Gemini's story analysis) is later than where the
    narration track's own cursor has naturally landed — so a scene's
    narration doesn't start speaking before that scene has even begun on
    screen.

    Mono, 44.1kHz MP3 to match ElevenLabs' own `mp3_44100_128` output
    format, so the existing frame-level concatenation (_stitch_mp3_
    segments) keeps working correctly across a real line clip / silence /
    real line clip sequence.

    Best-effort, never fabricates: returns None (never raises, never
    returns a shorter/wrong-length clip) when duration is not positive or
    ffmpeg is unavailable or generation fails for any reason. Callers MUST
    treat None as "padding unavailable" and skip the gap — an honest
    degrade to sequential concatenation — never as a zero-length silence."""
    if duration_sec is None or duration_sec <= 0:
        return None
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return None
    work_id = uuid.uuid4().hex
    out_path = os.path.join(tempfile.gettempdir(), f"vnr_silence_{work_id}.mp3")
    try:
        args = (
            ffmpeg, "-y", "-f", "lavfi", "-i", f"anullsrc=r={sample_rate}:cl=mono",
            "-t", f"{duration_sec:.3f}", "-c:a", "libmp3lame", "-b:a", "128k", out_path,
        )
        code, _out, err = await _run(*args, timeout=timeout)
        if code != 0:
            logger.info("video_render: silence generation skipped (ffmpeg exit %s): %s",
                        code, err.decode("utf-8", errors="replace")[-300:])
            return None
        with open(out_path, "rb") as f:
            data = f.read()
        return data or None
    except RenderError:
        return None
    finally:
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass


# A narration line is only ever compressed within this range — small enough
# that ffmpeg's atempo (a real, pitch-preserving time-scale filter, not a
# naive resample that would shift pitch) stays inaudibly natural. Above
# this, video_narration_tools.assemble_narration_track deliberately does
# NOT compress — it records the overrun honestly instead, per the explicit
# "do not create robotic speech" / "do not arbitrarily speed voices up"
# requirement. Chosen from atempo's own documented sweet spot (values
# under ~1.15x are broadly considered transparent for speech).
MAX_SAFE_TIME_COMPRESSION = 1.08


async def time_compress_clip(audio_bytes: bytes, factor: float, *, timeout: float = 60.0) -> bytes | None:
    """Real, pitch-preserving time compression via ffmpeg's `atempo` filter
    — a genuine, documented ffmpeg audio filter (not an invented
    capability), used ONLY to fit a narration line that would otherwise
    overrun its scene's real end time back within that window, and ONLY
    for small factors (see MAX_SAFE_TIME_COMPRESSION) so the result stays
    natural rather than becoming audibly sped-up or robotic. `factor` > 1.0
    speeds up (shortens) the clip; e.g. 1.05 plays 5% faster.

    Best-effort, never fabricates: returns None (never raises, never
    silently skips the compression while claiming success) when ffmpeg is
    unavailable, factor is out of atempo's valid range, or generation
    fails for any reason — the caller MUST treat None as "compression
    unavailable" and fall back to recording the overrun honestly, never as
    a zero-cost compression that didn't actually happen."""
    if not audio_bytes or factor is None or not (0.5 <= factor <= 2.0):
        return None
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return None
    work_id = uuid.uuid4().hex
    in_path = os.path.join(tempfile.gettempdir(), f"vnr_tempo_{work_id}_in.mp3")
    out_path = os.path.join(tempfile.gettempdir(), f"vnr_tempo_{work_id}_out.mp3")
    try:
        with open(in_path, "wb") as f:
            f.write(audio_bytes)
        args = (ffmpeg, "-y", "-i", in_path, "-af", f"atempo={factor:.4f}", "-ar", "44100", out_path)
        code, _out, err = await _run(*args, timeout=timeout)
        if code != 0:
            logger.info("video_render: time compression skipped (ffmpeg exit %s): %s",
                        code, err.decode("utf-8", errors="replace")[-300:])
            return None
        with open(out_path, "rb") as f:
            data = f.read()
        return data or None
    except RenderError:
        return None
    finally:
        for p in (in_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


async def mux_narration_into_video(
    video_bytes: bytes, video_content_type: str, audio_bytes: bytes,
    *, treatment: str = DEFAULT_SOURCE_AUDIO_TREATMENT, timeout: float = 300.0,
) -> bytes:
    """Combines the approved AI narration audio with the lesson's original
    video into one final master. `treatment` controls what happens to the
    ORIGINAL audio track as a single whole — there is no source stem
    separation in this stack (see video_narration_tools.py's module
    docstring), so treatment is deliberately coarse and honest rather than
    pretending to selectively keep only "ambience" or only "music":

      "mute"     — original audio dropped entirely, narration is the only
                   audio (the exact behavior this function always had).
      "duck"     — original audio kept but lowered under the narration.
      "preserve" — original audio kept at near-full volume alongside the
                   narration (both audible — appropriate when the
                   original had no dialogue/narration worth removing).

    If the source has no audio stream at all, "duck"/"preserve" silently
    behave like "mute" (there is nothing to duck or preserve) — this is
    the correct, honest outcome, not a bug: ffmpeg's amix filter requires
    two real audio inputs.

    The video stream is always copied without re-encoding (`-c:v copy`) —
    visual quality/timing is untouched; only the audio stream changes, so
    existing word/sentence timings computed against the narration audio
    remain accurate against the output file.

    Raises RenderError (never silently degrades):
      - "ffmpeg_unavailable" if no ffmpeg binary can be resolved at all
      - "invalid_treatment" if `treatment` isn't a recognized value
      - "empty_input" if either input is empty
      - "render_timeout" if ffmpeg hangs past `timeout`
      - "ffmpeg_failed" with the real stderr tail on a nonzero exit
    """
    if treatment not in SOURCE_AUDIO_TREATMENTS:
        raise RenderError("invalid_treatment", f"unknown source audio treatment {treatment!r}", 400)
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        raise RenderError(
            "ffmpeg_unavailable",
            "Server-side video rendering is unavailable in this environment (ffmpeg not found).",
            503,
        )
    if not video_bytes or not audio_bytes:
        raise RenderError("empty_input", "video or audio input was empty", 400)

    effective_treatment = treatment
    if treatment != "mute" and not await source_has_audio_stream(video_bytes, video_content_type):
        effective_treatment = "mute"  # nothing to duck/preserve — honest fallback, not a silent lie

    ext = ".mp4" if "mp4" in (video_content_type or "") else ".bin"
    work_id = uuid.uuid4().hex
    video_path = os.path.join(tempfile.gettempdir(), f"vnr_{work_id}_in{ext}")
    audio_path = os.path.join(tempfile.gettempdir(), f"vnr_{work_id}_audio.mp3")
    out_path = os.path.join(tempfile.gettempdir(), f"vnr_{work_id}_out.mp4")
    try:
        with open(video_path, "wb") as f:
            f.write(video_bytes)
        with open(audio_path, "wb") as f:
            f.write(audio_bytes)

        # -movflags +faststart relocates the MP4 "moov" atom (the index the
        # browser needs to read before it knows duration/seek points) to the
        # FRONT of the file. ffmpeg writes it at the END by default, which is
        # harmless for local files but means a browser streaming this master
        # over HTTP must download the entire multi-minute video before
        # duration/seeking resolve — observed live as a stuck "--:--"
        # duration and an indefinite loading spinner on longer lessons. This
        # is a pure atom-relocation (no re-encode, no quality/timing change),
        # so it's zero-risk to add.
        if effective_treatment == "mute":
            args = (
                ffmpeg, "-y",
                "-i", video_path,
                "-i", audio_path,
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest",
                "-movflags", "+faststart",
                out_path,
            )
        else:
            source_volume = DUCK_VOLUME if effective_treatment == "duck" else PRESERVE_VOLUME
            filter_complex = (
                f"[0:a]volume={source_volume}[src];"
                "[src][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]"
            )
            args = (
                ffmpeg, "-y",
                "-i", video_path,
                "-i", audio_path,
                "-filter_complex", filter_complex,
                "-map", "0:v:0", "-map", "[aout]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest",
                "-movflags", "+faststart",
                out_path,
            )

        code, _out, err = await _run(*args, timeout=timeout)
        if code != 0:
            tail = err.decode("utf-8", errors="replace")[-800:]
            raise RenderError("ffmpeg_failed", f"ffmpeg exited {code}: {tail}", 500)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (video_path, audio_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:  # noqa: PERF203 — best-effort cleanup, never fails the render
                pass


async def probe_audio_duration_seconds(audio_bytes: bytes, *, timeout: float = 30.0) -> float | None:
    """Best-effort duration probe for a standalone audio clip (e.g. a
    generated SFX asset) — ffprobe only, no ffmpeg-stderr fallback: unlike
    probe_has_audio_stream's yes/no question, parsing an exact duration out
    of ffmpeg's free-text stderr reliably is materially more fragile, and
    this value is informational (timeline display) rather than required
    for any render to succeed. Returns None — never raises, never guesses
    — whenever ffprobe isn't available or the probe fails for any reason."""
    ffprobe = _resolve_ffprobe()
    if not ffprobe or not audio_bytes:
        return None
    work_id = uuid.uuid4().hex
    path = os.path.join(tempfile.gettempdir(), f"vnr_dur_{work_id}.mp3")
    try:
        with open(path, "wb") as f:
            f.write(audio_bytes)
        code, out, _err = await _run(
            ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
            timeout=timeout,
        )
        if code != 0:
            return None
        return round(float(out.decode("utf-8", errors="replace").strip()), 3)
    except (RenderError, ValueError):
        return None
    finally:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


async def overlay_audio_at_offset(
    base_audio_bytes: bytes, overlay_audio_bytes: bytes, offset_seconds: float,
    *, overlay_volume: float = 1.0, timeout: float = 120.0,
) -> bytes:
    """Mixes a second audio clip (e.g. a generated SFX asset) into a base
    track (e.g. the assembled narration) starting at `offset_seconds` —
    reuses this SAME module's ffmpeg resolver/execution plumbing rather
    than a second mixing engine, per the "build on the existing renderer"
    requirement.

    The BASE track's own duration and internal timing are always preserved
    exactly (`amix ... duration=first`) — an overlay is additive, never a
    splice, so anything already timed against the base track's audio (word/
    sentence timestamps computed before this call) remains accurate
    afterward. An overlay landing near/after the base track's own end is
    simply attenuated by ffmpeg's own duration truncation, not an error.

    Raises RenderError with the same honest codes as mux_narration_into_
    video — this is never allowed to silently return the un-mixed base
    track disguised as a successful mix; callers that treat SFX mixing as
    optional must catch RenderError themselves and skip that overlay."""
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        raise RenderError("ffmpeg_unavailable", "Server-side audio mixing is unavailable (ffmpeg not found).", 503)
    if not base_audio_bytes or not overlay_audio_bytes:
        raise RenderError("empty_input", "base or overlay audio input was empty", 400)

    work_id = uuid.uuid4().hex
    base_path = os.path.join(tempfile.gettempdir(), f"vnr_mix_{work_id}_base.mp3")
    overlay_path = os.path.join(tempfile.gettempdir(), f"vnr_mix_{work_id}_overlay.mp3")
    out_path = os.path.join(tempfile.gettempdir(), f"vnr_mix_{work_id}_out.mp3")
    try:
        with open(base_path, "wb") as f:
            f.write(base_audio_bytes)
        with open(overlay_path, "wb") as f:
            f.write(overlay_audio_bytes)

        delay_ms = max(0, int(round(offset_seconds * 1000)))
        filter_complex = (
            f"[1:a]adelay={delay_ms}|{delay_ms},volume={overlay_volume}[ov];"
            "[0:a][ov]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        args = (
            ffmpeg, "-y",
            "-i", base_path, "-i", overlay_path,
            "-filter_complex", filter_complex,
            "-map", "[aout]",
            "-c:a", "libmp3lame",
            out_path,
        )
        code, _out, err = await _run(*args, timeout=timeout)
        if code != 0:
            tail = err.decode("utf-8", errors="replace")[-800:]
            raise RenderError("ffmpeg_failed", f"ffmpeg exited {code}: {tail}", 500)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (base_path, overlay_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


async def probe_has_audio_stream(video_bytes: bytes, *, content_type: str = "video/mp4",
                                  timeout: float = 30.0) -> bool:
    """Media-inspection verification (not just 'the browser could play an
    overlay') — confirms a file genuinely contains an audio stream, per
    the explicit 'physically embedded, not just playable' requirement.
    Uses ffprobe when available; falls back to parsing the resolved
    ffmpeg binary's own stderr stream listing when it isn't (imageio-
    ffmpeg does not bundle ffprobe). Returns False (never raises) when
    nothing can be resolved — callers must treat that as 'could not
    verify', not 'verified absent'."""
    if not video_bytes:
        return False
    ext = ".mp4" if "mp4" in (content_type or "") else ".bin"
    work_id = uuid.uuid4().hex
    path = os.path.join(tempfile.gettempdir(), f"vnr_probe_{work_id}{ext}")
    try:
        with open(path, "wb") as f:
            f.write(video_bytes)

        ffprobe = _resolve_ffprobe()
        if ffprobe:
            code, out, _err = await _run(
                ffprobe, "-v", "error", "-select_streams", "a",
                "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
                timeout=timeout,
            )
            return code == 0 and b"audio" in out

        ffmpeg = _resolve_ffmpeg()
        if not ffmpeg:
            return False
        # No dedicated ffprobe binary — ffmpeg itself prints full stream
        # info to stderr whenever given an input, even with no output
        # requested (a standard, documented technique). Exit code is
        # nonzero in that case (no output specified) — that's expected;
        # only the stream listing in stderr is inspected.
        _code, _out, err = await _run(ffmpeg, "-i", path, timeout=timeout)
        return b"Audio:" in err
    except RenderError:
        return False
    finally:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
