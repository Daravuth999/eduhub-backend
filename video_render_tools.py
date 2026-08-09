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

        if effective_treatment == "mute":
            args = (
                ffmpeg, "-y",
                "-i", video_path,
                "-i", audio_path,
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest",
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
