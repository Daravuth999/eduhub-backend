"""tests/test_attendance_checkin.py
=====================================
Smart Attendance — check-in route tests (Join Link flow, shared-device
"not you?" re-attribution, network-failure degrade, and the rule that a
session's meet_url is NEVER returned by any student-facing endpoint).

Self-contained in-memory fakes (same approach as
tests/test_voice_treasure_reward.py); runnable under real pytest.
"""
from __future__ import annotations

import asyncio
import copy
import re

import attendance_tools as att


def run(c):
    return asyncio.run(c)


# ── richer in-memory Mongo fake (supports $or / $in / $ne / $regex) ──────────
def _match(doc, q):
    for k, v in q.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        dv = doc.get(k)
        if isinstance(v, dict):
            if "$in" in v and dv not in v["$in"]:
                return False
            if "$ne" in v and dv == v["$ne"]:
                return False
            if "$gte" in v and not (dv is not None and dv >= v["$gte"]):
                return False
            if "$regex" in v:
                flags = re.I if "i" in (v.get("$options") or "") else 0
                if dv is None or not re.search(v["$regex"], str(dv), flags):
                    return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(s, d):
        s._d = d

    def sort(s, f, d=1):
        s._d.sort(key=lambda x: x.get(f) or "", reverse=(d == -1))
        return s

    def limit(s, n):
        s._d = s._d[:n]
        return s

    def __aiter__(s):
        async def g():
            for x in s._d:
                yield x
        return g()


class _Coll:
    def __init__(s):
        s.docs = {}
        s._auto = 0

    async def create_index(s, *a, **k):
        return None

    async def find_one(s, q, p=None):
        for d in s.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                return o
        return None

    def _apply(s, doc, up):
        # Mirror MongoDB: a field may not appear in both $set and $setOnInsert.
        set_keys = set((up.get("$set") or {}).keys())
        soi_keys = set((up.get("$setOnInsert") or {}).keys())
        clash = set_keys & soi_keys
        if clash:
            raise ValueError(
                f"Updating the path '{sorted(clash)[0]}' would create a conflict"
            )
        if "$setOnInsert" in up:
            for k, v in up["$setOnInsert"].items():
                doc.setdefault(k, v)
        if "$set" in up:
            doc.update(up["$set"])
        if "$inc" in up:
            for k, v in up["$inc"].items():
                doc[k] = (doc.get(k) or 0) + v
        return doc

    async def update_one(s, q, up, upsert=False):
        for d in s.docs.values():
            if _match(d, q):
                s._apply(d, up)
                return type("R", (), {"matched_count": 1})()
        if upsert:
            base = {}
            # seed scalar query fields (e.g. _id, student_id)
            for k, v in q.items():
                if not isinstance(v, dict) and k != "$or":
                    base[k] = v
            s._apply(base, up)
            key = base.get("_id") or f"auto{s._auto}"
            s._auto += 1
            base.setdefault("_id", key)
            s.docs[key] = base
        return type("R", (), {"matched_count": 0})()

    async def insert_one(s, doc):
        key = doc.get("_id") or f"auto{s._auto}"
        s._auto += 1
        doc.setdefault("_id", key)
        s.docs[key] = copy.deepcopy(doc)
        return type("R", (), {"inserted_id": key})()

    async def delete_one(s, q):
        for k, d in list(s.docs.items()):
            if _match(d, q):
                del s.docs[k]
                return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()

    def find(s, q, p=None):
        out = []
        for d in s.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                out.append(o)
        return _Cursor(out)


class _DB:
    def __init__(s):
        s._c = {}

    def __getitem__(s, n):
        return s._c.setdefault(n, _Coll())

    def __getattr__(s, n):
        if n.startswith("_"):
            raise AttributeError(n)
        return s._c.setdefault(n, _Coll())


class _Router:
    def __init__(s):
        s.routes = {}

    def get(s, p):
        def d(fn):
            s.routes[("GET", p)] = fn
            return fn
        return d

    def post(s, p):
        def d(fn):
            s.routes[("POST", p)] = fn
            return fn
        return d

    def put(s, p):
        def d(fn):
            s.routes[("PUT", p)] = fn
            return fn
        return d

    def delete(s, p):
        def d(fn):
            s.routes[("DELETE", p)] = fn
            return fn
        return d


class _Student:
    def __init__(s, sid="stu_alice"):
        s.student_id = sid
        s.clean_id = sid


class _Admin:
    email = "admin@example.com"
    is_admin = True


def _call(router, m, p, **kw):
    return run(router.routes[(m, p)](**kw))


def _build():
    db = _DB()
    router = _Router()
    pushes = []

    async def fan_out(query, title, body, url):
        pushes.append({"query": query, "title": title, "body": body, "url": url})
        return (1, 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=None,
    )
    return db, router, pushes


def _seed_class(db, roster=("stu_alice",), cid="cls_x"):
    db[att.COLL_CLASSES].docs[cid] = {
        "_id": cid, "class_id": cid, "title_en": "English A1", "title_kh": "",
        "roster": [r.lower() for r in roster], "group": "",
    }
    for r in roster:
        db.students.docs[r] = {
            "_id": r, "student_id": r, "clean_id": r, "display_name": r.upper(),
        }
    return cid


def _seed_open_session(db, cid="cls_x", slug="abc123", sid="ses_1",
                       meet="https://meet.google.com/real-xyz"):
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    db[att.COLL_SESSIONS].docs[sid] = {
        "_id": sid, "session_id": sid, "class_id": cid, "join_slug": slug,
        "meet_url": meet, "status": att.SESS_OPEN,
        "opens_at": now.isoformat(),
        "closes_at": (now + timedelta(hours=1)).isoformat(),
        "grace_minutes": 10, "mid_session_enabled": True,
        "date": now.date().isoformat(),
    }
    return sid


# ── tests ────────────────────────────────────────────────────────────────────
def test_checkin_writes_attributed_record_and_returns_meet():
    db, router, _ = _build()
    _seed_class(db)
    _seed_open_session(db)
    res = _call(router, "POST", "/attendance/checkin",
                payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    assert res["ok"] is True
    assert res["tracked"] is True
    assert res["meet_url"] == "https://meet.google.com/real-xyz"
    assert res["status"] == att.ST_PRESENT_FULL
    # a correctly-attributed record exists
    rid = "ses_1:stu_alice"
    rec = db[att.COLL_RECORDS].docs[rid]
    assert rec["student_id"] == "stu_alice"
    assert rec["checked_in_at"]
    assert rec["attributed_via"] == "session_identity"


def test_checkin_is_idempotent():
    db, router, _ = _build()
    _seed_class(db)
    _seed_open_session(db)
    r1 = _call(router, "POST", "/attendance/checkin",
               payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    first_ts = db[att.COLL_RECORDS].docs["ses_1:stu_alice"]["checked_in_at"]
    r2 = _call(router, "POST", "/attendance/checkin",
               payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    second_ts = db[att.COLL_RECORDS].docs["ses_1:stu_alice"]["checked_in_at"]
    assert first_ts == second_ts  # not overwritten
    assert r1["meet_url"] == r2["meet_url"]


def test_not_you_reattributes_to_enrolled_student():
    db, router, _ = _build()
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    _seed_open_session(db)
    # Alice's sibling Bob is actually in class on the shared family device
    res = _call(router, "POST", "/attendance/checkin",
                payload=att.CheckInIn(slug="abc123", as_student_id="stu_bob"),
                student=_Student("stu_alice"))
    assert res["ok"] is True
    assert res["student_id"] == "stu_bob"
    assert res["attributed_via"] == "shared_device_picker"
    assert "ses_1:stu_bob" in db[att.COLL_RECORDS].docs
    assert "ses_1:stu_alice" not in db[att.COLL_RECORDS].docs


def test_not_you_rejects_non_enrolled_student():
    import fastapi
    db, router, _ = _build()
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    try:
        _call(router, "POST", "/attendance/checkin",
              payload=att.CheckInIn(slug="abc123", as_student_id="stranger"),
              student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except fastapi.HTTPException as e:
        assert e.status_code == 400
        assert e.detail == "not_enrolled_in_class"


def test_checkin_degrades_when_write_fails(monkeypatch):
    # A flaky DB write must NOT block the student from reaching Meet.
    db, router, _ = _build()
    _seed_class(db)
    _seed_open_session(db)

    async def boom(*a, **k):
        raise RuntimeError("simulated network failure")
    monkeypatch.setattr(db[att.COLL_RECORDS], "update_one", boom)

    res = _call(router, "POST", "/attendance/checkin",
                payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    assert res["tracked"] is False        # tracking failed
    assert res["meet_url"] == "https://meet.google.com/real-xyz"  # still reaches class


def test_meet_url_never_leaks_in_session_lookup():
    db, router, _ = _build()
    _seed_class(db)
    _seed_open_session(db)
    res = _call(router, "GET", "/attendance/session/by-slug/{slug}",
                slug="abc123", student=_Student("stu_alice"))
    assert "meet_url" not in res
    assert res["is_open"] is True
    assert any(r["student_id"] == "stu_alice" for r in res["roster"])


def test_mid_session_confirm_marks_record():
    db, router, _ = _build()
    _seed_class(db)
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    res = _call(router, "POST", "/attendance/mid-session-confirm",
                payload=att.MidSessionIn(session_id="ses_1"), student=_Student("stu_alice"))
    assert res["ok"] is True
    assert db[att.COLL_RECORDS].docs["ses_1:stu_alice"]["mid_session_confirmed"] is True


def test_miss_reason_stored_and_suppresses_next_nudge():
    db, router, _ = _build()
    _seed_class(db)
    _seed_open_session(db)
    res = _call(router, "POST", "/attendance/miss-reason",
                payload=att.MissReasonIn(session_id="ses_1", reason="sick"),
                student=_Student("stu_alice"))
    assert res["reason"] == "sick"
    # absence-reason timestamp recorded on the streak doc (guardrail input)
    st = next(d for d in db[att.COLL_STREAKS].docs.values()
              if d.get("student_id") == "stu_alice")
    assert st["last_absence_reason_at"]
