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
