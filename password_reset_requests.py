"""password_reset_requests.py — Milestone 4 (Authentication Completion,
Phase 1): teacher-assisted password reset queue.

No email/SMS provider exists in this backend, and `Student` documents
carry no email/phone field at all (confirmed during Milestone 4 scoping) —
so a self-service reset-link/code flow isn't buildable yet without first
adding that infrastructure, which was explicitly out of scope for this
milestone. Per the approved decision, this module instead lets a student
flag "I forgot my password" and gives a teacher a small queue to review,
then act on using the ALREADY-EXISTING `teacher_reset_password` flow in
`server.py` — no new credential-delivery mechanism is introduced here.

Designed to be upgradable later without replacing this queue: a future
self-service milestone can insert into this same `password_reset_requests`
collection from a token/link-based flow too, so teachers keep one place
to see reset activity regardless of which path created it.

Never reveals whether a given `clean_id` is registered — the student-
facing endpoint always returns the same generic response, mirroring the
enumeration-prevention care `student_login()` already takes.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import Depends, HTTPException


def register_password_reset_routes(api, db, *, require_admin, verify_turnstile, log=None):
    """Mount the 3 password-reset-request endpoints onto the existing `api`
    router. Safe to call once at server.py startup, mirroring the
    register_lucky_draw_routes/register_eligibility_routes convention.

    * require_admin: the existing `require_admin` FastAPI dependency from
      server.py, reused as-is — no new authorization check invented here.
    * verify_turnstile: the existing `_verify_turnstile` coroutine from
      server.py, reused as-is — no new bot-check logic duplicated here.
    """

    @api.post("/auth/student/forgot-password")
    async def student_forgot_password(payload: dict):
        clean_id = (payload.get("clean_id") or "").strip().lower()
        turnstile_token = payload.get("turnstile_token") or ""

        if not clean_id:
            raise HTTPException(status_code=400, detail="clean_id is required")
        if not await verify_turnstile(turnstile_token):
            raise HTTPException(status_code=401, detail="Bot check failed")

        # Everything below only affects whether a queue row is created —
        # the response is identical either way (see module docstring).
        doc = await db.students.find_one({"clean_id": clean_id}, {"_id": 0})
        if doc:
            existing = await db.password_reset_requests.find_one(
                {"student_id": doc["student_id"], "status": "pending"},
            )
            if not existing:
                now = datetime.now(timezone.utc)
                await db.password_reset_requests.insert_one({
                    "request_id": f"prr_{uuid.uuid4().hex[:12]}",
                    "student_id": doc["student_id"],
                    "clean_id": doc["clean_id"],
                    "display_name": doc["display_name"],
                    "group": doc.get("group", ""),
                    "status": "pending",
                    "requested_at": now,
                    "resolved_at": None,
                })

        return {
            "ok": True,
            "message": "If this ID is registered, your teacher has been notified.",
        }

    @api.get("/teacher/password-reset-requests")
    async def teacher_list_password_reset_requests(admin=Depends(require_admin)):
        cursor = db.password_reset_requests.find(
            {"status": "pending"}, {"_id": 0},
        ).sort("requested_at", -1)
        requests = await cursor.to_list(length=500)
        return {"requests": requests}

    @api.post("/teacher/password-reset-requests/{request_id}/dismiss")
    async def teacher_dismiss_password_reset_request(
        request_id: str, admin=Depends(require_admin),
    ):
        now = datetime.now(timezone.utc)
        result = await db.password_reset_requests.update_one(
            {"request_id": request_id},
            {"$set": {"status": "resolved", "resolved_at": now}},
        )
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Request not found")
        return {"ok": True}
