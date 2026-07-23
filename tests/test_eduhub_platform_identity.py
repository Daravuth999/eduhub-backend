"""tests/test_eduhub_platform_identity.py — Architecture Reconstruction Phase
1, item 4: direct coverage for the one canonical student-id normalizer.

Before eduhub_platform.identity existed, this rule was implemented four
separate times (server.py, wallet_service.py, mystery_box_tools.py,
speaking_lab_wallet_migration.py) with subtly different behavior. This file
tests the canonical implementation directly, independent of any of its
three call sites, including the real zero-width-character stripping that
server.py's pre-consolidation copy never actually performed (it checked for
the literal escape text "\\u200b" instead of the real U+200B character).
"""
from __future__ import annotations

import pytest

from eduhub_platform.identity import prefer_clean, resolve, resolve_strict


class TestResolve:
    def test_none_returns_empty_string(self):
        assert resolve(None) == ""

    def test_strips_whitespace_and_lowercases(self):
        assert resolve("  Stu094  ") == "stu094"

    def test_strips_real_zero_width_characters(self):
        # U+200B ZERO WIDTH SPACE, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM/ZWNBSP
        dirty = "stu​094‌‍﻿"
        assert resolve(dirty) == "stu094"

    def test_does_not_strip_literal_escape_text(self):
        # Regression guard for the discovered bug: the OLD server.py body
        # matched the literal 6-character text made of a backslash
        # followed by "u200b" (a double-escaped backslash), not the real
        # character. The canonical resolver must not repeat that mistake
        # in the other direction either -- that literal escape-looking
        # text in an id is not a zero-width char and must survive
        # normalization untouched (aside from casing).
        assert resolve("stu\\u200b094") == "stu\\u200b094"

    def test_non_string_input_is_stringified(self):
        assert resolve(12345) == "12345"

    def test_empty_and_whitespace_only(self):
        assert resolve("") == ""
        assert resolve("   ") == ""


class TestResolveStrict:
    def test_valid_id_passes_through_normalized(self):
        assert resolve_strict("  Stu094  ") == "stu094"

    def test_raises_on_empty_string(self):
        with pytest.raises(ValueError):
            resolve_strict("")

    def test_raises_on_non_string(self):
        with pytest.raises(ValueError):
            resolve_strict(12345)

    def test_raises_on_none(self):
        with pytest.raises(ValueError):
            resolve_strict(None)

    def test_raises_on_too_long(self):
        with pytest.raises(ValueError):
            resolve_strict("s" * 65, max_len=64)

    def test_accepts_at_max_len_boundary(self):
        assert resolve_strict("s" * 64, max_len=64) == "s" * 64


class TestPreferClean:
    def test_none_doc_returns_empty(self):
        assert prefer_clean(None) == ""

    def test_empty_doc_returns_empty(self):
        assert prefer_clean({}) == ""

    def test_prefers_clean_id_over_student_id(self):
        doc = {"clean_id": "Stu094", "student_id": "stu_88185fad5202"}
        assert prefer_clean(doc) == "stu094"

    def test_falls_back_to_student_id(self):
        doc = {"student_id": "stu_88185fad5202"}
        assert prefer_clean(doc) == "stu_88185fad5202"

    def test_falls_back_to_studentid_variant(self):
        doc = {"studentid": "Stu094"}
        assert prefer_clean(doc) == "stu094"
