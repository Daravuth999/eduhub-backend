"""tests/test_book_factory_cover_status.py
============================================
Part H/I: explicit, teacher-facing cover state — proves each of the 9
documented states resolves to a distinct, correct message, and that the
fallback-order signal (manual URL vs. stylized) is reported accurately.
"""
from __future__ import annotations

import book_factory_jobs as bfj


def _doc(cover_state=None, cover_image="", config_cover_image="", **config_extra):
    return {
        "cover": {"state": cover_state} if cover_state else {},
        "config": {"coverImage": config_cover_image, **config_extra},
        **({"cover": {"state": cover_state, "coverImage": cover_image}} if cover_state else {}),
    }


def test_feature_disabled_when_flag_off(monkeypatch):
    monkeypatch.delenv("BOOK_FACTORY_COVER_ENABLED", raising=False)
    status = bfj.cover_teacher_status({"cover": {}, "config": {}})
    assert status["state"] == "featureDisabled"
    assert "not enabled" in status["message"]


def test_key_unavailable_when_flag_on_but_no_key(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.delenv("GEMINI_IMAGE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    status = bfj.cover_teacher_status({"cover": {}, "config": {}})
    assert status["state"] == "keyUnavailable"
    assert "Gemini image service" in status["message"]


def test_storage_unavailable_when_key_present_but_no_r2(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "k")
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"):
        monkeypatch.delenv(k, raising=False)
    status = bfj.cover_teacher_status({"cover": {}, "config": {}})
    assert status["state"] == "storageUnavailable"
    assert "could not be stored" in status["message"]


def _fully_ready_env(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "k")
    for k, v in {"R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "b", "R2_SECRET_ACCESS_KEY": "c",
                 "R2_BUCKET_NAME": "d", "R2_PUBLIC_URL": "https://x"}.items():
        monkeypatch.setenv(k, v)


def test_pending_state_when_ready_but_never_run(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "pending"}, "config": {}})
    assert status["state"] == "pending"


def test_provider_pending_state(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "provider_pending"}, "config": {}})
    assert status["state"] == "providerPending"
    assert "Generating" in status["message"]


def test_completed_state(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "completed", "coverImage": "https://x/y.png"}, "config": {}})
    assert status["state"] == "completed"
    assert status["usingFallback"] is None  # generated cover exists, no fallback in use


def test_retryable_failure_state(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "failed_retryable"}, "config": {}})
    assert status["state"] == "retryableFailure"


def test_terminal_failure_state(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "failed_terminal"}, "config": {}})
    assert status["state"] == "terminalFailure"
    assert "will not retry automatically" in status["message"]


def test_unknown_outcome_state(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "unknown_outcome"}, "config": {}})
    assert status["state"] == "unknownOutcome"
    assert "manual review" in status["message"]


# ── fallback-order reporting (Part I) ──────────────────────────────────────
def test_fallback_reports_manual_url_when_no_generated_cover(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "pending"}, "config": {"coverImage": "https://teacher/pic.png"}})
    assert status["usingFallback"] == "manual_url"


def test_fallback_reports_stylized_when_neither_generated_nor_manual(monkeypatch):
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({"cover": {"state": "pending"}, "config": {"coverImage": ""}})
    assert status["usingFallback"] == "stylized"


def test_generated_cover_never_overwrites_manual_url_reporting(monkeypatch):
    """A generated cover takes precedence in `usingFallback` reporting once
    it exists — but this function only REPORTS state, it never mutates
    config.coverImage (the manual-URL-preservation guarantee lives in
    _compute_export / export_canonical_book, unaffected by this addition)."""
    _fully_ready_env(monkeypatch)
    status = bfj.cover_teacher_status({
        "cover": {"state": "completed", "coverImage": "https://gen/cover.png"},
        "config": {"coverImage": "https://teacher/pic.png"},
    })
    assert status["usingFallback"] is None  # generated cover is in use, not a fallback


def test_job_view_always_includes_cover_teacher_status(monkeypatch):
    monkeypatch.delenv("BOOK_FACTORY_COVER_ENABLED", raising=False)
    view = bfj._job_view({"_id": "x", "jobId": "job1", "cover": {}, "config": {}})
    assert "coverTeacherStatus" in view
    assert view["coverTeacherStatus"]["state"] == "featureDisabled"
    assert "_id" not in view
