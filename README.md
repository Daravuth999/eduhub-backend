# EduHub Unified Portal — v7.5 (Persistent Audio + Auto-Transcript)

> **What's new in v7.5 (May 2026):**
> The 3D reader now ships a **single, page-survival audio engine** plus
> **karaoke-style transcript highlighting**. Press play once on the
> introduction page, then keep flipping pages — the narration never
> stops, and the spoken words light up in time across every transcript
> paragraph that follows.
>
> **Reader chrome:**
> * Pulsing **AUDIO ON THIS PAGE** badge appears wherever an audio
>   block is present, switching to a green pulse + "Playing — …" label
>   the moment narration starts.
> * Custom in-page audio control (large gold play/pause, scrub bar, time)
>   replaces the native `<audio>` chrome on transcript pages so it blends
>   with the parchment theme.
> * **Persistent floating mini-player** docks at the bottom of the reader
>   the moment any audio loads. Survives every page transition, exposes
>   play/pause, scrub, and a close (X) button.
>
> **New `transcript` block type** (great for listen-along readers):
> ```json
> { "type": "transcript", "start": 0, "end": 18, "text": "Last summer I spent…" }
> ```
> Word-level highlight is computed by linear interpolation between
> `start` and `end` (seconds). No external SRT/VTT required — but you
> can ship one paragraph per spoken phrase for finer-grained sync.
>
> **Reader block types (CMS-friendly):**
> | `type`        | `text`                          | optional                 |
> |---------------|---------------------------------|--------------------------|
> | `audio`       | direct URL (mp3/m4a/ogg/wav)    | `heading` caption        |
> | `video`       | direct URL (mp4/webm)           | `heading`, `poster`      |
> | `embed`       | YouTube / Vimeo / Loom page URL | `heading`                |
> | `transcript`  | spoken paragraph text           | `start`, `end` (seconds) |
>
> URLs are auto-normalised: `dropbox.com/…?dl=0` →
> `dl.dropboxusercontent.com/…?raw=1`, Drive `/file/d/<id>/view` →
> `uc?export=download&id=<id>`, and YouTube / Vimeo / Loom share links →
> their proper embed URLs.
>
> **v7.3 Fix Pack (still in):**
> * `pointsLogin` uses GET (real wallet balance everywhere).
> * `purchaseBook` mirrors the P2P pipeline: `sendPoints → re-read
>   balance via pointsLogin → update UI immediately`.
> * `AuthContext.refreshPoints` is awaitable; new `setBalance()` for
>   instant optimistic updates after a debit.
> * Purchase modal has a "Top up at Lucky Spin" CTA when balance < price.
> * `REACT_APP_LIBRARY_TREASURY_ID` pre-configured to `stu001`.

## Tech stack (unchanged from v6.1)
* React 19 (CRA 5 + CRACO) + Tailwind 3.4 + Framer Motion 12
* `react-router-dom` 7 · `lucide-react` · `markdown-to-jsx` (new in v7)
* Google Apps Script backends (Portal / Points / Game / Shop / Library / Assistant / SystemTest / Config)
* HMAC session-token security (v6.1)

---

## 1) Quick start (5 minutes)

```bash
# 1. Install dependencies
yarn install

# 2. Configure env (.env already populated with demo Sheet; change to yours
#    — or delete those two lines to use the local JSON fallback only)
cat .env
#   REACT_APP_BACKEND_URL=...
#   REACT_APP_BOOKS_SHEET_ID=1DY8NSPcyvWy-GPbVA2tcxqiadUwZ1AgfNWtCQjvkO-E
#   REACT_APP_BOOKS_SHEET_NAME=Books

# 3. Run the dev server
yarn start      # opens on http://localhost:3000
```

Production build:
```bash
yarn build      # outputs /build — deploy to Vercel / Netlify / GH Pages
```

---

## 2) Library Reader — what's in v7

| Feature | Where |
|---|---|
| New route `/library/read/:slug` rendered outside AppShell for a distraction-free surface | `src/App.js` |
| Book cover page (gradient, emoji, author, "OPEN THE BOOK" CTA) | `src/eduhub/pages/library/reader/BookCover.jsx` |
| Subtle 3D page-flip between chapters (Framer Motion) | `src/eduhub/pages/library/reader/ReaderPage.jsx` |
| Classic book typography (drop caps, justified text, gold blockquote) | `src/eduhub/pages/library/reader/reader.css` |
| Markdown + structured-blocks renderer | `src/eduhub/pages/library/reader/ChapterBlocks.jsx` |
| Table-of-Contents drawer with chapter jump + "done" ticks | `src/eduhub/pages/library/reader/TocDrawer.jsx` |
| Light / Sepia / Dark theme toggle (persisted) | toolbar in `ReaderPage.jsx` |
| Font size toggle SM / MD / LG / XL (persisted) | toolbar |
| Bookmark / last-page memory (localStorage, per slug) | `ReaderPage.jsx` |
| Keyboard (←/→/Space), swipe, and on-screen arrows | `ReaderPage.jsx` |
| Completion calls the existing GAS `completeLesson` (points preserved) | `ReaderPage.jsx` |
| Cards gain a gold **READ** in-app badge when catalog-backed | `src/eduhub/pages/library/components/BookCard.jsx` |
| Manual **SYNC SHEET** button on the Library page | `src/eduhub/pages/library/LibraryPage.jsx` |
| **v7.1** Point economy: price badge per card (Free / N pts / Owned) | `BookCard.jsx` |
| **v7.1** Live wallet pill in the library header | `LibraryPage.jsx` |
| **v7.1** Stunning purchase modal (coin deduct → confetti → unlock) | `src/eduhub/pages/library/components/PurchaseModal.jsx` |
| **v7.1** Purchase ledger (localStorage, per-student, instant) | `src/eduhub/pages/library/books/purchaseService.js` |
| **v7.1** Reader guards — direct URL to a paid unowned book redirects to Library | `ReaderPage.jsx` |
| **v7.1** Skeleton shimmer on first shelves load · book-flip spinner on reader load | `library-theme.css` + `ReaderPage.jsx` |

---

## 3) Books CMS — edit books without code

Two content sources, in priority order:

1. **Google Sheets** (recommended) — public gviz JSON, no auth, no GAS
2. **Local JSON fallback** — `public/books/index.json` (ships with 5 demo books)

Details in **`LIBRARY_CMS_GUIDE.md`** (included at project root).

Minimum to go live with a new book:
1. Open your Sheet → add a row
2. Fill `slug`, `section` (story/conversation/exercise), `title`, `published=TRUE`
3. Either paste markdown in `content` (set `format=markdown`), or fill `chapter/type/heading/body` rows (set `format=blocks`)
4. Save the Sheet → reload the app → book appears (≤10 s cache)

Or click the **SYNC SHEET** button for an instant refresh.

---

## 4) File tree (v7-only additions in ☆)

```
src/
├── App.js                                    ☆ added /library/read/:slug route
├── eduhub/
│   ├── components/   … (unchanged)
│   ├── pages/
│   │   ├── library/
│   │   │   ├── LibraryPage.jsx               ☆ merges catalog into shelves, routes in-app
│   │   │   ├── api.js
│   │   │   ├── sections.js                   ☆ respects catalog-driven NEW flag
│   │   │   ├── library-theme.css
│   │   │   ├── books/
│   │   │   │   └── booksService.js           ☆ NEW — Sheets + JSON CMS
│   │   │   ├── reader/                       ☆ NEW — full reader
│   │   │   │   ├── ReaderPage.jsx
│   │   │   │   ├── BookCover.jsx
│   │   │   │   ├── ChapterBlocks.jsx
│   │   │   │   ├── TocDrawer.jsx
│   │   │   │   └── reader.css
│   │   │   └── components/
│   │   │       ├── BookCard.jsx              ☆ adds 'READ' in-app badge
│   │   │       └── … (others unchanged)
│   │   ├── portal/ · game/ · assistant/ · systemtest/  … (unchanged)
│   │   ├── Dashboard.jsx · LoginPage.jsx … (unchanged)
│   ├── context/ · hooks/ · lib/              … (unchanged)
└── components/ui/                            … (unchanged)

public/
├── books/
│   └── index.json                            ☆ NEW — 5 demo books
└── … (unchanged)

gas-backend/                                  … (unchanged — do NOT redeploy)
LIBRARY_CMS_GUIDE.md                          ☆ NEW — step-by-step CMS guide
```

---

## 5) Env variables

`.env` (shipped — replace the Sheet ID with yours):

```
REACT_APP_BACKEND_URL=https://env-cleanup-deploy.preview.emergentagent.com
WDS_SOCKET_PORT=443
ENABLE_HEALTH_CHECK=false
REACT_APP_BOOKS_SHEET_ID=1DY8NSPcyvWy-GPbVA2tcxqiadUwZ1AgfNWtCQjvkO-E
REACT_APP_BOOKS_SHEET_NAME=Books
# A real student ID that receives the points spent on paid-book unlocks.
# Works out-of-the-box with `stu001`; swap to a dedicated treasury student
# (e.g. REACT_APP_LIBRARY_TREASURY_ID=LIBRARY_TREASURY) once you've added
# that row to your roster so book-purchase revenue is isolated.
REACT_APP_LIBRARY_TREASURY_ID=stu001
```

> Want to disable Sheets and use only the local JSON file? Comment out the two
> `REACT_APP_BOOKS_*` lines and restart.

---

## 6) What did NOT change (important)

- **No GAS code was modified.** The existing LibraryBackend / Portal / Points /
  Game / Shop / Assistant / SystemTest / Config web-apps keep their URLs,
  actions, and schemas.
- **Legacy external-link books still work.** Any shelf item that isn't in the
  catalog opens via the original `window.open()` confirm-modal flow, exactly
  as in v6.1.
- **Points system still works.** The reader calls the same `completeLesson`
  endpoint when the last page is reached.
- **Auth, roster, Telegram FAB, dashboard, lucky spin, portal, system test,
  AI assistant — all untouched.**

---

— Designed for Learning Excellence.
"# Story-Creation-Prompt" 
