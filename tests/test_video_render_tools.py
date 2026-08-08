"""tests/test_video_render_tools.py — final-master rendering (video_render_
tools.py). The "ffmpeg unavailable" / "empty input" paths are deterministic
(no real ffmpeg needed, run everywhere). The real-mux tests actually invoke
ffmpeg with tiny synthetic lavfi-generated clips and verify — via ffprobe,
not just "the function returned bytes" — that the produced file genuinely
contains an embedded audio stream. These are skipped (not faked) in any
environment lacking ffmpeg/ffprobe, matching the module's own "never fake
a render" discipline.
"""
from __future__ import annotations

import asyncio

import pytest

import video_render_tools as vrt

NO_FFMPEG = not vrt.ffmpeg_available()
NO_FFPROBE = not vrt.ffprobe_available()


def test_ffmpeg_available_returns_a_bool():
    assert isinstance(vrt.ffmpeg_available(), bool)


@pytest.mark.asyncio
async def test_mux_raises_ffmpeg_unavailable_when_binary_missing(monkeypatch):
    monkeypatch.setattr(vrt.shutil, "which", lambda name: None)
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.mux_narration_into_video(b"fake-video", "video/mp4", b"fake-audio")
    assert exc_info.value.code == "ffmpeg_unavailable"
    assert exc_info.value.http_status == 503


@pytest.mark.asyncio
async def test_mux_raises_on_empty_video_input():
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.mux_narration_into_video(b"", "video/mp4", b"fake-audio")
    assert exc_info.value.code == "empty_input"


@pytest.mark.asyncio
async def test_mux_raises_on_empty_audio_input():
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.mux_narration_into_video(b"fake-video", "video/mp4", b"")
    assert exc_info.value.code == "empty_input"


@pytest.mark.asyncio
async def test_probe_returns_false_without_raising_when_ffprobe_missing(monkeypatch):
    monkeypatch.setattr(vrt.shutil, "which", lambda name: None)
    assert await vrt.probe_has_audio_stream(b"anything") is False


async def _make_test_clip(*, kind: str, duration: float = 0.5) -> bytes:
    """Generates a tiny real media file with real ffmpeg lavfi sources —
    no network, no fixtures checked into the repo."""
    import os
    import tempfile
    import uuid

    path = os.path.join(tempfile.gettempdir(), f"vrt_src_{uuid.uuid4().hex}.mp4")
    if kind == "video_only":
        args = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=blue:s=64x64:d={duration}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", path]
    elif kind == "audio_only":
        path = path.replace(".mp4", ".mp3")
        args = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
                "-c:a", "libmp3lame", path]
    else:
        raise ValueError(kind)
    # subprocess.run in a thread, not asyncio.create_subprocess_exec — see
    # video_render_tools._run's docstring for why (Windows Proactor-loop-
    # only subprocess-pipe requirement, irrelevant on Linux/production).
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 30.0)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_real_mux_produces_a_file_with_a_genuine_embedded_audio_stream():
    video_only = await _make_test_clip(kind="video_only")
    audio_only = await _make_test_clip(kind="audio_only")

    rendered = await vrt.mux_narration_into_video(video_only, "video/mp4", audio_only)

    assert len(rendered) > 0
    has_audio = await vrt.probe_has_audio_stream(rendered)
    assert has_audio is True, "rendered master must contain a real embedded audio stream, not just be playable via a browser-side overlay"


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_probe_correctly_reports_false_for_a_video_only_file():
    video_only = await _make_test_clip(kind="video_only")
    assert await vrt.probe_has_audio_stream(video_only) is False


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_mux_raises_ffmpeg_failed_on_genuinely_malformed_input():
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.mux_narration_into_video(b"not-a-real-video-file", "video/mp4", b"not-a-real-audio-file")
    assert exc_info.value.code == "ffmpeg_failed"
