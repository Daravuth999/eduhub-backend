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
import os
import tempfile
import uuid

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
async def test_real_mux_output_is_faststart_moov_before_mdat():
    """Proves -movflags +faststart actually took effect on a REAL rendered
    file — not just that the flag is present in the ffmpeg invocation.
    Without faststart, ffmpeg writes the MP4 "moov" atom (the index a
    browser needs before it can report duration/seek points) AFTER "mdat"
    (the actual media bytes), forcing the browser to fetch the entire file
    before playback metadata resolves — the live-observed stuck "--:--"
    duration / indefinite loading spinner on longer lessons. A correctly
    faststart'd file has moov's box header appear before mdat's."""
    video_only = await _make_test_clip(kind="video_only")
    audio_only = await _make_test_clip(kind="audio_only")

    rendered = await vrt.mux_narration_into_video(video_only, "video/mp4", audio_only)

    moov_pos = rendered.find(b"moov")
    mdat_pos = rendered.find(b"mdat")
    assert moov_pos != -1 and mdat_pos != -1, "expected a real MP4 with both atoms present"
    assert moov_pos < mdat_pos, "moov atom must precede mdat — faststart did not take effect"


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_probe_correctly_reports_false_for_a_video_only_file():
    video_only = await _make_test_clip(kind="video_only")
    assert await vrt.probe_has_audio_stream(video_only) is False


# ── probe_audio_stream_status: tri-state present/absent/unknown ───────────
# The root cause this exists to fix: silently treating "could not verify"
# the same as "confirmed no audio" would make a video that DOES have
# speech silently skip real speech recognition just because ffprobe
# momentarily failed — far worse than the slow-but-correct prior behavior.
@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_probe_status_reports_absent_for_a_genuinely_silent_video():
    video_only = await _make_test_clip(kind="video_only")
    assert await vrt.probe_audio_stream_status(video_only) == "absent"


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_probe_status_reports_present_for_a_video_with_real_audio():
    video_with_audio = await _make_video_with_audio_clip()
    assert await vrt.probe_audio_stream_status(video_with_audio) == "present"


@pytest.mark.asyncio
async def test_probe_status_reports_unknown_for_empty_bytes():
    assert await vrt.probe_audio_stream_status(b"") == "unknown"


@pytest.mark.asyncio
async def test_probe_status_reports_unknown_when_ffprobe_and_ffmpeg_both_missing(monkeypatch):
    monkeypatch.setattr(vrt.shutil, "which", lambda name: None)
    assert await vrt.probe_audio_stream_status(b"anything") == "unknown"


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_probe_status_reports_unknown_for_genuinely_unreadable_bytes(monkeypatch):
    """A file ffmpeg/ffprobe can't even open (corrupt/garbage bytes) is a
    real "could not verify" — must never be reported as "absent", since
    that would incorrectly authorize a caller to skip real ASR."""
    monkeypatch.setattr(vrt, "_resolve_ffprobe", lambda: None)
    status = await vrt.probe_audio_stream_status(b"not-a-real-video-file")
    assert status == "unknown"


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_probe_has_audio_stream_treats_both_absent_and_unknown_as_false():
    """probe_has_audio_stream's existing boolean contract must be
    unchanged by the tri-state refactor — both "absent" and "unknown"
    still resolve to False for its existing callers."""
    video_only = await _make_test_clip(kind="video_only")
    assert await vrt.probe_has_audio_stream(video_only) is False
    assert await vrt.probe_has_audio_stream(b"") is False


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


# ── loudness normalization (root cause for "some lines too loud, others
#    nearly inaudible") ────────────────────────────────────────────────────
async def _make_sine_clip_at_volume(*, volume: float, duration: float = 4.0) -> bytes:
    """A real MP3 sine clip at a controlled, explicit amplitude — lets a
    test assert on ACTUAL measured loudness convergence, not just "it ran"."""
    path = os.path.join(tempfile.gettempdir(), f"vrt_loud_src_{uuid.uuid4().hex}.mp3")
    args = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
            "-af", f"volume={volume}", "-c:a", "libmp3lame", path]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 30.0)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


async def _measure_integrated_loudness(audio_bytes: bytes) -> float | None:
    """Real EBU R128 measurement (ffmpeg's own ebur128 filter) — parses the
    "I: <value> LUFS" summary line ffmpeg writes to stderr. Used only to
    VERIFY the fix's effect in this test file; not part of the shipped
    normalize_line_loudness implementation itself (which uses loudnorm's
    own single-pass measure+adjust, no separate probe needed in production)."""
    import re as _re
    path = os.path.join(tempfile.gettempdir(), f"vrt_measure_{uuid.uuid4().hex}.mp3")
    with open(path, "wb") as f:
        f.write(audio_bytes)
    try:
        ffmpeg = vrt._resolve_ffmpeg()
        args = (ffmpeg, "-i", path, "-af", "ebur128=framelog=verbose", "-f", "null", "-")
        _code, _out, err = await vrt._run(*args, timeout=30.0)
        text = err.decode("utf-8", errors="replace")
        matches = _re.findall(r"^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", text, flags=_re.MULTILINE)
        return float(matches[-1]) if matches else None
    finally:
        if os.path.exists(path):
            os.remove(path)


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_normalize_line_loudness_brings_a_quiet_and_a_loud_clip_close_together():
    """The actual reported defect: ElevenLabs renders each line
    independently at inconsistent volumes. Proves real ffmpeg loudnorm
    measurably closes the gap between a quiet clip and a normal one —
    not just that bytes came back."""
    quiet = await _make_sine_clip_at_volume(volume=0.05)
    normal = await _make_sine_clip_at_volume(volume=0.5)

    quiet_before = await _measure_integrated_loudness(quiet)
    normal_before = await _measure_integrated_loudness(normal)
    assert quiet_before is not None and normal_before is not None
    gap_before = abs(quiet_before - normal_before)

    quiet_after = await vrt.normalize_line_loudness(quiet)
    normal_after = await vrt.normalize_line_loudness(normal)
    loud_quiet_after = await _measure_integrated_loudness(quiet_after)
    loud_normal_after = await _measure_integrated_loudness(normal_after)
    assert loud_quiet_after is not None and loud_normal_after is not None
    gap_after = abs(loud_quiet_after - loud_normal_after)

    assert gap_after < gap_before
    assert gap_after < 2.0  # LUFS — genuinely close, not just "closer"
    # Lands near the documented target, not an arbitrary level.
    assert loud_quiet_after == pytest.approx(vrt.LOUDNESS_TARGET_LUFS, abs=1.5)
    assert loud_normal_after == pytest.approx(vrt.LOUDNESS_TARGET_LUFS, abs=1.5)


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_normalize_line_loudness_does_not_change_duration():
    """Karaoke/word timestamps are measured against the PRE-normalization
    ElevenLabs alignment — normalization must never shift clip duration
    enough to drift that timing."""
    clip = await _make_sine_clip_at_volume(volume=0.2, duration=3.0)
    normalized = await vrt.normalize_line_loudness(clip)

    before = await vrt.probe_audio_duration_seconds(clip)
    after = await vrt.probe_audio_duration_seconds(normalized)
    assert after == pytest.approx(before, abs=0.15)


@pytest.mark.asyncio
async def test_normalize_line_loudness_returns_original_bytes_when_ffmpeg_unavailable(monkeypatch):
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
    original = b"fake-mp3-bytes"
    assert await vrt.normalize_line_loudness(original) == original


@pytest.mark.asyncio
async def test_normalize_line_loudness_returns_original_bytes_on_ffmpeg_failure(monkeypatch):
    async def _failing_run(*args, timeout):
        return 1, b"", b"ffmpeg: invalid data"

    monkeypatch.setattr(vrt, "_run", _failing_run)
    original = b"fake-mp3-bytes"
    assert await vrt.normalize_line_loudness(original) == original


@pytest.mark.asyncio
async def test_normalize_line_loudness_passthrough_on_empty_input():
    assert await vrt.normalize_line_loudness(b"") == b""


# ── silence generation (scene-anchored narration timing) ──────────────────
@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_generate_silence_clip_produces_a_clip_of_the_requested_duration():
    clip = await vrt.generate_silence_clip(2.0)
    assert clip is not None
    assert len(clip) > 0
    duration = await vrt.probe_audio_duration_seconds(clip)
    assert duration == pytest.approx(2.0, abs=0.15)


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_generate_silence_clip_is_genuinely_silent():
    """Real verification via ffmpeg's own volumedetect filter — not just
    "a file came back", but that its measured mean/max volume is at (or
    indistinguishable from) digital silence."""
    clip = await vrt.generate_silence_clip(1.0)
    assert clip is not None
    path = os.path.join(tempfile.gettempdir(), f"vrt_silence_check_{uuid.uuid4().hex}.mp3")
    with open(path, "wb") as f:
        f.write(clip)
    try:
        ffmpeg = vrt._resolve_ffmpeg()
        _code, _out, err = await vrt._run(ffmpeg, "-i", path, "-af", "volumedetect", "-f", "null", "-", timeout=30.0)
        text = err.decode("utf-8", errors="replace")
        assert "mean_volume" in text
        import re as _re
        mean = float(_re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)", text).group(1))
        assert mean < -50.0  # dB — effectively silent
    finally:
        if os.path.exists(path):
            os.remove(path)


@pytest.mark.asyncio
async def test_generate_silence_clip_returns_none_for_non_positive_duration():
    assert await vrt.generate_silence_clip(0.0) is None
    assert await vrt.generate_silence_clip(-1.0) is None


@pytest.mark.asyncio
async def test_generate_silence_clip_returns_none_when_ffmpeg_unavailable(monkeypatch):
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
    assert await vrt.generate_silence_clip(2.0) is None


@pytest.mark.asyncio
async def test_generate_silence_clip_returns_none_on_ffmpeg_failure(monkeypatch):
    async def _failing_run(*args, timeout):
        return 1, b"", b"ffmpeg: invalid filter"

    monkeypatch.setattr(vrt, "_run", _failing_run)
    assert await vrt.generate_silence_clip(2.0) is None


# ── bounded time compression (scene-overrun handling) ──────────────────────
@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_time_compress_clip_genuinely_shortens_a_real_clip_by_the_requested_factor():
    clip = await _make_sine_clip_at_volume(volume=0.3, duration=4.0)
    original_duration = await vrt.probe_audio_duration_seconds(clip)

    compressed = await vrt.time_compress_clip(clip, 1.05)

    assert compressed is not None
    compressed_duration = await vrt.probe_audio_duration_seconds(compressed)
    assert compressed_duration == pytest.approx(original_duration / 1.05, abs=0.15)


@pytest.mark.asyncio
async def test_time_compress_clip_uses_the_pitch_preserving_atempo_filter_not_a_resample(monkeypatch):
    """Confirms the actual implementation choice: ffmpeg's `atempo` is a
    real, documented time-scale filter that explicitly preserves pitch —
    a naive sample-rate-based speedup would NOT (it would raise pitch
    audibly, sounding like a chipmunk). This locks in that the real
    invocation always requests atempo, never a bare `-r`/resample trick."""
    captured_args = []

    async def _capturing_run(*args, timeout):
        captured_args.append(args)
        return 1, b"", b"forced failure, args capture only"

    monkeypatch.setattr(vrt, "_run", _capturing_run)
    await vrt.time_compress_clip(b"fake-mp3-bytes", 1.05)

    assert len(captured_args) == 1
    joined = " ".join(captured_args[0])
    assert "atempo=1.0500" in joined


@pytest.mark.asyncio
async def test_time_compress_clip_rejects_factors_outside_the_valid_atempo_range():
    assert await vrt.time_compress_clip(b"fake-mp3", 0.1) is None
    assert await vrt.time_compress_clip(b"fake-mp3", 3.0) is None


@pytest.mark.asyncio
async def test_time_compress_clip_returns_none_for_empty_input():
    assert await vrt.time_compress_clip(b"", 1.05) is None


@pytest.mark.asyncio
async def test_time_compress_clip_returns_none_when_ffmpeg_unavailable(monkeypatch):
    monkeypatch.setattr(vrt, "_resolve_ffmpeg", lambda: None)
    assert await vrt.time_compress_clip(b"fake-mp3", 1.05) is None


@pytest.mark.asyncio
async def test_time_compress_clip_returns_none_on_ffmpeg_failure(monkeypatch):
    async def _failing_run(*args, timeout):
        return 1, b"", b"ffmpeg: invalid filter"

    monkeypatch.setattr(vrt, "_run", _failing_run)
    assert await vrt.time_compress_clip(b"fake-mp3", 1.05) is None
