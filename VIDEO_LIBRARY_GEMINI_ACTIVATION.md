# Video Library — Gemini Activation & Deployment Checklist

**Status:** All Video Library code (backend routes, pipeline, Review
Studio, student player, purchase flow) is built, tested, and merged to
`audit/video-library-production-fixes` in both repos. Nothing in this
file was executed by Claude — every step below is a manual action you
perform in Render / MongoDB / Vercel.

There is **no feature flag** gating the Video Library. The routes mount
unconditionally in `server.py` (wrapped in try/except purely so an import
error can't take down the rest of the API — not a kill switch). Once the
branch is merged and deployed, the routes and UI are live immediately.

---

## 1. Required environment variable (only one is mandatory)

Set on the **eduhub-backend** Render service → Environment:

```
GEMINI_API_KEY=<your Gemini API key>
```

This is the only variable required for real (non-mock) AI processing.
Get a key from [Google AI Studio](https://aistudio.google.com/apikey) if
one isn't already provisioned — check first, since this codebase's other
Gemini integrations (`voice_treasure_gemini.py`, `ai_assistant_tools.py`,
`book_factory_gemini.py`, `edutalk_tools.py`) already read the same
`GEMINI_API_KEY`. If a key is already set for those features, **the Video
Library reuses it — no second key, no second provider, nothing new to
provision.**

## 2. Optional environment variables

```
VIDEO_AI_MODEL=gemini-2.5-flash     # default if unset; any generateContent-capable model works
VIDEO_AI_MOCK=1                     # forces deterministic mock ASR even if GEMINI_API_KEY is set
```

Leave both unset for normal production behavior. `VIDEO_AI_MOCK` exists
for staging/demo environments where you want the pipeline to run without
burning Gemini quota — the mock produces clearly-labeled placeholder
transcripts (`provider_version: "mock-asr-v1"`), never something that
could be mistaken for real speech recognition.

**If `GEMINI_API_KEY` is absent and `VIDEO_AI_MOCK` is not set:** the
pipeline still runs, but automatically falls back to the mock provider
(same as `VIDEO_AI_MOCK=1`) rather than failing lessons. This is
intentional — it means the Video Library is safe to deploy *before* the
key is set, but transcripts won't be real until the key is added.

## 3. Database — no migration required

No manual MongoDB setup, index creation, or data migration is needed.
`ensure_video_library_indexes()` runs automatically on API startup and
creates every required index the first time the service boots with this
code (idempotent — safe to run on every restart). Collections
(`video_lessons`, `video_purchases`, `video_progress`, `video_bookmarks`,
`video_notes`, `chapter_sync`) are created lazily on first write — there
is nothing to pre-create by hand.

## 4. Storage — no new bucket required

Uploaded media (video/audio) reuses the existing GridFS-backed storage
path already used by `sync_studio_tools.py` for book audio. No new
storage bucket, no new credentials, no new provider account.

## 5. Frontend — no build-time configuration needed

The Video Library UI ships inside the existing CRA bundle
(`eduhub-studio-test`). It talks to the backend through the existing
`REACT_APP_BACKEND_URL` — the same variable every other `/api/...`
feature already uses. No new frontend env var.

## 6. Deployment steps, in order

1. Merge `audit/video-library-production-fixes` → your integration branch
   → `master` in **both** repos (backend, frontend), or deploy the audit
   branch directly if that's your current workflow.
2. Render (backend): confirm `GEMINI_API_KEY` is set (step 1). Deploy.
   Watch the boot log for `video_library_tools: disabled (...)` or
   `video_pipeline_tools: disabled (...)` — if either line appears, the
   import failed and the feature is silently off; if neither appears,
   both mounted successfully.
3. Vercel (frontend): deploy as normal — no new env vars, no new build
   flags.
4. Author Studio → Video Factory tab (`/studio`) is visible immediately
   to allowlisted admin accounts (`StudioAuth.jsx` allowlist — unrelated
   to this feature, already governs all of `/studio`).
5. Create one test lesson end-to-end (see verification checklist below)
   before announcing the feature to students.

## 7. Turning it off

There is no dedicated kill switch, because there is no flag. To disable:
remove `GEMINI_API_KEY` (pipeline falls back to mock — lessons process
but with placeholder transcripts, nothing crashes) or revert the merge.
Nothing this feature writes affects any other collection ownership
(verified via `tools/check_collection_ownership.py --strict`), so a
revert is clean.

---

## Manual, honest disclosure: what has and hasn't been verified

Everything below the line is real evidence, not aspiration:

- **Verified in this environment:** full backend pytest suite (2330
  passed, 21 skipped), full frontend jest suite (2247 passed), `yarn
  build` clean, `tools/check_collection_ownership.py --strict` clean,
  every backend route cross-referenced against a frontend consumer (two
  gaps found and fixed this round: `GET /video/purchases/mine` and the
  admin reconcile-listing route).
- **Not verified, and cannot be from here:** a live Gemini API call
  (no `GEMINI_API_KEY` is configured in this local/dev environment), and
  end-to-end behavior against your actual deployed Render/Vercel/MongoDB
  production stack. This environment has no live MongoDB, no Docker, and
  no network path to your production infrastructure — "verified against
  the deployed code" in the sense of hitting the real production URLs is
  not something I can do from here. The mitigation is the same one this
  codebase already uses for every other Gemini feature: mock-mode
  fallback with honest labeling, so a missing key degrades gracefully
  instead of failing silently or fabricating results.
- **What you should personally check once deployed:** create one lesson,
  upload a short real video, confirm the pipeline reaches
  `review_ready` with a non-mock `provider_version`, approve it in Review
  Studio, publish it, and complete one real student purchase + watch +
  resume cycle. That is the one gap only a live deploy with a real key
  can close.
