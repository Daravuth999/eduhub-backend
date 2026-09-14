"""tests/test_attendance_recurring_sessions.py
=================================================
Recurring weekly session scheduling (§1) — the structured
`weekly_recurrence` template on ClassIn, `generate_sessions_for_class`,
and the two new admin/cron generation routes.

Same self-contained in-memory fake Mongo as test_attendance_checkin.py
(per-file duplication is this codebase's own established convention for
these fakes, not something to consolidate here).
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
        if "$set" in up:
            doc.update(up["$set"])
        if "$addToSet" in up:
            for k, v in up["$addToSet"].items():
                doc.setdefault(k, [])
                if v not in doc[k]:
                    doc[k].append(v)
        return doc

    async def update_one(s, q, up, upsert=False):
        for d in s.docs.values():
            if _match(d, q):
                s._apply(d, up)
                return type("R", (), {"matched_count": 1})()
        return type("R", (), {"matched_count": 0})()

    async def insert_one(s, doc):
        key = doc.get("_id") or f"auto{s._auto}"
        s._auto += 1
        doc.setdefault("_id", key)
        s.docs[key] = copy.deepcopy(doc)
        return type("R", (), {"inserted_id": key})()

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

    def patch(s, p):
        def d(fn):
            s.routes[("PATCH", p)] = fn
            return fn
        return d


class _Admin:
    email = "admin@example.com"
    is_admin = True


def _call(router, m, p, **kw):
    return run(router.routes[(m, p)](**kw))


def _build(**extra):
    db = _DB()
    router = _Router()
    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=None, build_target_query=None,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=None,
        **extra,
    )
    return db, router


def _seed_class(db, *, cid="cls_x", weekdays=None, opens_time="19:00", closes_time="20:00", enabled=True):
    db[att.COLL_CLASSES].docs[cid] = {
        "_id": cid, "class_id": cid, "title_en": "English A1", "title_kh": "",
        "roster": [], "group": "",
        "weekly_recurrence": {
            "enabled": enabled,
            "weekdays": weekdays if weekdays is not None else [0, 2, 4],  # Mon/Wed/Fri
            "opens_time": opens_time, "closes_time": closes_time,
        },
    }
    return cid


# ── generate_sessions_for_class (pure, no route needed) ─────────────────────
def test_generates_a_session_for_every_matching_weekday_in_the_window():
    db = _DB()
    cid = _seed_class(db, weekdays=[0, 2, 4])  # Mon/Wed/Fri
    cls = db[att.COLL_CLASSES].docs[cid]
    result = run(att.generate_sessions_for_class(db, cls, days_ahead=14))
    assert len(result["created"]) > 0
    for date_str in result["created"]:
        d = datetime.fromisoformat(date_str).date()
        assert d.weekday() in {0, 2, 4}


def test_generated_session_opens_and_closes_at_the_configured_wall_clock_time_in_utc():
    db = _DB()
    cid = _seed_class(db, weekdays=[0], opens_time="19:00", closes_time="20:00")
    cls = db[att.COLL_CLASSES].docs[cid]
    run(att.generate_sessions_for_class(db, cls, days_ahead=14))
    sessions = list(db[att.COLL_SESSIONS].docs.values())
    assert len(sessions) > 0
    for sess in sessions:
        opens = att._parse_iso(sess["opens_at"])
        closes = att._parse_iso(sess["closes_at"])
        # 19:00 Cambodia (UTC+7) == 12:00 UTC
        assert opens.astimezone(timezone.utc).hour == 12
        assert closes.astimezone(timezone.utc).hour == 13
        assert sess["generated"] is True
        assert sess["status"] == att.SESS_SCHEDULED


def test_disabled_template_generates_nothing():
    db = _DB()
    cid = _seed_class(db, enabled=False)
    cls = db[att.COLL_CLASSES].docs[cid]
    result = run(att.generate_sessions_for_class(db, cls, days_ahead=14))
    assert result["created"] == []
    assert result["reason"] == "recurrence_disabled"


def test_incomplete_template_generates_nothing_rather_than_guessing():
    db = _DB()
    cid = _seed_class(db, opens_time="", closes_time="")
    cls = db[att.COLL_CLASSES].docs[cid]
    result = run(att.generate_sessions_for_class(db, cls, days_ahead=14))
    assert result["created"] == []
    assert result["reason"] == "template_incomplete"


def test_regression_never_duplicates_a_manually_created_session_for_the_same_class_and_date():
    """§1.5/§1.6 — a manually-created session for a date the template also
    covers must be detected as a conflict and skipped, never duplicated or
    overwritten."""
    db = _DB()
    cid = _seed_class(db, weekdays=[0])
    today = datetime.now(att._KH_TZ).date()
    # Find the first Monday in the window and manually seed a session there.
    d = today
    while d.weekday() != 0:
        d += timedelta(days=1)
    manual_id = "ses_manual"
    db[att.COLL_SESSIONS].docs[manual_id] = {
        "_id": manual_id, "session_id": manual_id, "class_id": cid,
        "date": d.isoformat(), "meet_url": "https://meet.google.com/manual",
        "join_slug": "manual-slug", "opens_at": "2026-01-01T12:00:00+00:00",
        "closes_at": "2026-01-01T13:00:00+00:00", "grace_minutes": 10,
        "mid_session_enabled": True, "status": att.SESS_SCHEDULED,
    }
    cls = db[att.COLL_CLASSES].docs[cid]
    result = run(att.generate_sessions_for_class(db, cls, days_ahead=14))
    assert d.isoformat() in result["skipped_existing"]
    assert d.isoformat() not in result["created"]
    # The manually-created session is completely untouched.
    assert db[att.COLL_SESSIONS].docs[manual_id]["meet_url"] == "https://meet.google.com/manual"
    assert db[att.COLL_SESSIONS].docs[manual_id]["join_slug"] == "manual-slug"
    # Exactly one session document exists for that date — no duplicate.
    matching = [s for s in db[att.COLL_SESSIONS].docs.values() if s["date"] == d.isoformat()]
    assert len(matching) == 1


def test_regression_respects_an_existing_exception_never_regenerating_a_cancelled_date():
    """§1.4 — a session already marked with an exception (cancelled/
    holiday/etc.) is a real, already-existing session document for that
    date, so it is skipped exactly like any other existing session —
    never silently regenerated or duplicated."""
    db = _DB()
    cid = _seed_class(db, weekdays=[1])  # Tuesday
    today = datetime.now(att._KH_TZ).date()
    d = today
    while d.weekday() != 1:
        d += timedelta(days=1)
    cancelled_id = "ses_cancelled"
    db[att.COLL_SESSIONS].docs[cancelled_id] = {
        "_id": cancelled_id, "session_id": cancelled_id, "class_id": cid,
        "date": d.isoformat(), "exception": "holiday", "status": att.SESS_SCHEDULED,
    }
    cls = db[att.COLL_CLASSES].docs[cid]
    result = run(att.generate_sessions_for_class(db, cls, days_ahead=14))
    assert d.isoformat() in result["skipped_existing"]
    assert db[att.COLL_SESSIONS].docs[cancelled_id]["exception"] == "holiday"


# ── admin on-demand + cron generation routes ─────────────────────────────────
def test_admin_generate_sessions_route_returns_a_summary():
    db, router = _build()
    cid = _seed_class(db, weekdays=[3])  # Thursday
    res = _call(router, "POST", "/admin/attendance/classes/{class_id}/generate-sessions",
                class_id=cid, days_ahead=14, admin=_Admin())
    assert res["ok"] is True
    assert res["class_id"] == cid
    assert isinstance(res["created"], list)


def test_generate_due_route_requires_cron_secret_or_super_admin():
    import fastapi
    calls = {}

    def is_super_admin(user):
        calls["checked"] = user
        return False

    db, router = _build(
        current_user_dep=lambda: None, is_super_admin_fn=is_super_admin, cron_secret="real-secret",
    )
    try:
        _call(router, "POST", "/admin/attendance/sessions/generate-due",
              request=object(), days_ahead=14, x_cron_secret="wrong-secret", user=None)
        assert False, "expected 403"
    except fastapi.HTTPException as e:
        assert e.status_code == 403


def test_generate_due_route_accepts_the_correct_cron_secret_and_generates_for_every_enabled_class():
    db, router = _build(
        current_user_dep=lambda: None, is_super_admin_fn=lambda u: False, cron_secret="real-secret",
    )
    cid1 = _seed_class(db, cid="cls_a", weekdays=[0])
    cid2 = _seed_class(db, cid="cls_b", weekdays=[0], enabled=False)
    res = _call(router, "POST", "/admin/attendance/sessions/generate-due",
                request=object(), days_ahead=14, x_cron_secret="real-secret", user=None)
    assert res["ok"] is True
    assert cid1 in res["classes"]
    assert cid2 not in res["classes"]  # disabled template never participates
