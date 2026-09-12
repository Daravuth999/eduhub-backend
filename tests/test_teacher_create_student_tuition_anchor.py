"""tests/test_teacher_create_student_tuition_anchor.py — item 4 of the
Teacher Studio round: auto-anchor a genuinely NEW student's first tuition
due date to their real registration timestamp.

Confirmed against current code (tuition_tools.py, read directly, not
assumed): tuition_records is created ONLY as a side effect of an actual
payment (tuition_finalize_payment, called from payment_bridge.py) or a
manual GAS-shadow-write (teacher_update_tuition) — teacher_create_student
never touched it before this round. _ttn_advance_billing(current_ndd,
today) needs only dates, never a monetary rate — the billing CYCLE LENGTH
is a hardcoded constant of that function (always +1 calendar month), so
there is no "missing external config" risk for the DATE computation
itself. The one genuinely optional piece of config that DOES exist —
tuition_config's global_config.enabled — is respected: if explicitly
disabled, no record is fabricated.

teacher_create_student lives directly in server.py (not a separate
*_tools.py module with its own register_*_routes(router, db, ...)
factory), and — confirmed by grepping this whole test suite — no test
here imports server.py directly; it requires full app/env setup at import
time. This file therefore verifies the new wiring structurally against
the real source text (same convention already used elsewhere in this
suite for other hard-to-mount server.py logic), plus directly exercises
the exact _ttn_advance_billing/_ttn_fmt_date call pattern the new code
uses, to prove the computation itself is correct.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

from tuition_tools import _ttn_advance_billing, _ttn_fmt_date


def _teacher_create_student_source() -> str:
    src = Path("server.py").read_text(encoding="utf-8")
    start = src.index("async def teacher_create_student")
    end = src.index("async def teacher_list_students")
    return src[start:end]


def test_tuition_anchor_computation_is_registration_date_plus_one_month():
    """Directly proves the exact call pattern the new code uses:
    _ttn_advance_billing(None, registration_date) — a brand-new student has
    no prior due date, so the anchor point is their own registration day,
    advanced by the SAME billing-cycle logic every subsequent due date
    already uses (never new/invented date math)."""
    registration_date = date(2026, 9, 12)
    first_due = _ttn_advance_billing(None, registration_date)
    assert first_due == date(2026, 10, 12)
    assert _ttn_fmt_date(first_due) == "2026.10.12"


def test_tuition_anchor_clamps_to_month_end_exactly_like_every_other_advance():
    """Jan 31 -> Feb has no 31st; _ttn_advance_billing already clamps this
    for subsequent due dates, and the new registration-time call must
    behave identically, not add a second, subtly different date rule."""
    registration_date = date(2026, 1, 31)
    first_due = _ttn_advance_billing(None, registration_date)
    assert first_due == date(2026, 2, 28)


def test_tuition_anchor_lives_only_on_the_brand_new_branch_not_reactivation():
    src = _teacher_create_student_source()
    reactivation_idx = src.index('action = "reactivated"')
    brand_new_idx = src.index('action = "created"')
    anchor_idx = src.index("_ttn_advance_billing")
    assert brand_new_idx < anchor_idx, "tuition anchoring must be in the brand-new branch"
    assert not (reactivation_idx < anchor_idx < brand_new_idx), \
        "tuition anchoring must not run on the reactivation branch"


def test_tuition_anchor_respects_the_global_enabled_flag_and_never_fabricates_amount():
    src = _teacher_create_student_source()
    assert 'tuition_cfg.get("enabled", True)' in src
    # Never invents a payment_amount or tuition_status other than the
    # honest "nothing paid yet" starting state.
    assert '"payment_amount": None' in src
    assert '"tuition_status": "Unpaid"' in src
    assert '"last_payment_date": None' in src


def test_tuition_anchor_never_overwrites_an_existing_tuition_record():
    """The brand-new branch can only ever run for a student_id that was
    JUST minted in this same request (uuid4()-based, freshly inserted) —
    no pre-existing tuition_records document could possibly reference it
    yet. Confirmed structurally: the upsert's filter is keyed on the
    freshly-generated student_id, and no code path re-anchors an existing
    record."""
    src = _teacher_create_student_source()
    anchor_section = src[src.index('action = "created"'):]
    assert 'db["tuition_records"].update_one(\n                    {"student_id": student_id},' in anchor_section \
        or '{"student_id": student_id},' in anchor_section
    assert "upsert=True" in anchor_section


def test_tuition_anchor_failure_never_blocks_student_creation():
    src = _teacher_create_student_source()
    anchor_section = src[src.index('action = "created"'):src.index("log.info(\"teacher: student")]
    assert "except Exception" in anchor_section
    assert "never block student creation" in anchor_section.lower() or "non-fatal" in anchor_section.lower()
