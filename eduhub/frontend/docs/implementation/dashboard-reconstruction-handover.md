# Dashboard Reconstruction — Engineering Handover

**Status:** Release Candidate (RC1) — implementation frozen, pending authenticated acceptance testing.
**Scope:** Home Dashboard (`/`) presentation layer + a new Dashboard Studio framework in Author Studio. Nothing else.
**Date:** 2026-07-28

This document is the permanent reference for this project. If you are extending the Dashboard, read Section 4 first. If you are debugging it, read Section 1–2. If you are deciding whether something is in scope, read Section 7 before touching anything.

---

## Section 1 — Final Architecture

The Dashboard is built from five systems, four of which already existed before this project and were reused unchanged:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Author Studio (/studio)                                            │
│                                                                       │
│  ┌───────────────────────────┐   ┌─────────────────────────────┐    │
│  │ Existing Experience Studio │   │ Dashboard Studio  (NEW)      │    │
│  │ panels (unchanged):        │   │  src/studio/DashboardStudio  │    │
│  │  WelcomeExperienceStudio   │   │  .jsx                        │    │
│  │  AchievementExperienceStudio│   │                               │    │
│  │  PromotionExperienceStudio │   │  Generic list→edit→preview→   │    │
│  │  DashboardEnvironmentStudio│   │  publish shell, parameterized │    │
│  │  AnnouncementsStudio       │   │  over a registry (Section 3)  │    │
│  └──────────────┬─────────────┘   └───────────────┬───────────────┘    │
│                 │                                  │                  │
│                 └────────────────┬─────────────────┘                  │
└──────────────────────────────────┼─────────────────────────────────┬─┘
                                   ▼                                 │
                  Experience Configuration Platform                  │
                  (pre-existing, generic, untouched)                 │
                  src/studio/api.js:                                 │
                    listExperienceConfigs / createExperienceConfig / │
                    getExperienceConfig / updateExperienceConfig /   │
                    publishExperienceConfig / unpublishExperienceConfig /
                    duplicateExperienceConfig / deleteExperienceConfig
                                   │
                                   ▼
                  src/eduhub/lib/experienceConfig/
                    resolveExperienceConfig.js  (priority: published → legacy → default)
                    experienceDefaults.js       (generic empty default for unregistered types)
                                   │
                                   ▼
                  src/eduhub/hooks/useExperienceConfig.js
                  (the ONE hook every experience surface calls; SWR-cached)
                                   │
                                   ▼
┌──────────────────────────────────┼──────────────────────────────────┐
│  Dashboard renderer (/  route)   ▼                                  │
│  src/eduhub/pages/Dashboard.jsx  — composition root, zero business   │
│  logic, renders Dashboard-owned presentation components in a flat,  │
│  mobile-first column (see Section 2)                                │
└───────────────────────────────────────────────────────────────────┘
                                   ▲
                                   │ (artwork field: assetId/url)
                  Media pipeline (pre-existing, untouched)
                  src/studio/api.js: uploadHeroArtwork / listHeroArtworkLibrary /
                    deleteHeroArtworkAsset  →  Cloudflare R2
                  src/studio/HeroArtworkPanel.jsx (upload/library picker UI)
                  src/eduhub/components/HeroArtworkLayer.jsx (render + offline cache)
```

**Data flow, end to end, for any Experience-Config-backed Dashboard section** (e.g. Today's Discovery):

1. An admin opens **Dashboard Studio** → picks a registered experience type → edits fields → clicks **Save draft**. This calls `createExperienceConfig`/`updateExperienceConfig` — the same generic endpoint every other Experience Studio panel uses.
2. The draft is **not visible to students** until the admin clicks **Publish** (`publishExperienceConfig`), which flips its `status` to `"published"`.
3. `resolveExperienceConfig(experienceType, publishedConfig, legacySource)` decides what wins, in fixed priority: **published → legacy adapter (if one exists for that type) → hardcoded default**. This priority order is documented as "do not reorder" in the source — it's the platform's whole migration-compatibility guarantee.
4. `useExperienceConfig(experienceType)` is the hook every Dashboard component calls. It seeds the first paint from a cached published config (stale-while-revalidate), then revalidates in the background.
5. `Dashboard.jsx` renders each presentation component; each component either self-fetches via `useExperienceConfig` (Discovery, and every genuinely new Dashboard section) or receives an already-resolved config as a prop from `Dashboard.jsx` (Mission Hero, Promotion — the two sections whose underlying resolution is coordinated by the pre-existing `useDashboardBootstrap` hook for crossfade-timing reasons).

**Preview** never diverges from production: Dashboard Studio's preview column renders the exact same student-facing component the Dashboard itself renders, with the draft config passed in as a prop override (see Section 3). There is no separate mock-preview renderer anywhere in this system.

---

## Section 2 — Dashboard Components

All paths below are relative to `src/`.

| Component | File | Responsibility | Production data source | Configurable via Author Studio? | Renderer only? | Backend dependency |
|---|---|---|---|---|---|---|
| `Dashboard` | `eduhub/pages/Dashboard.jsx` | Composition root; owns section order and inter-section spacing (`sectionRhythm` tokens) | N/A (pure composition) | No | Yes | No |
| `DashboardHeader` | `eduhub/components/dashboard/DashboardHeader.jsx` | Greeting, streak/tier, points chip | `useAuth()`, `useAttendance()` | No | Yes | Yes (Attendance + auth backend) |
| `MissionHero` | `eduhub/components/dashboard/MissionHero.jsx` | "Today's Journey" card | `welcome_dashboard` Experience Config (passed as prop by `Dashboard.jsx`) | **Yes** — via existing `WelcomeExperienceStudio` (not Dashboard Studio) | Yes | Yes (Experience Config API) |
| `AnnouncementStrip` | `eduhub/components/AnnouncementStrip.jsx` | Live system/announcement ticker | `announcement` Experience Config + legacy GAS adapter | **Yes** — via existing `AnnouncementsStudio` | Yes | Yes |
| `CathyAssistant` | `eduhub/components/activity/CathyAssistant.jsx` | Highlights one real unread high-priority notification | `useNotifications()` | No | Yes | Yes |
| `ContinueLearningShelf` | `eduhub/components/dashboard/ContinueLearningShelf.jsx` | "Continue Learning" shelf (Library progress only) | Two localStorage keys (`eduhub_book_bm_*`, `eduhub_reader_audio_progress`) + `booksService.getAllBooks()` | No (no config; pure client-state read) | Yes | No (reads localStorage + existing Library catalog fetch) |
| `DiscoveryCard` | `eduhub/components/dashboard/DiscoveryCard.jsx` | "Today's Discovery" rotating card + empty state | `daily_discovery` Experience Config | **Yes** — the first Dashboard Studio experience type | Yes | Yes (Experience Config API) |
| `CommunityPulse` | `eduhub/components/dashboard/CommunityPulse.jsx` | Section shell composing the two widgets below | N/A (pure composition) | No | Yes | No |
| `WinnerShowcaseBanner` | `eduhub/components/WinnerShowcaseBanner.jsx` | Auto-published Lucky Draw winner banner (pre-existing, unchanged) | `useWinnerShowcaseRotation()` | No (backend-auto-published) | Yes | Yes |
| `LiveActivityStrip` | `eduhub/components/activity/LiveActivityStrip.jsx` | Rotating real recent-event strip (pre-existing, unchanged) | `useNotifications()` | No | Yes | Yes |
| `MyRankCard` | `eduhub/components/dashboard/MyRankCard.jsx` | "Your Rank" tile + empty state | `useTopEarners()` (roster/leaderboard) | No | Yes | Yes |
| `RecentAchievements` | `eduhub/components/dashboard/RecentAchievements.jsx` | Grid of real achievement-priority notifications | `useNotifications()`, filtered to `priority==="achievement"` | No | Yes | Yes |
| `PromotionPanel` | `eduhub/components/PromotionPanel.jsx` | "Top Up Bonus" banner (pre-existing, unchanged, repositioned) | `promotional_banner` Experience Config, legacy Artwork Campaign fallback | **Yes** — via existing `PromotionExperienceStudio` | Yes | Yes |
| `EmptyStateCard` | `eduhub/components/dashboard/EmptyStateCard.jsx` | Shared honest "nothing here yet" presentation | N/A (pure presentation, props-driven) | Discovery's copy is; Continue Learning/Rank's is not (generic static copy) | Yes | No |
| `CrossfadeSwap` | `eduhub/components/dashboard/CrossfadeSwap.jsx` | Pre-existing crossfade wrapper (unchanged) | N/A | No | Yes | No |

**Retired from this page (files left on disk for rollback safety, routes still reachable via bottom nav/Sidebar):** `LottieTileGrid.jsx`, `LibraryShowcase.jsx`, `components/dashboard/world/*`, `HomeTodayZone.jsx`.

**Deliberately NOT modified** (imported by Author Studio for live preview; a Dashboard-only restyle would have silently changed Author Studio's UI): `Hero.jsx`, `TopEarnerPanel.jsx`.

---

## Section 3 — Dashboard Studio (Developer Guide)

**Location:** `src/studio/DashboardStudio.jsx`, registered as the `"dashboardstudio"` tab in `src/studio/StudioPage.jsx`.

**Architecture:** Dashboard Studio is a single generic shell with zero knowledge of any specific experience type. It reads an array of descriptors from the **Experience Registry** and renders identical list/edit/preview/publish UI for whichever one is selected. It contains no `if (type === "daily_discovery")` branching anywhere — this is verified by an automated test (`src/studio/__tests__/dashboardStudioWiring.test.js`) that asserts the literal string `daily_discovery` never appears inside `DashboardStudio.jsx`.

**Experience Registry:** `src/studio/dashboardExperiences/dashboardExperienceRegistry.js`, exporting `DASHBOARD_EXPERIENCE_TYPES`. Each entry is a descriptor:

```js
{
  id: "daily_discovery",        // the experienceType key
  label: "Today's Discovery",   // shown in the type switcher
  Icon: Sparkles,                // lucide-react icon
  description: "...",            // one line, shown in the panel header
  defaultConfig: () => ({...}),  // fresh {content, appearance, motion, playback} for "New config"
  FormFields: DailyDiscoveryFields,   // component({config, onChange})
  Preview: DailyDiscoveryPreview,     // component({config})
  summarize: (config) => "...",       // optional one-line row summary
}
```

**How artwork is configured:** every artwork slot (Discovery items, Discovery's empty-state artwork) reuses `HeroArtworkPanel.jsx` — the exact same upload/media-library/placement/scale/padding UI Welcome Hero and Promotion already use. There is no Dashboard-specific upload component or endpoint. Uploads go through the existing `uploadHeroArtwork`/`listHeroArtworkLibrary`/`deleteHeroArtworkAsset` functions in `src/studio/api.js`, which write to the existing Cloudflare R2-backed media library.

**How publishing works:** identical to every other Experience Studio panel — `createExperienceConfig`/`updateExperienceConfig` save a draft; `publishExperienceConfig` makes it live; `unpublishExperienceConfig` reverts to the next tier down (legacy adapter or hardcoded default); `duplicateExperienceConfig` clones a config under a new key; `deleteExperienceConfig` removes it (requires `force:true` if currently published). None of these functions were added or modified by this project.

---

## Section 4 — Extension Guide: Adding a Brand-New Dashboard Experience

To add a new Dashboard-configurable section (example: "Community Spotlight"):

1. **Register it.** Add one entry to `DASHBOARD_EXPERIENCE_TYPES` in `dashboardExperienceRegistry.js` with a new `id` (this becomes the `experienceType` string), `label`, `Icon`, `description`, and `defaultConfig()`.
2. **Create its fields component.** A new file, e.g. `CommunitySpotlightFields.jsx`, receiving `{ config, onChange }`. Edit `config.content`/`appearance`/`motion`/`playback` however the section needs; call `onChange(nextConfig)` on every change. Reuse `HeroArtworkPanel` for any artwork field — do not build a new uploader.
3. **Create its preview component.** A new file, e.g. `CommunitySpotlightPreview.jsx`, that imports and renders the REAL student-facing component with the draft `config` passed in as a prop override (see `DiscoveryCard`'s `previewConfig` prop for the established pattern — the hook is always called for rules-of-hooks compliance, but a `previewConfig` prop overrides its result and is treated as `"published"` for gating).
4. **Build the student-facing renderer component** the normal way: call `useExperienceConfig("community_spotlight")`, gate on `source === "published"` (an unregistered/unpublished type already resolves to a generic empty default — no platform change needed), and add an `EmptyStateCard` fallback for the unpublished/no-content case.
5. **Wire it into `Dashboard.jsx`** in the appropriate position, wrapped in a `<Section rhythm="...">` for spacing consistency.
6. **Publish.** An admin creates a draft in Dashboard Studio, previews it (real component, real data), and publishes. The Dashboard renders it automatically — no code deploy required to change content after this point.

**No duplicate architecture is ever required**: no new CRUD endpoint, no new upload path, no new preview mechanism, no new StudioPage tab. If you find yourself about to build any of those four things for a new Dashboard experience, stop — you are duplicating existing infrastructure.

---

## Section 5 — Current Limitations

### Backend
- No live concurrent student-presence count exists anywhere accessible from this frontend or its backend.
- Speaking Lab / AI Assistant mission progress has zero server-side persistence — nothing to resume across devices or sessions.
- The notification system carries a single flat `priority==="achievement"` signal, not a typed sub-category — achievement tiles cannot be visually differentiated by real category today.
- Library reading progress (`ContinueLearningShelf`) is stored in `localStorage`, not keyed by student — it does not survive a device change or a shared-device login.

### Product
- No "Level"/XP concept exists in the data model. The Dashboard header shows the real Attendance tier (bronze/silver/gold/diamond) in that slot instead — a deliberate, disclosed substitution, not the same information.
- Whether "Today's Journey," "Promotional Banner" should ever migrate from their existing dedicated Studio panels into the Dashboard Experience Registry is an open product/architecture decision, not assumed by this project.

### Content
- "Today's Discovery" ships with zero built-in items — an admin must author at least one via Dashboard Studio before the section shows real content (its empty state is honest and premium, not broken).
- "Recent Achievements" and "Community Pulse — activity event" only ever show something if the backend has actually emitted a real qualifying event; whether it currently ever does so was not verifiable from this frontend-only repository.

**Not included above, because they are resolved:** spacing/typography/icon/shadow consistency, empty-state design, CTA/button consistency — all addressed during the Polish and Final Acceptance passes of this project.

---

## Section 6 — Future Projects (documented, not implemented)

These are independent, separately-scoped projects. None were implemented as part of this reconstruction:

1. **Level / XP System** — a real backend concept, replacing the Attendance-tier substitution in the Dashboard header.
2. **Live Presence** — a live "N students studying now" capability, requiring new backend infrastructure.
3. **Speaking / AI Assistant Progress Persistence** — server-side mission-resume state, which would let Continue Learning include Speaking and AI Conversation cards honestly.
4. **Achievement Categories** — a typed sub-category on achievement-priority notifications, enabling real per-type badge icons instead of a single shared glyph.
5. **Cross-device Library Progress** — moving Continue Learning's bookmark/audio-progress data from `localStorage` to a student-keyed backend record.
6. **Experience Studio Consolidation** — migrating `WelcomeExperienceStudio` and `PromotionExperienceStudio` into the Dashboard Experience Registry, unifying all Dashboard-configurable surfaces under one Studio tab. Explicitly deferred by the user during this project ("do not migrate... unless a separate architectural refactor is explicitly approved").

---

## Section 7 — Scope Protection

**Intentionally left untouched, verified via `git diff` at every phase of this project — zero changes:**

- AI Assistant
- Library (including the Reader, `ContinueReading.jsx`, and every Library-owned component)
- Speaking Lab / System Test
- EduTalk / Live Coach
- Wallet
- Portal (`/portal`, `/portal/me`)
- Passport / Attendance business logic (only *read* via `useAttendance()`, never modified)
- Notifications, Settings, Profile, Login, Registration, Payment
- `MobileBottomNav.jsx`, `Sidebar.jsx` (global navigation chrome)
- Every existing Experience Studio page: `WelcomeExperienceStudio.jsx`, `AchievementExperienceStudio.jsx`, `PromotionExperienceStudio.jsx`, `DashboardEnvironmentStudio.jsx`, `AnnouncementsStudio.jsx`
- `Hero.jsx`, `TopEarnerPanel.jsx` (left byte-for-byte unchanged specifically because Author Studio imports them directly for live preview)
- The Experience Configuration Platform's core files: `resolveExperienceConfig.js`, `useExperienceConfig.js`, `experienceConfigApi.js`
- The media pipeline: upload/library/asset-picker APIs and UI

**A future developer should treat any of the above as out-of-bounds for "Dashboard work"** unless a new, separately-approved project explicitly says otherwise.

---

## Section 8 — Final Statistics

| Metric | Value |
|---|---|
| New Dashboard components | 8 (`DashboardHeader`, `MissionHero`, `ContinueLearningShelf`, `DiscoveryCard`, `CommunityPulse`, `MyRankCard`, `RecentAchievements`, `EmptyStateCard`) |
| New Dashboard Studio files | 4 (`DashboardStudio.jsx`, `dashboardExperienceRegistry.js`, `DailyDiscoveryFields.jsx`, `DailyDiscoveryPreview.jsx`) |
| Production files modified | 4 (`Dashboard.jsx`, `AnnouncementStrip.jsx`, `roster.js`, `StudioPage.jsx`) |
| New/updated test files | 4 (`dashboardStudioWiring.test.js` new; `dashboardWorldWiring.test.js`, `attendanceStudio.test.jsx`, `roster.test.js` updated) |
| Test suite | 153/153 suites passing, 1994/1994 tests passing |
| Production build | Green |
| Experience Types added | 1 (`daily_discovery`) |
| New backend APIs | 0 |
| Existing APIs reused | `listExperienceConfigs`, `createExperienceConfig`, `getExperienceConfig`, `updateExperienceConfig`, `publishExperienceConfig`, `unpublishExperienceConfig`, `duplicateExperienceConfig`, `deleteExperienceConfig`, `uploadHeroArtwork`, `listHeroArtworkLibrary`, `deleteHeroArtworkAsset`, plus the existing Mongo-backed leaderboard endpoint (`/api/student/points/leaderboard`, consumed via `roster.js`) |
| Media pipeline | Fully reused, zero changes |
| Schema extensions | 1, purely additive (`daily_discovery.content.emptyState`) |
| Production status | Release Candidate (RC1) — ready for authenticated acceptance testing |

---

## Section 9 — Final Verdict

**Would this document be sufficient for an engineer joining six months from now?**

- **How the Dashboard works** — yes: Section 1's data-flow diagram plus Section 2's per-component table cover every widget and its real data source.
- **How Dashboard Studio works** — yes: Section 3 documents the registry contract precisely enough to read the actual descriptor shape in code without guessing.
- **How to safely extend it** — yes: Section 4 is a literal numbered procedure, cross-referenced to the one existing example (`daily_discovery`) a new author can copy.
- **What not to modify** — yes: Section 7 lists every protected surface explicitly, with the specific reason two files (`Hero.jsx`, `TopEarnerPanel.jsx`) look like Dashboard components but must never be touched.
- **Where future work belongs** — yes: Section 6 lists exactly the backend/product decisions blocking further improvement, framed as independent projects rather than open threads of this one.

**Freeze declared.** This project is closed. Further Dashboard work — including the six items in Section 6 and the Experience Studio consolidation — begins as a new, independently-scoped project, not a continuation of this one.
