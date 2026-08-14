# EduHub v7.9.7 — Cover Badge Repositioning + Auto Content-Type Detection

> Release date: 2026-01

## Summary

Book-card and in-reader cover badges were re-organised so the animated
"Live · New" pill no longer collides with the instructor-driven
`SheetBadge` (PREMIUM / FEATURED / HOT / …). The pill was also
renamed to just **"New"**, and every cover now auto-detects whether it
contains audio, video or plain text and shows the matching lucide-react
icon (`Headphones` / `Video` / `BookOpen`).

Sheet editors gain a new optional column — **`contentType`** — that
overrides the auto-detection when set to one of `audio`, `video`, or
`text` (case-insensitive).

## Visual layout (book card)

```
┌────────────────────┐
│ [15 PTS]  [PREMIUM]│   ← top-left = price chip, top-right = SheetBadge
│                    │
│      cover         │
│                    │
│            [ NEW ] │   ← NEW pill (gold) — moved from top-left
│            [ AUDIO]│   ← auto content-type chip (lucide icon)
│ Book title         │
│ Author · Lv         │
└────────────────────┘
```

## Files changed

| File | What changed |
|---|---|
| `src/eduhub/pages/library/components/NewBadge.jsx` | Label `Live · New` → `New`; pill tightened (`px-2 py-0.5`). |
| `src/eduhub/pages/library/components/BookCard.jsx` | NEW pill + content-type chip moved to bottom-right stack. Added `ContentTypeChip` (Headphones / Video / BookOpen) using the existing `book-card__inapp` aesthetic. |
| `src/eduhub/pages/library/reader/BookCover.jsx` | Added top-chip row content-type indicator with matching lucide icon (re-uses book's existing accent colour). |
| `src/eduhub/pages/library/books/booksService.js` | New column alias `contentType` (plus `booktype`, `kind`, `mediatype`, `format2`). New helpers `detectContentType()` and `normalizeContentType()`. `_contentType` is now promoted onto every shelf item via `mergeCatalogIntoShelves`. |

## Constraints respected

* No hook / state / API / prop / component-export changed.
* No new dependency installed — only framer-motion + lucide-react
  (both pre-existing) are used.
* All Tailwind classes and CSS variables follow the existing
  `book-card__inapp`, `text-parchment`, `rounded-full`, `tracking-[…]`
  conventions — no new palette or utility was invented.
* The legacy `📖 Read` pill position was preserved; it now carries the
  auto-detected icon instead of a hard-coded emoji.

## Sheet editor notes

* Existing `badge` column (Premium / Featured / Hot / …) still drives
  the top-right `SheetBadge` exactly as before.
* Existing `newUntil` column still drives the golden **New** pill.
  Leave empty to fall back to the 7-day client-discovered window.
* NEW column `contentType` (optional) accepts `audio`, `video`, `text`
  and overrides the automatic scan of chapter blocks.
