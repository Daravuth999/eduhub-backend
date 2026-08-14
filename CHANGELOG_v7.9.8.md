# EduHub v7.9.8 — Trust & Content-Type pass

> Release date: 2026-01
> Scope: security hardening (S1-S4 + 6 hardening items) + content-fix
> items (C1-C8) + new content-type engines (dialog / MCQ / fill-blank).
> Backend contract unchanged — no GAS re-deploy required.

## 🔒 Security fixes

| ID | Fix |
|----|-----|
| **S1** | `Assistant.jsx` no longer uses `dangerouslySetInnerHTML`. Bot replies, cached replies, and the greeting are rendered through `markdown-to-jsx` with `disableParsingRawHTML: true`, plus an allow-list override that nulls out `<script>` / `<iframe>` / `<object>` / `<embed>` / `<link>`. Prompt-injection-driven XSS is neutralised. |
| **S2** | Login stays on GET (backend contract preserved) — but the password is **no longer placed in `sessionStorage`**. See S3. |
| **S3** | `AuthContext.writeSession` now strips `password` and `portalData.Password` before writing to storage. Password stays in React state (memory only). After page refresh, sessionToken-based APIs keep working; password-backed ones (sendPoints / pointsLogin / askGPT) prompt re-login instead of silently using a persisted credential. |
| **S4** | `purchaseService.isUnlocked()` for **paid** books now trusts ONLY the server-side `UnlockedBooks` / `Inventory` / Unlocks-tab cache. The localStorage ledger can no longer be tampered with to bypass the purchase flow. Free books unchanged. |
| **H1** | `public/index.html` ships a strict **Content-Security-Policy-Report-Only** meta tag. Promote to enforcing after 24h of clean reports. |
| **H2** | MathJax CDN is **version-pinned to 3.2.2** with `crossOrigin="anonymous"` + `referrerPolicy="no-referrer"` + graceful `onerror` fallback. |
| **H3** | `LibrarySearch.jsx` no longer interpolates `coverImage` into an inline `background:url("…")`. Cover thumbs render through a URL-validated `<img>` (`isSafeHttpsUrl()` — http/https only, rejects quotes/whitespace/`javascript:`/`data:`). The local `escape()` helper now also covers `"` and `'`. |
| **H4** | `booksService.normalizeAssetUrl()` tightened bare-Drive-ID regex: `{20,}` → `{25,44}`. Short alnum tokens no longer become Drive image URLs. |
| **H5** | `booksService` cache key now includes `SHEET_ID` + `SHEET_NAME` so multi-tenant deploys can't leak cached books across environments. |
| **H6** | `<meta name="referrer" content="strict-origin-when-cross-origin">` for every outbound request initiated from the page. |

## 🧩 Content-fix items

| ID | Fix |
|----|-----|
| **C1** | `LibraryShowcase` counts are now derived from `getAllBooks()` (the catalog used by the shelves) instead of the legacy `getContent()` feed. The pill and the shelves can no longer disagree. |
| **C3** | `ReaderPage` writes `data-reader-section="story|conversation|exercise"` on `<body>` and on the reader root. `reader.css` can now re-skin per section without touching component code. |
| **C5** | See H5 — cache key is tenant-scoped. |
| **C6** | See H4 — Drive ID length validated. |
| **C7** | Library filter chips now include **Audio / Video / Text**, driven by the `_contentType` already exposed on every shelf item. |

## 🎙️ Content-type engines (new, additive)

Three new block `type` values land in `booksService.js` and `ChapterBlocks.jsx`.
All three are **fully backward compatible** — any existing sheet that
doesn't use them is unaffected.

| `type` | Sheet columns used | Rendered by |
|---|---|---|
| `dialog` | `body`, `speaker`, `audio?` | `DialogTurn` (A/B/centre speaker bubbles, optional per-turn audio via the shared `BookAudioProvider`) |
| `mcq` | `body` (question), `options` (pipe-separated: `"A|B|C|D"`), `answer`, `explain?` | `ExerciseBlock` (MCQ with local scoring, correct/wrong reveal) |
| `fillblank` | `body` (with `___` placeholder), `answer`, `explain?` | `ExerciseBlock` (inline input, case-insensitive match) |
| `transcript` *(already existed; now fully wired from block rows with `start`/`end`)* | `body`, `start`, `end` | `TranscriptParagraph` |

New column aliases in `booksService.fetchBooksFromSheet`:

- `options` ← `options`, `choices`, `answers`
- `answer`  ← `answer`, `correct`, `correctanswer`
- `explain` ← `explain`, `explanation`, `feedback`
- `speaker` ← `speaker`, `role`, `character`

Section-aware CSS (`reader.css`):
- `[data-section="exercise"]` → soft blue vignette on every page.
- `[data-section="conversation"]` → looser line-height so dialog turns breathe.

## ⚠️ Migration / notes

- **No GAS changes required.** The existing `studentData`, `pointsLogin`,
  `sendPoints`, `askGPT`, and `completeLesson` actions are untouched.
- **Post-refresh UX**: on an un-upgraded GAS (no sessionToken yet),
  students who refresh the tab will be asked to sign in again before
  they can spend points or chat with the assistant. On upgraded GAS
  deployments, sessionToken takes over and refresh is seamless.
- **CSP Report-Only** — if you have a collector URL, add
  `report-uri <url>` to the meta tag. Promote to
  `Content-Security-Policy` (enforcing) after 24h of clean reports.
