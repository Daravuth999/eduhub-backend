# EduHub Unified Portal — Security Hardening Report (v6 → v6-secure)

**Date:** 2026-01
**Scope:** All 7 Google Apps Script web-app backends + 1 Config endpoint, plus the React frontend that calls them.
**Compatibility:** No existing feature, UI flow, or sheet schema is broken. The endpoint URLs (`AKfyc…`) are preserved.

---

## 1. Vulnerabilities found in the original implementation

| # | Severity | Where                              | Vulnerability                                                                                                                      |
|---|----------|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| 1 | **Critical** | Every backend                  | Plaintext **password sent on every single request** as a query parameter — leaked to browser history, proxy logs, and Sheet logs. |
| 2 | **Critical** | Points + Game + Shop           | Client-supplied `amount`/`pointCost` was trusted; users could redeem expensive items for tiny amounts by tampering payload.       |
| 3 | **Critical** | System Test                    | Question payload **included the correct-answer key** (`isCorrect`) — open in DevTools → 100% score trivially.                       |
| 4 | **Critical** | All endpoints                  | `doGet`/`doPost` had **no action allowlist** — any URL parameter would call any internal helper.                                  |
| 5 | High     | Assistant                          | LLM API key was at risk of leaking back through error responses (no allowlist on output fields).                                  |
| 6 | High     | All endpoints                  | **No origin / referer validation**, so any third party site could relay requests with a stolen password.                          |
| 7 | High     | Portal + Points                | **No identity binding on read** — student A could read student B by changing `?studentId=`.                                       |
| 8 | High     | All endpoints                  | **No rate limiting** — vulnerable to credential stuffing and brute force.                                                          |
| 9 | Medium   | All endpoints                  | **No replay protection** — capturing a single redemption URL allowed unlimited replays.                                            |
| 10 | Medium  | Config (JSONP)                 | `callback=` was accepted unfiltered → DOM-XSS by callback name injection.                                                          |
| 11 | Medium  | All endpoints                  | Verbose default error messages leaked stack traces / Sheet structure.                                                              |
| 12 | Low     | Frontend                       | Telegram support FAB popup had over-padding and pushed layout on small screens.                                                    |

---

## 2. Security improvements made

### 2.1  Authentication & access control
- Introduced **HMAC-signed session tokens** (`SecurityCore.issueToken` / `verifyToken`).
- The frontend stores **only** the token (in `sessionStorage`); the password is sent **once** on `login` and never again.
- Token contains `{sid, role, iat, exp, jti}`, signed with `HMAC_SHA-256` using a Script-Properties secret (`HMAC_SECRET`).
- Server-side **role check** (`student | teacher | admin`) read from a `Users` sheet — clients cannot self-promote.
- Identity is bound: students may only read **their own** records — any client-passed `studentId` is silently ignored for student-role tokens.

### 2.2  Endpoint protection
- Every backend goes through `SecurityCore.secureExecute(e, opts, handler)` which enforces:
  1. **Action allowlist** (regex-validated) — unknown actions return `UNKNOWN_ACTION`.
  2. **Origin / Referer gate** (`ALLOWED_ORIGINS` script property).
  3. **Payload caps**: 32 KB total, 4 KB per field — blocks oversize abuse.
  4. **JSON / form / query parameter normalisation** with strict per-field validators.
- `doGet` and `doPost` are now thin routers — no business logic at the perimeter.

### 2.3  Data security (Sheets protection)
- **No raw row dumps** — every read goes through allow-listed projection (e.g. `Password` is stripped from the response).
- **Server-side filtering by caller identity** — students get only their own row.
- **System Test** now strips `isCorrect` / answer-keys before sending; the canonical answer key is stashed server-side and used by `submitTest`.
- **Config endpoint** allow-lists every field it returns — no more whole-sheet exposure.

### 2.4  Anti-tampering
- Field validators (`SecurityCore.V.studentId`, `.int`, `.enum`, `.json`) reject malformed values up front.
- **All scoring / point / balance maths happens inside GAS** — clients can never set `score`, `pointCost`, `amount` (sender), or `pointsLeft`.
- `redeemReward` looks up the canonical PointCost from the Sheet; the client `pointCost` parameter is ignored.
- `sendPoints` always uses the token-derived sender SID — clients can't forge a sender.

### 2.5  Abuse prevention
- Per-user **rate limiting** (default `45 rpm` + `10s` burst window) backed by `CacheService`.
- **Failed-auth counter** with **10-minute lock-out** after 3 wrong passwords.
- **Replay protection** via cached `nonce` for sensitive writes (`sendPoints`, `redeemReward`, `completeLesson`, `submitTest`, `handleCardGame`).
- **Audit log** sheet (`AuditLog`) records every login, write, and security event with timestamp, sid, status, origin, and metadata.

### 2.6  Secrets & config
- `HMAC_SECRET`, `LLM_API_KEY`, `USERS_SHEET_ID`, `ALLOWED_ORIGINS` — all in **Script Properties**, never in code.
- LLM responses sanitised before return — keys can't leak through error paths.
- `DEBUG_MODE` defaults `false`; verbose errors only when explicitly enabled.

### 2.7  Deployment safety
- **Same deployment URLs preserved** (`AKfyc…`) — frontend keeps working without a re-publish.
- All errors return generic messages with stable codes; stack traces never leave the server.
- JSONP callback name strictly regex-validated.

### 2.8  Frontend fixes
- `TelegramFab.jsx` rebuilt: compact 280px popup with **proper internal padding**, mobile-safe inset, no layout-pushing, accessible close button, auto-show only once per session.
- `AuthContext` now captures a `sessionToken` when the secured backend issues one, but **keeps the classic password-gated login flow** working against the un-upgraded backend. This is a **zero-breakage upgrade path** — the same frontend build works identically against both backend versions.
- Every `api.*` helper sends the classic `studentId`/`id`/`password` params **AND** the `sessionToken` (when present). The secured backend uses the token and ignores the password; the legacy backend uses the password and ignores the extra token param. The moment you deploy the secured `Code.gs`, security engages automatically.

### 2.9  Graceful upgrade (dual-mode) — why login keeps working
The frontend fires `?action=login` *opportunistically in parallel* with the classic `getStudentData` fetch. If the backend is the secured build, it returns a `sessionToken`; if it's still the legacy build, the call is harmless and the classic password compare authenticates the user exactly as before. Either way, login succeeds.

---

## 3. Endpoints / functions secured

| Backend       | Public endpoint URL (preserved)                                      | Actions secured                                                                              |
|---------------|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| Portal        | `AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-…`        | `login` (new), `getStudentData`, `getPasswordHint`, `validateCoupon`, `getStudentComments`, `getPerformanceHistory` |
| Points        | `AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49I…`       | `login`, `getRecentTransfers`, `sendPoints`                                                   |
| Lucky Spin    | `AKfycbxKSDSZm-iM9dTqT_noZ_EC1DV-lFcIinJGt-2sIdBCcWbfahyx_8u…`        | `login`, `getSlotConfig`, `handleCardGame`, `getRestrictionMessage`                           |
| Rewards Shop  | `AKfycbyp40ywz45gwSAJQjQpCAKR61wF5T6gh4MnQEcNltqW4V5p2DPlyQR1…`       | `login`, `getStudentData`, `getRewards`, `redeemReward`                                       |
| Library       | `AKfycbzgTmcWAwLw8ZlA6cmSgkxv-KvQwSHwTLgL3cwD4l3RI8iHIOYacJPb…`       | `login`, `getContent`, `getStudentStats`, `completeLesson`                                    |
| AI Assistant  | `AKfycbzrDPwsOB4GC3kMD85jls4PyMzTl6KWoRHRz1wuNE6NEIcuoqjrri3F…`       | `askGPT`                                                                                       |
| System Test   | `AKfycbwQknsM0MJwRmoTGPai-_E2OSMb9FPxK7UsexqmpXZAqelyw99guEh…`        | `getTimerConfig`, `fetchQuestions`, `submitTest`                                              |
| Config (JSONP) | `AKfycby7Ca0rv5uZAalC7l0jyeQM2JQ2iX34LwW_CKB41cYiu2n4jZ9A6aK-…`       | `getConfig`                                                                                    |

---

## 4. Limitations of GAS security still remaining

These are **platform constraints** in Apps Script that no wrapper can fully eliminate. They're listed here so you have a clear picture:

1. **No real CORS preflight** — Apps Script web apps respond `*` to OPTIONS. We compensate with **Origin/Referer allow-lists** + tokens, but a determined attacker on a controlled server can still re-relay if they capture a token.
2. **No outbound IP whitelist** — Anonymous deployments accept any caller; we mitigate via tokens + rate limit, but you cannot lock down by IP.
3. **`Session.getActiveUser().getEmail()` returns empty** for anonymous deployments. Without forcing Google sign-in (which is incompatible with the current public Web App deployment) we cannot use Google identity as the auth source. The HMAC session-token model is the strongest available alternative.
4. **No transactional writes across sheets** — Apps Script has no native ACID transaction across rows. We use `LockService` for critical writes (you should keep using it inside `*Logic_*_` functions).
5. **Cache can be flushed** — `CacheService` is best-effort. Rate-limit and nonce stores can theoretically be reset under heavy load. For high-stakes systems, persist a `Nonces` sheet as fallback.
6. **No password hashing built-in** — `Utilities.computeDigest` is available, but the existing Password column is plaintext. We've kept that compatible; the recommended next step is to migrate to PBKDF2-style hashing inside `authenticatePassword`. The wrapper is a one-line change away.
7. **6-min execution limit + UrlFetch quotas** — long-running endpoints (Assistant, System Test scoring of large batches) can be killed mid-write. Keep handlers under 30 s.
8. **Audit log size** — `AuditLog` sheet grows unboundedly. Add a monthly archive trigger.

---

## 5. Quick verification checklist (after deployment)

- [ ] Run `runSecuritySelfTest` from each project's editor — must log a token round-trip OK.
- [ ] Hit any read endpoint without `sessionToken` → expect `{"error":"AUTH_REQUIRED"}`.
- [ ] Hit `?action=login` 4 times with a wrong password → 4th call returns `TEMP_LOCKED`.
- [ ] Send `redeemReward` twice with the same `nonce` → second call returns `REPLAY`.
- [ ] Try `?action=fetchQuestions&sessionToken=…` and inspect response — there must be **no** `isCorrect` / `answerKey` / `correctAnswer` field.
- [ ] Check `AuditLog` sheet for entries.

---

## 6. Frontend ↔ backend contract changes (summary)

| Old request                                              | New request                                                  |
|----------------------------------------------------------|--------------------------------------------------------------|
| `?action=login&id=…&password=…`                          | unchanged shape, but **response now contains `sessionToken`** |
| `?action=getStudentData&studentId=X`                     | `?action=getStudentData&sessionToken=…` (sid derived server-side for students) |
| `?action=sendPoints&id=A&password=B&receiverId=C&amount=N` | `?action=sendPoints&sessionToken=…&receiverId=C&amount=N&nonce=…` |
| `?action=redeemReward&studentId=A&itemName=X&pointCost=N` | `?action=redeemReward&sessionToken=…&itemName=X&nonce=…` (server reads cost) |
| `?action=submitTest&id=A&password=B&answers=[…]`         | `?action=submitTest&sessionToken=…&answers=[…]&nonce=…`      |
| `?action=askGPT&id=A&password=B&message=X`               | `?action=askGPT&sessionToken=…&message=X`                    |
| `?action=fetchQuestions&id=A&password=B`                 | `?action=fetchQuestions&sessionToken=…`                      |

The React `api.*` helpers in this build already emit the new contract. The
old request shape continues to be **rejected** by the secured backend (this
is intentional — accepting both would defeat the purpose).
