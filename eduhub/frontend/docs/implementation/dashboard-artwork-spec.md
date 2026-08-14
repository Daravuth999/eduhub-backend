# Dashboard Artwork Specification (RC2)

For anyone authoring artwork for a Dashboard surface in Author Studio (Welcome Hero, Today's Discovery, Empty states, or any future Dashboard experience registered in `dashboardExperienceRegistry.js`). Documentation only — the media pipeline, upload flow, and placement engine it describes are unchanged by this document.

## Where this applies

Every Dashboard artwork slot — Mission Hero, Today's Discovery items, Today's Discovery's empty state, and any empty state built on `EmptyStateCard` — renders through the same two files:

- `src/eduhub/lib/experienceConfig/heroArtworkSchema.js` — the layout math (`getArtworkLayout`)
- `src/eduhub/components/HeroArtworkLayer.jsx` — the render + offline-cache layer

Because every slot shares this one engine, one spec covers all of them.

## File format

- **Transparent PNG or WebP.** JPEG is accepted but loses the transparent background, which usually looks wrong against a tinted card.
- No embedded text. Titles, labels, and CTAs are set by the surrounding card in real typography — text baked into the image can't be localized, can't respect the student's font-size setting, and won't match the card's type scale.
- Reasonable file size (a few hundred KB, not multiple MB) — this is a mobile-first PWA and every artwork asset is preloaded into the offline cache on first render.

## Composition

- **Landscape or square subject, right-weighted or center-weighted.** The layout engine's default placement is `right`, anchored so the image scales toward that edge rather than its own center — art directed with the subject already toward the right (or center) edge composes best against that default.
- **Safe padding built into the source image is not necessary** — the engine already insets the artwork from the card's edges (`padding`, default 16px per side) so it never touches rounded corners. Extra whitespace baked into the file just shrinks the effective subject size.
- **The engine caps artwork at 55% width / 75% height of its zone** and lets `scale` (author-adjustable, 100 = that reference size) grow or shrink from there — so a single asset works across placements without being re-exported per placement.
- **Premium educational illustration style** — consistent with Welcome Hero's existing artwork: warm, inviting, editorial-illustration quality rather than stock-photo or clip-art. Avoid busy backgrounds; the subject should read clearly at small sizes (Today's Discovery's artwork zone is ~120px tall on a phone).

## Placement, scale, and effects

All of the following are already exposed as Author Studio controls (`HeroArtworkPanel.jsx`) — nothing below requires a code change to use:

- **Placement** — one of `left / center / right / topLeft / topRight / bottomLeft / bottomRight / custom`. Pick based on where the card's text sits so the two never compete for the same space.
- **Scale** — percent, anchored at the placement's edge (a right-placed piece scaling up grows leftward, staying pinned to the right).
- **Padding** — per-edge, in px, on top of the engine's default safe inset.
- **Layer order** — `behindText` (default) is correct for nearly every case; the others exist for Welcome Hero's particle system and rarely apply to Discovery-style cards.
- **Opacity / brightness / contrast / blur** — optional filters for blending an asset into a themed card without re-exporting it.
- **Overlay / gradient overlay** — an optional color wash rendered above the image, for keeping any incidental text legible over a busier image.

## What NOT to do

- Don't hand-position artwork by eyeballing pixels in an external tool and exporting an image sized to one specific card — the same asset needs to work across placements, scales, and (for Today's Discovery) a card whose text length varies item to item.
- Don't embed a background color intended to match one theme — dark mode and light mode both render this artwork, and a hardcoded background will clash in one of them. Keep the source transparent and let the card's own background (which is theme-aware) show through.
- Don't rely on the artwork to carry the section's meaning by itself — every Dashboard artwork slot is decorative reinforcement for real text/data, never the only carrier of information (per the Dashboard's "never fabricate data" rule, an artwork-only claim with no real backing text would be exactly that kind of fabrication).

## Why one spec instead of one per surface

Today's Discovery's artwork zone was fixed in RC2 to reserve a defined, guaranteed height (`src/eduhub/components/dashboard/DiscoveryCard.jsx`) specifically so authors never have to manually position artwork per item — the zone is automatic, the same engine Welcome Hero already uses. Any future Dashboard experience type that adds an artwork field should reuse `heroArtwork`'s shape and `HeroArtworkLayer` rather than inventing a new picker or layout system — that reuse is the whole point of the shared engine, and it's what keeps this one spec accurate for every surface it applies to.
