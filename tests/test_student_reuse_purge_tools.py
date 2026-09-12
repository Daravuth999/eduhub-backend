"""tests/test_student_reuse_purge_tools.py — item 3 of the Teacher Studio
round: reused student IDs must not inherit a prior occupant's history.

Confirmed bug this fixes (verified against current server.py, not assumed):
teacher_deactivate_student only sets is_active=False/status="archived" and
clears active sessions; teacher_create_student's reactivation branch reuses
the SAME internal student_id the previous occupant had and updates only
display_name/group/password_hash/is_active/status/role/enrolled_at/
last_login on the existing document. Every other collection in this
codebase scoped to that student_id or clean_id was (and, without this
purge, still is by default) left completely untouched.

This file tests student_reuse_purge_tools.purge_student_slot_for_reuse
directly against a self-contained fake Mongo layer (delete_many/update_many/
update_one/find/find_one, matching the fake-Mongo convention already
established elsewhere in this test suite) — real, not mocked-away, Mongo
operation semantics for $or/$in/$set/$rename/$pull. server.py's own
teacher_create_student is NOT importable/testable in isolation (confirmed:
no test in this suite imports server.py directly — it is a large module
requiring full app/env setup at import time, unlike every *_tools.py
module's own register_*_routes(router, db, ...) factory pattern). The
purge function itself — the actual data-safety-critical logic — is fully
isolated and testable, and is tested exhaustively here; server.py's own
~15-line wiring (only call this when an admin explicitly sets
purge_previous_history=True, only on the reactivation branch, never on
ordinary deactivation) is verified structurally against the real source
text, the same convention this codebase already uses for other hard-to-
mount server.py wiring (see e.g. this repo's own startup-hook structural
tests).
"""
from __future__ import annotations

from pathlib import Path

import pytest

import student_reuse_purge_tools as purge


# ── fake Mongo layer ─────────────────────────────────────────────────────
def _match(doc, query):
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if isinstance(v, dict) and "$in" in v:
            actual = doc.get(k)
            # Real MongoDB semantics: {field: {"$in": [...]}} against an
            # ARRAY field matches if ANY element is in the target list —
            # needed for push_history/push_scheduled's studentIds arrays.
            if isinstance(actual, list):
                if not any(x in v["$in"] for x in actual):
                    return False
            elif actual not in v["$in"]:
                return False
            continue
        if doc.get(k) != v:
            return False
    return True


class _Result:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Coll:
    def __init__(self):
        self.docs: dict = {}
        self._auto = 0

    async def insert_one(self, doc):
        key = doc.get("_id") or f"auto{self._auto}"
        self._auto += 1
        doc.setdefault("_id", key)
        self.docs[key] = dict(doc)

    async def find_one(self, query, projection=None):
        for d in self.docs.values():
            if _match(d, query):
                out = dict(d)
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None

    def find(self, query, projection=None):
        matched = [dict(d) for d in self.docs.values() if _match(d, query)]
        return _Cursor(matched)

    async def delete_many(self, query):
        to_delete = [k for k, d in self.docs.items() if _match(d, query)]
        for k in to_delete:
            del self.docs[k]
        return _Result(deleted_count=len(to_delete))

    async def update_one(self, query, update):
        for d in self.docs.values():
            if _match(d, query):
                self._apply(d, update)
                return _Result(matched_count=1)
        return _Result(matched_count=0)

    async def update_many(self, query, update):
        count = 0
        for d in self.docs.values():
            if _match(d, query):
                before = dict(d)
                self._apply(d, update)
                if d != before:
                    count += 1
        return _Result(modified_count=count)

    @staticmethod
    def _apply(d, update):
        if "$set" in update:
            d.update(update["$set"])
        if "$rename" in update:
            for old, new in update["$rename"].items():
                if old in d:
                    d[new] = d.pop(old)
        if "$pull" in update:
            for field, cond in update["$pull"].items():
                if field not in d or not isinstance(d[field], list):
                    continue
                if isinstance(cond, dict) and any(isinstance(v, dict) for v in cond.values()):
                    d[field] = [item for item in d[field] if not _match(item, cond)]
                elif isinstance(cond, dict) and "$in" in cond:
                    ids = set(cond["$in"])
                    d[field] = [x for x in d[field] if x not in ids]


class _FakeDB:
    def __init__(self):
        self._colls: dict = {}
        self.students = _Coll()

    def __getitem__(self, name):
        return self._colls.setdefault(name, _Coll())


# ── DELETE collections ───────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_delete_collections_are_wiped_for_the_reused_ids_only():
    db = _FakeDB()
    db["video_purchases"].docs["p1"] = {"_id": "p1", "studentId": "stu_old", "lessonId": "vid_1"}
    db["video_purchases"].docs["p2"] = {"_id": "p2", "studentId": "stu_untouched", "lessonId": "vid_1"}
    db["attendance_records"].docs["a1"] = {"_id": "a1", "student_id": "clean_old", "date": "2026-01-01"}

    result = await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )

    assert result["ok"] is True
    assert "p1" not in db["video_purchases"].docs
    assert "p2" in db["video_purchases"].docs  # a genuinely different student, untouched
    assert "a1" not in db["attendance_records"].docs
    assert result["deleted"]["video_purchases"] == 1
    assert result["deleted"]["attendance_records"] == 1


@pytest.mark.asyncio
async def test_delete_matches_by_either_student_id_or_clean_id():
    """This codebase is confirmed inconsistent about which id a given
    collection stores under a field literally named 'student_id' — some
    modules store the true internal id, others resolve to clean_id first.
    The purge must catch both without needing to know which one a given
    module actually used."""
    db = _FakeDB()
    db["edutalk_sessions"].docs["e1"] = {"_id": "e1", "clean_id": "clean_old"}
    db["student_sessions"].docs["s1"] = {"_id": "s1", "student_id": "stu_old"}

    result = await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )
    assert "e1" not in db["edutalk_sessions"].docs
    assert "s1" not in db["student_sessions"].docs


# ── ARCHIVE collections (financial/audit — never deleted) ───────────────
@pytest.mark.asyncio
async def test_archived_collections_are_preserved_but_rekeyed_off_the_live_id():
    db = _FakeDB()
    db["points_wallets"].docs["w1"] = {"_id": "w1", "student_id": "stu_old", "balance": 480}
    db["tuition_records"].docs["t1"] = {"_id": "t1", "student_id": "stu_old", "next_due_date": "2026.10.01"}

    result = await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )

    # preserved — never deleted
    assert "w1" in db["points_wallets"].docs
    assert "t1" in db["tuition_records"].docs
    wallet = db["points_wallets"].docs["w1"]
    tuition = db["tuition_records"].docs["t1"]
    # the live field is gone (a query scoped to the reused student_id must
    # never find this document again)...
    assert "student_id" not in wallet
    assert "student_id" not in tuition
    # ...but the real value survives, fully inspectable, under an archived key
    assert wallet["archived_student_id"] == "stu_old"
    assert wallet["balance"] == 480  # the actual data is untouched
    assert tuition["archived_student_id"] == "stu_old"
    assert tuition["next_due_date"] == "2026.10.01"
    # archive metadata stamped
    assert wallet["archivedReason"] == "clean_id_reused_for_new_student"
    assert wallet["archivedByAdmin"] == "admin@example.com"
    assert wallet["archivedStudentId"] == "stu_old"
    assert wallet["archivedCleanId"] == "clean_old"
    assert result["archived"]["points_wallets"] == 1
    assert result["archived"]["tuition_records"] == 1


@pytest.mark.asyncio
async def test_archive_renames_whichever_of_multiple_candidate_fields_are_actually_present():
    """points_transactions can hold the reused id in EITHER from_id or
    to_id (a student can be a sender in one row and a recipient in
    another) — both must be independently renamed wherever present."""
    db = _FakeDB()
    db["points_transactions"].docs["tx1"] = {"_id": "tx1", "from_id": "treasury", "to_id": "stu_old", "delta": 10}
    db["points_transactions"].docs["tx2"] = {"_id": "tx2", "from_id": "stu_old", "to_id": "treasury", "delta": -5}

    await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )
    tx1 = db["points_transactions"].docs["tx1"]
    tx2 = db["points_transactions"].docs["tx2"]
    assert tx1["archived_to_id"] == "stu_old" and tx1["from_id"] == "treasury"  # from_id untouched, still live
    assert tx2["archived_from_id"] == "stu_old" and tx2["to_id"] == "treasury"


# ── embedded-array pulls in SHARED documents ─────────────────────────────
@pytest.mark.asyncio
async def test_coupon_redemption_pull_touches_only_this_students_entry():
    db = _FakeDB()
    db["coupons"].docs["c1"] = {
        "_id": "c1", "code": "WELCOME10",
        "redemptions": [
            {"student_id": "stu_old", "redeemed_at": "2026-01-01"},
            {"student_id": "stu_other", "redeemed_at": "2026-01-02"},
        ],
    }
    await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )
    coupon = db["coupons"].docs["c1"]
    assert coupon["redemptions"] == [{"student_id": "stu_other", "redeemed_at": "2026-01-02"}]
    # the shared coupon document itself is never deleted
    assert "c1" in db["coupons"].docs


@pytest.mark.asyncio
async def test_push_history_scalar_array_pull_touches_only_this_students_id():
    db = _FakeDB()
    db["push_history"].docs["ph1"] = {"_id": "ph1", "title": "New lesson!", "studentIds": ["stu_old", "stu_other"]}
    await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )
    assert db["push_history"].docs["ph1"]["studentIds"] == ["stu_other"]


# ── student document itself (avatar + created_at) ────────────────────────
@pytest.mark.asyncio
async def test_avatar_and_created_at_are_reset_on_the_student_document(monkeypatch):
    db = _FakeDB()
    db.students.docs["stu_old"] = {
        "_id": "stu_old", "student_id": "stu_old", "clean_id": "clean_old",
        "avatar_url": "https://r2.example/avatars/old.png", "avatar_r2_key": "avatars/old.png",
        "created_at": "2025-01-01T00:00:00Z",
    }
    deleted_keys = []

    async def fake_delete_from_r2(key):
        deleted_keys.append(key)

    monkeypatch.setattr("hero_artwork_tools._delete_from_r2", fake_delete_from_r2, raising=False)
    import hero_artwork_tools  # noqa: F401 — ensure the module exists to patch onto

    await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )
    doc = db.students.docs["stu_old"]
    assert doc["avatar_url"] == ""
    assert doc["avatar_r2_key"] == ""
    assert doc["created_at"] != "2025-01-01T00:00:00Z"
    assert deleted_keys == ["avatars/old.png"]


@pytest.mark.asyncio
async def test_no_avatar_means_no_r2_delete_attempt():
    db = _FakeDB()
    db.students.docs["stu_old"] = {"_id": "stu_old", "student_id": "stu_old", "clean_id": "clean_old"}
    # Must not raise even though avatar_r2_key is absent entirely.
    result = await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
    )
    assert result["ok"] is True


# ── audit trail ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_purge_writes_its_own_audit_record():
    db = _FakeDB()
    db["video_purchases"].docs["p1"] = {"_id": "p1", "studentId": "stu_old"}
    result = await purge.purge_student_slot_for_reuse(
        db, student_id="stu_old", clean_id="clean_old", admin_email="admin@example.com",
        reason="clean_id_reused_for_new_student",
    )
    audit_docs = list(db[purge.PURGE_AUDIT_COLL].docs.values())
    assert len(audit_docs) == 1
    audit = audit_docs[0]
    assert audit["student_id"] == "stu_old"
    assert audit["clean_id"] == "clean_old"
    assert audit["performed_by"] == "admin@example.com"
    assert audit["reason"] == "clean_id_reused_for_new_student"
    assert audit["deleted"]["video_purchases"] == 1
    assert audit["purge_id"] == result["purge_id"]


# ── boundary: nothing is fabricated, a clean slot is a real no-op ────────
@pytest.mark.asyncio
async def test_a_student_with_no_data_anywhere_produces_a_clean_empty_purge():
    db = _FakeDB()
    db.students.docs["stu_new"] = {"_id": "stu_new", "student_id": "stu_new", "clean_id": "clean_new"}
    result = await purge.purge_student_slot_for_reuse(
        db, student_id="stu_new", clean_id="clean_new", admin_email="admin@example.com",
    )
    assert result["ok"] is True
    assert result["deleted"] == {}
    assert result["archived"] == {}


@pytest.mark.asyncio
async def test_missing_both_ids_is_a_safe_no_op_never_a_wildcard_wipe():
    """A defensive guard: this function must never be callable in a way
    that could match every document in a collection."""
    db = _FakeDB()
    db["video_purchases"].docs["p1"] = {"_id": "p1", "studentId": "someone_else"}
    result = await purge.purge_student_slot_for_reuse(
        db, student_id="", clean_id="", admin_email="admin@example.com",
    )
    assert result["ok"] is False
    assert "p1" in db["video_purchases"].docs


# ── structural verification of server.py's wiring (not directly testable
#    in isolation — see this file's own module docstring for why) ────────
def test_server_only_purges_on_the_reactivation_branch_behind_an_explicit_opt_in_flag():
    src = Path("server.py").read_text(encoding="utf-8")
    create_start = src.index("async def teacher_create_student")
    deactivate_start = src.index("async def teacher_deactivate_student")
    create_src = src[create_start:deactivate_start]

    assert 'purge_previous_history = bool(payload.get("purge_previous_history") or False)' in create_src
    assert "from student_reuse_purge_tools import purge_student_slot_for_reuse" in create_src

    # The purge call must be gated behind the opt-in flag, and must live
    # inside the reactivation ("existing") branch, never the brand-new
    # branch (action = "created" is provably never a reuse of anyone's data).
    purge_call_idx = create_src.index("purge_student_slot_for_reuse(")
    reactivation_branch_idx = create_src.index('action = "reactivated"')
    brand_new_branch_idx = create_src.index('action = "created"')
    guard_idx = create_src.index("if purge_previous_history:")
    assert guard_idx < purge_call_idx
    assert reactivation_branch_idx < purge_call_idx < brand_new_branch_idx


def test_ordinary_deactivation_never_references_the_purge_module():
    """The single most important boundary in this whole feature: merely
    deactivating a student (which may be temporary/reversible for the SAME
    student) must NEVER trigger a purge — only an explicit, separate opt-in
    at reactivation time for a genuinely different occupant can."""
    src = Path("server.py").read_text(encoding="utf-8")
    deactivate_start = src.index("async def teacher_deactivate_student")
    # bounded to a generous window past the function's own body
    deactivate_src = src[deactivate_start:deactivate_start + 2000]
    assert "purge_student_slot_for_reuse" not in deactivate_src
    assert "student_reuse_purge_tools" not in deactivate_src


def test_purge_previous_history_defaults_to_false_never_silently_true():
    src = Path("server.py").read_text(encoding="utf-8")
    assert 'payload.get("purge_previous_history") or False' in src
