"""tests/test_attendance_live_next_session.py
=================================================
Live dashboard tile (§3) — the `/attendance/live` extension: existing
live/slug/session_id fields are byte-for-byte unchanged for a live
student, and a not-live student now also gets a real `next_session`
(or `null`, an honest "nothing scheduled" state — never a guessed
placeholder) sourced from actually-materialized Session documents.

Same self-contained fake Mongo as test_attendance_checkin.py.
"""
from __future__ import annotations

import asyncio
import copy
import re
from datetime import datetime, timedelta, timezone

import attendance_tools as att


def run(c):
    return asyncio.run(c)


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

    async def find_one(s, q, p=None):
        for d in s.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                return o
        return None

    async def update_one(s, q, up, upsert=False):
        return type("R", (), {"matched_count": 0})()

    async def insert_one(s, doc):
        key = doc.get("_id") or f"auto{len(s.docs)}"
        doc.setdefault("_id", key)
        s.docs[key] = copy.deepcopy(doc)
        return type("R", (), {"inserted_id": key})()

    def find(s, q, p=None):
        out = [copy.deepcopy(d) for d in s.docs.values() if _match(d, q)]
        if p and p.get("_id") == 0:
            for o in out:
                o.pop("_id", None)
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

    def patch(s, p):
        def d(fn):
            s.routes[("PATCH", p)] = fn
            return fn
        return d


class _Student:
    def __init__(s, sid="stu_alice"):
        s.student_id = sid
        s.clean_id = sid


def _call(router, m, p, **kw):
    return run(router.routes[(m, p)](**kw))


def _build():
    db = _DB()
    router = _Router()
    att.register_attendance_routes(
        router, db, require_admin=object(), require_student=object(),
        current_student=None, fan_out_push=None, build_target_query=None,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=None,
    )
    return db, router


def _seed_class(db, cid="cls_x", roster=("stu_alice",)):
    db[att.COLL_CLASSES].docs[cid] = {
        "_id": cid, "class_id": cid, "title_en": "English A1", "title_kh": "",
        "roster": list(roster), "group": "",
    }
    for r in roster:
        db.students.docs[r] = {"_id": r, "student_id": r, "clean_id": r, "display_name": r}
    return cid


def test_a_currently_open_session_still_returns_live_true_with_the_exact_existing_shape():
    """Existing consumers reading live/slug/session_id/title_en/title_kh
    must see byte-for-byte the same shape as before this extension."""
    db, router = _build()
    cid = _seed_class(db)
    now = datetime.now(timezone.utc)
    db[att.COLL_SESSIONS].docs["ses_1"] = {
        "_id": "ses_1", "session_id": "ses_1", "class_id": cid,
        "join_slug": "abc123", "status": att.SESS_OPEN,
        "opens_at": (now - timedelta(minutes=5)).isoformat(),
        "closes_at": (now + timedelta(minutes=55)).isoformat(),
    }
    res = _call(router, "GET", "/attendance/live", student=_Student("stu_alice"))
    assert res["live"] is True
    assert res["slug"] == "abc123"
    assert res["session_id"] == "ses_1"
    assert res["title_en"] == "English A1"
    assert "next_session" not in res  # unchanged shape for the live branch


def test_when_not_live_returns_next_session_from_a_real_materialized_session():
    db, router = _build()
    cid = _seed_class(db)
    now = datetime.now(timezone.utc)
    future_opens = now + timedelta(hours=3)
    db[att.COLL_SESSIONS].docs["ses_future"] = {
        "_id": "ses_future", "session_id": "ses_future", "class_id": cid,
        "join_slug": "future-slug", "status": att.SESS_SCHEDULED,
        "opens_at": future_opens.isoformat(),
        "closes_at": (future_opens + timedelta(hours=1)).isoformat(),
        "exception": None,
    }
    res = _call(router, "GET", "/attendance/live", student=_Student("stu_alice"))
    assert res["live"] is False
    assert res["next_session"] is not None
    assert res["next_session"]["opens_at"] == future_opens.isoformat()
    assert res["next_session"]["title_en"] == "English A1"


def test_regression_a_student_with_no_upcoming_session_gets_an_honest_null_never_a_guess():
    db, router = _build()
    _seed_class(db)  # no sessions seeded at all
    res = _call(router, "GET", "/attendance/live", student=_Student("stu_alice"))
    assert res["live"] is False
    assert res["next_session"] is None


def test_next_session_picks_the_earliest_of_several_future_sessions_not_just_the_first_found():
    db, router = _build()
    cid = _seed_class(db)
    now = datetime.now(timezone.utc)
    later = now + timedelta(days=2)
    sooner = now + timedelta(hours=1)
    db[att.COLL_SESSIONS].docs["ses_later"] = {
        "_id": "ses_later", "session_id": "ses_later", "class_id": cid,
        "join_slug": "later-slug", "status": att.SESS_SCHEDULED,
        "opens_at": later.isoformat(), "closes_at": (later + timedelta(hours=1)).isoformat(),
        "exception": None,
    }
    db[att.COLL_SESSIONS].docs["ses_sooner"] = {
        "_id": "ses_sooner", "session_id": "ses_sooner", "class_id": cid,
        "join_slug": "sooner-slug", "status": att.SESS_SCHEDULED,
        "opens_at": sooner.isoformat(), "closes_at": (sooner + timedelta(hours=1)).isoformat(),
        "exception": None,
    }
    res = _call(router, "GET", "/attendance/live", student=_Student("stu_alice"))
    assert res["next_session"]["opens_at"] == sooner.isoformat()


def test_a_session_already_open_and_past_never_counts_as_the_next_upcoming_session():
    """opens_at in the past must not be reported as 'next' — it should
    have been (or should be) the LIVE session, not an upcoming one."""
    db, router = _build()
    cid = _seed_class(db)
    now = datetime.now(timezone.utc)
    db[att.COLL_SESSIONS].docs["ses_past"] = {
        "_id": "ses_past", "session_id": "ses_past", "class_id": cid,
        "join_slug": "past-slug", "status": att.SESS_CLOSED,
        "opens_at": (now - timedelta(hours=2)).isoformat(),
        "closes_at": (now - timedelta(hours=1)).isoformat(),
        "exception": None,
    }
    res = _call(router, "GET", "/attendance/live", student=_Student("stu_alice"))
    assert res["live"] is False
    assert res["next_session"] is None


def test_an_excepted_future_session_is_excluded_from_the_countdown():
    db, router = _build()
    cid = _seed_class(db)
    now = datetime.now(timezone.utc)
    future_opens = now + timedelta(hours=3)
    db[att.COLL_SESSIONS].docs["ses_cancelled_future"] = {
        "_id": "ses_cf", "session_id": "ses_cf", "class_id": cid,
        "join_slug": "cf-slug", "status": att.SESS_SCHEDULED,
        "opens_at": future_opens.isoformat(),
        "closes_at": (future_opens + timedelta(hours=1)).isoformat(),
        "exception": "holiday",
    }
    res = _call(router, "GET", "/attendance/live", student=_Student("stu_alice"))
    assert res["next_session"] is None
