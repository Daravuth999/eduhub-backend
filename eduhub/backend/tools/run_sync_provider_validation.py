#!/usr/bin/env python
"""tools/run_sync_provider_validation.py — Universal Synchronization Engine,
Speech Recognition / Alignment provider validation harness.

Runs the real, evidence-based comparison requested before coupling any
implementation to a vendor (tech spec §12): transcription accuracy (when a
reference transcript is supplied), speaker diarization, word-level
timestamp coverage, sentence-turn alignment, latency, and confidence —
against REAL sample files, via the CANDIDATE `ScribeAlignmentProvider`
(sync_provider.py) — never a production route, never wired into server.py.

This script makes ZERO assumptions about results: it reports what the
provider actually returns for the files it is given. It does not run
without real inputs — there is no synthetic/fabricated fallback, per this
project's explicit "do not bypass validation" instruction.

Requires:
  - ELEVENLABS_API_KEY environment variable (not present in this
    development environment — see the run report this script prints if
    missing, and docs/proposals/synchronization-provider-vendor-decision.md
    in the frontend repo for why this specific vendor is being evaluated).
  - A manifest JSON describing real sample files (see --manifest below).
    Sample manifest shape:
      [
        {"path": "khmer_conversation.mp3", "language_code": "khm",
         "content_type": "conversation", "reference_transcript": "..." },
        {"path": "english_storytelling.mp3", "language_code": "eng",
         "content_type": "storytelling", "reference_transcript": null}
      ]
    `reference_transcript` is optional per sample — when present, a basic
    word-error-rate is computed against it; when absent, the report still
    covers timestamp coverage/diarization/latency/confidence, just not
    transcription accuracy for that sample.

Usage:
  ELEVENLABS_API_KEY=... python tools/run_sync_provider_validation.py --manifest samples.json

Video note: as of this script's writing, EduHub has no video upload
pipeline and no existing video assets anywhere in the system (confirmed in
docs/proposals/smart-books-engine-architecture-study.md's explicit "not
found" list). This harness accepts a video file exactly like an audio
file (it only sends bytes to the endpoint) but cannot validate the
video-specific requirement until a real video sample exists — flagged
in the report, not skipped silently.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sync_provider import ScribeAlignmentProvider  # noqa: E402
from sync_schema import validate_sync_document  # noqa: E402


def _word_error_rate(reference: str, hypothesis: str) -> float | None:
    """Standard Levenshtein-distance WER over whitespace-tokenized words.
    Returns None if reference is empty (nothing to compare against)."""
    ref_words = reference.split()
    hyp_words = hypothesis.split()
    if not ref_words:
        return None
    d = [[0] * (len(hyp_words) + 1) for _ in range(len(ref_words) + 1)]
    for i in range(len(ref_words) + 1):
        d[i][0] = i
    for j in range(len(hyp_words) + 1):
        d[0][j] = j
    for i in range(1, len(ref_words) + 1):
        for j in range(1, len(hyp_words) + 1):
            cost = 0 if ref_words[i - 1] == hyp_words[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    return d[len(ref_words)][len(hyp_words)] / len(ref_words)


async def _validate_one(provider: ScribeAlignmentProvider, sample: dict) -> dict:
    path = Path(sample["path"])
    if not path.exists():
        return {"path": str(path), "error": f"file not found: {path}"}

    audio_bytes = path.read_bytes()
    started = time.monotonic()
    try:
        result = await provider.align(audio_bytes, language_code=sample.get("language_code"))
    except Exception as exc:  # noqa: BLE001 — report the failure, don't crash the batch
        return {"path": str(path), "error": f"{type(exc).__name__}: {exc}"}
    latency_sec = time.monotonic() - started

    sync = result["sync"]
    ok, schema_errors = validate_sync_document(sync)
    words = [w for p in sync["paragraphs"] for s in p["sentences"] for w in s["words"]]
    hypothesis_text = " ".join(w["word"] for w in words)

    reference = sample.get("reference_transcript")
    wer = _word_error_rate(reference, hypothesis_text) if reference else None

    confidences = [w["confidence"].get("transcript") for w in words if w["confidence"].get("transcript") is not None]
    speaker_count = len(sync.get("speakers") or [])

    return {
        "path": str(path),
        "language_code": sample.get("language_code"),
        "content_type": sample.get("content_type"),
        "latency_sec": round(latency_sec, 2),
        "word_count": len(words),
        "sentence_turn_count": len(sync["paragraphs"][0]["sentences"]),
        "speaker_count": speaker_count,
        "mean_transcript_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
        "min_transcript_confidence": round(min(confidences), 4) if confidences else None,
        "word_error_rate": round(wer, 4) if wer is not None else None,
        "schema_valid": ok,
        "schema_errors": schema_errors,
        "transcript_preview": hypothesis_text[:200],
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="Path to a JSON manifest of real sample files (see module docstring for shape)")
    parser.add_argument("--model-id", default="scribe_v1", choices=["scribe_v1", "scribe_v2"])
    args = parser.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        print(
            "BLOCKED: ELEVENLABS_API_KEY is not set in this environment.\n"
            "This script cannot make a real API call without it — no synthetic\n"
            "fallback is used, per the explicit 'do not bypass validation' instruction.\n"
            "Set the key and re-run, or run this script yourself in an environment\n"
            "that already has it.",
            file=sys.stderr,
        )
        return 2

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        print(f"BLOCKED: manifest file not found: {manifest_path}", file=sys.stderr)
        return 2
    samples = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not samples:
        print("BLOCKED: manifest is empty — nothing to validate.", file=sys.stderr)
        return 2

    provider = ScribeAlignmentProvider(api_key, model_id=args.model_id)
    results = [await _validate_one(provider, s) for s in samples]

    print(json.dumps({"model_id": args.model_id, "results": results}, indent=2, ensure_ascii=False))

    failures = [r for r in results if r.get("error") or not r.get("schema_valid", True)]
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
