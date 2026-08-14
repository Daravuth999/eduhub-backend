"""eduhub_platform/identity.py — the one canonical student-id normalizer
(Architecture Reconstruction Phase 1, item 4).

Package named `eduhub_platform` rather than architecture.md's literal
`platform/` — see eduhub_platform/__init__.py for why (stdlib collision,
confirmed by 13 failing test collections).

Before this module, the SAME normalization concept was implemented four
separate times, with three genuinely different behaviors:

  server.py:_norm_student_id        strips zero-width chars + whitespace,
                                     lowercases; returns "" for None/invalid
                                     (never raises)
  wallet_service.py:_norm_id        same core normalization, but RAISES
                                     WalletError on empty/too-long input —
                                     a deliberate fail-fast contract for
                                     money-path code, not a bug
  mystery_box_tools.py:_mbt_norm_id looked up server.py's _norm_student_id
                                     via `globals().get(...)` (only works
                                     because of exec()-namespace sharing —
                                     see Phase 1 item 2) and silently fell
                                     back to a WEAKER normalization (no
                                     zero-width-char stripping) if that
                                     lookup ever failed
  speaking_lab_wallet_migration.py:_safe_norm_id
                                     wraps wallet_service._norm_id, turning
                                     its raise into None (best-effort)

`resolve()` below is now the ONLY place the actual normalization rule
(zero-width-char stripping + whitespace strip + lowercase) is written.
Every one of the four call sites above still exists (renaming 21 + 14
call sites across server.py/wallet_service.py in one pass was judged too
high-risk for this phase — see the Phase 1 report) but each is now a THIN
wrapper delegating to `resolve()`, so the underlying rule can never drift
between them again. The two genuinely different CONTRACTS (raise vs.
never-raise) are preserved as two named functions here, not collapsed into
one — that distinction is deliberate wallet-code behavior, not duplication.
"""
from __future__ import annotations

_ZERO_WIDTH = ("​", "‌", "‍", "﻿")


def resolve(value) -> str:
    """Canonical, NEVER-RAISING normalization. Returns "" for None / any
    non-stringifiable input. Safe to call on every id before any equality
    check or Mongo query — this is the right default for lookups/reads."""
    if value is None:
        return ""
    s = str(value)
    for ch in _ZERO_WIDTH:
        s = s.replace(ch, "")
    return s.strip().lower()


def resolve_strict(value, *, label: str = "student_id", max_len: int = 64) -> str:
    """Canonical, RAISING normalization for money-path code that must never
    silently proceed on a blank/garbage id. Raises ValueError (callers that
    need a domain-specific exception type, e.g. wallet_service's
    WalletError, should catch ValueError and re-wrap — see wallet_service.py
    for the one place that still does that translation)."""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    v = resolve(value)
    if not v or len(v) > max_len:
        raise ValueError(f"{label} invalid")
    return v


# The canonical EXTERNAL identifier going forward is `clean_id` (human-
# readable, e.g. "stu094") per the accepted architecture — `student_id`
# (wallet-form, e.g. "stu_88185fad5202") is a legacy internal alias.
# `prefer_clean()` centralizes the "which id do I actually send/store"
# decision so feature modules stop re-implementing it ad hoc (see the v1.7
# EMERGENCY FIX precedent in the Speaking Lab console's mapEduhubStudent()).
def prefer_clean(student_doc: dict | None) -> str:
    """Given a student-shaped dict (or anything with .get), return the
    preferred external id: clean_id if present, else the legacy student_id
    form, else "". Never raises."""
    if not student_doc:
        return ""
    get = student_doc.get if hasattr(student_doc, "get") else (lambda k: None)
    return resolve(get("clean_id") or get("student_id") or get("studentid") or "")


__all__ = ["resolve", "resolve_strict", "prefer_clean"]
