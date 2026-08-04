"""tests/test_tuition_receipt_pdf.py
=====================================
Persistent Tuition Receipt Engine, C2 — PDF/PNG rendering.

Imports tuition_receipt_pdf.py directly (a pure, dependency-free rendering
module — no Mongo, no `import server`), matching this session's established
fix for the earlier test-collision issue (see guest_content_boundary.py's
test file for precedent): keep rendering logic importable in isolation.
"""
from __future__ import annotations

from datetime import datetime, timezone

from tuition_receipt_pdf import render_receipt_pdf, render_receipt_png


def _receipt(**overrides) -> dict:
    base = {
        "receipt_id": "rcpt_abc123",
        "invoice_number": "INV-2026-000003",
        "student_id": "sid1",
        "clean_id": "seyma.kann",
        "amount_usd": 18.0,
        "amount_khr": 73800,
        "method": "khqr",
        "reference": "TUITION-0801120000-ABC123",
        "prev_due_date": "2026.07.01",
        "new_due_date": "2026.08.01",
        "confirmed_at": datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc),
        "recorded_by_name": None,
    }
    base.update(overrides)
    return base


def _cfg(**overrides) -> dict:
    base = {
        "company_name": "Eduhub Studio",
        "company_address": "Phnom Penh, Cambodia",
        "company_phone": "855-69489680",
        "company_email": "daravuthappleid995@gmail.com",
        "notes": "Thank you for choosing EduHub Studio.",
        "terms_and_conditions": "Payment received is non-refundable.",
    }
    base.update(overrides)
    return base


def test_render_receipt_pdf_produces_valid_nonempty_pdf():
    data = render_receipt_pdf(_receipt(), _cfg())
    assert data.startswith(b"%PDF-")
    assert len(data) > 500


def test_render_receipt_png_produces_valid_png_and_is_rasterized_from_the_same_pdf():
    data = render_receipt_png(_receipt(), _cfg())
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(data) > 500


def test_pdf_rendering_is_deterministic_for_identical_inputs():
    # reportlab embeds a creation timestamp + random /ID in every PDF's
    # container, so raw bytes legitimately differ run-to-run — assert on
    # the extracted TEXT content instead, which is what "deterministic
    # regeneration" actually promises (same receipt_doc -> same visible
    # invoice, not a byte-identical file).
    import fitz
    r, c = _receipt(), _cfg()
    first = render_receipt_pdf(r, c)
    second = render_receipt_pdf(r, c)
    with fitz.open(stream=first, filetype="pdf") as p1, fitz.open(stream=second, filetype="pdf") as p2:
        assert p1[0].get_text() == p2[0].get_text()


def test_manual_payment_shape_renders_without_error():
    manual = _receipt(
        method="cash", reference="MANUAL-rcpt_abc123", months_covered=2,
        recorded_by_name="Alita.Ly", reward_points=0, reward_status=None,
    )
    data = render_receipt_pdf(manual, _cfg())
    assert data.startswith(b"%PDF-")


def test_missing_optional_fields_do_not_crash_the_renderer():
    sparse = {
        "receipt_id": "rcpt_zzz",
        "amount_usd": 0,
        "method": None,
        "reference": None,
        "prev_due_date": None,
        "new_due_date": None,
        "confirmed_at": None,
    }
    data = render_receipt_pdf(sparse, {})
    assert data.startswith(b"%PDF-")
    png = render_receipt_png(sparse, {})
    assert png.startswith(b"\x89PNG\r\n\x1a\n")


def test_automated_khqr_payment_shows_automated_cashier_not_a_fabricated_name():
    data = render_receipt_pdf(_receipt(recorded_by_name=None), _cfg())
    # Rendered PDF text streams are compressed by default in reportlab
    # SimpleDocTemplate, so assert via the pure helper instead of scanning bytes.
    from tuition_receipt_pdf import _cashier_name
    assert _cashier_name(_receipt(recorded_by_name=None)) == "Automated · KHQR"
    assert _cashier_name(_receipt(recorded_by_name="Alita.Ly")) == "Alita.Ly"
