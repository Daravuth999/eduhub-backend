"""book_factory_narration.py — Book Factory (Phase 3) synced-words transform.

Pure, deterministic, side-effect-free. Converts `paragraph`-type blocks to
`transcript`-type blocks so the EXISTING ElevenLabs word-timestamp
distribution logic in server.py (which only targets `transcript` blocks)
applies automatically to Book-Factory-authored chapters, without touching
ReaderPage.jsx / ChapterBlocks.jsx / ExerciseBlock.jsx / BookAudioProvider or
any other protected Reader file.

Naturally idempotent: a `transcript` block is never re-converted (the
predicate is `type == "paragraph"`, and conversion changes the type), so
calling this twice on the same chapters is a no-op the second time — no
separate "already applied" flag is required for correctness. An audit marker
(`_bfTranscriptFromParagraph: True`) is still added to each converted block so
a human or a test can see WHY a transcript block exists.

Only `paragraph` blocks are converted. `heading` / `quote` text is already
included in the ElevenLabs narration audio (server.py's full_text collector
accepts "paragraph", "transcript", "text", "paragraphs", "heading", "quote")
but is intentionally left as-is — converting them would blur the visual
distinction between a heading/quote and body prose, exactly as a manually
authored book (where the teacher chooses which blocks are `transcript`) would.
`markdown`, `dialog`, `mcq`, `fillblank`, `image`, `audio`, `video`, `embed`
blocks are never touched.
"""
from __future__ import annotations


def _convert_block(block: dict) -> dict:
    return {
        **block,
        "type": "transcript",
        "_bfTranscriptFromParagraph": True,
    }


def convert_paragraphs_to_transcript(chapters: list[dict]) -> tuple[list[dict], bool]:
    """Return (new_chapters, changed).

    `chapters` is a list of {title, blocks} dicts (matches both the Book
    Factory export shape and a saved db.books chapter shape). Never mutates
    its input. `changed` is True iff at least one block was converted.
    """
    changed = False
    new_chapters: list[dict] = []
    for ch in chapters or []:
        if not isinstance(ch, dict):
            new_chapters.append(ch)
            continue
        blocks = ch.get("blocks") or []
        new_blocks = []
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "paragraph":
                new_blocks.append(_convert_block(b))
                changed = True
            else:
                new_blocks.append(b)
        new_chapters.append({**ch, "blocks": new_blocks})
    return new_chapters, changed
