# CHANGELOG v9.0 — PWA Install UX Overhaul

**Date:** 2026-02
**Scope:** Frontend only. Backend, API, routes, and core functionality are untouched.
**Branding:** App now consistently identifies as **"EduHub Studio"** across manifest, meta tags, install UI.

---

## What changed

### 2A — Custom Install Button + iOS Installation Guide Modal

- New React provider `PwaInstallProvider` owns all install state (no more vanilla-JS pill in `index.html`).
- **Header install button** — `src/eduhub/components/pwa/InstallButton.jsx`
  Shown in the sticky header next to the Telegram / login buttons. Hidden automatically once the app is installed (display-mode: standalone or `appinstalled` event).
- **Dismissible bottom banner** — `src/eduhub/components/pwa/InstallBanner.jsx`
  Sits above the MobileBottomNav (safe-area aware). One dismiss is persisted in localStorage (`eduhub_pwa_banner_dismissed_v1`).
- **iOS installation guide modal** — `src/eduhub/components/pwa/IosInstallModal.jsx`
  Triggered **only** when an iOS Safari user taps either the header "Install" button or the bottom banner's "Install" button (per your requested trigger behavior). Walks through the 3-step Share → Add to Home Screen → Confirm flow with inline iconography. Dismissable by ✕, Escape key, or tapping outside. Body scroll locked while open.
- Behavior matrix:

| User environment               | Click "Install" |
|-------------------------------|-----------------|
| Chrome / Edge / Android       | Fires the captured `beforeinstallprompt` (native install dialog) |
| iOS Safari                    | Opens the `IosInstallModal` guide |
| Already installed (standalone)| Button + banner hidden entirely |

### D3 — iOS Splash Screen Configuration

- 16 portrait splash images generated at `public/splash/` — one for every iOS device size Apple recommends (iPhone SE → iPhone 16 Pro Max, iPad mini 6 → iPad Pro 12.9"). Brand-color background `#050010` with centered logo at 35% of the shorter edge.
- `public/index.html` now declares a complete `<link rel="apple-touch-startup-image" media="...">` set. "Add to Home Screen" launch now shows a native-feeling splash instead of a white flash.

### D4 — Icon + Manifest Consistency

- Fixed legacy `icon-192.png` (was actually 512×512) to a true 192×192.
- Added dedicated maskable icons with a proper safe-zone → `icon-maskable-192.png` / `icon-maskable-512.png`. Android adaptive icons will no longer crop the logo.
- Added the full Apple touch icon ladder — 60/76/120/152/167/180 + precomposed copy at 180 — so iOS never falls back to a screenshot tile.
- `manifest.json`:
  - Name → **"EduHub Studio — Unified Learning Portal"**
  - `short_name` → **"EduHub Studio"**
  - `display_override: ["standalone", "minimal-ui"]`
  - `start_url: "/?source=pwa"` (lets you measure PWA-sourced traffic)
  - Correct per-icon `sizes` fields; maskable entries are now distinct files, not the lie that was there before.
- `index.html` meta:
  - `apple-mobile-web-app-title` and `application-name` → `EduHub Studio`
  - Runtime Blob-URL manifest patch (kept from v8.4) updated to match the new manifest.

---

## Files added

```
public/icons/icon-maskable-192.png
public/icons/icon-maskable-512.png
public/apple-touch-icon-167.png
public/apple-touch-icon-152.png
public/apple-touch-icon-120.png
public/apple-touch-icon-76.png
public/apple-touch-icon-60.png
public/splash/                         (16 iOS splash PNGs)
src/eduhub/hooks/usePwaInstall.js
src/eduhub/components/pwa/PwaInstallProvider.jsx
src/eduhub/components/pwa/InstallButton.jsx
src/eduhub/components/pwa/InstallBanner.jsx
src/eduhub/components/pwa/IosInstallModal.jsx
```

## Files modified

```
public/index.html        # splash links, apple-touch-icon ladder, vanilla install pill removed, update toast retained
public/manifest.json     # name "EduHub Studio", correct icon sizes, maskable entries
public/sw.js             # SW_VERSION bumped → clients auto-refresh into v9.0
public/icons/icon-192.png  # fixed to true 192x192 (was 512x512 misnamed)
src/App.js               # mounts <PwaInstallProvider/>
src/eduhub/components/Header.jsx  # adds <InstallButton/>
```

---

## Zero-regression checklist

- **No backend, API, or GAS endpoint touched.** All changes are inside `public/` and `src/` only.
- **Service worker update flow preserved.** The update toast (the only vanilla-JS install-adjacent UI left in `index.html`) still fires on new-version deploys and still reloads via `controllerchange`.
- **Service worker version bumped** → existing installs auto-refresh; caches rebuild on next visit.
- **Safe-area insets respected** on all new UI (banner, modal).
- **CSP unchanged** — no new origins allowed; `manifest-src 'self' blob:` retained for the runtime manifest.
- **data-testid attributes** on every new interactive element:
  `pwa-install-header-btn`, `pwa-install-banner`, `pwa-banner-title`, `pwa-banner-install-btn`, `pwa-banner-dismiss-btn`, `pwa-ios-modal`, `pwa-ios-modal-close`, `pwa-ios-modal-got-it`, `pwa-update-toast`.

---

## Deployment steps

1. Merge the patch into `master`.
2. `yarn build && yarn deploy` (or your existing deploy command).
3. Ask any previously-installed test device to reopen the app once — the service worker will notice the new `SW_VERSION` and surface the "New version · tap to refresh" toast. Tap it, and the upgraded PWA UX is live.
4. Verify on an iPhone:
   - Open in Safari → tap the new **Install** pill in the header → iOS guide modal appears.
   - Follow the 3 steps → app icon lands on the home screen, launches with the brand-color splash screen, opens full-screen with the notch respected.
5. Verify on Android Chrome:
   - Visit the site → after the `beforeinstallprompt` fires, the header "Install" button + the bottom banner appear. Tap either → native install sheet opens. After install, all install UI disappears.

## Risks flagged

- **CSP:** `img-src` already allows `https:`, so all new icons/splashes are covered. No CSP change required.
- **Service worker cache:** SW version bump forces a refresh. Users will see the update toast exactly once after deployment. This is the intended contract of the existing SW.
- **iOS "standalone" detection nuance:** `navigator.standalone` is still how iOS signals PWA mode. We use it alongside `matchMedia('(display-mode: standalone)')` so Chrome, Edge, Android, and iOS all hide the install UI correctly after install.
