"""auth_lifecycle.py — Milestone 1 (Authentication Completion, Phase 1).

Additive account-lifecycle status. Introduces a single shared source of
truth for deriving a student's `status` ("active" | "suspended" |
"archived") from a raw Mongo document, so every endpoint that surfaces
student data computes it the same way instead of re-implementing the
is_active-to-status fallback inline.

Nothing here changes access control. `is_active` remains the actual
enforcement mechanism (current_student() still rejects on
`is_active is False`, student_login()'s query still filters on it) —
`status` is a read-side, additive projection on top of it. No document is
migrated or backfilled: existing documents have no `status` field at all,
and derive_student_status() computes the correct value for them on every
read, indefinitely, with zero write required. New documents (created via
teacher_create_student()/teacher_deactivate_student(), this same
milestone) start carrying an explicit `status` going forward, which is
what will eventually let a future milestone retire the fallback — not
this one.
"""
from __future__ import annotations

STUDENT_STATUSES = ("active", "suspended", "archived")


def derive_student_status(doc: dict) -> str:
    """Return this student's lifecycle status.

    If the document already carries an explicit, recognized `status`
    (new-style documents, or a future explicit write such as "suspended"),
    that value wins verbatim — this function never overrides an explicit
    status. Otherwise falls back to the legacy `is_active` boolean:
    True/missing -> "active", False -> "archived". "suspended" can never
    be produced by this fallback, since no legacy field encodes it — a
    document is only ever "suspended" once something explicitly sets
    `status: "suspended"` (a capability introduced in a later milestone,
    not here).
    """
    explicit = doc.get("status")
    if explicit in STUDENT_STATUSES:
        return explicit
    # Same `is False` idiom already used at the enforcement points this
    # mirrors (current_student(), student_login()'s query filter) — missing
    # or True both mean active; only an explicit False means archived.
    return "archived" if doc.get("is_active") is False else "active"
