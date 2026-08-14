"""
tests/test_speaking_lab_enrollment_audit.py

Unit tests for the durable enrollment audit module in isolation. The
ROUTE-level wiring (that every direct-join terminal path writes an audit
row) is proven in test_speaking_lab_direct_join.py where the full
fake-Mongo transaction harness already lives.

Contract under test:
  * a row is appended with the expected fields;
  * the Lucky Code itself is NEVER stored (only a boolean);
  * a write failure ALWAYS fails open — it never raises, so an audit
    problem can never affect an enrollment outcome.
"""
from __future__ import annotations

import pathlib
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import speaking_lab_enrollment_audit as audit  # noqa: E402


class _FakeCollection:
    def __init__(self):
        self.docs = []

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def create_index(self, *a, **k):
        return "idx"


class _FakeDB:
    def __init__(self):
        self._cols = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection())


class _ExplodingDB:
    def __getitem__(self, name):
        raise RuntimeError("mongo is down")


@pytest.mark.asyncio
async def test_records_a_success_row_without_the_lucky_code():
    db = _FakeDB()

    await audit.record_enrollment_attempt(
        db, session_id="s1", student_id="stu1", outcome="committed",
        reason_code="committed", http_status=200, idempotency_key="uuid-1",
        idempotent_replay=False, lucky_code_assigned=True, join_id="djn_x",
    )

    rows = db[audit.COLLECTION_ENROLLMENT_AUDIT].docs
    assert len(rows) == 1
    row = rows[0]
    assert row["session_id"] == "s1"
    assert row["student_id"] == "stu1"
    assert row["outcome"] == "committed"
    assert row["http_status"] == 200
    assert row["idempotent_replay"] is False
    assert row["lucky_code_assigned"] is True
    assert row["join_id"] == "djn_x"
    assert row["audit_id"].startswith("sla_")
    assert "ts" in row
    # The ticket itself must never be duplicated into the audit trail.
    assert "lucky_code" not in row
    assert "code" not in row


@pytest.mark.asyncio
async def test_records_a_failure_row_with_reason_and_no_ticket():
    db = _FakeDB()

    await audit.record_enrollment_attempt(
        db, session_id="s1", student_id="stu1", outcome="insufficient_points",
        reason_code="insufficient_points", http_status=402,
        lucky_code_assigned=False,
    )

    row = db[audit.COLLECTION_ENROLLMENT_AUDIT].docs[0]
    assert row["outcome"] == "insufficient_points"
    assert row["reason_code"] == "insufficient_points"
    assert row["http_status"] == 402
    assert row["lucky_code_assigned"] is False


@pytest.mark.asyncio
async def test_write_failure_fails_open_never_raises():
    # A broken database must not turn an audit write into an exception
    # that could bubble up and abort/alter an enrollment.
    await audit.record_enrollment_attempt(
        _ExplodingDB(), session_id="s1", student_id="stu1",
        outcome="committed", reason_code="committed", http_status=200,
        lucky_code_assigned=True,
    )
    # Reaching here without raising IS the assertion.


@pytest.mark.asyncio
async def test_ensure_indexes_never_raises_on_a_broken_db():
    result = await audit.ensure_enrollment_audit_indexes(_ExplodingDB())
    assert result is False
