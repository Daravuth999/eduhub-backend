"""admin_security.py — EduHub operational security controls for Author Studio.

Force All Users to Sign Out
----------------------------
Real-world purpose: after a major PWA/authentication upgrade, an admin
needs a reliable way to make every currently-open EduHub tab (student or
staff) drop back to the login screen and pick up the fresh build, without
touching any account data.

Do NOT invent a new session architecture. This reuses the EXACT
revocation primitive server.py already uses everywhere a session needs to
die — `db.student_sessions.delete_many(...)` (password reset, deactivate,
regenerate) and the identical single-session `db.user_sessions.delete_one`
on logout. A global sign-out is that same operation with no filter: every
row in both session collections is deleted in one pass.

Why deletion, not a "session epoch" marker:
  * `current_student()` / `current_user()` (server.py) authenticate a
    request by looking the token up in `student_sessions` / `user_sessions`
    and returning None on a miss. Deleting the row makes that lookup miss
    — the exact same code path an expired/revoked session already takes.
    Zero changes needed to either dependency, and zero added per-request
    cost forever after (a marker-timestamp approach would need a global
    config read added to both hot-path dependencies, on every request,
    permanently, to serve a control that is used maybe once per release).
  * No race window matters here: any session created a few milliseconds
    before or after the delete_many() call either survives or doesn't —
    both outcomes are safe, and a caught-in-the-middle student simply
    logs in again, which is already the expected post-upgrade flow.

What this deliberately does NOT touch:
  * `students` / `users` — accounts, names, roles, wallet balances,
    password hashes: untouched.
  * `student_smart_login_credentials` — Smart Login QR credentials stay
    valid; a student can scan their existing QR the instant they're
    bounced back to /login. This is the actual point of the feature —
    "force re-authentication", not "revoke credentials".
  * Every other collection (assessments, attendance, Speaking Lab,
    EduTalk, payments, notifications, video library, etc.) — not
    referenced anywhere in this module.

Authorization: `require_admin`, the same dependency every other
`/api/teacher/*` and `/api/admin/*` route already uses. No new auth
concept introduced.
"""
from __future__ import annotations

from fastapi import Depends


def register_admin_security_routes(
    api,
    db,
    *,
    require_admin,
    log=None,
):
    """Mount admin security routes onto the existing `api` router."""
    import logging
    _log = log or logging.getLogger("eduhub")

    @api.post("/admin/security/force-logout-all")
    async def force_logout_all_users(admin=Depends(require_admin)):
        student_result = await db.student_sessions.delete_many({})
        user_result = await db.user_sessions.delete_many({})
        total = student_result.deleted_count + user_result.deleted_count
        _log.warning(
            "admin-security: force-logout-all triggered by %s — "
            "%d student session(s) + %d admin/teacher session(s) invalidated",
            getattr(admin, "email", "?"),
            student_result.deleted_count,
            user_result.deleted_count,
        )
        return {
            "ok": True,
            "student_sessions_invalidated": student_result.deleted_count,
            "admin_sessions_invalidated": user_result.deleted_count,
            "total_invalidated": total,
        }
