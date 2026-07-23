"""tests/test_wallet_migration_tools.py
=====================================================
Architecture Reconstruction Phase 2 ("wallet migration"). wallet_service.py
already contains a complete GAS->Mongo wallet migration framework
(import_wallet_one, import_wallet_one_manual, balance_audit_one,
wallet_seed_status, pending_sync_event_counts, register_migration_routes,
register_student_points_routes) — built in an earlier session, wired into
server.py behind USE_MONGO_POINTS_READ / USE_MONGO_POINTS_WRITE (both
default off), but with ZERO test coverage before this file. Every write
path here is dry_run=True by default and requires an explicit non-default
argument to touch storage — these tests exercise the real functions
against an in-memory fake Mongo + a monkeypatched httpx (never a live GAS
call, never a live Mongo connection).
"""
from __future__ import annotations

import copy

import httpx
import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import wallet_service as ws



# ── fake Mongo ──────────────────────────────────────────────────────────────
class _FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def sort(self, *a, **k):
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _FakeWallets:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None, session=None):
        sid = query.get("student_id")
        doc = self.docs.get(sid)
        return dict(doc) if doc is not None else None

    async def update_one(self, query, update, upsert=False, session=None):
        sid = query.get("student_id")
        existing = self.docs.get(sid)
        if "$setOnInsert" in update:
            if existing is None:
                self.docs[sid] = dict(update["$setOnInsert"])
                existing = self.docs[sid]
        if "$set" in update:
            if existing is not None:
                existing.update(update["$set"])
            elif upsert:
                self.docs[sid] = dict(update["$set"])
        if "$inc" in update and existing is not None:
            for k, v in update["$inc"].items():
                existing[k] = existing.get(k, 0) + v
        return _Result(matched_count=1 if sid in self.docs else 0)

    async def insert_one(self, doc, session=None):
        sid = doc.get("student_id")
        self.docs[sid] = dict(doc)
        return _Result(inserted_id=sid)

    async def find_one_and_update(
        self, filt, update, return_document=None, projection=None, session=None,
    ):
        sid = filt.get("student_id")
        existing = self.docs.get(sid)
        if existing is None:
            return None
        if "status" in filt and existing.get("status", ws.STATUS_ACTIVE) != filt["status"]:
            return None
        if "balance" in filt:
            cond = filt["balance"]
            if isinstance(cond, dict) and "$gte" in cond:
                if float(existing.get("balance") or 0) < cond["$gte"]:
                    return None
        if "$inc" in update:
            for k, v in update["$inc"].items():
                existing[k] = existing.get(k, 0) + v
        if "$set" in update:
            existing.update(update["$set"])
        return dict(existing)

    def find(self, query=None, projection=None):
        return _FakeCursor(list(self.docs.values()))

    async def count_documents(self, query=None):
        return len(self.docs)

    async def create_index(self, *a, **k):
        return None

    async def list_indexes(self):
        return _FakeCursor([])


class _FakeTxns:
    def __init__(self):
        self.docs: dict[str, dict] = {}
        self._seq = 0

    async def find_one(self, query, projection=None, session=None):
        key = query.get("idempotency_key")
        if key is not None:
            for d in self.docs.values():
                if d.get("idempotency_key") == key:
                    return dict(d)
            return None
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                return dict(d)
        return None

    async def insert_one(self, doc, session=None):
        self._seq += 1
        _id = self._seq
        stored = dict(doc)
        stored["_id"] = _id
        self.docs[_id] = stored
        return _Result(inserted_id=_id)

    async def delete_one(self, query, session=None):
        _id = query.get("_id")
        existed = _id in self.docs
        self.docs.pop(_id, None)
        return _Result(deleted_count=1 if existed else 0)

    async def update_one(self, query, update, session=None):
        _id = query.get("_id")
        doc = self.docs.get(_id)
        if doc is not None and "$set" in update:
            doc.update(update["$set"])
        return _Result(matched_count=1 if doc is not None else 0)

    def find(self, query=None, projection=None):
        query = query or {}
        rows = [d for d in self.docs.values()
                if all(d.get(k) == v for k, v in query.items() if not isinstance(v, dict))]
        return _FakeCursor(rows)

    async def create_index(self, *a, **k):
        return None


def _student_matches_active_or(doc, query):
    ors = query.get("$or")
    if not ors:
        return True
    for cond in ors:
        if "is_active" in cond:
            want = cond["is_active"]
            if want == {"$exists": False}:
                if "is_active" not in doc:
                    return True
            elif doc.get("is_active") == want:
                return True
    return False


class _FakeStudents:
    def __init__(self, wallets: _FakeWallets):
        self.docs: list[dict] = []
        self._wallets = wallets

    async def find_one(self, query, projection=None):
        ors = query.get("$or") or []
        for d in self.docs:
            for cond in ors:
                sid_ok = "student_id" not in cond or d.get("student_id") == cond["student_id"]
                cid_ok = "clean_id" not in cond or d.get("clean_id") == cond["clean_id"]
                active_ok = True
                if "is_active" in cond:
                    want = cond["is_active"]
                    if want == {"$exists": False}:
                        active_ok = "is_active" not in d
                    else:
                        active_ok = d.get("is_active") == want
                if sid_ok and cid_ok and active_ok and ("student_id" in cond or "clean_id" in cond):
                    return dict(d)
        return None

    async def count_documents(self, query):
        if "legacy_password" in query:
            return sum(1 for d in self.docs if d.get("legacy_password"))
        return sum(1 for d in self.docs if _student_matches_active_or(d, query))

    def find(self, query=None, projection=None):
        query = query or {}
        return _FakeCursor([d for d in self.docs if _student_matches_active_or(d, query)])

    def aggregate(self, pipeline):
        # Special-cased for wallet_seed_status's fixed pipeline shape: active
        # students whose normalized student_id has no matching points_wallets
        # row. Mongo's own $lookup/$match semantics are not this codebase's
        # code to test — only wallet_seed_status's interpretation of the
        # aggregate result is.
        active = [d for d in self.docs if _student_matches_active_or(
            d, {"$or": [{"is_active": True}, {"is_active": {"$exists": False}}]})]
        missing = [d for d in active
                   if (d.get("student_id") or "").lower() not in self._wallets.docs]
        count = len(missing)

        async def _gen():
            if count:
                yield {"n": count}
        return _gen()


class _FakeSyncEvents:
    def __init__(self):
        self.docs: list[dict] = []

    async def count_documents(self, query):
        status = query.get("mongo_status")
        return sum(1 for d in self.docs if d.get("mongo_status") == status)

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self.wallets = _FakeWallets()
        self.txns = _FakeTxns()
        self.students = _FakeStudents(self.wallets)
        self.sync_events = _FakeSyncEvents()
        self.client = None

    def __getitem__(self, name):
        return {
            ws.COLL_WALLETS: self.wallets,
            ws.COLL_TRANSACTIONS: self.txns,
            ws.COLL_SYNC_EVENTS: self.sync_events,
            "students": self.students,
        }[name]

    async def list_collection_names(self):
        return ["students", ws.COLL_WALLETS]


def _seed_wallet(db, student_id, balance):
    db.wallets.docs[student_id] = {
        "student_id": student_id, "clean_id": student_id, "balance": balance,
        "status": ws.STATUS_ACTIVE,
    }


def _seed_student(db, student_id, **overrides):
    doc = {"student_id": student_id, "clean_id": student_id}
    doc.update(overrides)
    db.students.docs.append(doc)
    return doc


# ── fake GAS httpx client ────────────────────────────────────────────────
class _FakeResp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _patch_gas(monkeypatch, *, post_payload=None, post_status=200, raise_exc=None):
    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None):
            if raise_exc is not None:
                raise raise_exc
            return _FakeResp(post_status, post_payload)

        async def get(self, url, params=None):
            if raise_exc is not None:
                raise raise_exc
            return _FakeResp(post_status, post_payload)

    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)


GAS_URL = "https://gas.example/exec"


# ═════════════════════════════════════════════════════════════════════════
# balance_audit_one
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_audit_no_gas_url_is_unsupported():
    db = _FakeDB()
    row = await ws.balance_audit_one(db, student_id="stu1", gas_login_url=None)
    assert row["status"] == "unsupported_without_legacy_password"


@pytest.mark.asyncio
async def test_audit_no_password_is_unsupported():
    db = _FakeDB()
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password=None,
    )
    assert row["status"] == "unsupported_without_legacy_password"


@pytest.mark.asyncio
async def test_audit_matched_when_mongo_equals_gas(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 100)
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 100})
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password="pw",
    )
    assert row["status"] == "matched"
    assert row["gas_balance"] == 100
    assert row["mongo_balance"] == 100


@pytest.mark.asyncio
async def test_audit_mismatched_when_balances_differ(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 50)
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 100})
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password="pw",
    )
    assert row["status"] == "mismatched"


@pytest.mark.asyncio
async def test_audit_mongo_missing_when_no_wallet(monkeypatch):
    db = _FakeDB()
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 100})
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password="pw",
    )
    assert row["status"] == "mongo_missing"
    assert row["gas_balance"] == 100


@pytest.mark.asyncio
async def test_audit_gas_auth_failed_never_treated_as_zero(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 100)
    _patch_gas(monkeypatch, post_payload={"success": False}, post_status=200)
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password="wrong",
    )
    assert row["status"] == "gas_auth_failed"
    assert row["gas_balance"] is None  # never coerced to 0


@pytest.mark.asyncio
async def test_audit_gas_unreachable_on_5xx(monkeypatch):
    db = _FakeDB()
    _patch_gas(monkeypatch, post_payload=None, post_status=502)
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password="pw",
    )
    assert row["status"] == "gas_unreachable"


@pytest.mark.asyncio
async def test_audit_gas_unreachable_on_network_error(monkeypatch):
    db = _FakeDB()
    _patch_gas(monkeypatch, raise_exc=httpx.ConnectError("refused"))
    row = await ws.balance_audit_one(
        db, student_id="stu1", gas_login_url=GAS_URL, legacy_password="pw",
    )
    assert row["status"] == "gas_unreachable"


# ═════════════════════════════════════════════════════════════════════════
# import_wallet_one (GAS-backed)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_import_dry_run_would_import_never_writes(monkeypatch):
    db = _FakeDB()
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 250})
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password="pw", overwrite_existing=False, dry_run=True,
    )
    assert row["status"] == "would_import"
    assert "stu1" not in db.wallets.docs


@pytest.mark.asyncio
async def test_import_real_run_writes_wallet(monkeypatch):
    db = _FakeDB()
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 250})
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password="pw", overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "imported"
    assert db.wallets.docs["stu1"]["balance"] == 250


@pytest.mark.asyncio
async def test_import_matched_existing_no_write(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 250)
    before = copy.deepcopy(db.wallets.docs["stu1"])
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 250})
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password="pw", overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "matched_existing"
    assert db.wallets.docs["stu1"] == before


@pytest.mark.asyncio
async def test_import_mismatched_existing_blocked_without_overwrite(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 50)
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 250})
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password="pw", overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "mismatched_existing"
    assert db.wallets.docs["stu1"]["balance"] == 50  # untouched


@pytest.mark.asyncio
async def test_import_overwrite_existing_repairs_balance(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 50)
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 250})
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password="pw", overwrite_existing=True, dry_run=False,
    )
    assert row["status"] == "imported"
    assert row["overwrite"] is True
    assert db.wallets.docs["stu1"]["balance"] == 250


@pytest.mark.asyncio
async def test_import_unsupported_without_password_never_writes():
    db = _FakeDB()
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password=None, overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "unsupported_without_legacy_password"
    assert "stu1" not in db.wallets.docs


@pytest.mark.asyncio
async def test_import_gas_auth_failed_never_writes(monkeypatch):
    db = _FakeDB()
    _patch_gas(monkeypatch, post_payload={"success": False})
    row = await ws.import_wallet_one(
        db, student_id="stu1", clean_id="stu1", gas_login_url=GAS_URL,
        legacy_password="wrong", overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "gas_auth_failed"
    assert "stu1" not in db.wallets.docs


# ═════════════════════════════════════════════════════════════════════════
# import_wallet_one_manual (Sheet-snapshot path, no GAS call)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_manual_dry_run_never_writes():
    db = _FakeDB()
    _seed_student(db, "stu1")
    row = await ws.import_wallet_one_manual(
        db, student_id="stu1", clean_id="stu1", trusted_balance=300,
        overwrite_existing=False, dry_run=True,
    )
    assert row["status"] == "would_import"
    assert "stu1" not in db.wallets.docs


@pytest.mark.asyncio
async def test_manual_real_run_writes():
    db = _FakeDB()
    _seed_student(db, "stu1")
    row = await ws.import_wallet_one_manual(
        db, student_id="stu1", clean_id="stu1", trusted_balance=300,
        overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "imported"
    assert db.wallets.docs["stu1"]["balance"] == 300
    assert db.wallets.docs["stu1"]["last_imported_from"] == "manual_sheet_snapshot"


@pytest.mark.asyncio
async def test_manual_rejects_negative_balance():
    db = _FakeDB()
    _seed_student(db, "stu1")
    row = await ws.import_wallet_one_manual(
        db, student_id="stu1", clean_id="stu1", trusted_balance=-5,
        overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "invalid"
    assert "stu1" not in db.wallets.docs


@pytest.mark.asyncio
async def test_manual_rejects_non_numeric_balance():
    db = _FakeDB()
    _seed_student(db, "stu1")
    row = await ws.import_wallet_one_manual(
        db, student_id="stu1", clean_id="stu1", trusted_balance="lots",
        overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "invalid"


@pytest.mark.asyncio
async def test_manual_rejects_unknown_or_inactive_student():
    db = _FakeDB()  # no student seeded at all
    row = await ws.import_wallet_one_manual(
        db, student_id="ghost", clean_id="ghost", trusted_balance=100,
        overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "invalid"
    assert "not found" in row["reason"] or "not active" in row["reason"]


@pytest.mark.asyncio
async def test_manual_skips_existing_without_overwrite():
    db = _FakeDB()
    _seed_student(db, "stu1")
    _seed_wallet(db, "stu1", 999)
    row = await ws.import_wallet_one_manual(
        db, student_id="stu1", clean_id="stu1", trusted_balance=300,
        overwrite_existing=False, dry_run=False,
    )
    assert row["status"] == "skipped_existing"
    assert db.wallets.docs["stu1"]["balance"] == 999  # untouched


@pytest.mark.asyncio
async def test_manual_overwrite_existing_updates_balance():
    db = _FakeDB()
    _seed_student(db, "stu1")
    _seed_wallet(db, "stu1", 999)
    row = await ws.import_wallet_one_manual(
        db, student_id="stu1", clean_id="stu1", trusted_balance=300,
        overwrite_existing=True, dry_run=False,
    )
    assert row["status"] == "imported"
    assert db.wallets.docs["stu1"]["balance"] == 300


# ═════════════════════════════════════════════════════════════════════════
# wallet_seed_status / pending_sync_event_counts
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_seed_status_can_enable_shadow_when_fully_seeded():
    db = _FakeDB()
    _seed_student(db, "stu1")
    _seed_student(db, "stu2")
    _seed_wallet(db, "stu1", 10)
    _seed_wallet(db, "stu2", 20)
    status = await ws.wallet_seed_status(db)
    assert status["can_enable_shadow"] is True
    assert status["missing_wallets"] == 0


@pytest.mark.asyncio
async def test_seed_status_blocks_shadow_when_students_missing_wallets():
    db = _FakeDB()
    _seed_student(db, "stu1")
    _seed_student(db, "stu2")
    _seed_wallet(db, "stu1", 10)
    # stu2 has no wallet.
    status = await ws.wallet_seed_status(db)
    assert status["can_enable_shadow"] is False
    assert status["missing_wallets"] == 1


@pytest.mark.asyncio
async def test_pending_sync_event_counts_reports_pending_and_failed():
    db = _FakeDB()
    db.sync_events.docs.append({"mongo_status": "pending"})
    db.sync_events.docs.append({"mongo_status": "pending"})
    db.sync_events.docs.append({"mongo_status": "failed"})
    counts = await ws.pending_sync_event_counts(db)
    assert counts == {"pending": 2, "failed": 1}


# ═════════════════════════════════════════════════════════════════════════
# register_migration_routes — HTTP-level, real APIRouter + TestClient
# ═════════════════════════════════════════════════════════════════════════
async def _admin_dep():
    return {"email": "admin@test"}


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ws.register_migration_routes(api, db, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def test_migration_status_route_reports_flags_and_gate():
    db = _FakeDB()
    client = _make_client(db)
    resp = client.get("/api/teacher/migration/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "feature_flags" in body
    assert body["feature_flags"]["USE_MONGO_POINTS_WRITE"] in ("off", "shadow", "primary", "syncing")
    assert "phase_2_gate" in body
    assert body["steps_completed"] == ["phase_1_preflight"]


def test_migration_import_wallets_manual_snapshot_dry_run(monkeypatch):
    db = _FakeDB()
    _seed_student(db, "stu1")
    client = _make_client(db)
    resp = client.post("/api/teacher/migration/import-wallets", json={
        "students": [{"student_id": "stu1", "clean_id": "stu1", "balance": 400}],
        "balance_source": "manual_sheet_snapshot",
        "dry_run": True,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["dry_run"] is True
    assert body["summary"]["would_import"] == 1
    assert "stu1" not in db.wallets.docs


def test_migration_import_wallets_manual_snapshot_real_run():
    db = _FakeDB()
    _seed_student(db, "stu1")
    client = _make_client(db)
    resp = client.post("/api/teacher/migration/import-wallets", json={
        "students": [{"student_id": "stu1", "clean_id": "stu1", "balance": 400}],
        "balance_source": "manual_sheet_snapshot",
        "dry_run": False,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"]["imported"] == 1
    assert db.wallets.docs["stu1"]["balance"] == 400


def test_balance_audit_status_route_never_treats_auth_failure_as_zero():
    db = _FakeDB()
    client = _make_client(db)
    resp = client.get("/api/teacher/migration/balance-audit/status")
    assert resp.status_code == 200
    assert resp.json()["gas_auth_failure_treated_as_zero"] is False


def test_balance_audit_route_explicit_list(monkeypatch):
    db = _FakeDB()
    _seed_wallet(db, "stu1", 100)
    _patch_gas(monkeypatch, post_payload={"success": True, "points": 100})
    client = _make_client(db)
    resp = client.post("/api/teacher/migration/balance-audit", json={
        "students": [{"student_id": "stu1", "legacy_password": "pw"}],
        "gas_url": GAS_URL,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"]["matched"] == 1
    assert body["phase_3_ready"] is True


def test_balance_audit_get_route_is_a_gas_free_convenience_read():
    db = _FakeDB()
    client = _make_client(db)
    resp = client.get("/api/teacher/migration/balance-audit")
    assert resp.status_code == 200
    assert "wallet_mode" in resp.json()


def test_migration_reconcile_requires_confirm_true():
    db = _FakeDB()
    client = _make_client(db)
    resp = client.post("/api/teacher/migration/reconcile", json={
        "items": [{"student_id": "stu1", "set_balance": 100}],
    })
    assert resp.status_code == 400


def test_migration_reconcile_applies_delta_via_credit():
    db = _FakeDB()
    _seed_wallet(db, "stu1", 40)
    client = _make_client(db)
    resp = client.post("/api/teacher/migration/reconcile", json={
        "confirm": True,
        "items": [{"student_id": "stu1", "set_balance": 100, "note": "manual fix"}],
    })
    assert resp.status_code == 200
    assert resp.json()["applied"][0]["ok"] is True
    assert db.wallets.docs["stu1"]["balance"] == 100


# ═════════════════════════════════════════════════════════════════════════
# register_student_points_routes — flag-gated disabled-by-default behavior
# ═════════════════════════════════════════════════════════════════════════
async def _student_dep():
    return type("Student", (), {"clean_id": "stu1", "student_id": "stu1"})()


def test_student_points_routes_disabled_by_default(monkeypatch):
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ws.register_student_points_routes(api, db, _student_dep)
    app.include_router(api)
    client = TestClient(app)
    resp = client.get("/api/student/points/balance")
    assert resp.status_code == 200
    assert resp.json()["mode"] == "disabled"


def test_student_points_routes_enabled_reads_mongo_balance(monkeypatch):
    monkeypatch.setenv("USE_MONGO_POINTS_READ", "true")
    db = _FakeDB()
    _seed_wallet(db, "stu1", 77)
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ws.register_student_points_routes(api, db, _student_dep)
    app.include_router(api)
    client = TestClient(app)
    resp = client.get("/api/student/points/balance")
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] != "disabled"
    assert body["balance"] == 77
