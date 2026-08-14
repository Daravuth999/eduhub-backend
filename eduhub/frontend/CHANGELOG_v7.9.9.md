# EduHub v7.9.9 — Audit Closure Release

> Release date: 2026-02
> Scope: surgical fixes for the 10 items raised by the v7.9.8 audit.
> No feature, UI/UX, or backend contract changes — security & release
> hygiene ONLY.

## 🔒 Critical fixes (1 – 6)

| # | Fix |
|---|-----|
| **1** | `.env` removed from the release ZIP. New `.gitignore` excludes `.env`, `node_modules/`, `build/`, `*.zip`, and every `public/downloads/*.zip`. A sanitised `.env.example` documents every variable the frontend reads. |
| **2** | `public/downloads/eduhub-v7.9.7-release.zip` deleted from this build. The old vulnerable bundle is no longer reachable from the live site. |
| **3** | `gas-backend/DEPLOYMENT_CHECKLIST.md` — a pre-flight list that MUST be satisfied before the frontend is published. Lists every one of the 7+1 GAS endpoints in the exact order they have to be re-deployed, the shared Script Properties they share, and the smoke tests that prove the hardened pipeline is live. |
| **4** | All `PortalLogic_*` / `AssistantLogic_*` stubs now have real bodies: `PortalLogic_getStudentRow_` / `_getComments_` / `_getHistory_` / `_validateCoupon_` read from the Students / Comments / History / Coupons tabs with header-alias detection and LockService-guarded writes; `AssistantLogic_getPointsLeft_` / `_decrementPoints_` track a per-student daily cap in an `AssistantUsage` tab; `AssistantLogic_callLLM_` makes a server-side call to OpenAI's chat completions endpoint using the key held in Script Properties (never echoed back to the client). |
| **5** | No `.env` shipped with the release; `.env.example` is the only environment template in the ZIP. Operators copy it to `.env` locally / in their deployment pipeline and fill in production values there. |
| **6** | `public/index.html` — the meta CSP was flipped from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` (enforcing). Violations now block the resource instead of being merely logged. |

## 🟡 Medium-priority fixes (7 – 10)

| # | Fix |
|---|-----|
| **7** | `gas-backend/PortalBackend.Code.gs` — `validateCoupon` now has `requireNonce: true`. The frontend already sent a nonce (`securePost` with `{ requireNonce: true }`), so this is a pure backend tightening; replays of a captured `validateCoupon` request are rejected by `SecurityCore.checkNonce`. |
| **8** | `src/eduhub/pages/portal/lib/api.ts` — `pointsLogin` switched from GET to POST. The student's password no longer rides in the URL (previously leaked into browser history, HTTP proxy logs, and GAS execution transcripts). Same change applied to `src/eduhub/pages/library/api.js::loginRequest`. The upgraded GAS routers treat both verbs identically, so no breakage. |
| **9** | `src/eduhub/pages/portal/screens/Dashboard.tsx` — `DebugDrawer` is now gated to authenticated **teacher / admin** accounts only. Previously it rendered whenever `NODE_ENV === 'development'`, which meant a production student building from source could still see the bug FAB, toggle the drawer, and fire +N points test events locally. The drawer is now invisible (not just hidden) for every student account regardless of NODE_ENV. |
| **10** | `gas-backend/_AuditArchive.gs` — new file with a monthly time-driven trigger (`installAuditArchiveTrigger()`). Rows older than `AUDIT_RETENTION_DAYS` (default 31) are moved into dated `AuditLog_YYYY-MM` tabs inside the same spreadsheet. The live `AuditLog` stays small and fast to query. Manual `runAuditArchiveNow()` is also exposed for on-demand runs. |

## ⚠️ Migration notes

- **Back-end redeploy is now MANDATORY before this frontend is published.**
  The stub bodies filled in for Issue #4 still live inside the SAME
  Apps Script projects and reuse the same deployment URLs — so the
  frontend build does not change — but they only become active once
  the operator re-deploys each Code.gs (see `gas-backend/DEPLOYMENT_CHECKLIST.md`).
- **CSP flip** — on the rare chance a third-party origin is now
  blocked, the operator can temporarily revert the `http-equiv` meta
  in `public/index.html` to `Content-Security-Policy-Report-Only`,
  confirm the report feed is clean, and re-enforce. The allow-list
  covers every origin used by the app today.
- **DebugDrawer gate** — teachers / admins still get the full drawer
  with `?debug=1` auto-open. Students never see the bug FAB.
- **POST `pointsLogin`** — purely a safety upgrade. If you are on an
  un-upgraded legacy PointsBackend (rare after v7.9.9 deploy), the
  login request continues to authenticate with the same params; the
  only difference is the verb.

## 🛒 Post-release hotfix — Library purchase spendable-balance

`src/eduhub/pages/library/books/purchaseService.js` — `purchaseBook`
now fetches the authoritative points balance from the **Points
backend** (`pointsLogin`) immediately before the affordability gate,
instead of trusting the caller-supplied `portalPoints` (React state
from AuthContext). The previous behaviour blocked students who
actually had the points because the state value could be stale or
`0` — typically after a page refresh, since v7.9.8 hardening
strips the password from `sessionStorage` and that in turn makes
`AuthContext.refreshPoints()` silently no-op on a refresh. If the
live fetch fails (network / legacy backend), we fall back to the
caller-supplied value so behaviour degrades gracefully. No backend
change; no UI/UX change. `sendPoints` still performs the real debit
and the post-purchase balance re-read stays in place.
