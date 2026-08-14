# EduHub GAS Backend — Secure Deployment Guide

This folder contains hardened wrappers for **all 7 Google Apps Script
backends + 1 Config endpoint** used by the EduHub portal. The frontend has
already been migrated to call them with the new auth contract (`sessionToken`
instead of plaintext password on every request).

> **The wrappers do not break any existing feature.**
> All your business-logic functions (sheet writes, scoring, point math…) are
> kept intact — they are referenced from `*Logic_*_` stubs in each Code.gs.
> Just paste your existing function bodies into those stubs.

> ## 🩺 Getting "Incorrect Student ID or password" with a correct password?
>
> 99% of the time this means the wrapper can't locate the columns in your
> existing student sheet.  The wrapper auto-detects many header names
> (`Student ID`, `StudentID`, `ID`, `Password`, `Pass`, …) but if yours is
> unusual, run this **once** in the Apps Script editor:
>
> ```js
> diagnoseUsersSheet()
> ```
>
> Open **View → Executions → Logs** and it will print your sheet's headers,
> which logical field each one maps to, and a masked sample row.  If the
> `sid` or `pwd` index is `-1`, set a Script Property called
> `USERS_HEADER_MAP` to a JSON override, e.g.
> `{"sid":"student no","pwd":"passcode"}`.  Then run `refreshUsersCache()`
> and try logging in again.
>
> Full troubleshooting guide: see **§3 "Users sheet schema"** below.

---

## 1.  Files in this folder

| File                          | Where to paste                                                     |
|-------------------------------|--------------------------------------------------------------------|
| `_SecurityCore.gs`            | **Every** GAS project (paste this file first in every project)     |
| `PortalBackend.Code.gs`       | The "Portal" GAS project (`AKfycbw_…`)                              |
| `PointsBackend.Code.gs`       | The "Points" GAS project (`AKfycbzRkt…`)                            |
| `GameBackend.Code.gs`         | The "Lucky Spin" GAS project (`AKfycbxKSDS…`)                       |
| `ShopBackend.Code.gs`         | The "Rewards Shop" GAS project (`AKfycbyp40y…`)                     |
| `LibraryBackend.Code.gs`      | The "Library" GAS project (`AKfycbzgTm…`)                           |
| `AssistantBackend.Code.gs`    | The "AI Assistant" GAS project (`AKfycbzrDP…`)                      |
| `SystemTestBackend.Code.gs`   | The "System Test" GAS project (`AKfycbwQk…`)                        |
| `ConfigBackend.Code.gs`       | The "Config" GAS project (`AKfycby7C…`)                             |

---

## 2.  One-time setup per project (≈ 4 min each)

1. Open `script.google.com` → open the project.
2. Add a **new Apps Script file** named `_SecurityCore` and paste
   `gas-backend/_SecurityCore.gs` into it. Save.
3. Open your **existing `Code.gs`** (or whatever holds your `doGet`/`doPost`).
   - **Rename your existing `doGet` and `doPost`** to something like
     `legacyDoGet` and `legacyDoPost` (so they're not entry points anymore).
   - **Rename your existing business functions** to match the
     `*Logic_*_` stub names in this folder (or just copy the function bodies
     into the stubs).
4. Paste the matching `*Backend.Code.gs` from this folder into a **new file**
   named `Code.gs` (or replace the existing one) — this is the new entry point.
5. **Project Settings → Script Properties → Edit script properties** and add:

   | Key                | Value                                                           |
   |--------------------|-----------------------------------------------------------------|
   | `HMAC_SECRET`      | A random string ≥ 48 chars (e.g. `openssl rand -hex 32`)        |
   | `ALLOWED_ORIGINS`  | `daravuthenglish.online,daravuth995.github.io,<emergent-host>`  |
   | `USERS_SHEET_ID`   | The Sheet ID containing the canonical `Users` tab               |
   | `USERS_SHEET_NAME` | The tab name holding your student list (e.g. `Sheet1`, `Students`) |
   | `USERS_HEADER_MAP` | *(optional)* JSON like `{"sid":"student_no","pwd":"passcode"}` — only needed if your headers don't match any of the built-in aliases |
   | `AUDIT_SHEET_NAME` | `AuditLog` (auto-created)                                       |
   | `RATE_LIMIT_RPM`   | `45`                                                            |
   | `RATE_LIMIT_BURST` | `10`                                                            |
   | `SESSION_TTL_MIN`  | `720`                                                           |
   | `DEBUG_MODE`       | `false`                                                         |
   | `LLM_API_KEY`      | *(Assistant project only)* OpenAI/Gemini key                    |

   > **Use the SAME `HMAC_SECRET` across all 7 projects.** This is what lets a
   > single login on the Portal backend produce a `sessionToken` that all the
   > other backends will accept.

6. Run `runSecuritySelfTest` once from the editor to confirm the secret is
   readable. (It throws if `HMAC_SECRET` is missing.)
7. **Deploy → Manage deployments → New version** of the **same deployment**
   (don't create a new URL — keep the existing `AKfyc...` so the frontend
   doesn't have to change).

---

## 3.  `Users` sheet schema (single source of truth for roles)

The wrapper **auto-detects** your existing sheet's column headers against a
broad list of aliases — you do **not** have to rename anything.  These are
the fields it looks for and the header names it will accept out of the box
(all case-insensitive, spaces/underscores/dashes ignored):

| Logical field | Header aliases the wrapper recognises                                                                                          |
|---------------|---------------------------------------------------------------------------------------------------------------------------------|
| **Student ID**| `StudentID`, `Student ID`, `Student_ID`, `Student-ID`, `Student No`, `StudentNo`, `ID`, `SID`, `Stud ID`, `StudID`, `RollNo`, `UserID` |
| **Name**      | `Name`, `FullName`, `Full Name`, `StudentName`, `Student Name`, `DisplayName`                                                   |
| **Password**  | `Password`, `Pass`, `Passcode`, `Pwd`, `PW`, `Secret`, `Login Password`, `Student Password`                                      |
| **Role**      | `Role`, `UserType`, `User Type`, `Type`, `Permission`, `Access`, `AccessLevel` *(optional — defaults to `student` if missing)*    |
| **Status**    | `Status`, `State`, `Active`, `Enabled`, `AccountStatus` *(optional — defaults to `active` if missing)*                          |

So if your existing sheet already has headers like `Student ID | Name | Password`
(no Role/Status columns), it **just works** — every student is treated as an
active student.

### If your sheet uses an exotic header name

Set a Script Property called `USERS_HEADER_MAP` to a JSON object that maps
logical fields to your literal header names, e.g.:

```json
{ "sid": "student_no", "pwd": "passcode" }
```

Keys: `sid | name | pwd | role | status | email` — any key you omit keeps
its alias-based detection.

### Example sheet (minimum)

| A: Student ID | B: Name      | C: Password |
|---------------|--------------|-------------|
| `STD001`      | Lina Sok     | `hunter2`   |
| `T001`        | Daravuth Yon | `…`         |

- **Status** = `blocked` (in any Status column) immediately revokes access
  on the next request.
- The Password column is only used for the *initial* `login` action; after
  that the frontend uses the `sessionToken` and the password is never sent
  again.  When you're ready, migrate this column to a salted-hash check
  inside `SecurityCore.authenticatePassword` (one-line change).

### 🩺 Debugging login failures (IMPORTANT)

If students get **BAD_CREDENTIALS** with correct passwords, it means the
wrapper could not find one of the required columns.  Run this from the
Apps Script editor:

```js
diagnoseUsersSheet()
```

Then open **View → Executions → Logs**. You will see output like:

```
USERS_SHEET_ID   = (set, 44 chars)
USERS_SHEET_NAME = Sheet1
Headers (raw)    : ["Student ID","Full Name","PassCode"]
Headers (lower)  : ["student id","full name","passcode"]
Resolved indexes : {"sid":0,"name":1,"pwd":2,"role":-1,"status":-1,"email":-1}
Row 2 sample     : {"sid":"STD001","name":"Lina Sok","pwd":"***r2",...}
Users loaded     : 72
```

- `Resolved indexes.sid = -1` ⇒ ID column not recognised → add the real
  header name to `USERS_HEADER_MAP` as `{ "sid": "your header" }`.
- `Tab "Users" NOT FOUND` ⇒ fix `USERS_SHEET_NAME` to one of the tabs it
  prints.
- `Users loaded: 0` but `sid >= 0` ⇒ the ID column exists but every cell
  in column A is empty — check for a blank header row or merged cells.

After fixing the properties, run `refreshUsersCache()` once to flush the
60-second in-memory cache, then try logging in again.

---

## 4.  Smoke test (1 minute)

After deploying, hit the endpoint from a browser:

```
https://script.google.com/.../exec?action=getConfig&callback=cb
```

You should see `cb({ ... })` returned (Config endpoint is the only public
one).  Now try:

```
https://script.google.com/.../exec?action=getStudentData&studentId=STD001
```

You should see `{"success":false,"error":"AUTH_REQUIRED"}` because no
`sessionToken` was sent.  That's the security working.

To get a token:

```bash
curl -X POST 'https://script.google.com/.../exec' \
  -d 'action=login&studentId=STD001&password=hunter2'
```

Response:

```json
{ "success": true, "sessionToken": "v1...xxx", "role": "student", "name": "Lina Sok" }
```

Now reuse that token for everything else:

```bash
curl 'https://script.google.com/.../exec?action=getStudentData&sessionToken=v1...xxx'
```

---

## 5.  Migrating existing data

No data migration is required.  The `Users` sheet may already exist; just
make sure the column headers match and add a `Role` column if missing
(default everyone to `student`).

---

## 6.  When to rotate `HMAC_SECRET`

- After any suspected leak.
- Every 6 months as routine hygiene.
- Rotation invalidates all live sessions — students get prompted to log in
  again.  No data loss.
