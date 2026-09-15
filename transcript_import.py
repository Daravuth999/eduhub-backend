"""transcript_import.py — parses SRT/VTT subtitle files into the same
`{speaker, start, end, text}` segment shape video_ai_provider.segments_to_sync
already consumes, so a manually-imported transcript with real cue-level
timing is consolidated through that EXACT same, already-proven path
(paragraph grouping + distribute_words interpolation) — never a second,
parallel consolidation implementation. Confirmed via direct reading of
video_ai_provider.py before writing this module: no existing SRT/VTT
parser exists anywhere in this codebase (checked video_pipeline_tools.py,
video_library_tools.py, video_ai_provider.py, and the frontend repo).

Neither baseline format carries real per-word timing — only one
timestamp range per CUE/line — so every word segments_to_sync produces
from either format is interpolated (its own distribute_words call),
never marked `measured`. This is the same honesty rule already enforced
for Gemini's own lower-confidence output; it is not weakened or worked
around here.

Speaker info: SRT has no speaker concept at all (confirmed against the
SRT format itself — it is plain sequence-number/timing/text, nothing
else). WebVTT's `<v Speaker Name>text</v>` voice tag IS a real, standard
part of the WebVTT spec (confirmed against the spec, not assumed) and is
parsed here when present — the only baseline-format case that supplies
speaker info without this pipeline's own speaker-detection step running
first.
"""
from __future__ import annotations

import re


class TranscriptImportError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


_SRT_TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})")
_VTT_TIME_RE = re.compile(r"(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})")
_TAG_RE = re.compile(r"<[^>]+>")


def _srt_time_to_seconds(text: str) -> float | None:
    m = _SRT_TIME_RE.search(text)
    if not m:
        return None
    h, mi, sec, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(sec) + int(ms) / 1000.0


def _vtt_time_to_seconds(text: str) -> float | None:
    m = _VTT_TIME_RE.search(text)
    if not m:
        return None
    h, mi, sec, ms = m.groups()
    hours = int(h) if h else 0
    return hours * 3600 + int(mi) * 60 + int(sec) + int(ms) / 1000.0


def parse_srt(content: str) -> list[dict]:
    """Parse SRT text into `[{start, end, text, speaker: None}, ...]`.
    SRT has no speaker concept — speaker is always None, exactly like an
    absent WebVTT voice tag, so a caller can treat both formats
    uniformly."""
    if not content or not content.strip():
        raise TranscriptImportError("empty SRT content")
    text = content.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", text.strip())
    segments: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        idx = 1 if re.fullmatch(r"\d+", lines[0].strip()) else 0
        if idx >= len(lines):
            continue
        m = re.search(
            r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})", lines[idx],
        )
        if not m:
            continue
        start = _srt_time_to_seconds(m.group(1))
        end = _srt_time_to_seconds(m.group(2))
        cue_text = _TAG_RE.sub("", " ".join(ln.strip() for ln in lines[idx + 1:])).strip()
        if start is None or end is None or not cue_text:
            continue
        segments.append({"start": start, "end": max(start, end), "text": cue_text, "speaker": None})
    if not segments:
        raise TranscriptImportError("no valid cues found — check the SRT format")
    return segments


_VTT_VOICE_RE = re.compile(r"<v\s+([^>]+)>(.*?)(?:</v>)?$", re.IGNORECASE | re.DOTALL)


def parse_vtt(content: str) -> list[dict]:
    """Parse WebVTT text into `[{start, end, text, speaker}, ...]` —
    `<v Speaker Name>text</v>` voice tags are extracted when present."""
    if not content or not content.strip():
        raise TranscriptImportError("empty VTT content")
    text = content.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip().upper().startswith("WEBVTT"):
        raise TranscriptImportError("not a valid WebVTT file — must start with WEBVTT")
    parts = text.split("\n\n", 1)
    body = parts[1] if len(parts) > 1 else ""
    blocks = re.split(r"\n\s*\n", body.strip())
    segments: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        idx = 1 if "-->" not in lines[0] else 0
        if idx >= len(lines):
            continue
        m = re.search(
            r"((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})", lines[idx],
        )
        if not m:
            continue
        start = _vtt_time_to_seconds(m.group(1))
        end = _vtt_time_to_seconds(m.group(2))
        raw_text = " ".join(ln.strip() for ln in lines[idx + 1:]).strip()
        vm = _VTT_VOICE_RE.search(raw_text)
        speaker = vm.group(1).strip() if vm else None
        cue_text = vm.group(2).strip() if vm else raw_text
        cue_text = _TAG_RE.sub("", cue_text).strip()
        if start is None or end is None or not cue_text:
            continue
        segments.append({"start": start, "end": max(start, end), "text": cue_text, "speaker": speaker})
    if not segments:
        raise TranscriptImportError("no valid cues found — check the VTT format")
    return segments


def parse_transcript_import(fmt: str, content: str) -> list[dict]:
    """Dispatch by format string ('srt' | 'vtt') to the matching parser.
    The single entry point every caller (the pipeline route) should use,
    so format support never has two divergent call sites."""
    normalized = (fmt or "").strip().lower()
    if normalized == "srt":
        return parse_srt(content)
    if normalized == "vtt":
        return parse_vtt(content)
    raise TranscriptImportError(f"unsupported import format: {fmt!r} (expected 'srt' or 'vtt')")
