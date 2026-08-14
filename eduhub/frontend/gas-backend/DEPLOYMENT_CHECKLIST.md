# EduHub v7.9.9 — Pre-flight Deployment Checklist

> **CRITICAL GATE:** Do **not** publish the new frontend build until every
> item in §1 is ticked. The v7.9.8 audit found that deploying the hardened
> frontend against the un-upgraded GAS backends leaves critical endpoints
> (`PortalLogic_*`, `AssistantLogic_*`) returning `null` / stubs — users
> see an empty dashboard, broken coupons, and a non-responsive tutor.

---

## 1. Deploy all 7 GAS backends (in this exact order)

| # | GAS project         | Existing deployment URL (preserve — do NOT create a new one)                                                |
|---|---------------------|-------------------------------------------------------------------------------------------------------------|
| 1 | Portal              | `AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-a1xTUJYA894FwAQ`                                 |
| 2 | Points              | `AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA`                                 |
| 3 | Lucky Spin (Game)   | `AKfycbxKSDSZm-iM9dTqT_noZ_EC1DV-lFcIinJGt-2sIdBCcWbfahyx_8uOKsEbenaeQMKa`                                   |
| 4 | Rewards Shop        | `AKfycbyp40ywz45gwSAJQjQpCAKR61wF5T6gh4MnQEcNltqW4V5p2DPlyQR1khAi3a3bqCHu`                                   |
| 5 | Library             | `AKfycbzgTmcWAwLw8ZlA6cmSgkxv-KvQwSHwTLgL3cwD4l3RI8iHIOYacJPbGke76Fo0ETR8kA`                                 |
| 6 | AI Assistant        | `AKfycbzrDPwsOB4GC3kMD85jls4PyMzTl6KWoRHRz1wuNE6NEIcuoqjrri3FU0eegFdoBM50wg`                                 |
| 7 | System Test         | `AKfycbwQknsM0MJwRmoTGPai-_E2OSMb9FPxK7UsexqmpXZAqelyw99guEhjhNQn9hCL0m5uTg`                                 |
| 8 | Config (JSONP)      | `AKfycby7Ca0rv5uZAalC7l0jyeQM2JQ2iX34LwW_CKB41cYiu2n4jZ9A6aK-SdGfaPkmYUmmoA`                                 |

For **each** of the 8 projects above, repeat this micro-flow (≈ 3 min each):

- [ ] Open the project in `script.google.com`.
- [ ] Add / update `_SecurityCore.gs` (identical file across all 8 — paste from `gas-backend/_SecurityCore.gs`).
- [ ] Replace `Code.gs` with the matching `*Backend.Code.gs` from `gas-backend/`.
- [ ] **Project Settings → Script Properties** — set the shared keys (see §2).
- [ ] Save.
- [ ] **Deploy → Manage deployments → ✎ (edit) → New version → Deploy**.
      (Keep the SAME deployment URL — the frontend does not need to change.)
- [ ] Run `runSecuritySelfTest()` from the editor. Logs must print
      `OK — token round-trip works`.

---

## 2. Shared Script Properties (must be IDENTICAL across all 8 projects)

| Key                   | Value                                                                  | Notes                                 |
|-----------------------|------------------------------------------------------------------------|---------------------------------------|
| `HMAC_SECRET`         | 48+ random hex chars (e.g. `openssl rand -hex 32`)                     | Must match across ALL 8 projects      |
| `ALLOWED_ORIGINS`     | `daravuthenglish.online,daravuth995.github.io,<your-emergent-host>`    | CSV of allowed hostnames              |
| `USERS_SHEET_ID`      | Sheet ID of the canonical roster + AuditLog                            | Same sheet across all                 |
| `USERS_SHEET_NAME`    | `Students` / `Sheet1` / …                                              | Tab name in the sheet above           |
| `AUDIT_SHEET_NAME`    | `AuditLog`                                                             | Auto-created if missing               |
| `RATE_LIMIT_RPM`      | `45`                                                                   |                                       |
| `RATE_LIMIT_BURST`    | `10`                                                                   |                                       |
| `SESSION_TTL_MIN`     | `720`                                                                  | 12 hours                              |
| `DEBUG_MODE`          | `false`                                                                | NEVER `true` in production            |
| `AUDIT_RETENTION_DAYS`| `31`                                                                   | See §4 — AuditLog archive             |

### Portal-project-only properties

| Key                    | Value                                     |
|------------------------|-------------------------------------------|
| `PORTAL_SHEET_ID`      | *(optional — defaults to `USERS_SHEET_ID`)* |
| `PORTAL_STUDENTS_TAB`  | `Students`                                |
| `PORTAL_COMMENTS_TAB`  | `Comments`                                |
| `PORTAL_HISTORY_TAB`   | `History`                                 |
| `PORTAL_COUPONS_TAB`   | `Coupons`                                 |

### Assistant-project-only properties

| Key                   | Value                                             |
|-----------------------|---------------------------------------------------|
| `LLM_API_KEY`         | OpenAI / Gemini key — **Script Properties ONLY**  |
| `LLM_MODEL`           | defaults to `gpt-4o-mini`                         |
| `LLM_DAILY_POINT_CAP` | defaults to `100`                                 |
| `ASSISTANT_SHEET_ID`  | *(optional — defaults to `USERS_SHEET_ID`)*       |
| `ASSISTANT_USAGE_TAB` | `AssistantUsage` (auto-created)                   |

---

## 3. Smoke tests (run right after each deploy, before flipping the frontend)

```bash
# 1. Anonymous read must fail with AUTH_REQUIRED
curl 'https://script.google.com/macros/s/<URL>/exec?action=getStudentData'

# 2. Login must return a sessionToken
curl -X POST 'https://script.google.com/macros/s/<URL>/exec' \
     --data-urlencode 'action=login' \
     --data-urlencode 'studentId=STD001' \
     --data-urlencode 'password=<their-password>'

# 3. Token-authenticated read must succeed
curl 'https://script.google.com/macros/s/<URL>/exec?action=getStudentData&sessionToken=<token>'

# 4. Replay protection — re-submitting the same nonce must fail
curl -X POST '.../exec' \
     --data-urlencode 'action=validateCoupon' \
     --data-urlencode 'sessionToken=<t>' \
     --data-urlencode 'couponCode=X' \
     --data-urlencode 'nonce=abc' --data-urlencode 'studentId=STD001'
#    → second identical call returns {"error":"REPLAY"}
```

- [ ] Portal `getStudentData` round-trip OK
- [ ] Portal `validateCoupon` — nonce replay rejected
- [ ] Points `sendPoints` — no password in URL, 2nd identical nonce rejected
- [ ] Library `loginRequest` — POST, no password in URL
- [ ] Assistant `askGPT` — tutor reply received, daily cap decremented

---

## 4. One-time install — monthly AuditLog archive trigger

Install the trigger in **exactly ONE** project (typically Portal) so the
shared `AuditLog` tab is archived once per month:

1. Open the Portal project → `_AuditArchive.gs` (added in v7.9.9).
2. Run `installAuditArchiveTrigger()` once from the editor.
3. (Optional) Run `runAuditArchiveNow()` for an immediate first archive.
4. Confirm under *Triggers* that `auditArchiveMonthly` is scheduled for
   the 1st of every month at 03:00.

The live `AuditLog` tab will now retain rolling 31 days of rows; older
rows are moved into `AuditLog_YYYY-MM` tabs in the same spreadsheet.

---

## 5. Final gate — frontend publish

Only after every `[ ]` in §1, §2, and §3 above is ticked:

- [ ] Replace `.env` with production values (never ship `.env` inside the
      release ZIP — see `.env.example`).
- [ ] `yarn build`
- [ ] Publish the contents of `build/` to your hosting of choice.
- [ ] Confirm the production site serves the new CSP header in
      enforcing mode (devtools → Network → any HTML → Response Headers).
- [ ] Retire the old release ZIP; the v7.9.9 ZIP must NOT contain any
      prior release artefact under `public/downloads/`.
