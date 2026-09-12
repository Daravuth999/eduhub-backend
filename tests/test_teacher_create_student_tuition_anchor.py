"""tests/test_teacher_create_student_tuition_anchor.py — item 4 of the
Teacher Studio round: auto-anchor a genuinely NEW student's first tuition
due date to their real registration timestamp.

Confirmed against current code (tuition_tools.py, read directly, not
assumed): tuition_records was created ONLY as a side effect of an actual
payment (tuition_finalize_payment, called from payment_bridge.py) or a
manual GAS-shadow-write (teacher_update_tuition) — teacher_create_student
never touched it before this round. _ttn_advance_billing(current_ndd,
today) needs only dates, never a monetary rate — the billing CYCLE LENGTH
is a hardcoded constant of that function (always +1 calendar month), so
there is no "missing external config" risk for the DATE computation
itself. The one genuinely optional piece of config that DOES exist —
tuition_config's global_config.enabled — is respected: if explicitly
disabled, no record is fabricated.

tuition_tools.ensure_new_student_tuition_anchor(db, ...) is where the
real work lives — a standalone, module-level, directly-testable function
(deliberately NOT inlined into server.py's teacher_create_student, so
that tuition_records/tuition_config stay touched only by their declared
owner, tuition_tools.py — see tools/check_collection_ownership.py's
--strict gate, which failed CI on an earlier version of this change that
read/wrote those collections straight from server.py). This file tests
that function directly against a fake db. teacher_create_student's own
wiring (call it only on the brand-new branch, never reactivation) is
verified structurally against the real server.py source, the same
convention this suite already uses for other hard-to-mount server.py
logic — but the actual anchoring BEHAVIOR is proven with real assertions
against real inputs, not string matching.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from tuition_tools import _ttn_advance_billing, _ttn_fmt_date, ensure_new_student_tuition_anchor


def _teacher_create_student_source() -> str:
    src = Path("server.py").read_text(encoding="utf-8")
    start = src.index("async def teacher_create_student")
    end = src.index("async def teacher_list_students")
    return src[start:end]


# ── pure date-math sanity (the exact call pattern the accessor uses) ──────
def test_tuition_anchor_computation_is_registration_date_plus_one_month():
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


# ── ensure_new_student_tuition_anchor — the real, now-directly-testable
#    accessor function, exercised against a fake db ───────────────────────
def _match(doc, query):
    return all(doc.get(k) == v for k, v in query.items())


class _Coll:
    def __init__(self):
        self.docs: dict = {}

    async def find_one(self, query, projection=None):
        for d in self.docs.values():
            if _match(d, query):
                out = dict(d)
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None

    async def update_one(self, query, update, upsert=False):
        for key, d in self.docs.items():
            if _match(d, query):
                if "$set" in update:
                    d.update(update["$set"])
                return
        if upsert:
            doc = dict(query)
            if "$set" in update:
                doc.update(update["$set"])
            self.docs[doc.get("student_id", f"auto{len(self.docs)}")] = doc


class _FakeDB:
    def __init__(self):
        self._c: dict = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())


@pytest.mark.asyncio
async def test_ensure_new_student_tuition_anchor_creates_an_honest_unpaid_record():
    db = _FakeDB()
    result = await ensure_new_student_tuition_anchor(
        db, student_id="stu_new1", clean_id="stu100", registration_date=date(2026, 9, 12),
    )
    assert result == {"created": True, "next_due_date": "2026.10.12"}

    doc = db["tuition_records"].docs["stu_new1"]
    assert doc["student_id"] == "stu_new1"
    assert doc["clean_id"] == "stu100"
    assert doc["next_due_date"] == "2026.10.12"
    # Never fabricated — the honest "nothing has happened yet" starting state.
    assert doc["tuition_status"] == "Unpaid"
    assert doc["last_payment_date"] is None
    assert doc["payment_amount"] is None
    assert doc["updated_by"] == "registration"


@pytest.mark.asyncio
async def test_ensure_new_student_tuition_anchor_respects_the_disabled_flag():
    db = _FakeDB()
    db["tuition_config"].docs["global_config"] = {"type": "global_config", "enabled": False}
    result = await ensure_new_student_tuition_anchor(
        db, student_id="stu_new2", clean_id="stu101", registration_date=date(2026, 9, 12),
    )
    assert result == {"created": False, "reason": "tuition tracking is disabled in global config"}
    assert "stu_new2" not in db["tuition_records"].docs


@pytest.mark.asyncio
async def test_ensure_new_student_tuition_anchor_defaults_to_enabled_when_no_config_doc_exists():
    """A deployment that has never touched tuition_config at all must not
    be silently treated as disabled — the documented default is enabled."""
    db = _FakeDB()
    result = await ensure_new_student_tuition_anchor(
        db, student_id="stu_new3", clean_id="stu102", registration_date=date(2026, 9, 12),
    )
    assert result["created"] is True


@pytest.mark.asyncio
async def test_ensure_new_student_tuition_anchor_is_idempotent_via_upsert():
    """Calling it twice for the same student_id (should never happen in
    practice, since it only ever runs once per freshly-minted id) must not
    create two documents."""
    db = _FakeDB()
    await ensure_new_student_tuition_anchor(
        db, student_id="stu_new4", clean_id="stu103", registration_date=date(2026, 9, 12),
    )
    await ensure_new_student_tuition_anchor(
        db, student_id="stu_new4", clean_id="stu103", registration_date=date(2026, 9, 12),
    )
    assert len(db["tuition_records"].docs) == 1


# ── server.py wiring — structural, since it is not directly importable ───
def test_server_calls_the_owner_accessor_not_the_raw_collections():
    """Confirms the fix for the collection-ownership CI failure: server.py
    must never reach into tuition_records/tuition_config directly — only
    tuition_tools.py (the declared owner) may do that. server.py calls the
    owner-exposed accessor instead."""
    src = _teacher_create_student_source()
    assert "ensure_new_student_tuition_anchor" in src
    assert 'db["tuition_records"]' not in src
    assert 'db["tuition_config"]' not in src
    assert "db.tuition_records" not in src
    assert "db.tuition_config" not in src


def test_tuition_anchor_lives_only_on_the_brand_new_branch_not_reactivation():
    src = _teacher_create_student_source()
    reactivation_idx = src.index('action = "reactivated"')
    brand_new_idx = src.index('action = "created"')
    anchor_idx = src.index("ensure_new_student_tuition_anchor")
    assert brand_new_idx < anchor_idx, "tuition anchoring must be in the brand-new branch"
    assert not (reactivation_idx < anchor_idx < brand_new_idx), \
        "tuition anchoring must not run on the reactivation branch"


def test_tuition_anchor_failure_never_blocks_student_creation():
    src = _teacher_create_student_source()
    anchor_section = src[src.index('action = "created"'):src.index("log.info(\"teacher: student")]
    assert "except Exception" in anchor_section
    assert "never block student creation" in anchor_section.lower() or "non-fatal" in anchor_section.lower()
