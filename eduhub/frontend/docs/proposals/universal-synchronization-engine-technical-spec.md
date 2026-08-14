# Universal Synchronization Engine (USE) — Technical Design Specification

**Status:** **Approved architectural foundation.** Design specification, revised after two rounds of architecture review and approved for implementation. Supersedes nothing — extends the findings in `smart-books-engine-architecture-study.md`. Every "extends" reference below cites the specific existing file it builds on. Implementation begins at Phase 0 (see `smart-books-engine-architecture-study.md` §10), under the standing condition that every phase continues to verify first, extend existing systems, preserve backward compatibility, and avoid parallel infrastructure unless there is a demonstrable architectural necessity.

---

## 1. Scope

USE is scoped to consumers with a *fixed, recorded* audio/video/text asset that needs post-hoc synchronized playback. A live stream has no fixed asset to align, so real-time systems are explicitly excluded — the live coaching system stays independent, and only what it exports afterward can become a USE asset.

| Supported (USE consumers) | Not supported (stays independent) |
|---|---|
| Books | EduTalk Live's real-time conversation loop |
| Audio Books | Live microphone streaming |
| Storytelling | Live Gemini session synchronization |
| Conversation Lessons | |
| Listening Lessons | |
| Podcasts | |
| Video Lessons | |
| Uploaded MP3 | |
| Uploaded MP4 | |
| Post-session transcripts exported from other systems (e.g. a recorded EduTalk Live session) | |

Speaking Lab and Voice Treasure's recorded-clip evaluation flows are in-scope wherever they need playback-time word/sentence highlighting, on the same "fixed asset" basis.

---

## 2. Canonical Synchronization Schema

One shape, produced by any provider, consumed by any reader. Extends the existing `{word, start, end}` shape already flowing through `server.py` → `ChapterBlocks.jsx`/`DialogTurn.jsx` — this schema is a strict superset, so today's data remains valid without migration (see §11).

```jsonc
{
  "syncId": "sync_9f2a...",              // stable identity — see §4, Media Independence
  "mediaRef": "r2://.../chapter-3.mp3",  // or GridFS ref — existing storage patterns, §10

  "syncVersion": 1,                      // schema shape version (breaking changes only)
  "providerVersion": "elevenlabs-align-2026-05",  // provider/model build identifier
  "alignmentVersion": 1,                 // bumped when THIS asset is re-aligned (better model, fixed error) without a schema change
  "generatedAt": "2026-08-10T04:12:00Z",
  "approvedAt": null,                    // set once, at the reviewStatus -> "approved" transition — §5

  "durationSec": 187.4,
  "providerCategory": "speech_recognition",  // see §3 — never a vendor name
  "reviewStatus": "approved",            // "pending" | "in_review" | "approved" | "rejected" — §5

  "speakers": [                          // OPTIONAL — omitted for single-narrator content
    { "id": "spk_1", "label": "Narrator", "confidence": { "speaker": 0.97 } }
  ],

  "paragraphs": [
    {
      "id": "p1", "start": 0.0, "end": 14.2,
      "confidence": { "transcript": 0.95, "alignment": 0.93 },
      "sentences": [
        {
          "id": "p1s1", "start": 0.0, "end": 6.1,
          "confidence": { "transcript": 0.96, "alignment": 0.94 },
          "speakerId": "spk_1",          // present only when speakers[] is present
          "words": [
            { "word": "Once", "start": 0.0, "end": 0.31,
              "confidence": { "transcript": 0.98, "alignment": 0.97 } },
            { "word": "upon", "start": 0.31, "end": 0.52,
              "confidence": { "transcript": 0.94, "alignment": 0.90 } }
          ]
        }
      ]
    }
  ]
}
```

Design rules:
- **Confidence is a namespaced object, not a single float**, on every unit (word, sentence, paragraph, speaker). Ships with `transcript` and `alignment` keys (and `speaker` on speaker entries); `translation` and `pronunciation` are reserved key names for future capability layers (§13) and require no schema change to add — a consumer that doesn't recognize a key simply ignores it. Any key may be `null` when its producing provider doesn't supply one (e.g. `"providerCategory": "manual"` — a hand-typed timestamp has no meaningful transcript confidence; `null` is honest, `1.0` would be fabricated).
- **Words are the source of truth**; sentence/paragraph `start`/`end` are the first/last word's bounds, computed once at write time, not re-derived at render time — matches the existing pattern where `server.py` already writes `start`/`end` alongside `wordTimestamps` on a block (`server.py:1236-1238`).
- **`speakers[]` is optional** — single-narrator books (the overwhelming majority today) simply omit it; nothing downstream needs to special-case its absence beyond a null check, mirroring `DialogTurn.jsx`'s existing pattern where `speaker` defaults to `"Narrator"` when absent.
- **Versioning is four separate fields, each answering a different question**: `syncVersion` (can old code even parse this document's shape?), `providerVersion` (which model/build produced it — for debugging quality regressions), `alignmentVersion` (has this specific asset been re-aligned since it was first generated?), `generatedAt`/`approvedAt` (when). This lets a future, better alignment model reprocess an asset and bump only `alignmentVersion`, without touching `syncVersion` or invalidating anything that reads the schema shape.
- A `transcript`-type block gains one new field, `sync: <this object>`, while `wordTimestamps`/`start`/`end` remain exactly as today (deprecated-but-supported, §11) — this schema lives **alongside** the existing block, never replacing it.

---

## 3. Provider Independence

Extends the existing provider isolation already present for ElevenLabs (`server.py:_elevenlabs_generate`, `_elevenlabs_generate_line` — already just two functions, not scattered) and the retry/error taxonomy already proven in `book_factory_gemini.py` (`BFRetryableError`/`BFUnknownOutcomeError`/`BFTerminalError`).

A provider is identified by **capability category**, never by vendor name, anywhere in code, schema, or config. The engine depends on a capability *chain*, not on any single provider:

```
Speech Recognition Provider   (audio/video -> transcript, no timestamps yet)
        ↓
Alignment Provider            (audio + transcript -> word-level timestamps)
        ↓
Synchronization Provider      (composes the above into the canonical schema, §2 —
                                the ONLY thing the pipeline, Review Studio, and
                                Reader ever see or depend on)
```

The `SyncProvider` interface defined below **is** this top-level "Synchronization Provider" — it may internally delegate to a Speech Recognition Provider and/or an Alignment Provider to do its work, but nothing outside the provider implementation itself ever calls those stages directly or sees their intermediate output. This is what makes the chain swappable: a future provider could merge recognition+alignment into one call, or split them across two vendors, without the pipeline, Review Studio, or Reader changing at all.

Two future, reserved categories sit alongside this chain rather than in it — **Translation Provider** (transcript → translated transcript) and **Evaluation Provider** (pronunciation/fluency scoring) — named in the schema's reserved confidence keys (§2) but not designed here (§13).

Today's only two real implementations map onto the chain: ElevenLabs (Alignment Provider, wrapping its existing TTS-time alignment output — no Speech Recognition step needed, since the text is already known) and a not-yet-chosen ASR vendor (Speech Recognition + Alignment Provider combined, for uploaded media — see §12, still an open choice). Neither vendor name appears in the interface itself:

```python
class SyncProvider(Protocol):
    """The 'Synchronization Provider' at the top of the capability chain.
    One implementation per vendor. The processing pipeline and the Reader
    never import a vendor SDK directly, and the interface itself never
    exposes a vendor-specific concept — every method returns the canonical
    schema from §2, already normalized. Swapping the concrete provider
    behind this interface changes nothing upstream, and any internal
    Speech Recognition / Alignment sub-steps are invisible outside it."""

    category: str  # "speech_recognition" | "alignment" | "synthesis" | "manual"

    async def synthesize(self, text: str, voice_id: str) -> SyncResult:
        """Generate audio FROM text (TTS path — what ElevenLabs does today)."""

    async def align(self, audio_bytes: bytes, transcript: str | None) -> SyncResult:
        """Align EXISTING audio to timestamps. `transcript` optional: if
        provided, this is forced alignment; if absent, the provider must
        also perform speech recognition internally before aligning."""
```

- `ElevenLabsProvider` wraps the two existing `server.py` functions unchanged — a **wrapping**, not a rewrite; the HTTP call, the character-to-word alignment math (`server.py:536-573`), and the R2-first/GridFS-fallback storage all stay exactly as they are. Only the *output* gets reshaped into §2's schema at the boundary.
- The Reader, the Review Studio (§6), and every API contract (§9) speak only the canonical schema. None of them can name a vendor or a chain stage even if they wanted to — there is no field for it.
- Vendor selection for the not-yet-chosen categories is deliberately deferred (§12) — this spec defines the seam, not the vendor.

---

## 4. Media Independence

**Synchronization belongs to the media asset, not to the book.** A book *references* a sync document by `syncId` (§2); it does not own or embed it. This principle is treated as immutable — later phases extend the schema and pipeline, but none should reverse this ownership direction.

This is why §2's schema carries its own `syncId` and `mediaRef` rather than a book slug and chapter index. Consequences, all deliberate:
- **Reuse across books.** The same narrated audio (e.g. a shared vocabulary drill, a stock intro clip) can be referenced by `syncId` from more than one book without duplicating alignment work.
- **Synchronization updates without republishing.** Re-running an Alignment Provider to fix a bad word boundary bumps `alignmentVersion` (§2) on the sync document alone — no book revision, no republish, no author touching content they didn't change.
- **Media replacement while preserving book structure.** Swapping a chapter's audio file (re-recorded narration, a corrected take) produces a new `syncId`; the book's chapter simply repoints its reference. The book's text, blocks, and structure are untouched.
- **Simpler future localization.** A translated edition of a book can reference a different `syncId` (different language audio) against the same underlying content structure, once a Translation Provider (§3) exists — not designed here, but the ownership model already accommodates it without rework.
- `chapter_sync` (§10) is keyed by `syncId` as its primary identity; the `{slug, chapterIndex}` lookup is a secondary index for "what does this chapter currently point to," not the source of truth.

---

## 5. Synchronization Review Studio

This is a **flagship, first-class subsystem** of Author Studio — the professional quality-assurance stage for Smart Books, not a simple transcript editor bolted onto an existing panel. It owns transcript review, speaker review, synchronization (timing) review, confidence review, and the approval workflow as one coherent editorial stage, rather than scattering those concerns across different screens. Authors remain the final authority before publication.

```
Author Studio
      ↓
Synchronization Review Studio
      ↓
   Approve
      ↓
   Publish
```

Owned capabilities:
- **Transcript review** — inline text editing; an edit re-keys word boundaries via nearest-neighbor snap, and never silently re-runs the provider.
- **Speaker review** — relabeling (`spk_1` → `"Teacher"`), merging/splitting speaker segments.
- **Synchronization review** — a timeline scrubber with word/sentence/paragraph replay buttons, so an author can hear exactly what a boundary currently captures.
- **Confidence review** — every namespaced confidence value from §2 is visualized; units below a configurable per-key threshold (e.g. `transcript < 0.75`) are flagged for attention, using the same threshold-driven pattern `book_factory_interaction_planner.py` already uses for tier density budgets.
- **Approval workflow / `reviewStatus` transitions** (§2): `pending` → `in_review` (author opened it) → `approved` | `rejected` (rejected sends the asset back for re-alignment). `approvedAt` is stamped exactly once, on the `approved` transition.

**Publish gate:** a sync document is not served to students (§9) until `reviewStatus == "approved"`, OR `providerCategory` traces back to a synthesis path (ElevenLabs TTS output is auto-approved — it was generated *from* already-approved text, so there is nothing new to review; this preserves the current zero-review behavior for the existing narration pipeline exactly as it works today).

This is additive to the existing "author always reviews before publish" invariant already established for Book Factory drafts — no review is introduced where none exists today; review is added specifically for the new, lower-trust ASR-on-uploaded-media path where transcription errors are expected.

---

## 6. Processing Pipeline

Extends `book_factory_jobs.py`'s existing atomic per-stage claim/attempt-fencing state machine (the same one already safely handling blueprint/chapter/cover/narration/conversation stages) with one new stage family, rather than a parallel job engine:

```
Upload (new route, R2-first/GridFS-fallback — same pattern as _upload_audio_to_r2)
        ↓
[audio extraction — video only, new, ffmpeg or equivalent]
        ↓
Synchronization Provider (§3) — internally: Speech Recognition (if no
transcript supplied) then Alignment  →  raw output
        ↓
Normalize to canonical schema (§2), assign syncId  →  reviewStatus: "pending"
        ↓
Synchronization Review Studio (§5)
        ↓
reviewStatus: "approved"
        ↓
Sync document servable at GET /api/sync/{syncId} (§9); book's chapter repoints
its reference (§4) — no book revision write required unless the book's own
structure also changed
```

---

## 7. Synchronization Consumption Layer

Formalizes the reuse already identified in review: `ChapterBlocks.jsx`'s `computeTimestampActiveWord` and `DialogTurn.jsx`'s `computeWordSyncActiveWord` are already standalone, already-exported pure functions — not new logic, a refactor of what exists into one shared library:

```
src/eduhub/lib/syncConsumption/
  computeActiveWord(sync, timeSec)        — extends computeTimestampActiveWord
  computeActiveSentence(sync, timeSec)    — new, same binary-search discipline
  computeActiveParagraph(sync, timeSec)   — new, same binary-search discipline
  computeCurrentSpeaker(sync, timeSec)    — extends computeWordSyncActiveWord's speaker lookup
  computeScrollPosition(sync, timeSec, viewportMeta) — new, for auto-scroll reading profiles
```

- `ChapterBlocks.jsx` and `DialogTurn.jsx` become **consumers** of this library, not owners of synchronization logic. A future reader (a native mobile app, an alternate web reader) imports the same library and gets identical highlighting behavior for free — the synchronization model is reusable independent of any particular Reader implementation. This separation is also what makes §8's performance principle enforceable: the Reader's job stays presentation-only, so it can stay lightweight regardless of how synchronization data grows in richness.
- **Reading profiles** are a small config object resolved at Reader mount time, modeled directly on `book_factory_interaction_planner.py`'s `TIER_INTERACTION_POLICY` pattern:
  ```python
  READING_PROFILES = {
      "reading":      {"wordHighlight": True, "sentenceHighlight": False, "autoScroll": False},
      "storytelling": {"wordHighlight": True, "sentenceHighlight": True,  "autoScroll": True},
      "shadowing":    {"wordHighlight": True, "sentenceHighlight": True,  "replayControls": True},
      # ... conversation, listening, presentation, pronunciation
  }
  ```
  A book's `syncProfile` field selects one preset; an optional `syncOverrides` object (same shape as a profile) merges on top for advanced per-book tuning. Profiles are sugar over the same granular capability flags, never a separate data model — advanced overrides remain fully expressive.
- The Reader reads `syncProfile`/`syncOverrides` the same way it already reads `tier`/`price` today — a plain field on the book document, no new fetch.

---

## 8. Performance

Elevated from an implementation detail to a platform principle: **USE must preserve the responsiveness of the current Reader.** The existing mobile-first, fast-loading experience is a constraint on every phase, not a nice-to-have to revisit later.

- **Sync data loads lazily, not eagerly.** `GET /api/books/{slug}` never grows to include sync payloads (§9) — a chapter's sync document is fetched only when that chapter is actually opened, exactly as designed in §9's API contract. Books without any sync data pay zero extra cost, today and after rollout.
- **Media is processed lazily.** Speech Recognition/Alignment (§3) run once, asynchronously, in the existing job pipeline (§6) — never synchronously in a student-facing request path. A student is never waiting on a provider call.
- **The Reader stays presentation-only** (§7) — binary-search lookups over already-fetched, already-normalized data, the same computational shape as today's `computeTimestampActiveWord`. Adding sentence/paragraph/speaker resolution does not change this complexity class.
- **New capabilities must degrade, not block.** A book with no sync document, a pending (unapproved) sync document, or a `syncVersion` newer than the running client's consumption library (§10) all fall back to existing behavior (§11) rather than failing or stalling the Reader.

---

## 9. API Contracts

New routes, following the existing `register_*_routes(api, db, ...)` explicit-DI convention. Every payload is the canonical schema (§2) or a reference to it — never a provider-shaped object.

```
POST   /api/studio/sync/upload
       multipart audio/video, target reference (book slug + chapter index, or
       a bare mediaRef for a not-yet-attached asset — see §4)
       → { jobId, status: "queued" }

GET    /api/studio/sync/jobs/{jobId}
       → { status, stage, canonicalSync: <§2 schema or null>, error? }
       (mirrors book_factory_jobs.py's existing job-status polling shape)

POST   /api/studio/sync/jobs/{jobId}/review
       body: { reviewStatus, editedTranscript?, speakerRelabels? }
       → updated canonicalSync, reviewStatus transition per §5

GET    /api/sync/{syncId}
       public, student-facing — returns ONLY reviewStatus == "approved"
       canonicalSync (§2), 404 otherwise. This is the ONE endpoint the
       Reader calls; it never sees job/provider internals. Keyed by
       syncId, not by book/chapter (§4).

GET    /api/books/{slug}/chapters/{index}/sync
       thin convenience wrapper — resolves the chapter's current syncId
       reference, then behaves exactly like GET /api/sync/{syncId}.
```

`GET /api/books/{slug}` (existing, `server.py`) is **unchanged** — it keeps returning the book document with its existing `wordTimestamps`/`start`/`end` fields exactly as today. The sync sub-resource is fetched separately, lazily, only when a reader actually opens a chapter with sync data (§8) — this avoids inflating the existing book-fetch payload for the majority of books that have no sync data at all.

---

## 10. Storage Strategy

- **Canonical sync documents** live in a new collection, `chapter_sync`, primary-keyed by `syncId` (§4) — not embedded in the book document itself, unlike today's `wordTimestamps`. A secondary index on `{slug, chapterIndex}` supports the convenience lookup in §9. Rationale: sync data can be large (a full paragraph/sentence/word tree per asset) and has its own lifecycle (pending → review → approved) and its own reuse model (§4) independent of the book's own revision lifecycle; embedding it would force every sync edit to mint a new book revision, which the existing `db.books` append-only-revision model isn't designed for at this granularity.
- **Media bytes** (uploaded audio/video, and any intermediate extracted-audio-from-video file) follow the proven R2-first/GridFS-fallback pattern from `_upload_audio_to_r2` — no new storage backend.
- **`syncVersion`** (§2) is bumped only on a breaking schema-shape change. The consumption library (§7) must handle its own current version and the immediately-prior version, so a deploy of a new `syncVersion` never breaks already-approved chapters mid-rollout. `alignmentVersion` changes independently and never requires consumption-library changes — it is informational provenance, not a shape signal.
- **Collection ownership**: `chapter_sync` is owned by the new sync-processing module alone, per the codebase's existing collection-ownership discipline (enforced by `tools/check_collection_ownership.py`, already governing `camrapidpay_intents`, `payment_intents`, etc.) — no other module writes to it directly.

---

## 11. Backward Compatibility

- Every existing book with `wordTimestamps`/`start`/`end` on its blocks (today's only sync data) **continues to render exactly as today** — `ChapterBlocks.jsx`/`DialogTurn.jsx` keep their existing fallback path for blocks with no `sync` field at all. The consumption library (§7) checks for `sync` first, falls back to the legacy flat fields, and finally to the existing weighted-estimation mode — three tiers, never fewer capabilities than today.
- **No migration is required or triggered.** A book only gains a `chapter_sync` document if an author explicitly runs it through the new upload pipeline. Nothing reprocesses existing ElevenLabs-generated audio.
- **The ElevenLabs TTS path is unchanged at the storage layer** — `server.py`'s `run_elevenlabs_for_chapter` keeps writing `wordTimestamps`/`start`/`end` on the block exactly as today; a thin adapter at read time (not write time) can optionally lift that flat shape into the §2 canonical schema on the fly for chapters that want sentence/paragraph highlighting, without touching the write path at all. This is the safest possible integration: zero risk to the proven, already-shipping narration pipeline.
- **`camrapidpay_intents`-style collection-ownership discipline applies**: the new `chapter_sync` collection is never touched by `book_factory_jobs.py`, `server.py`'s book routes, or any Reader-facing route directly — only through the new module's own functions, verifiable by the existing `check_collection_ownership.py --strict` gate.

---

## 12. Scope Discipline & Non-Goals

USE exists for **one purpose**: produce and serve accurate synchronization data for recorded learning assets. To keep that boundary clean, the following are explicitly outside the engine — other systems may *consume* synchronization data, but must not be absorbed *into* the engine:

- **AI tutoring, lesson generation, translation, scoring, and media editing** are not part of USE. They may read a `syncId`'s canonical data (e.g. an Evaluation Provider scoring pronunciation against aligned words), but that consumption happens in those systems, not inside the synchronization engine itself.
- Choosing the vendor behind the Speech Recognition / Alignment Provider categories (§3) for uploaded media — a separate, focused evaluation (accuracy, Khmer-language support given EduHub's bilingual content, cost per minute, latency) belongs in its own short decision doc before implementation begins. This spec defines the seam those vendors plug into, deliberately not which vendor.
- Any change to EduTalk Live Coach's real-time loop, Gemini consolidation (already scoped separately in the architecture study), or video upload/extraction internals beyond noting where they plug into this pipeline.
- Reader UI/visual design for karaoke/shadowing modes — this spec defines the data contract they consume, not their presentation.
- Designing Translation or Evaluation providers, or any of the future capability layers in §13 — reserved categories and reserved confidence keys (§2) only.

---

## 13. Future Expansion (Reserved, Not Designed)

The following are recognized as future capability layers the schema and pipeline must not need to be redesigned for — they are reserved extension points, not scoped work:

- Multilingual synchronization
- Pronunciation evaluation
- Translation synchronization
- Phoneme alignment
- Vocabulary synchronization
- Assessment synchronization

Each of these should arrive as an **optional layer on the same synchronization contract** (§2's namespaced confidence object and `providerCategory` enum are the deliberate seams for this) rather than as an independent parallel system. None are designed in this spec; they are named here so that §2/§3's extensibility can be evaluated against concrete future demands rather than in the abstract.

---

## Summary of what changes vs. what's reused

| New | Reused unchanged |
|---|---|
| `chapter_sync` collection + schema (§2), keyed by `syncId` (§4) | `book_factory_jobs.py` state machine (extended with one stage family) |
| Synchronization Provider implementation (vendor TBD) — internally chains Speech Recognition + Alignment (§3) | `ElevenLabsProvider` = thin wrapper over existing `_elevenlabs_generate*` |
| 5 new/adjusted API routes (§9) | `db.books` schema, revision model, `GET /api/books/{slug}` (untouched) |
| Synchronization Review Studio as a flagship, first-class subsystem (§5) | R2-first/GridFS-fallback storage pattern |
| Reading profiles config | `book_factory_interaction_planner.py`'s tier-policy pattern (directly modeled) |
| Shared `syncConsumption/` module (§7) | `computeTimestampActiveWord`/`computeWordSyncActiveWord` (extracted, not rewritten) |
