"""student_smart_login.py — EduHub Smart Login (QR-based optional student
authentication).

Additive, optional second entry door into the EXACT SAME student session
mechanism student_login() already mints (see `issue_session`, injected at
registration — both paths call the identical function so they can never
drift apart). Student ID + Password is completely unchanged and remains
the default; this only adds a second way to reach the same session.

Credential model:
  * A student has at most one active Smart Login credential at a time —
    matches the Author Studio lifecycle (Generate / Regenerate / Revoke),
    which shows a single Active/Not-generated state per student, not a
    list of credentials.
  * The credential is a 256-bit CSPRNG secret (`secrets.token_urlsafe`),
    generated with the same stdlib `secrets` module this codebase already
    uses for the student passphrase (server.py's `_generate_passphrase`)
    — never derived from the student's password, name, or ID.
  * QR payload = "EDUHUB-SL:v1:" + secret. The prefix lets both the
    client-side decoder and this module's verify endpoint reject an
    unrelated QR code with a clear, generic error before doing any
    database work — a format check only, never a validity signal (the
    frontend still never decides whether a credential is VALID, only
    whether it's shaped like one).
  * Storage: sha256(secret) is stored as an indexed lookup key, NOT a
    bcrypt hash. bcrypt is the right primitive for the LOW-entropy,
    human-chosen secrets this codebase already bcrypts (passwords,
    passphrases) — its slow, salted design defends against dictionary /
    rainbow-table attacks on secrets a human could plausibly have picked.
    A 256-bit secrets.token_urlsafe() value has no such attack surface
    (nothing to guess, nothing to enumerate), so a fast, preimage-
    resistant hash is the correct primitive for THIS class of secret —
    the same reasoning bearer-token/API-key systems use industry-wide —
    and it is what makes an O(1) indexed lookup possible at all, which a
    per-row-salted bcrypt hash structurally cannot support (there is no
    student_id available to pick the right row until AFTER the secret
    resolves).
  * The raw secret is returned to the admin exactly once, at generation
    time — identical contract to teacher_create_student()'s plaintext
    password ("shown once — never stored, never logged").

Verification (`/auth/student/smart-login`):
  * No auth required to call (same as /auth/student/login).
  * Same Turnstile bot-check the password path already uses
    (`_verify_turnstile`, injected as `verify_turnstile` — same function,
    same dev-mode-bypass behaviour, nothing new).
  * Same enumeration protection as password login: unknown credential,
    revoked credential, and a disabled owning account all return the
    identical generic 401 "Invalid credential".
  * A small in-process rate limiter, same sliding-window-deque idiom as
    server.py's existing `_credit_rate_check` (P2P transfer limiter),
    keyed by client IP instead of a sender/recipient pair since there is
    no student identity to key on until AFTER a credential resolves.
  * On success: hands off to the injected `issue_session()` — the EXACT
    function student_login() itself calls. The QR is never itself a
    session; it authenticates, once, into the real one.

Generation / revocation (teacher-only, `require_admin`):
  * `require_admin` is the same dependency every other `/api/teacher/*`
    route already uses.
  * Generate is safe to call on a student who already has a credential —
    it replaces it (same "create or replace" shape
    `teacher_create_student()` already uses for ID reuse). Author
    Studio's "Generate" vs "Regenerate" buttons differ only in label; the
    backend operation is identical, matching this codebase's existing
    convention of one endpoint handling both create and update-in-place.
    Nothing here ever runs as a side effect of merely viewing a student.
  * Revoke deletes the credential row outright — the same idea as the
    existing `db.student_sessions.delete_many(...)` revocation pattern
    password reset already uses. No soft-delete flag: presence of a row
    IS "active"; absence is "not generated" (or "revoked" — deliberately
    the same student-facing state, since both mean "no active credential").

QR image rendering:
  * `segno` — already a hard dependency (`requirements.txt: segno>=1.6.0`)
    already used in production for KHQR payment codes
    (camrapidpay_payment_tools.py's `_cam_emv_to_data_uri`). No new
    backend dependency. PNG is the canonical download; SVG is included
    too since segno makes it a one-line addition.

Explicitly NOT touched: Assessment Lab, Speaking Lab, EduTalk,
WalletService, Attendance, Video Library, payment systems, unrelated
notification systems. The only existing file this module requires a
(minimal, additive) change to is server.py: one import, one registration
call, two new indexes, and extracting the session-issuance tail
student_login() already had into the shared `issue_session` helper both
paths now call — described in server.py's own comment at that call site.
"""
from __future__ import annotations

import base64
import hashlib
import io
import secrets
import time
from collections import deque
from datetime import datetime, timezone

import segno
from fastapi import Depends, HTTPException, Request, Response

QR_PAYLOAD_PREFIX = "EDUHUB-SL:v1:"
_TOKEN_BYTES = 32          # 256-bit credential
_MAX_PAYLOAD_LEN = 512     # defensive ceiling — a real payload is ~57 chars

# Sliding-window in-process rate limiter — same idiom as server.py's
# _credit_rate_check (P2P transfer limiter), keyed by client IP since a
# Smart Login verification attempt carries no student identity until
# AFTER a credential resolves.
_RATE_BUCKETS: dict[str, deque] = {}
_RATE_WINDOW_S = 60.0
_RATE_MAX_PER_WINDOW = 8


def _rate_check(key: str) -> bool:
    now_ts = time.time()
    bucket = _RATE_BUCKETS.setdefault(key, deque())
    while bucket and (now_ts - bucket[0]) > _RATE_WINDOW_S:
        bucket.popleft()
    if len(bucket) >= _RATE_MAX_PER_WINDOW:
        return False
    bucket.append(now_ts)
    if len(_RATE_BUCKETS) > 4096:
        for k in list(_RATE_BUCKETS.keys())[:512]:
            if not _RATE_BUCKETS[k]:
                _RATE_BUCKETS.pop(k, None)
    return True


def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _lookup_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _generate_secret() -> str:
    return secrets.token_urlsafe(_TOKEN_BYTES)


def _render_qr(payload_text: str) -> tuple[str, str]:
    """Render payload_text to (png_data_uri, svg_data_uri).

    Raises HTTPException(500) on failure — unlike the payment QR's
    best-effort fallback (a student can still pay another way), there is
    no alternate way for an admin to get this image, so a rendering
    failure must be a real, visible error rather than a silently empty
    field.
    """
    try:
        qr = segno.make(payload_text, error="m")
        png_buf = io.BytesIO()
        qr.save(png_buf, kind="png", scale=8, border=2)
        png_uri = "data:image/png;base64," + base64.b64encode(png_buf.getvalue()).decode("ascii")

        svg_buf = io.BytesIO()
        qr.save(svg_buf, kind="svg", scale=8, border=2, xmldecl=False)
        svg_uri = "data:image/svg+xml;base64," + base64.b64encode(svg_buf.getvalue()).decode("ascii")
        return png_uri, svg_uri
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="QR rendering failed") from exc


def register_student_smart_login_routes(
    api,
    db,
    *,
    require_admin,
    verify_turnstile,
    issue_session,
    log=None,
):
    """Mount Smart Login routes onto the existing `api` router.

    `issue_session(response, student_doc) -> dict` is the SAME function
    student_login() calls to mint a normal session — injected so both
    entry doors provably converge on one mechanism instead of a
    duplicated copy that could drift.
    """
    import logging
    _log = log or logging.getLogger("eduhub")

    @api.post("/auth/student/smart-login")
    async def student_smart_login(payload: dict, request: Request, response: Response):
        raw = (payload.get("qr_payload") or "").strip()
        turnstile_token = payload.get("turnstile_token") or ""

        if not raw or len(raw) > _MAX_PAYLOAD_LEN:
            raise HTTPException(status_code=400, detail="Malformed credential")

        if not _rate_check(_client_key(request)):
            raise HTTPException(status_code=429, detail="Too many attempts. Try again shortly.")

        if not await verify_turnstile(turnstile_token):
            raise HTTPException(status_code=401, detail="Bot check failed")

        # Format check only — mechanical, never a validity decision (the
        # backend still makes the actual call below).
        if not raw.startswith(QR_PAYLOAD_PREFIX):
            raise HTTPException(status_code=401, detail="Invalid credential")
        secret = raw[len(QR_PAYLOAD_PREFIX):]
        if not secret:
            raise HTTPException(status_code=401, detail="Invalid credential")

        lookup = _lookup_hash(secret)
        cred = await db.student_smart_login_credentials.find_one(
            {"credential_lookup": lookup}, {"_id": 0},
        )
        # Identical generic 401 for "no such credential" and "student
        # disabled" — same enumeration-protection contract student_login()
        # already documents: "Identical 401 for missing user and wrong
        # password — prevents enumeration."
        if not cred:
            raise HTTPException(status_code=401, detail="Invalid credential")

        doc = await db.students.find_one(
            {"student_id": cred["student_id"], "is_active": {"$ne": False}},
            {"_id": 0},
        )
        if not doc:
            raise HTTPException(status_code=401, detail="Invalid credential")

        _log.info("smart-login: successful login for %s", doc["student_id"])
        return await issue_session(response, doc)

    @api.post("/teacher/students/{student_id}/smart-login/generate")
    async def teacher_generate_smart_login(student_id: str, admin=Depends(require_admin)):
        doc = await db.students.find_one({"student_id": student_id}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Student not found")

        secret = _generate_secret()
        payload_text = QR_PAYLOAD_PREFIX + secret
        png_uri, svg_uri = _render_qr(payload_text)

        now = datetime.now(timezone.utc)
        await db.student_smart_login_credentials.update_one(
            {"student_id": student_id},
            {"$set": {
                "student_id": student_id,
                "credential_lookup": _lookup_hash(secret),
                "created_at": now.isoformat(),
            }},
            upsert=True,
        )

        _log.info(
            "smart-login: credential generated for %s by %s",
            student_id, getattr(admin, "email", "?"),
        )
        return {
            "ok": True,
            "student_id": student_id,
            "clean_id": doc.get("clean_id", ""),
            "display_name": doc.get("display_name", ""),
            "qr_payload": payload_text,   # shown ONCE — never stored, never logged
            "qr_png_data_uri": png_uri,
            "qr_svg_data_uri": svg_uri,
            "generated_at": now.isoformat(),
        }

    @api.post("/teacher/students/{student_id}/smart-login/revoke")
    async def teacher_revoke_smart_login(student_id: str, admin=Depends(require_admin)):
        result = await db.student_smart_login_credentials.delete_one({"student_id": student_id})
        _log.info(
            "smart-login: credential revoked for %s by %s (existed=%s)",
            student_id, getattr(admin, "email", "?"), bool(result.deleted_count),
        )
        return {"ok": True, "revoked": bool(result.deleted_count)}

    @api.get("/teacher/students/{student_id}/smart-login")
    async def teacher_smart_login_status(student_id: str, admin=Depends(require_admin)):
        cred = await db.student_smart_login_credentials.find_one(
            {"student_id": student_id}, {"_id": 0, "credential_lookup": 0},
        )
        return {"active": bool(cred), "created_at": (cred or {}).get("created_at")}
