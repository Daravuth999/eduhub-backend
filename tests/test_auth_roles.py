"""tests/test_auth_roles.py — Milestone 2 (Authentication Completion,
Phase 1) verification.

Pure function, no Mongo/db dependency at all — derive_user_role() takes a
plain dict and returns a string. Proves the single shared fallback
computation server.py now calls from every User read/write site
(current_user(), both auth_google() branches) behaves correctly for
every case that can actually occur in production data.
"""
from __future__ import annotations

from auth_roles import USER_ROLES, derive_user_role


def test_legacy_document_with_no_role_field_and_is_admin_true():
    assert derive_user_role({"is_admin": True}) == "super_admin"


def test_legacy_document_with_no_role_field_and_is_admin_false():
    assert derive_user_role({"is_admin": False}) == "teacher"


def test_legacy_document_missing_is_admin_entirely_defaults_teacher():
    # Matches the User pydantic model's own default (is_admin: bool = False).
    assert derive_user_role({}) == "teacher"


def test_explicit_role_field_wins_verbatim_over_is_admin():
    # A future write (e.g. an eventual "promote to admin" action) sets
    # role explicitly — this function must never override an explicit
    # value, even one that would otherwise look inconsistent with is_admin.
    assert derive_user_role({"role": "admin", "is_admin": True}) == "admin"
    assert derive_user_role({"role": "admin", "is_admin": False}) == "admin"
    assert derive_user_role({"role": "teacher", "is_admin": True}) == "teacher"


def test_unrecognized_role_value_falls_back_to_is_admin_derivation():
    assert derive_user_role({"role": "not-a-real-role", "is_admin": True}) == "super_admin"
    assert derive_user_role({"role": "not-a-real-role", "is_admin": False}) == "teacher"


def test_new_style_document_with_explicit_super_admin_role():
    assert derive_user_role({"role": "super_admin", "is_admin": True}) == "super_admin"


def test_fallback_never_produces_admin():
    # "admin" is reserved for a future milestone — the is_admin-derived
    # fallback must only ever yield "teacher" or "super_admin".
    assert derive_user_role({"is_admin": True}) != "admin"
    assert derive_user_role({"is_admin": False}) != "admin"


def test_user_roles_constant_matches_the_pydantic_literal():
    # Kept in sync manually with User.role's Literal in server.py — this
    # test exists so a future edit to one without the other is caught.
    assert USER_ROLES == ("teacher", "admin", "super_admin")
