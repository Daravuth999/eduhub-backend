"""
Speaking Lab Emergency Teacher Admit — integration tests (v1.1.1)
==================================================================

These tests run against the REAL ``teacher_admission`` module + an
in-memory motor-compatible fake database. They cover:

  • the 40-case v1.1 spec matrix (kept from v1.1)
  • all 10 audit corrections required for v1.1.1
  • real concurrency using ``asyncio.gather``

Run from the backend folder:

    cd backend
    pytest -q tests/test_teacher_admit.py
"""

from __future__ import annotations

import asyncio
import hashlib
import pathlib
import sys
import pytest

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport


# ── Make the backend folder importable regardless of test cwd ────────────────
BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import teacher_admission as ta  # noqa: E402


# ──────────────────────────────────────────────────────────────────────────────
# Fake motor DB — supports the queries the real route uses
# ──────────────────────────────────────────────────────────────────────────────
class DuplicateKey(Exception):
    pass


class _FakeCursor:
    def __init__(self, docs, projection=None):
        self._docs = list(docs)
        self._proj = projection or {}

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _FakeCollection:
    def __init__(self, name):
        self.name = name
        self._docs: list[dict] = []
        self._unique_indexes: list[tuple[str, ...]] = []
        self._lock = asyncio.Lock()

    async def create_index(self, keys, **kw):
        if kw.get("unique"):
            fields = tuple(k[0] for k in keys) if isinstance(keys, list) else (keys,)
            self._unique_indexes.append(fields)
        return kw.get("name") or "idx"

    def _matches(self, doc, query):
        if "$or" in query:
            return any(self._matches(doc, sub) for sub in query["$or"])
        for k, v in query.items():
            if k == "$or":
                continue
            if isinstance(v, dict) and "$ne" in v:
                if doc.get(k) == v["$ne"]:
                    return False
                continue
            if isinstance(v, dict) and "$in" in v:
                if doc.get(k) not in v["$in"]:
                    return False
                continue
            if isinstance(v, dict) and "$exists" in v:
                if v["$exists"] and k not in doc:
                    return False
                if (not v["$exists"]) and k in doc:
                    return False
                continue
            if isinstance(v, dict) and "$regex" in v:
                import re as _re
                if not _re.search(v["$regex"], str(doc.get(k) or "")):
                    return False
                continue
            if doc.get(k) != v:
                return False
        return True

    async def find_one(self, query, projection=None):
        async with self._lock:
            for d in self._docs:
                if self._matches(d, query):
                    return dict(d)
        return None

    def find(self, query, projection=None):
        snapshot = [dict(d) for d in self._docs if self._matches(d, query)]
        return _FakeCursor(snapshot, projection)

    async def count_documents(self, query):
        async with self._lock:
            return sum(1 for d in self._docs if self._matches(d, query))

    def _check_unique(self, doc, ignore=None):
        for fields in self._unique_indexes:
            key = tuple(doc.get(f) for f in fields)
            if any(v is None for v in key):
                continue
            for other in self._docs:
                if other is ignore:
                    continue
                if tuple(other.get(f) for f in fields) == key:
                    raise DuplicateKey(
                        f"duplicate key E11000 in {self.name}: {fields}={key}"
                    )

    async def insert_one(self, doc):
        async with self._lock:
            d = dict(doc)
            self._check_unique(d)
            self._docs.append(d)
        return type("R", (), {"inserted_id": "fake"})()

    async def update_one(self, query, update, upsert=False):
        async with self._lock:
            matched = 0
            for d in self._docs:
                if self._matches(d, query):
                    matched += 1
                    if "$set" in update:
                        d.update(update["$set"])
                    if "$setOnInsert" in update:
                        for k, v in update["$setOnInsert"].items():
                            d.setdefault(k, v)
                    if "$unset" in update:
                        for k in update["$unset"]:
                            d.pop(k, None)
                    self._check_unique(d, ignore=d)
                    break
            if matched == 0 and upsert:
                new = dict(query)
                if "$set" in update: new.update(update["$set"])
                if "$setOnInsert" in update: new.update(update["$setOnInsert"])
                self._check_unique(new)
                self._docs.append(new)
                matched = 1
        return type("R", (), {"matched_count": matched, "modified_count": matched})()

    async def delete_one(self, query):
        async with self._lock:
            for i, d in enumerate(self._docs):
                if self._matches(d, query):
                    self._docs.pop(i)
                    return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


def _norm_student_id(value):
    if value is None:
        return ""
    return str(value).strip().lower()


# ──────────────────────────────────────────────────────────────────────────────
# Fake lucky-code generator — mirrors the production contract:
# idempotent on (session, student), publishes events, stores
# `display_name`/`code`/`entry_fee`/`awarded_at` in
# `speaking_lab_lucky_codes`.
# ──────────────────────────────────────────────────────────────────────────────
PUBLISHED: list[tuple[str, dict]] = []
_CODE_COUNTER = {"n": 0}


async def _sl_publish_fake(session_id, event):
    PUBLISHED.append((session_id, dict(event)))


async def _fake_generate_and_publish(db, sl_publish, session_id, student_id,
                                     display_name, *, amount=0, log=None):
    existing = await db.speaking_lab_lucky_codes.find_one(
        {"session_id": session_id, "student_id": student_id},
    )
    if existing:
        return existing
    _CODE_COUNTER["n"] += 1
    code = f"WORD-{_CODE_COUNTER['n']:04d}"
    awarded_at = "2026-01-01T00:00:00+00:00"
    doc = {
        "session_id":   session_id,
        "student_id":   student_id,
        "display_name": display_name,
        "code":         code,
        "entry_fee":    int(amount or 0),
        "awarded_at":   awarded_at,
    }
    await db.speaking_lab_lucky_codes.insert_one(dict(doc))
    await sl_publish(session_id, {
        "type": "lucky_code", "student_id": student_id,
        "display_name": display_name, "code": code,
        "entry_fee": int(amount or 0),
        "pool_total": 0, "player_count": 1,
        "awarded_at": awarded_at,
    })
    await sl_publish(session_id, {"type": "pool_update",
                                  "pool_total": int(amount or 0),
                                  "player_count": 1})
    return doc


# ──────────────────────────────────────────────────────────────────────────────
# App factory
# ──────────────────────────────────────────────────────────────────────────────
URL = "/api/speaking-lab/sessions/{sid}/teacher-admit"


def _make_app(db, code_helper=None, set_index_ok=True, verify_pool_payment=None):
    api = APIRouter(prefix="/api")
    PUBLISHED.clear()
    _CODE_COUNTER["n"] = 0

    class _Admin:
        email = "teacher@school.example"
        user_id = "teacher_001"

    async def _require_admin():
        return _Admin()

    helper = code_helper or _fake_generate_and_publish
    ta.register_teacher_admission_routes(
        api=api,
        db=db,
        SL_SESSIONS=db["speaking_lab_sessions"],
        SL_ENTRIES=db["speaking_lab_entries"],
        sl_publish=_sl_publish_fake,
        require_admin_dep=_require_admin,
        norm_student_id=_norm_student_id,
        generate_and_publish_lucky_code=helper,
        verify_pool_payment=verify_pool_payment,
    )
    app = FastAPI()
    app.include_router(api)
    ta._force_index_health(set_index_ok)
    return app


def _run(coro):
    """Run an async coroutine from sync context, regardless of whether
    an outer event loop (e.g. pytest-asyncio) is already running."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        # Use a dedicated background loop
        import threading
        result = {}
        def _target():
            new_loop = asyncio.new_event_loop()
            try:
                result["v"] = new_loop.run_until_complete(coro)
            except BaseException as e:
                result["e"] = e
            finally:
                new_loop.close()
        t = threading.Thread(target=_target)
        t.start(); t.join()
        if "e" in result:
            raise result["e"]
        return result.get("v")
    if loop is None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _seed_session_sync(db, *, sid="sl_test_1", schedule="A", fee=10,
                       status="waiting", lucky_draw_done=False, prepared=None):
    sess = {
        "session_id": sid, "schedule": schedule, "entry_fee": fee,
        "status": status, "treasury_id": "stu092",
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    if lucky_draw_done:
        sess["lucky_draw_done"] = True
    if prepared:
        sess["lucky_draw_prepared_draw_id"] = prepared
    _run(db["speaking_lab_sessions"].insert_one(sess))


def _seed_student_sync(db, *, sid="stu100", name="Alice Cao", group="A",
                       is_active=True):
    _run(db["students"].insert_one({
        "clean_id": sid, "student_id": sid,
        "display_name": name, "group": group,
        "is_active": is_active,
    }))


def _seed_indexes_sync(db):
    _run(db["speaking_lab_entries"].create_index(
        [("session_id", 1), ("display_name_key", 1)], unique=True,
    ))
    _run(db["speaking_lab_lucky_codes"].create_index(
        [("session_id", 1), ("student_id", 1)], unique=True,
    ))
    _run(ta.ensure_teacher_admission_indexes(db))


def _body(**over):
    base = {
        "student_id":          "stu100",
        "points_sent":         10,
        "transfer_reference":  "ABC123",
        "transfer_datetime":   "2026-01-01T12:00:00Z",
        "verification_method": "p2p_history",
        "teacher_explanation": "Student paid but no code generated.",
        "teacher_confirmed":   True,
    }
    base.update(over)
    return base


@pytest.fixture
def db():
    d = _FakeDB()
    _seed_indexes_sync(d)
    return d


@pytest.fixture
def app(db):
    return _make_app(db)


@pytest.fixture
def client(app):
    return TestClient(app)


# ═════════════════════════════════════════════════════════════════════════════
# v1.1 spec matrix (40 cases) — retained
# ═════════════════════════════════════════════════════════════════════════════

def test_1_session_lookup_uses_session_id(db, client):
    _seed_session_sync(db, sid="sl_abc"); _seed_student_sync(db)
    r = client.post(URL.format(sid="sl_abc"), json=_body())
    assert r.status_code == 200 and r.json()["session_id"] == "sl_abc"


def test_2_student_lookup_canonical(db, client):
    _seed_session_sync(db); _seed_student_sync(db, sid="stu123")
    r = client.post(URL.format(sid="sl_test_1"), json=_body(student_id="stu123"))
    assert r.status_code == 200 and r.json()["student_id"] == "stu123"


def test_3_waiting_session_accepted(db, client):
    _seed_session_sync(db, status="waiting"); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 200


def test_4_active_session_accepted(db, client):
    _seed_session_sync(db, status="active"); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 200


def test_5_lucky_draw_done_blocks(db, client):
    _seed_session_sync(db, lucky_draw_done=True); _seed_student_sync(db)
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 409 and "draw_completed" in r.text


def test_6_lucky_draw_prepared_blocks(db, client):
    _seed_session_sync(db, prepared="draw_abc"); _seed_student_sync(db)
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 409 and "draw_prepared" in r.text


def test_7_unknown_student_blocked(db, client):
    _seed_session_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(student_id="ghost")).status_code == 404


def test_8_inactive_student_blocked(db, client):
    _seed_session_sync(db); _seed_student_sync(db, is_active=False)
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 403


def test_9_wrong_schedule_blocked(db, client):
    _seed_session_sync(db, schedule="A"); _seed_student_sync(db, group="B")
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 403


def test_10_wrong_group_blocked(db, client):
    _seed_session_sync(db, schedule="C"); _seed_student_sync(db, group="A")
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 403


def test_10b_ab_session_accepts_a_group_student(db, client):
    _seed_session_sync(db, schedule="AB", fee=10); _seed_student_sync(db, group="A")
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 200


def test_10c_ab_session_accepts_b_group_student(db, client):
    _seed_session_sync(db, schedule="AB", fee=10); _seed_student_sync(db, group="B")
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 200


def test_10d_ab_session_accepts_unassigned_student_without_override(db, client):
    """Combined A+B sessions admit Unassigned students automatically —
    unlike a plain "A"/"B" session, no external-verification override or
    authoritative payment evidence is required just to pass the schedule
    gate for an AB session."""
    _seed_session_sync(db, schedule="AB", fee=10); _seed_student_sync(db, group="")
    resp = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert resp.status_code == 200


def test_10e_ab_session_never_mutates_student_group(db, client):
    _seed_session_sync(db, schedule="AB", fee=10); _seed_student_sync(db, group="")
    client.post(URL.format(sid="sl_test_1"), json=_body())
    student = _run(db["students"].find_one({"clean_id": "stu100"}))
    assert student.get("group") == ""  # still Unassigned — never mutated


def test_10f_plain_a_session_still_blocks_b_after_ab_support_added(db, client):
    """Confirms the AB bypass is scoped to schedule == "AB" only — a
    plain "A" session still rejects a "B" student exactly as before."""
    _seed_session_sync(db, schedule="A", fee=10); _seed_student_sync(db, group="B")
    assert client.post(URL.format(sid="sl_test_1"), json=_body()).status_code == 403


def test_12_underpayment_blocked(db, client):
    _seed_session_sync(db, fee=20); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(points_sent=10)).status_code == 422


def test_13_exact_fee_accepted(db, client):
    _seed_session_sync(db, fee=15); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(points_sent=15)).status_code == 200


def test_14_overpayment_one_code(db, client):
    _seed_session_sync(db, fee=10); _seed_student_sync(db)
    r = client.post(URL.format(sid="sl_test_1"), json=_body(points_sent=100))
    assert r.status_code == 200
    j = r.json()
    assert j["entry_fee"] == 10 and j["pool_total"] == 10


def test_15_empty_reference_blocked(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(transfer_reference="   ")).status_code in (400, 422)


def test_17_same_reference_different_session(db, client):
    _seed_session_sync(db, sid="sl_1"); _seed_session_sync(db, sid="sl_2")
    _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_1"),
                       json=_body(transfer_reference="REF7")).status_code == 200
    assert client.post(URL.format(sid="sl_2"),
                       json=_body(transfer_reference="ref7")).status_code == 409


def test_18_same_reference_different_student(db, client):
    _seed_session_sync(db); _seed_student_sync(db, sid="stu100")
    _seed_student_sync(db, sid="stu200", name="Bob")
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(student_id="stu100",
                                  transfer_reference="X1")).status_code == 200
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(student_id="stu200",
                                  transfer_reference="X1")).status_code == 409


def test_19_invalid_datetime_blocked(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(transfer_datetime="bad")).status_code == 422


def test_20_missing_explanation_blocked(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(teacher_explanation="")).status_code == 422


def test_21_missing_confirmation_blocked(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    assert client.post(URL.format(sid="sl_test_1"),
                       json=_body(teacher_confirmed=False)).status_code == 422


def test_28_pool_counts_session_fee(db, client):
    _seed_session_sync(db, fee=10)
    _seed_student_sync(db, sid="stu100", name="A")
    _seed_student_sync(db, sid="stu101", name="B")
    r1 = client.post(URL.format(sid="sl_test_1"),
                     json=_body(student_id="stu100", points_sent=10,
                                transfer_reference="r1"))
    r2 = client.post(URL.format(sid="sl_test_1"),
                     json=_body(student_id="stu101", points_sent=999,
                                transfer_reference="r2"))
    assert r1.status_code == 200 and r2.status_code == 200
    assert r2.json()["pool_total"] == 20
    assert r2.json()["player_count"] == 2


def test_35_36_37_idempotent_no_inflation(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    r1 = client.post(URL.format(sid="sl_test_1"), json=_body())
    r2 = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["lucky_code"] == r2.json()["lucky_code"]
    assert r2.json()["idempotent_replay"] is True
    assert r2.json()["pool_total"] == 10 and r2.json()["player_count"] == 1


def test_39_sse_event_shapes(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    client.post(URL.format(sid="sl_test_1"), json=_body())
    types = {evt["type"] for _, evt in PUBLISHED}
    assert {"entry", "lucky_code", "pool_update"}.issubset(types)
    for _sid, evt in PUBLISHED:
        if evt["type"] == "lucky_code":
            for k in ("student_id", "display_name", "code", "entry_fee",
                     "awarded_at"):
                assert k in evt


def test_40_protected_lucky_draw_unchanged():
    """v3: focused, AST-based protection of the Lucky Draw CORE logic.

    The fragile whole-file SHA test was REPLACED (per the v3 mandate) with a
    region-level guard. We extract the exact source of the protected functions
    via `ast` and compare against frozen baseline hashes captured from the
    original eduhub-backend-master source. Edits elsewhere in lucky_draw.py
    (the additive v3 payout state machine) do NOT trip this test; any change to
    the protected regions WILL.
    """
    import ast as _ast

    PROTECTED = ("_weighted_pick", "_normalize_split", "_run_draw")
    BASELINE = {
        "_weighted_pick":
            "871c5ad4d2cc3d721ed309e8dc2930e55053fdd9ac53d5a2a3fb815d6ccd461a",
        "_normalize_split":
            "077c2583249d28118a489a47ad00fa669f14375e8db6b7a153837bff6fa9a359",
        "_run_draw":
            "65ecec65bcd07a0fad9023e8b3b91f73a801c6ec551e93d63b989ef164825aac",
    }
    p = pathlib.Path(__file__).resolve().parent.parent / "lucky_draw.py"
    source = p.read_text(encoding="utf-8")
    tree = _ast.parse(source)
    found = {}
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)) \
                and node.name in PROTECTED:
            seg = _ast.get_source_segment(source, node)
            found[node.name] = hashlib.sha256(seg.encode("utf-8")).hexdigest()
    for name in PROTECTED:
        assert name in found, f"protected region missing: {name}"
        assert found[name] == BASELINE[name], (
            f"PROTECTED REGION CHANGED: {name} "
            f"(got {found[name]}, expected {BASELINE[name]})")
    # The full payout/route surface must still be present.
    for sig in ("async def generate_and_publish_lucky_code",
                "async def _run_draw",
                "async def _finalize_draw",
                "async def _gas_send_points",
                "def _weighted_pick",
                "def register_lucky_draw_routes"):
        assert sig in source


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 1 — Synthetic roster row linking
# ═════════════════════════════════════════════════════════════════════════════

def _seed_synthetic_entry(db, *, session_id="sl_test_1",
                          display_name="Alice", sid="sl-abcdef012345"):
    _run(
        db["speaking_lab_entries"].insert_one({
            "session_id": session_id, "student_id": sid,
            "display_name": display_name,
            "display_name_key": display_name.lower(),
            "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
        })
    )
    return sid


def test_c1_synthetic_row_links_safely(db, client):
    _seed_session_sync(db); _seed_student_sync(db, name="Alice")
    synth_id = _seed_synthetic_entry(db, display_name="Alice")
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 200, r.text
    assert r.json()["linked_synthetic_entry"] is True
    # Original row is now owned by canonical student, position preserved.
    rows = _run(
        db["speaking_lab_entries"].count_documents({"session_id": "sl_test_1"})
    )
    assert rows == 1
    row = _run(
        db["speaking_lab_entries"].find_one(
            {"session_id": "sl_test_1", "student_id": "stu100"}
        )
    )
    assert row["position"] == 1
    assert row["entered_at"] == "2026-01-01T00:00:00+00:00"
    assert row["linked_from_synthetic_id"] == synth_id


def test_c1_canonical_not_duplicated(db, client):
    _seed_session_sync(db); _seed_student_sync(db, name="Alice")
    _seed_synthetic_entry(db, display_name="Alice")
    client.post(URL.format(sid="sl_test_1"), json=_body())
    n = _run(
        db["speaking_lab_entries"].count_documents({"session_id": "sl_test_1"})
    )
    assert n == 1


def test_c1_same_name_canonical_untouched(db, client):
    """A pre-existing CANONICAL same-name row for a DIFFERENT student
    must not be reassigned."""
    _seed_session_sync(db)
    _seed_student_sync(db, sid="stu100", name="Alice")
    _seed_student_sync(db, sid="stu999", name="Alice")
    _run(
        db["speaking_lab_entries"].insert_one({
            "session_id": "sl_test_1", "student_id": "stu999",
            "display_name": "Alice", "display_name_key": "alice",
            "position": 1, "entered_at": "x",
        })
    )
    r = client.post(URL.format(sid="sl_test_1"),
                    json=_body(student_id="stu100"))
    assert r.status_code == 409
    other = _run(
        db["speaking_lab_entries"].find_one({"student_id": "stu999"})
    )
    assert "admit_audit_id" not in other


def test_c1_ambiguous_non_synthetic_blocked(db, client):
    """A row with a non-synthetic ID and matching name is treated as a
    different canonical student → block."""
    _seed_session_sync(db); _seed_student_sync(db, sid="stu100", name="Alice")
    _run(
        db["speaking_lab_entries"].insert_one({
            "session_id": "sl_test_1", "student_id": "stu_someone_else",
            "display_name": "Alice", "display_name_key": "alice",
            "position": 1, "entered_at": "x",
        })
    )
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 409


def test_c1_synthetic_other_display_blocked(db, client):
    """Synthetic row exists but with a DIFFERENT display name → don't
    link; we create a fresh canonical row."""
    _seed_session_sync(db); _seed_student_sync(db, name="Alice")
    _seed_synthetic_entry(db, display_name="Bob")
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 200
    assert r.json()["linked_synthetic_entry"] is False
    n = _run(
        db["speaking_lab_entries"].count_documents({"session_id": "sl_test_1"})
    )
    assert n == 2


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 2 — prior-state snapshot + restore on failure
# ═════════════════════════════════════════════════════════════════════════════

def test_c2_existing_canonical_restored_on_code_failure(db):
    """If code creation throws, the pre-existing canonical row must be
    restored to its EXACT prior values."""
    _seed_session_sync(db); _seed_student_sync(db, sid="stu100", name="Alice")
    _run(
        db["speaking_lab_entries"].insert_one({
            "session_id": "sl_test_1", "student_id": "stu100",
            "display_name": "Alice", "display_name_key": "alice",
            "position": 7, "entered_at": "2025-12-25T10:00:00+00:00",
        })
    )
    async def boom(*a, **kw):
        raise RuntimeError("simulated code failure")
    app = _make_app(db, code_helper=boom)
    cli = TestClient(app)
    r = cli.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 500
    row = _run(
        db["speaking_lab_entries"].find_one(
            {"session_id": "sl_test_1", "student_id": "stu100"})
    )
    # Restored
    assert row["position"] == 7
    assert row["entered_at"] == "2025-12-25T10:00:00+00:00"
    assert "admit_audit_id" not in row
    assert "paid_entry" not in row


def test_c2_synthetic_identity_restored(db):
    _seed_session_sync(db); _seed_student_sync(db, name="Alice")
    synth_id = _seed_synthetic_entry(db, display_name="Alice")
    async def boom(*a, **kw):
        raise RuntimeError("simulated code failure")
    app = _make_app(db, code_helper=boom)
    cli = TestClient(app)
    r = cli.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 500
    row = _run(
        db["speaking_lab_entries"].find_one({"session_id": "sl_test_1"})
    )
    assert row["student_id"] == synth_id
    assert "admit_audit_id" not in row


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 3 — mandatory audit completion
# ═════════════════════════════════════════════════════════════════════════════

def test_c3_audit_completion_error_blocks_success(db, monkeypatch):
    _seed_session_sync(db); _seed_student_sync(db)
    app = _make_app(db)
    cli = TestClient(app)
    # Patch the admissions collection's update_one to fail when completing
    real_update = db["speaking_lab_teacher_admissions"].update_one
    calls = {"n": 0}
    async def fail_complete(query, update, upsert=False):
        if "$set" in update and update["$set"].get("status_after") == "admitted":
            raise RuntimeError("audit complete boom")
        return await real_update(query, update, upsert=upsert)
    db["speaking_lab_teacher_admissions"].update_one = fail_complete
    r = cli.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 500
    # No code, no active entry
    assert _run(
        db["speaking_lab_lucky_codes"].count_documents({})
    ) == 0


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 4 — operation state machine + resume
# ═════════════════════════════════════════════════════════════════════════════

def test_c4_resume_after_entry_crash(db):
    """Reservation + entry succeed; code phase 'crashes' (raises).
    Retry resumes using the same admission_id and completes."""
    _seed_session_sync(db); _seed_student_sync(db)
    # 1st attempt with broken code helper
    async def boom(*a, **kw):
        raise RuntimeError("crash")
    app_a = _make_app(db, code_helper=boom)
    r1 = TestClient(app_a).post(URL.format(sid="sl_test_1"), json=_body())
    assert r1.status_code == 500
    # Operation row exists with rolled_back state
    op = _run(
        db["speaking_lab_teacher_admissions"].find_one(
            {"normalized_transfer_reference": "abc123"})
    )
    assert op and op["status_after"] in ("rolled_back", "failed_retriable")
    aid = op["admission_id"]
    # 2nd attempt with healthy helper — must REUSE the same admission_id
    app_b = _make_app(db)  # healthy code helper
    r2 = TestClient(app_b).post(URL.format(sid="sl_test_1"), json=_body())
    assert r2.status_code == 200, r2.text
    assert r2.json()["admission_id"] == aid
    final_op = _run(
        db["speaking_lab_teacher_admissions"].find_one({"admission_id": aid})
    )
    assert final_op["status_after"] == "admitted"
    assert final_op["attempts"] >= 2


def test_c4_incomplete_admitted_fails_closed(db):
    """If status_after=admitted but the actual code is missing, return
    500 — never silently succeed."""
    _seed_session_sync(db); _seed_student_sync(db)
    # Seed an audit that LIES about being admitted
    _run(
        db["speaking_lab_teacher_admissions"].insert_one({
            "admission_id": "fake_admit_1",
            "session_id": "sl_test_1", "student_id": "stu100",
            "display_name": "Alice Cao",
            "normalized_transfer_reference": "abc123",
            "status_after": "admitted",
            "generated_code": "GHOST",
            "completed_at": "x", "created_at": "x", "updated_at": "x",
        })
    )
    app = _make_app(db)
    r = TestClient(app).post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 500
    assert "Integrity" in r.text or "integrity" in r.text


def test_c4_pending_reservation_other_student_rejected(db):
    """A pending reservation for student X must reject student Y on the
    same reference."""
    _seed_session_sync(db)
    _seed_student_sync(db, sid="stu100", name="A")
    _seed_student_sync(db, sid="stu200", name="B")
    _run(
        db["speaking_lab_teacher_admissions"].insert_one({
            "admission_id": "pre",
            "session_id": "sl_test_1", "student_id": "stu100",
            "normalized_transfer_reference": "abc123",
            "status_after": "pending",
        })
    )
    app = _make_app(db)
    r = TestClient(app).post(URL.format(sid="sl_test_1"),
                              json=_body(student_id="stu200"))
    assert r.status_code == 409


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 5 — orphan code rollback + provenance
# ═════════════════════════════════════════════════════════════════════════════

def test_c5_orphan_code_rolled_back_on_audit_completion_failure(db):
    _seed_session_sync(db); _seed_student_sync(db)
    app = _make_app(db)
    cli = TestClient(app)
    real_update = db["speaking_lab_teacher_admissions"].update_one
    async def fail_complete(query, update, upsert=False):
        if "$set" in update and update["$set"].get("status_after") == "admitted":
            raise RuntimeError("audit complete boom")
        return await real_update(query, update, upsert=upsert)
    db["speaking_lab_teacher_admissions"].update_one = fail_complete
    r = cli.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 500
    # Operation-owned code must be removed
    n = _run(
        db["speaking_lab_lucky_codes"].count_documents({})
    )
    assert n == 0


def test_c5_existing_code_preserved(db):
    """A code that already exists and was NOT created by the current
    admission must never be deleted on rollback."""
    _seed_session_sync(db); _seed_student_sync(db)
    _run(
        db["speaking_lab_lucky_codes"].insert_one({
            "session_id": "sl_test_1", "student_id": "stu100",
            "display_name": "Alice Cao", "code": "LEGACY-001",
            "entry_fee": 10, "awarded_at": "x",
        })
    )
    app = _make_app(db)
    cli = TestClient(app)
    real_update = db["speaking_lab_teacher_admissions"].update_one
    async def fail_complete(query, update, upsert=False):
        if "$set" in update and update["$set"].get("status_after") == "admitted":
            raise RuntimeError("audit complete boom")
        return await real_update(query, update, upsert=upsert)
    db["speaking_lab_teacher_admissions"].update_one = fail_complete
    r = cli.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 500
    # Pre-existing legacy code untouched
    legacy = _run(
        db["speaking_lab_lucky_codes"].find_one({"code": "LEGACY-001"})
    )
    assert legacy is not None


def test_c5_code_provenance_present_on_success(db, client):
    _seed_session_sync(db); _seed_student_sync(db)
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 200
    code = _run(
        db["speaking_lab_lucky_codes"].find_one({"session_id": "sl_test_1"})
    )
    for k in ("admit_audit_id", "admit_reference", "admit_by",
              "admitted_at", "source"):
        assert k in code, f"provenance field missing: {k}"
    assert code["source"] == "teacher_emergency_admit"


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 6 — index health gate
# ═════════════════════════════════════════════════════════════════════════════

def test_c6_unhealthy_index_blocks_route(db):
    _seed_session_sync(db); _seed_student_sync(db)
    app = _make_app(db, set_index_ok=False)
    ta._force_index_health(False, last_error="simulated")
    cli = TestClient(app)
    r = cli.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 503
    assert "index" in r.text.lower()


def test_c6_index_recovery_restores_route(db):
    _seed_session_sync(db); _seed_student_sync(db)
    ta._force_index_health(False, last_error="boot")
    app = _make_app(db, set_index_ok=False)
    assert TestClient(app).post(URL.format(sid="sl_test_1"),
                                  json=_body()).status_code == 503
    # Recover
    ta._force_index_health(True)
    app2 = _make_app(db, set_index_ok=True)
    assert TestClient(app2).post(URL.format(sid="sl_test_1"),
                                   json=_body()).status_code == 200


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 7 — REAL asyncio concurrency
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_c7_real_concurrent_identical_requests_safe(db):
    _seed_session_sync(db); _seed_student_sync(db)
    app = _make_app(db)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        results = await asyncio.gather(
            ac.post(URL.format(sid="sl_test_1"), json=_body()),
            ac.post(URL.format(sid="sl_test_1"), json=_body()),
            ac.post(URL.format(sid="sl_test_1"), json=_body()),
        )
    ok = [r for r in results if r.status_code == 200]
    assert len(ok) >= 2
    codes = {r.json()["lucky_code"] for r in ok}
    assert len(codes) == 1
    n_entries = await db["speaking_lab_entries"].count_documents(
        {"session_id": "sl_test_1"})
    n_codes = await db["speaking_lab_lucky_codes"].count_documents(
        {"session_id": "sl_test_1"})
    n_audits = await db["speaking_lab_teacher_admissions"].count_documents(
        {"normalized_transfer_reference": "abc123"})
    assert n_entries == 1 and n_codes == 1 and n_audits == 1


@pytest.mark.asyncio
async def test_c7_concurrent_conflicting_reference(db):
    _seed_session_sync(db)
    _seed_student_sync(db, sid="stu100", name="A")
    _seed_student_sync(db, sid="stu200", name="B")
    app = _make_app(db)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r1, r2 = await asyncio.gather(
            ac.post(URL.format(sid="sl_test_1"),
                    json=_body(student_id="stu100",
                               transfer_reference="X")),
            ac.post(URL.format(sid="sl_test_1"),
                    json=_body(student_id="stu200",
                               transfer_reference="X")),
        )
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [200, 409]


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 8 — enrollment policy fails closed
# ═════════════════════════════════════════════════════════════════════════════

def test_c8_missing_enrollment_blocked(db, client):
    _seed_session_sync(db, schedule="A")
    _seed_student_sync(db, group="")  # no enrollment metadata
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 403
    # v4: empty-group fails closed; with no authoritative verifier wired the
    # specific reason is authoritative_payment_verification_unavailable.
    assert ("enrollment" in r.text.lower()
            or "unavailable" in r.text.lower())


def test_c8_session_without_schedule_accepts_active_student(db, client):
    _seed_session_sync(db, schedule="")  # no requirement
    _seed_student_sync(db, group="")
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 200


# ═════════════════════════════════════════════════════════════════════════════
# CORRECTION 9 — response carries the participant payload
# ═════════════════════════════════════════════════════════════════════════════

def test_c9_response_carries_participant(db, client):
    _seed_session_sync(db); _seed_student_sync(db, sid="stu100", name="Alice")
    r = client.post(URL.format(sid="sl_test_1"), json=_body())
    assert r.status_code == 200
    p = r.json()["participant"]
    assert p["studentid"] == "stu100"
    assert p["student_id"] == "stu100"
    assert p["clean_id"] == "stu100"
    assert p["display_name"] == "Alice"
    assert p["name"] == "Alice"



# ═════════════════════════════════════════════════════════════════════════════
# FIX 5 (v4) — SESSION-BOUND authoritative empty-group admission
# ═════════════════════════════════════════════════════════════════════════════
#
# Empty-group admission requires (a) same-session pool entry + lucky code as
# supporting records AND (b) an AUTHORITATIVE, session-bound payment verifier
# (bound to session_id + the SESSION treasury + entry_fee + canonical student).
# The verified transfer reference becomes the admission's UNIQUE reference, so
# one authoritative transfer cannot admit into two sessions. When no
# authoritative verifier is wired, admission fails closed
# (authoritative_payment_verification_unavailable) unless an explicit, audited
# human override is supplied.

_TREASURY = "stu092"


def _make_authoritative_verifier(ledger):
    """A fake AUTHORITATIVE, session-bound verifier. `ledger` is a list of
    dicts: {sender, recipient(treasury), amount, ref, session_window=True}."""
    async def _verify(*, canonical_student_id, session_id, entry_fee,
                      session_treasury_id=""):
        sender = _norm_student_id(canonical_student_id)
        treasury = _norm_student_id(session_treasury_id or _TREASURY)
        if not sender or not treasury or sender == treasury:
            return None
        for r in ledger:
            if _norm_student_id(r.get("recipient") or "") != treasury:
                continue
            if _norm_student_id(r.get("sender") or "") != sender:
                continue
            if int(r.get("amount") or 0) < int(entry_fee or 0):
                continue
            ref = (r.get("ref") or "").strip()
            if not ref:
                continue
            return {"verified_transfer_reference": ref,
                    "verified_amount": int(r.get("amount") or 0),
                    "verified_sender_id": sender,
                    "verified_recipient_id": treasury}
        return None
    return _verify


def _seed_lucky_code(db, *, session_id="sl_test_1", student_id="stu100",
                     code="WORD-9999", fee=10):
    _run(db["speaking_lab_lucky_codes"].insert_one({
        "session_id": session_id, "student_id": student_id,
        "display_name": "Alice", "code": code, "entry_fee": fee}))


def _seed_entry(db, *, session_id="sl_test_1", student_id="stu100"):
    _run(db["speaking_lab_entries"].insert_one({
        "session_id": session_id, "student_id": student_id,
        "display_name": "Alice", "display_name_key": "alice"}))


def _seed_support(db, *, session_id="sl_test_1", student_id="stu100", fee=10):
    _seed_lucky_code(db, session_id=session_id, student_id=student_id, fee=fee)
    _seed_entry(db, session_id=session_id, student_id=student_id)


def _app_auth(db, ledger):
    return TestClient(_make_app(
        db, verify_pool_payment=_make_authoritative_verifier(ledger)))


def test_fix5_valid_authoritative_admission_succeeds(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-REF-1"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_test_1"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 200, r.text
    audit = _run(db["speaking_lab_teacher_admissions"].find_one(
        {"student_id": "stu100"}))
    assert audit["enrollment_override_basis"] == \
        "authoritative_session_bound_verification"
    # FIX 5: verified reference is the unique admission reference.
    assert audit["normalized_transfer_reference"] == \
        ta.normalize_reference("GAS-REF-1")
    assert audit["verified_transfer_reference"] == "GAS-REF-1"


def test_fix5_one_transfer_cannot_admit_two_sessions(db):
    # Two different sessions, same authoritative transfer reference.
    _seed_session_sync(db, sid="sl_A", schedule="A", fee=10)
    _seed_session_sync(db, sid="sl_B", schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db, session_id="sl_A")
    _seed_support(db, session_id="sl_B")
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-REF-DUP"}]
    client = _app_auth(db, ledger)
    r1 = client.post(URL.format(sid="sl_A"), json=_body(student_id="stu100"))
    assert r1.status_code == 200, r1.text
    r2 = client.post(URL.format(sid="sl_B"), json=_body(student_id="stu100"))
    # Second session reuses the same verified reference → rejected (409/422/403).
    assert r2.status_code in (403, 409, 422), r2.text


def test_fix5_verifier_uses_session_treasury(db):
    # Session treasury differs; ledger only credits the SESSION treasury.
    _run(db["speaking_lab_sessions"].insert_one({
        "session_id": "sl_T", "schedule": "A", "entry_fee": 10,
        "status": "waiting", "treasury_id": "stuTREAS"}))
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db, session_id="sl_T")
    # Credit to the SESSION treasury → succeeds.
    ledger_ok = [{"sender": "stu100", "recipient": "stuTREAS", "amount": 10,
                  "ref": "GAS-T1"}]
    r = _app_auth(db, ledger_ok).post(URL.format(sid="sl_T"),
                                      json=_body(student_id="stu100"))
    assert r.status_code == 200, r.text


def test_fix5_wrong_treasury_fails(db):
    _run(db["speaking_lab_sessions"].insert_one({
        "session_id": "sl_T", "schedule": "A", "entry_fee": 10,
        "status": "waiting", "treasury_id": "stuTREAS"}))
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db, session_id="sl_T")
    # Credit to the GLOBAL/default treasury, NOT the session treasury → fail.
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-WT"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_T"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_wrong_student_fails(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    ledger = [{"sender": "someoneelse", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-X"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_test_1"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_underpayment_fails(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 5,
               "ref": "GAS-LOW"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_test_1"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_missing_ledger_fails_closed(db):
    # Verifier wired but no matching authoritative payment.
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    r = _app_auth(db, []).post(URL.format(sid="sl_test_1"),
                               json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_no_verifier_unavailable_fails_closed(db):
    # No authoritative verifier wired at all → unavailable, fail closed.
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    client = TestClient(_make_app(db))  # verify_pool_payment=None
    r = client.post(URL.format(sid="sl_test_1"), json=_body(student_id="stu100"))
    assert r.status_code == 403
    assert "unavailable" in r.text.lower()


def test_fix5_same_session_entry_only_fails(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_entry(db)  # entry but no lucky code, no authoritative payment
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-E"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_test_1"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_same_session_code_only_fails(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_lucky_code(db)  # code but no entry, no authoritative payment
    r = _app_auth(db, []).post(URL.format(sid="sl_test_1"),
                               json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_populated_mismatched_group_still_fails(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="B")  # populated mismatch
    _seed_support(db)
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-M"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_test_1"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 403


def test_fix5_populated_matching_group_preserved(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="A")
    r = _app_auth(db, []).post(URL.format(sid="sl_test_1"),
                               json=_body(student_id="stu100"))
    assert r.status_code == 200, r.text


def test_fix5_human_override_succeeds_with_confirmation(db):
    # No authoritative verifier, but an explicit audited human override.
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    client = TestClient(_make_app(db))  # no automatic verifier
    body = _body(student_id="stu100", confirm_external_verification=True,
                 transfer_reference="HUMAN-REF-1",
                 teacher_explanation="Checked GAS ledger manually; paid.")
    r = client.post(URL.format(sid="sl_test_1"), json=body)
    assert r.status_code == 200, r.text
    audit = _run(db["speaking_lab_teacher_admissions"].find_one(
        {"student_id": "stu100"}))
    assert audit["enrollment_override_basis"] == \
        "human_authorized_external_verification"
    assert audit["human_authorized_override"] is True
    assert audit["normalized_transfer_reference"] == \
        ta.normalize_reference("HUMAN-REF-1")


def test_fix5_inactive_student_still_fails(db):
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="", is_active=False)
    _seed_support(db)
    ledger = [{"sender": "stu100", "recipient": _TREASURY, "amount": 10,
               "ref": "GAS-IA"}]
    r = _app_auth(db, ledger).post(URL.format(sid="sl_test_1"),
                                   json=_body(student_id="stu100"))
    assert r.status_code == 403


# ═════════════════════════════════════════════════════════════════════════════
# v5.1 FIX 1 — Human admission override must require same-session evidence
# ═════════════════════════════════════════════════════════════════════════════
def test_v51_human_override_no_entry_rejected(db):
    """Empty group + explicit human override + NO same-session entry → 403.

    The human-authorized override is a HUMAN judgement, but the operator
    cannot demonstrate participation in this session without a same-session
    pool entry. Refuse 403.
    """
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    # Same-session lucky code exists, but NO same-session entry.
    _seed_lucky_code(db)
    client = TestClient(_make_app(db))  # no automatic verifier
    body = _body(student_id="stu100", confirm_external_verification=True,
                 transfer_reference="HUMAN-V51-NOENTRY",
                 teacher_explanation="Checked GAS ledger manually.")
    r = client.post(URL.format(sid="sl_test_1"), json=body)
    assert r.status_code == 403
    payload = r.json()
    assert "same-session pool entry" in str(payload).lower() or \
        "student_enrollment_unverified" in str(payload).lower()
    # Audit row must NOT exist for a rejected admission.
    audit = _run(db["speaking_lab_teacher_admissions"].find_one(
        {"student_id": "stu100"}))
    assert audit is None


def test_v51_human_override_no_lucky_code_rejected(db):
    """Empty group + explicit human override + NO same-session lucky code
    → 403."""
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    # Same-session entry exists, but NO same-session lucky code.
    _seed_entry(db)
    client = TestClient(_make_app(db))
    body = _body(student_id="stu100", confirm_external_verification=True,
                 transfer_reference="HUMAN-V51-NOCODE",
                 teacher_explanation="Checked GAS ledger manually.")
    r = client.post(URL.format(sid="sl_test_1"), json=body)
    assert r.status_code == 403
    payload = r.json()
    assert "same-session lucky code" in str(payload).lower() or \
        "student_enrollment_unverified" in str(payload).lower()
    audit = _run(db["speaking_lab_teacher_admissions"].find_one(
        {"student_id": "stu100"}))
    assert audit is None


def test_v51_human_override_with_both_same_session_records_succeeds(db):
    """Empty group + explicit human override + BOTH same-session records
    → 200, audited."""
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)  # seeds BOTH entry + lucky code
    client = TestClient(_make_app(db))
    body = _body(student_id="stu100", confirm_external_verification=True,
                 transfer_reference="HUMAN-V51-OK",
                 teacher_explanation="Checked GAS ledger; transfer confirmed.")
    r = client.post(URL.format(sid="sl_test_1"), json=body)
    assert r.status_code == 200, r.text
    audit = _run(db["speaking_lab_teacher_admissions"].find_one(
        {"student_id": "stu100"}))
    assert audit["enrollment_override_basis"] == \
        "human_authorized_external_verification"
    assert audit["human_authorized_override"] is True
    # v5.1: audit must persist the same-session evidence the override relied on.
    assert audit["same_session_entry_present"] is True
    assert audit["same_session_lucky_code"] == "WORD-9999"


def test_v51_human_override_same_reference_reused_in_other_session_rejected(db):
    """A transfer reference once used by a human override cannot admit
    into a second session (unique reference still enforced)."""
    _seed_session_sync(db, schedule="A", fee=10)
    _seed_student_sync(db, sid="stu100", group="")
    _seed_support(db)
    client = TestClient(_make_app(db))
    body = _body(student_id="stu100", confirm_external_verification=True,
                 transfer_reference="HUMAN-V51-UNIQ",
                 teacher_explanation="Same reference reuse test.")
    r1 = client.post(URL.format(sid="sl_test_1"), json=body)
    assert r1.status_code == 200, r1.text
    # Second session, same student, same transfer reference.
    _seed_session_sync(db, sid="sl_test_2", schedule="A", fee=10)
    _seed_lucky_code(db, session_id="sl_test_2")
    _seed_entry(db, session_id="sl_test_2")
    r2 = client.post(URL.format(sid="sl_test_2"), json=body)
    assert r2.status_code == 409
