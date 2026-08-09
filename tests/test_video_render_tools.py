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


def test_ffmpeg_source_reports_system_when_on_path():
    assert vrt.ffmpeg_source() in ("system", "bundled", None)


def test_ffmpeg_source_reports_bundled_when_system_missing_but_imageio_ffmpeg_resolves(monkeypatch):
    monkeypatch.setattr(vrt.shutil, "which", lambda name: None)
    import imageio_ffmpeg  # noqa: F401 — only relevant if this dependency is actually installed
    assert vrt.ffmpeg_source() == "bundled"


def test_ffmpeg_source_reports_none_when_nothing_resolves(monkeypatch):
    monkeypatch.setattr(vrt.shutil, "which", lambda name: None)
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
    assert vrt.ffmpeg_source() is None


@pytest.mark.asyncio
async def test_mux_rejects_unknown_treatment():
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.mux_narration_into_video(b"fake-video", "video/mp4", b"fake-audio", treatment="surgical_remove")
    assert exc_info.value.code == "invalid_treatment"



@pytest.mark.asyncio
async def test_mux_raises_ffmpeg_unavailable_when_binary_missing(monkeypatch):
    # Simulates a deployment with NEITHER a system ffmpeg on PATH NOR the
    # imageio-ffmpeg fallback installed — the genuine "nothing resolves"
    # case. Only mocking shutil.which is insufficient in an environment
    # where imageio-ffmpeg IS installed (it would legitimately fall back
    # to the bundled binary, which is exactly the behavior being added).
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
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


async def _make_video_with_audio_clip(*, duration: float = 0.5) -> bytes:
    """A source clip that genuinely HAS its own original audio track — needed
    to exercise duck/preserve, which only differ from mute when the source
    actually has audio to keep."""
    import os
    import tempfile
    import uuid

    path = os.path.join(tempfile.gettempdir(), f"vrt_srcaudio_{uuid.uuid4().hex}.mp4")
    args = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=red:s=64x64:d={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=220:duration={duration}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 30.0)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_duck_treatment_produces_a_master_with_embedded_audio():
    video_with_audio = await _make_video_with_audio_clip()
    narration = await _make_test_clip(kind="audio_only")

    rendered = await vrt.mux_narration_into_video(video_with_audio, "video/mp4", narration, treatment="duck")

    assert len(rendered) > 0
    assert await vrt.probe_has_audio_stream(rendered) is True


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_preserve_treatment_produces_a_master_with_embedded_audio():
    video_with_audio = await _make_video_with_audio_clip()
    narration = await _make_test_clip(kind="audio_only")

    rendered = await vrt.mux_narration_into_video(video_with_audio, "video/mp4", narration, treatment="preserve")

    assert len(rendered) > 0
    assert await vrt.probe_has_audio_stream(rendered) is True


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_duck_treatment_honestly_downgrades_to_mute_when_source_has_no_audio():
    """A silent source can't be "kept faintly audible" — amix needs two real
    audio inputs. This must still succeed by falling back to mute, never by
    fabricating a mixed track that doesn't exist."""
    video_only = await _make_test_clip(kind="video_only")
    narration = await _make_test_clip(kind="audio_only")

    rendered = await vrt.mux_narration_into_video(video_only, "video/mp4", narration, treatment="duck")

    assert len(rendered) > 0
    assert await vrt.probe_has_audio_stream(rendered) is True


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_probe_falls_back_to_ffmpeg_stderr_parsing_when_ffprobe_missing(monkeypatch):
    """When ffprobe genuinely isn't on the system (a real possibility on a
    minimal deploy image), verification must not just return False by
    default — it must actually parse ffmpeg's own stderr for a real answer."""
    video_only = await _make_test_clip(kind="video_only")
    audio_only = await _make_test_clip(kind="audio_only")
    rendered = await vrt.mux_narration_into_video(video_only, "video/mp4", audio_only)

    monkeypatch.setattr(vrt, "_resolve_ffprobe", lambda: None)
    assert await vrt.probe_has_audio_stream(rendered) is True


# ── SFX-into-narration mixing (overlay_audio_at_offset) + duration probe ──
@pytest.mark.asyncio
async def test_overlay_raises_ffmpeg_unavailable_when_binary_missing(monkeypatch):
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.overlay_audio_at_offset(b"base", b"overlay", 1.0)
    assert exc_info.value.code == "ffmpeg_unavailable"


@pytest.mark.asyncio
async def test_overlay_raises_on_empty_inputs():
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.overlay_audio_at_offset(b"", b"overlay", 0.0)
    assert exc_info.value.code == "empty_input"
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.overlay_audio_at_offset(b"base", b"", 0.0)
    assert exc_info.value.code == "empty_input"


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_overlay_raises_ffmpeg_failed_on_genuinely_malformed_input():
    with pytest.raises(vrt.RenderError) as exc_info:
        await vrt.overlay_audio_at_offset(b"not-real-audio", b"also-not-real", 0.0)
    assert exc_info.value.code == "ffmpeg_failed"


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_overlay_produces_a_real_mixed_track_preserving_base_duration():
    base = await _make_test_clip(kind="audio_only", duration=1.0)
    overlay = await _make_test_clip(kind="audio_only", duration=0.3)

    mixed = await vrt.overlay_audio_at_offset(base, overlay, 0.5)

    assert len(mixed) > 0
    assert await vrt.probe_audio_duration_seconds(mixed) == pytest.approx(1.0, abs=0.15)


@pytest.mark.skipif(NO_FFPROBE, reason="ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_probe_audio_duration_seconds_reports_a_real_duration():
    clip = await _make_test_clip(kind="audio_only", duration=0.7)
    duration = await vrt.probe_audio_duration_seconds(clip)
    assert duration == pytest.approx(0.7, abs=0.1)


@pytest.mark.asyncio
async def test_probe_audio_duration_seconds_returns_none_without_ffprobe(monkeypatch):
    monkeypatch.setattr(vrt, "_resolve_ffprobe", lambda: None)
    assert await vrt.probe_audio_duration_seconds(b"anything") is None


@pytest.mark.asyncio
async def test_probe_audio_duration_seconds_returns_none_for_empty_input():
    assert await vrt.probe_audio_duration_seconds(b"") is None


# ── extract_audio_track — root-cause fix for the "130MB video stuck at
#    speech_recognition" incident: send audio, not the whole video ───────
@pytest.mark.asyncio
async def test_extract_audio_track_returns_none_for_empty_input():
    assert await vrt.extract_audio_track(b"") is None


@pytest.mark.asyncio
async def test_extract_audio_track_returns_none_without_ffmpeg(monkeypatch):
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
    assert await vrt.extract_audio_track(b"anything", "video/mp4") is None


@pytest.mark.asyncio
async def test_extract_audio_track_returns_none_for_a_video_with_no_audio_stream(monkeypatch):
    video_only = await _make_test_clip(kind="video_only")
    assert await vrt.extract_audio_track(video_only, "video/mp4") is None


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_extract_audio_track_produces_real_playable_audio_from_a_real_video():
    video_with_audio = await _make_video_with_audio_clip(duration=1.0)

    extracted = await vrt.extract_audio_track(video_with_audio, "video/mp4")

    assert extracted is not None
    assert len(extracted) > 0
    duration = await vrt.probe_audio_duration_seconds(extracted)
    assert duration == pytest.approx(1.0, abs=0.2)


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_extract_audio_track_dramatically_shrinks_a_representative_lesson_sized_clip():
    """Reproduces the reported incident's relevant media characteristic —
    NOT the literal 130MB/3-minute file (impractical to generate in a unit
    test), but the property that actually matters: a video whose audio
    content is what needs transcribing, at a duration long enough that the
    resulting size reduction is representative rather than noise-dominated
    (short clips have disproportionate container/codec overhead). A real,
    uncompressed-video-heavy source (raw color frames re-encoded) makes the
    video stream intentionally large relative to its short duration, so
    the extracted-audio-only track is verified to be genuinely smaller —
    not merely "some bytes came back"."""
    video_with_audio = await _make_video_with_audio_clip(duration=6.0)
    extracted = await vrt.extract_audio_track(video_with_audio, "video/mp4")

    assert extracted is not None
    assert len(extracted) < len(video_with_audio)
    duration = await vrt.probe_audio_duration_seconds(extracted)
    assert duration == pytest.approx(6.0, abs=0.3)
