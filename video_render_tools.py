"""video_render_tools.py — server-side final-master rendering: physically
muxes the approved AI narration audio into the lesson's original video,
producing a real MP4 with an embedded audio stream (not a separate
browser-side overlay).

Deliberately isolated from video_narration_tools.py's orchestration (which
owns job-stage bookkeeping) — this module knows nothing about Mongo, jobs,
or lessons. It takes bytes in, returns bytes out, and raises RenderError
with a specific, honest code when the operation genuinely cannot succeed.

Environment reality check (verified against this repo, not assumed):
server.py's own `_generate_silence_bytes()` already documents that ffmpeg
is NOT guaranteed present on Render ("works without ffmpeg on Render" —
its fallback path exists precisely because ffmpeg can be absent). This
module follows the same discipline: if ffmpeg is unavailable, every
render call raises RenderError("ffmpeg_unavailable", ...) — it NEVER
fabricates a successful render, and never silently returns the original
unmuxed video as if it were a real master.
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


class RenderError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def ffmpeg_available() -> bool:
    """Cheap presence check (no subprocess spawn) — the same yes/no this
    module's callers need before promising an admin a render will work."""
    return shutil.which("ffmpeg") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


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


async def mux_narration_into_video(
    video_bytes: bytes, video_content_type: str, audio_bytes: bytes,
    *, timeout: float = 300.0,
) -> bytes:
    """Replaces the video's audio track entirely with the approved AI
    narration audio (mode: REPLACE — the mode this pipeline's Mode B
    narration is designed for; ducking/mixing multiple simultaneous source
    layers is not implemented, see module docstring in video_narration_
    tools.py for the honest scope statement). The video stream is copied
    without re-encoding (`-c:v copy`) — visual quality/timing is untouched;
    only the audio stream changes, so the existing word/sentence timings
    computed against the narration audio remain accurate against the
    output file.

    Raises RenderError (never silently degrades):
      - "ffmpeg_unavailable" if the ffmpeg binary isn't present at all
      - "empty_input" if either input is empty
      - "render_timeout" if ffmpeg hangs past `timeout`
      - "ffmpeg_failed" with the real stderr tail on a nonzero exit
    """
    if not ffmpeg_available():
        raise RenderError(
            "ffmpeg_unavailable",
            "Server-side video rendering is unavailable in this environment (ffmpeg not found).",
            503,
        )
    if not video_bytes or not audio_bytes:
        raise RenderError("empty_input", "video or audio input was empty", 400)

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

        code, _out, err = await _run(
            "ffmpeg", "-y",
            "-i", video_path,
            "-i", audio_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            out_path,
            timeout=timeout,
        )
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


async def probe_has_audio_stream(video_bytes: bytes, *, timeout: float = 30.0) -> bool:
    """Media-inspection verification (not just 'the browser could play an
    overlay') — confirms the rendered file itself contains an audio
    stream, per the explicit 'physically embedded, not just playable'
    requirement. Returns False (never raises) if ffprobe is unavailable —
    callers treat that as 'could not verify', not 'verified absent'."""
    if not ffprobe_available() or not video_bytes:
        return False
    work_id = uuid.uuid4().hex
    path = os.path.join(tempfile.gettempdir(), f"vnr_probe_{work_id}.mp4")
    try:
        with open(path, "wb") as f:
            f.write(video_bytes)
        code, out, _err = await _run(
            "ffprobe", "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
            timeout=timeout,
        )
        return code == 0 and b"audio" in out
    except RenderError:
        return False
    finally:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
