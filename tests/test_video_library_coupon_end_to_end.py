"""tests/test_video_library_coupon_end_to_end.py
=====================================================
Full lifecycle proof for the Video Library Voucher feature, driven through
the REAL application routes at every step — Author Studio's own creation
route (coupon_tools.register_coupon_routes, the same route CouponStudio.jsx's
createCoupon() calls) all the way through to the student's own redemption
route (video_library_coupon_tools.register_video_library_coupon_routes).

This is the test that actually closes the gap discovered in production:
video_library_coupon_tools.py's redemption side was built and tested in
isolation (tests/test_video_library_coupon_tools.py, using a hand-seeded
coupon doc), but nothing proved a coupon created the way an Author actually
creates one — through the generic /api/coupons route — was structurally
redeemable without manual DB reshaping. This file proves exactly that, with
no manual reshaping anywhere between creation and redemption.
"""
from __future__ import annotations

import copy
import re

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import coupon_tools
import video_library_coupon_tools as vlc


# ── self-contained fake Mongo — same shape as test_video_library_coupon_
#    tools.py's own, plus insert_one (needed by coupon_tools.create_coupon,
#    which video_library_coupon_tools.py's own test file never exercises). ──
def _cmp(actual, cond):
    if isinstance(cond, dict):
        for op, v in cond.items():
            if op == "$ne":
                if actual == v:
                    return False
            elif op == "$lt":
                if not (actual is not None and actual < v):
                    return False
            else:
                return False
        return True
    return actual == cond


def _match_field(doc, key, cond):
    if "." in key:
        top, rest = key.split(".", 1)
        val = doc.get(top)
        if isinstance(val, list):
            if isinstance(cond, dict) and "$ne" in cond:
                target = cond["$ne"]
                return not any(isinstance(it, dict) and it.get(rest) == target for it in val)
            return any(isinstance(it, dict) and it.get(rest) == cond for it in val)
        return _cmp(val, cond)
    return _cmp(doc.get(key), cond)


def _match(doc, query):
    return all(_match_field(doc, k, v) for k, v in query.items())


_POSITIONAL_RE = re.compile(r"^([^.]+)\.\$\[([^\]]+)\]\.(.+)$")


def _apply(doc, update, array_filters=None):
    if "$push" in update:
        for k, v in update["$push"].items():
            doc.setdefault(k, []).append(copy.deepcopy(v))
    if "$inc" in update:
        for k, v in update["$inc"].items():
            _apply_path(doc, k, v, array_filters, "inc")
    if "$set" in update:
        for k, v in update["$set"].items():
            _apply_path(doc, k, v, array_filters, "set")


def _apply_path(doc, path, value, array_filters, op):
    m = _POSITIONAL_RE.match(path)
    if not m:
        doc[path] = value if op == "set" else (doc.get(path) or 0) + value
        return
    array_name, ident, subfield = m.groups()
    conditions = {}
    for af in (array_filters or []):
        for k, v in af.items():
            if k.startswith(ident + "."):
                conditions[k.split(".", 1)[1]] = v
    for item in (doc.get(array_name) or []):
        if all(item.get(ck) == cv for ck, cv in conditions.items()):
            if op == "set":
                item[subfield] = value
            else:
                item[subfield] = (item.get(subfield) or 0) + value


class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, q, projection=None):
        for d in self.docs.values():
            if _match(d, q):
                return copy.deepcopy(d)
        return None

    async def insert_one(self, doc):
        self.docs[doc["code"]] = copy.deepcopy(doc)

    async def find_one_and_update(self, q, update, upsert=False, return_document=None):
        for d in self.docs.values():
            if _match(d, q):
                before = copy.deepcopy(d)
                _apply(d, update)
                return before
        return None

    async def update_one(self, q, update, upsert=False, array_filters=None):
        for d in self.docs.values():
            if _match(d, q):
                _apply(d, update, array_filters=array_filters)
                return


class _DB:
    def __init__(self):
        self._c: dict[str, _Coll] = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())

    def __getattr__(self, name):
        return self[name]


class _Admin:
    email = "admin@test"


async def _admin_dep():
    return _Admin()


class _Student:
    def __init__(self, clean_id):
        self.clean_id = clean_id


def _student_dep(student_id="stu1"):
    async def dep():
        return _Student(student_id)
    return dep


def _make_client(db, student_id="stu1"):
    """Wires BOTH the Author Studio creation routes and the student
    redemption routes onto the SAME api router — exactly how server.py
    wires them in production (both register_*_routes calls share one
    APIRouter(prefix="/api"))."""
    app = FastAPI()
    api = APIRouter(prefix="/api")
    coupon_tools.register_coupon_routes(api, db, _admin_dep, object)
    vlc.register_video_library_coupon_routes(api, db, _admin_dep, _student_dep(student_id))
    app.include_router(api)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED", "true")


@pytest.fixture(autouse=True)
def _default_credit_succeeds(monkeypatch):
    async def ok(student_clean_id, amount):
        return True, ""
    monkeypatch.setattr(vlc, "_credit_video_library_points", ok)


def test_full_lifecycle_author_studio_creation_to_student_redemption():
    db = _DB()
    client = _make_client(db)

    # 1. Author Studio creates a Video Library Voucher through the SAME
    #    generic route CouponStudio.jsx's createCoupon() calls.
    create_resp = client.post("/api/coupons", json={
        "code": "LAUNCH20",
        "benefit_type": "video_library_points",
        "benefit_amount": 20,
    })
    assert create_resp.status_code == 200
    created = create_resp.json()["coupon"]
    assert created["benefit_type"] == "video_library_points"
    assert created["benefit_amount"] == 20

    # 2. Student validates the EXACT code an author just created — no
    #    manual DB reshaping, the same document coupon_tools.py wrote.
    validate_resp = client.post("/api/student/video-library/coupon/validate", json={"code": "LAUNCH20"})
    assert validate_resp.status_code == 200
    vbody = validate_resp.json()
    assert vbody["ok"] is True
    assert vbody["state"] == "valid"
    assert vbody["benefit_amount"] == 20

    # 3. Student redeems — real points-credit path (only the outbound GAS
    #    HTTP call is mocked; every other line of production code runs).
    redeem_resp = client.post("/api/student/video-library/coupon/redeem", json={"code": "LAUNCH20"})
    assert redeem_resp.status_code == 200
    rbody = redeem_resp.json()
    assert rbody["ok"] is True
    assert rbody["state"] == "credited"
    assert rbody["benefit_amount"] == 20

    stored = db["coupons"].docs["LAUNCH20"]
    assert stored["uses_count"] == 1
    assert stored["redemptions"][0]["status"] == "credited"
    assert stored["redemptions"][0]["student_id"] == "stu1"

    # 4. Duplicate redemption by the SAME student is rejected safely —
    #    idempotent, never double-credited, never a second reservation.
    dup_resp = client.post("/api/student/video-library/coupon/redeem", json={"code": "LAUNCH20"})
    assert dup_resp.status_code == 200
    dbody = dup_resp.json()
    assert dbody["ok"] is True
    assert dbody["state"] == "credited"
    assert dbody["credited_at"] == rbody["credited_at"]
    assert db["coupons"].docs["LAUNCH20"]["uses_count"] == 1


def test_full_lifecycle_two_different_students_each_get_their_own_redemption():
    db = _DB()
    creator = _make_client(db)
    creator.post("/api/coupons", json={
        "code": "SHARE10", "benefit_type": "video_library_points", "benefit_amount": 10,
    })

    client1 = _make_client(db, student_id="stu1")
    r1 = client1.post("/api/student/video-library/coupon/redeem", json={"code": "SHARE10"})
    assert r1.json()["state"] == "credited"

    client2 = _make_client(db, student_id="stu2")
    r2 = client2.post("/api/student/video-library/coupon/redeem", json={"code": "SHARE10"})
    assert r2.json()["state"] == "credited"

    stored = db["coupons"].docs["SHARE10"]
    assert stored["uses_count"] == 2
    assert {e["student_id"] for e in stored["redemptions"]} == {"stu1", "stu2"}


def test_full_lifecycle_expired_voucher_created_by_author_is_honestly_rejected():
    db = _DB()
    client = _make_client(db)
    client.post("/api/coupons", json={
        "code": "OLD5", "benefit_type": "video_library_points", "benefit_amount": 5,
        "expires_at": "2000-01-01T00:00:00+00:00",
    })
    resp = client.post("/api/student/video-library/coupon/redeem", json={"code": "OLD5"})
    body = resp.json()
    assert body["ok"] is False
    assert body["state"] == "expired"


def test_full_lifecycle_max_uses_created_by_author_is_enforced():
    db = _DB()
    creator = _make_client(db)
    creator.post("/api/coupons", json={
        "code": "LIMIT1", "benefit_type": "video_library_points", "benefit_amount": 5, "max_uses": 1,
    })
    c1 = _make_client(db, student_id="stu1")
    assert c1.post("/api/student/video-library/coupon/redeem", json={"code": "LIMIT1"}).json()["state"] == "credited"
    c2 = _make_client(db, student_id="stu2")
    body2 = c2.post("/api/student/video-library/coupon/redeem", json={"code": "LIMIT1"}).json()
    assert body2["ok"] is False
    assert body2["state"] == "global_limit_reached"


def test_full_lifecycle_assigned_to_students_created_via_author_studio_csv_field():
    # CouponStudio's assigned-to field is admin-typed free text — proves the
    # SAME normalization coupon_tools.py applies at creation time actually
    # lines up with video_library_coupon_tools.py's own _norm_sid() compare.
    db = _DB()
    creator = _make_client(db)
    creator.post("/api/coupons", json={
        "code": "VIP5", "benefit_type": "video_library_points", "benefit_amount": 5,
        "assigned_to": ["  STU1 ", "Stu2"],
    })
    allowed = _make_client(db, student_id="stu1")
    assert allowed.post("/api/student/video-library/coupon/redeem", json={"code": "VIP5"}).json()["state"] == "credited"

    blocked = _make_client(db, student_id="stu3")
    body = blocked.post("/api/student/video-library/coupon/redeem", json={"code": "VIP5"}).json()
    assert body["ok"] is False
    assert body["state"] == "not_assigned"


def test_full_lifecycle_book_discount_coupon_created_via_studio_is_never_redeemable_here():
    # Bidirectional isolation, proven end-to-end through the real creation
    # route this time (not a hand-seeded doc): a Book Discount coupon an
    # Author creates must never be usable as a Video Library Voucher.
    db = _DB()
    creator = _make_client(db)
    creator.post("/api/coupons", json={"code": "BOOK20", "type": "percent", "value": 20})
    client = _make_client(db)
    body = client.post("/api/student/video-library/coupon/redeem", json={"code": "BOOK20"}).json()
    assert body["ok"] is False
    assert body["state"] == "wrong_benefit_type"
