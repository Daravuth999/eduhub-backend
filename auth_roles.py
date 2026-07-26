"""auth_roles.py — Milestone 2 (Authentication Completion, Phase 1).

Additive identity role foundation for teacher/admin `User` documents.
Introduces a single shared source of truth for deriving a `role`
("teacher" | "admin" | "super_admin") from a raw Mongo document, mirroring
the Student.status pattern established in auth_lifecycle.py.

Nothing here changes authorization. `is_admin` remains the actual
enforcement mechanism (require_admin() still checks user.is_admin
directly) — `role` is a read-side, additive projection on top of it. No
document is migrated or backfilled: existing documents have no `role`
field at all, and derive_user_role() computes the correct value for them
on every read, indefinitely, with zero write required. New/updated
documents (via auth_google(), this same milestone) start carrying an
explicit `role` going forward.

"admin" is intentionally never produced by this milestone's fallback —
it is reserved vocabulary for a future milestone that distinguishes
"admin" from "super_admin" among is_admin==True users. Only an explicit
future write of role="admin" can ever produce it; until then every
is_admin==True user maps to "super_admin".
"""
from __future__ import annotations

USER_ROLES = ("teacher", "admin", "super_admin")


def derive_user_role(doc: dict) -> str:
    """Return this user's role.

    If the document already carries an explicit, recognized `role`, that
    value wins verbatim — this function never overrides an explicit role
    (so a future manual "admin" assignment survives subsequent logins).
    Otherwise falls back to the legacy `is_admin` boolean: True ->
    "super_admin", False/missing -> "teacher". "admin" can never be
    produced by this fallback.
    """
    explicit = doc.get("role")
    if explicit in USER_ROLES:
        return explicit
    return "super_admin" if doc.get("is_admin") else "teacher"
