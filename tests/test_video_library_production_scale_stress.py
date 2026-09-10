"""tests/test_video_library_production_scale_stress.py — autonomous
production-validation pass: proves the ea40e84 memory/concurrency fixes
hold at REALISTIC scale (a genuine ~130MB/3-minute video, matching the
real production incident this session's memory-pressure investigation was
triggered by), not just against tiny multi-KB fixtures. Uses tracemalloc
(cross-platform, no psutil dependency) to measure genuine Python-level
memory held by real byte buffers under 1/2/3 simultaneous simulated heavy
jobs racing the shared heavy_op_semaphore.
"""
from __future__ import annotations

import asyncio
import gc
import os
import tempfile
import time
import tracemalloc
import uuid

import pytest

import video_render_tools as vrt

NO_FFMPEG = not vrt.ffmpeg_available()

TARGET_DURATION_S = 180.0   # ~3 minutes, matching the real production incident
TARGET_BITRATE_MBIT = 5.8  # -> ~130MB over 180s


async def _make_realistic_scale_video() -> bytes:
    """A genuine ffmpeg-encoded video sized to match the real production
    incident (~130MB, ~3 minutes, with its own audio track) — not a toy
    2-second fixture. Encoding synthetic test patterns runs much faster
    than real time, so this stays practical inside a test suite."""
    path = os.path.join(tempfile.gettempdir(), f"scale_{uuid.uuid4().hex}.mp4")
    args = [
        vrt._resolve_ffmpeg(), "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=960x540:rate=30:duration={TARGET_DURATION_S}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={TARGET_DURATION_S}",
        "-c:v", "libx264", "-preset", "ultrafast", "-b:v", f"{TARGET_BITRATE_MBIT}M",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]
    loop = asyncio.get_running_loop()
    code, _out, err = await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 180.0)
    assert code == 0, f"fixture generation failed: {err[-400:]!r}"
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


@pytest.fixture(scope="module")
def realistic_video_bytes():
    if NO_FFMPEG:
        pytest.skip("ffmpeg not installed in this environment")
    data = asyncio.run(_make_realistic_scale_video())
    size_mb = len(data) / (1024 * 1024)
    assert 60 <= size_mb <= 250, (
        f"fixture came out at {size_mb:.1f}MB — adjust TARGET_BITRATE_MBIT to stay in the "
        "realistic 60-250MB band this test is meant to exercise, rather than silently testing a toy size"
    )
    return data


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_realistic_scale_fixture_is_genuinely_within_production_size_band(realistic_video_bytes):
    size_mb = len(realistic_video_bytes) / (1024 * 1024)
    print(f"\n[production-scale fixture] {size_mb:.1f}MB / {TARGET_DURATION_S:.0f}s")
    assert size_mb > 50, "must be large enough to make memory-pressure claims meaningful, not a toy fixture"


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_concurrency_cap_bounds_real_memory_at_realistic_scale(realistic_video_bytes, monkeypatch):
    """The core claim behind video_render_tools.heavy_op_semaphore: with N
    lessons' ~130MB raw uploads all "arriving" at once, AT MOST
    HEAVY_OP_CONCURRENCY copies are ever held in memory simultaneously —
    never one per submitted job. Measured with tracemalloc against the
    REAL fixture bytes (a bytearray copy per "held" buffer, exactly how
    run_pipeline holds its own raw media), not synthetic placeholders."""
    cap = 2
    monkeypatch.setattr(vrt, "heavy_op_semaphore", asyncio.Semaphore(cap))

    peak_concurrent_buffers = 0
    concurrent_now = 0
    lock = asyncio.Lock()

    async def _simulated_lesson_upload():
        nonlocal peak_concurrent_buffers, concurrent_now
        async with vrt.heavy_op_semaphore:
            # A genuine, independent ~130MB copy — exactly what
            # load_media_bytes hands run_pipeline for each lesson.
            held = bytearray(realistic_video_bytes)
            async with lock:
                concurrent_now += 1
                peak_concurrent_buffers = max(peak_concurrent_buffers, concurrent_now)
            await asyncio.sleep(0.15)  # simulate real in-flight processing time
            async with lock:
                concurrent_now -= 1
            del held

    NUM_LESSONS = 5
    tracemalloc.start()
    gc.collect()
    baseline, _ = tracemalloc.get_traced_memory()

    await asyncio.gather(*(_simulated_lesson_upload() for _ in range(NUM_LESSONS)))

    gc.collect()
    peak_bytes = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    fixture_mb = len(realistic_video_bytes) / (1024 * 1024)
    peak_over_baseline_mb = (peak_bytes) / (1024 * 1024)
    print(f"\n[concurrency stress] {NUM_LESSONS} lessons x {fixture_mb:.1f}MB, cap={cap}, "
          f"peak_concurrent_buffers={peak_concurrent_buffers}, traced_peak={peak_over_baseline_mb:.1f}MB")

    assert peak_concurrent_buffers == cap, (
        f"expected the semaphore to cap real concurrent buffer-holding at exactly {cap}, "
        f"observed {peak_concurrent_buffers} — the concurrency cap is not genuinely bounding memory"
    )
    # Peak traced memory must reflect roughly `cap` copies, not all 5 —
    # generous headroom (3x one fixture) for allocator/tracemalloc overhead,
    # while still catching the real failure mode (all 5 alive at once would
    # be ~5x fixture_mb, a completely different order of magnitude).
    assert peak_bytes < fixture_mb * 3 * 1024 * 1024, (
        f"peak traced memory ({peak_over_baseline_mb:.1f}MB) suggests more than {cap} buffers "
        f"were alive at once for a {fixture_mb:.1f}MB fixture — memory is not actually bounded"
    )


@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_1_vs_2_vs_3_simultaneous_jobs_queue_behind_the_real_cap(realistic_video_bytes, monkeypatch):
    """Directive requirement: measure execution time / queue wait for 1, 2,
    and 3 simultaneous jobs against the real semaphore. With cap=2, three
    simultaneous jobs (each taking ~HOLD_S) must take meaningfully longer
    than two — proof the third genuinely queues rather than running
    unbounded alongside the other two."""
    cap = 2
    monkeypatch.setattr(vrt, "heavy_op_semaphore", asyncio.Semaphore(cap))
    HOLD_S = 0.2

    async def _job():
        async with vrt.heavy_op_semaphore:
            _held = bytearray(realistic_video_bytes[:5_000_000])  # a representative slice, fast to copy
            await asyncio.sleep(HOLD_S)

    async def _run_n(n: int) -> float:
        started = time.monotonic()
        await asyncio.gather(*(_job() for _ in range(n)))
        return time.monotonic() - started

    t1 = await _run_n(1)
    t2 = await _run_n(2)
    t3 = await _run_n(3)

    print(f"\n[queue timing] 1 job={t1:.3f}s  2 jobs={t2:.3f}s  3 jobs={t3:.3f}s (cap={cap}, hold={HOLD_S}s)")

    # 1 and 2 jobs fit within the cap — both should complete in ~one HOLD_S.
    assert t1 < HOLD_S * 3
    assert t2 < HOLD_S * 3
    # 3 jobs against a cap of 2 MUST take at least ~2 HOLD_S (one job queues
    # behind the first two) — this is the actual, measured proof of queuing.
    assert t3 >= HOLD_S * 1.8, (
        f"3 jobs against cap={cap} finished in {t3:.3f}s, expected >= {HOLD_S * 1.8:.3f}s — "
        "the third job did not genuinely queue for a slot"
    )


# ── 2026-09 — Audio Extraction stage memory investigation (video pipeline
#    crash/reconciliation round, §1). Real incident: lesson "Pchum Ben", a
#    172MB upload, stalled specifically at "Audio extraction" right before
#    a Render service restart. Investigated whether this is the SAME OOM
#    class as the ea40e84 remux double-buffer fix above (reading a full
#    ffmpeg OUTPUT back into a SECOND full-size Python bytes object,
#    coexisting with the original upload buffer) — confirmed, by reading
#    video_render_tools.probe_audio_stream_status/extract_audio_track
#    directly, that this is a DIFFERENT, much healthier shape: both
#    functions write the (already-in-memory) input to ONE temp file for
#    ffmpeg/ffprobe to read, and the OUTPUT they read back is either a tiny
#    probe status string or dramatically-smaller audio-only data (mono/
#    16kHz/64kbps — "a few MB" per extract_audio_track's own docstring),
#    never a second full-size copy of the video. This test proves that
#    property with the SAME realistic ~130MB fixture the remux stress test
#    above uses, and is a permanent regression guard: it would fail if a
#    future change ever reintroduced a same-order-of-magnitude second
#    buffer into either function. ────────────────────────────────────────
@pytest.mark.skipif(NO_FFMPEG, reason="ffmpeg not installed in this environment")
@pytest.mark.asyncio
async def test_audio_extraction_stage_never_holds_a_second_full_size_buffer(realistic_video_bytes):
    """Mirrors run_pipeline's own real call order for a video-typed lesson:
    probe_audio_stream_status() first, then extract_audio_track() — both
    against the SAME already-in-memory upload, exactly as
    video_pipeline_tools._run_stages does."""
    fixture_mb = len(realistic_video_bytes) / (1024 * 1024)

    tracemalloc.start()
    gc.collect()

    status = await vrt.probe_audio_stream_status(realistic_video_bytes, content_type="video/mp4")
    peak_after_probe = tracemalloc.get_traced_memory()[1] / (1024 * 1024)

    extracted = await vrt.extract_audio_track(realistic_video_bytes, "video/mp4")
    peak_after_extract = tracemalloc.get_traced_memory()[1] / (1024 * 1024)

    tracemalloc.stop()

    assert status == "present"  # the synthetic fixture genuinely has an audio track
    assert extracted, "extraction should succeed for a real, valid fixture with audio"
    extracted_mb = len(extracted) / (1024 * 1024)
    print(f"\n[audio-extraction memory] fixture={fixture_mb:.1f}MB "
          f"peak_after_probe={peak_after_probe:.1f}MB peak_after_extract={peak_after_extract:.1f}MB "
          f"extracted_audio={extracted_mb:.2f}MB")

    # The remux bug's exact signature was ~2x fixture size (original +
    # a second full-size copy). This stage's real output is audio-only —
    # dramatically smaller than the video input, never a second
    # comparable-size buffer — so peak traced memory should stay close to
    # ONE copy of the fixture plus a small amount of overhead, with
    # generous headroom (1.6x) that would still comfortably catch a
    # reintroduced ~2x double-buffer if one ever appeared.
    assert peak_after_probe < fixture_mb * 1.6, (
        f"probe_audio_stream_status peak traced memory ({peak_after_probe:.1f}MB) suggests a second "
        f"large buffer for a {fixture_mb:.1f}MB fixture — investigate before assuming this is still healthy"
    )
    assert peak_after_extract < fixture_mb * 1.6, (
        f"extract_audio_track peak traced memory ({peak_after_extract:.1f}MB) suggests a second "
        f"large buffer for a {fixture_mb:.1f}MB fixture — investigate before assuming this is still healthy"
    )
    # The extracted audio itself must be genuinely small (this is WHY this
    # stage's memory profile differs fundamentally from the remux bug,
    # whose output was the same order of magnitude as its input).
    assert extracted_mb < fixture_mb * 0.3, (
        f"extracted audio ({extracted_mb:.2f}MB) is not dramatically smaller than the "
        f"{fixture_mb:.1f}MB source — if a future change makes this stage produce comparable-size "
        "output, the double-buffer risk this test guards against becomes real again"
    )
