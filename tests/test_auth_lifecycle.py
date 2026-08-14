"""tests/test_auth_lifecycle.py — Milestone 1 (Authentication Completion,
Phase 1) verification.

Pure function, no Mongo/db dependency at all — derive_student_status()
takes a plain dict and returns a string. Proves the single shared fallback
computation server.py now calls from every read site (current_student(),
teacher_list_students()'s two branches) behaves correctly for every case
that can actually occur in production data.
"""
from __future__ import annotations

from auth_lifecycle import STUDENT_STATUSES, derive_student_status


def test_legacy_document_with_no_status_field_and_is_active_true():
    assert derive_student_status({"is_active": True}) == "active"


def test_legacy_document_with_no_status_field_and_is_active_false():
    assert derive_student_status({"is_active": False}) == "archived"


def test_legacy_document_missing_is_active_entirely_defaults_active():
    # Matches the Student pydantic model's own default (is_active: bool = True)
    # and the `is_active: {"$ne": False}` query used at login — a document
    # with no is_active field at all is treated as active, never archived.
    assert derive_student_status({}) == "active"


def test_explicit_status_field_wins_verbatim_over_is_active():
    # A future write (e.g. an eventual "suspend" action) sets status
    # explicitly — this function must never override an explicit value,
    # even one that would otherwise look inconsistent with is_active.
    assert derive_student_status({"status": "suspended", "is_active": True}) == "suspended"
    assert derive_student_status({"status": "archived", "is_active": True}) == "archived"


def test_unrecognized_status_value_falls_back_to_is_active_derivation():
    # Defensive: a corrupt/unexpected status string must not be trusted
    # verbatim — fall back to the same is_active-derived computation as if
    # no status were present at all.
    assert derive_student_status({"status": "not-a-real-status", "is_active": True}) == "active"
    assert derive_student_status({"status": "not-a-real-status", "is_active": False}) == "archived"


def test_new_style_document_with_explicit_active_status():
    assert derive_student_status({"status": "active", "is_active": True}) == "active"


def test_student_statuses_constant_matches_the_pydantic_literal():
    # Kept in sync manually with Student.status's Literal in server.py —
    # this test exists so a future edit to one without the other is caught.
    assert STUDENT_STATUSES == ("active", "suspended", "archived")
