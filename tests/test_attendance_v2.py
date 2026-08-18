"""tests/test_attendance_v2.py
=================================
v2 rollout: separated status/verification model (Partial root-cause fix),
monthly attendance analytics + reward claim, teacher QR endpoint.

Same self-contained in-memory harness as tests/test_attendance_checkin.py
(direct route-function calls, no real DB, no TestClient) so these exercise
the REAL attendance_tools.py route logic end to end.

The v2 flag is AND-gated (env var AND a settings-doc field) and fail-closed
— every test that needs v2 ON sets both explicitly via monkeypatch/settings
seeding, and several tests explicitly prove the flag OFF path is untouched.
"""
from __future__ import annotations

import asyncio
import copy
import re

import attendance_tools as att


def run(c):
    return asyncio.run(c)


# ── same in-memory Mongo fake as test_attendance_checkin.py ────────────────
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
        set_keys = set((up.get("$set") or {}).keys())
        soi_keys = set((up.get("$setOnInsert") or {}).keys())
        clash = set_keys & soi_keys
        if clash:
            raise ValueError(f"Updating the path '{sorted(clash)[0]}' would create a conflict")
        if "$setOnInsert" in up:
            for k, v in up["$setOnInsert"].items():
                doc.setdefault(k, v)
        if "$set" in up:
            doc.update(up["$set"])
        if "$unset" in up:
            for k in up["$unset"]:
                doc.pop(k, None)
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


class _Wallet:
    def __init__(self):
        self.seen = {}
        self.calls = 0

    async def credit(self, student_id, amount, *, source, source_ref=None,
                     idempotency_key=None, clean_id=None, **kw):
        self.calls += 1
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True}
        self.seen[idempotency_key] = amount
        return {"ok": True, "duplicate": False, "transaction_id": f"tx{self.calls}"}


def _call(router, m, p, **kw):
    return run(router.routes[(m, p)](**kw))


def _build(wallet=None):
    db = _DB()
    router = _Router()

    async def fan_out(query, title, body, url):
        return (0, 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
    )
    return db, router


def _build_capturing(wallet=None):
    """Same as _build() but records every fan_out_push call — for the
    monthly goal-reached/reward-ready push tests, which need to assert on
    WHICH students were targeted and with what copy, not just that a route
    didn't crash."""
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
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
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
                       mid_session_enabled=True, date=None):
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    db[att.COLL_SESSIONS].docs[sid] = {
        "_id": sid, "session_id": sid, "class_id": cid, "join_slug": slug,
        "meet_url": "https://meet.google.com/real-xyz", "status": att.SESS_OPEN,
        "opens_at": now.isoformat(),
        "closes_at": (now + timedelta(hours=1)).isoformat(),
        "grace_minutes": 10, "mid_session_enabled": mid_session_enabled,
        "date": date or now.date().isoformat(),
    }
    return sid


def _v2_settings(**overrides):
    doc = {"_id": att.SETTINGS_ID, "v2_enabled": True}
    doc.update(overrides)
    return doc


# ─────────────────────────────────────────────────────────────────────────
# Pure functions
# ─────────────────────────────────────────────────────────────────────────
def test_finalize_status_v2_never_downgrades_to_partial():
    # The exact scenario that used to produce present_partial: checked in
    # on time, mid-session confirmation never tapped.
    assert att.finalize_status_v2(True, att.ST_PRESENT_FULL) == att.ST_PRESENT_FULL


def test_finalize_status_v2_absent_when_never_checked_in():
    assert att.finalize_status_v2(False, None) == att.ST_ABSENT


def test_finalize_status_v2_preserves_late():
    assert att.finalize_status_v2(True, att.ST_LATE) == att.ST_LATE


def test_verification_status_not_applicable_when_never_checked_in():
    assert att.compute_verification_status(False, False, True) == "not_applicable"


def test_verification_status_not_required_when_mid_session_off():
    assert att.compute_verification_status(True, False, False) == "not_required"


def test_verification_status_pending_when_unconfirmed():
    assert att.compute_verification_status(True, False, True) == "pending"


def test_verification_status_confirmed_when_tapped():
    assert att.compute_verification_status(True, True, True) == "confirmed"


def test_monthly_stats_zero_classes():
    stats = att.compute_monthly_stats([])
    assert stats == {
        "present": 0, "partial": 0, "late": 0, "absent": 0,
        "attended": 0, "total": 0, "attendance_pct": 0.0,
    }


def test_monthly_stats_all_present():
    stats = att.compute_monthly_stats([att.ST_PRESENT_FULL] * 5)
    assert stats["attended"] == 5 and stats["total"] == 5 and stats["attendance_pct"] == 100.0


def test_monthly_stats_mixed_counts_partial_as_attended():
    stats = att.compute_monthly_stats(
        [att.ST_PRESENT_FULL, att.ST_PRESENT_FULL, att.ST_PRESENT_PARTIAL,
         att.ST_LATE, att.ST_ABSENT]
    )
    assert stats["present"] == 2 and stats["partial"] == 1 and stats["late"] == 1 and stats["absent"] == 1
    assert stats["attended"] == 4 and stats["total"] == 5
    assert stats["attendance_pct"] == 80.0


def test_eligibility_zero_denominator_is_never_met():
    stats = att.compute_monthly_stats([])
    elig = att.compute_monthly_eligibility(stats, 0.85)
    assert elig["met"] is False


def test_eligibility_exactly_at_threshold_is_met():
    stats = att.compute_monthly_stats([att.ST_PRESENT_FULL] * 17 + [att.ST_ABSENT] * 3)  # 85%
    elig = att.compute_monthly_eligibility(stats, 0.85)
    assert stats["attendance_pct"] == 85.0
    assert elig["met"] is True


def test_eligibility_exceeded_is_met():
    stats = att.compute_monthly_stats([att.ST_PRESENT_FULL] * 9 + [att.ST_ABSENT] * 1)  # 90%
    elig = att.compute_monthly_eligibility(stats, 0.85)
    assert elig["met"] is True


def test_eligibility_missed_is_not_met():
    stats = att.compute_monthly_stats([att.ST_PRESENT_FULL] * 7 + [att.ST_ABSENT] * 3)  # 70%
    elig = att.compute_monthly_eligibility(stats, 0.85)
    assert elig["met"] is False


def test_v2_active_requires_both_env_and_db_flag(monkeypatch):
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)
    assert att._v2_active({"v2_enabled": True}) is False  # env off
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    assert att._v2_active({"v2_enabled": False}) is False  # db off
    assert att._v2_active({"v2_enabled": True}) is True    # both on
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


# ─────────────────────────────────────────────────────────────────────────
# v2-status endpoint
# ─────────────────────────────────────────────────────────────────────────
def test_v2_status_reflects_flag_state(monkeypatch):
    db, router = _build()
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)
    assert _call(router, "GET", "/attendance/v2-status")["enabled"] is False

    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings()
    assert _call(router, "GET", "/attendance/v2-status")["enabled"] is False  # env still off

    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    assert _call(router, "GET", "/attendance/v2-status")["enabled"] is True
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


# ─────────────────────────────────────────────────────────────────────────
# _do_close — the actual regression-fix proof
# ─────────────────────────────────────────────────────────────────────────
def test_close_with_v2_off_still_produces_partial_unchanged(monkeypatch):
    """Backward-compatibility proof: with the flag off, behavior is
    byte-for-byte the pre-existing legacy path."""
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)
    db, router = _build()
    _seed_class(db)
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    rec = db[att.COLL_RECORDS].docs["ses_1:stu_alice"]
    assert rec["status"] == att.ST_PRESENT_PARTIAL
    assert "verification_status" not in rec


def test_close_with_v2_on_never_produces_punitive_partial(monkeypatch):
    """The actual fix: same scenario (checked in on time, mid-session tap
    never made — because no UI anywhere calls it), but v2 keeps the
    student's attendance_status honestly Present, with verification
    carried as a separate, non-punitive signal."""
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings()
    _seed_class(db)
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    rec = db[att.COLL_RECORDS].docs["ses_1:stu_alice"]
    assert rec["status"] == att.ST_PRESENT_FULL
    assert rec["verification_status"] == "pending"
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_with_v2_on_confirmed_tap_is_verified(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings()
    _seed_class(db)
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/attendance/mid-session-confirm",
          payload=att.MidSessionIn(session_id="ses_1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    rec = db[att.COLL_RECORDS].docs["ses_1:stu_alice"]
    assert rec["status"] == att.ST_PRESENT_FULL
    assert rec["verification_status"] == "confirmed"
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_with_v2_on_absent_student_unaffected():
    """A student who never checks in stays absent under v2 too — the fix
    only changes the unconfirmed-but-present case."""
    import os
    os.environ[att.V2_ENV_VAR] = "true"
    try:
        db, router = _build()
        db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings()
        _seed_class(db, roster=("stu_alice", "stu_bob"))
        _seed_open_session(db)
        _call(router, "POST", "/attendance/checkin",
              payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
        _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
        rec = db[att.COLL_RECORDS].docs["ses_1:stu_bob"]
        assert rec["status"] == att.ST_ABSENT
        assert rec["verification_status"] == "not_applicable"
    finally:
        os.environ.pop(att.V2_ENV_VAR, None)


# ─────────────────────────────────────────────────────────────────────────
# Monthly summary
# ─────────────────────────────────────────────────────────────────────────
def test_monthly_summary_404_when_v2_off(monkeypatch):
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)
    db, router = _build()
    try:
        _call(router, "GET", "/attendance/monthly-summary", student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 404


def _seed_campaign(db, campaign_id="lrc_aug", *, name="August Attendance Bonus",
                   reward_label="", points=50, enabled=True, reward_kind="points",
                   start_at=None, end_at=None):
    db["login_reward_campaigns"].docs[campaign_id] = {
        "_id": campaign_id, "id": campaign_id, "campaign_id": campaign_id,
        "name": name, "reward_label": reward_label,
        "reward_points": points, "reward_kind": reward_kind,
        "enabled": enabled, "start_at": start_at, "end_at": end_at,
    }
    return campaign_id


def test_monthly_summary_zero_classes_never_eligible(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(monthly_reward_enabled=True)
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["stats"]["total"] == 0
    assert res["eligible"] is False
    assert res["can_claim"] is False
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_eligible_shows_real_campaign_name_and_points(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    cid = _seed_campaign(db, name="August Attendance Bonus", points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["eligible"] is True
    assert res["reward_enabled"] is True
    assert res["reward_configured"] is True
    assert res["reward_name"] == "August Attendance Bonus"  # the REAL campaign name, never invented
    assert res["reward_points"] == 50                        # the REAL configured points
    assert res["reward_campaign_status"] == "live"
    assert res["can_claim"] is True
    assert res["already_claimed"] is False
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_reward_label_overrides_campaign_name_when_set(monkeypatch):
    """reward_label is the student-facing reward identity (e.g. "Attendance
    Champion"); campaign `name` is the admin's internal campaign title.
    reward_label wins when the admin has filled it in."""
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    cid = _seed_campaign(db, name="Internal Aug Campaign", reward_label="Attendance Champion", points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.0, monthly_reward_campaign_id=cid,
    )
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["reward_name"] == "Attendance Champion"
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_no_campaign_attached_is_not_configured_not_a_fake_reward(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.0, monthly_reward_campaign_id=None,
    )
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["reward_enabled"] is True
    assert res["reward_configured"] is False
    assert res["reward_name"] is None
    assert res["reward_points"] is None
    assert res["can_claim"] is False
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_disabled_campaign_is_unavailable_not_claimable(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    cid = _seed_campaign(db, enabled=False)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["eligible"] is True
    assert res["reward_configured"] is True
    assert res["reward_campaign_status"] == "disabled"
    assert res["can_claim"] is False  # eligible, but the real reward isn't live
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_expired_campaign_is_unavailable(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    cid = _seed_campaign(db, end_at="2020-01-01T00:00:00+00:00")
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.0, monthly_reward_campaign_id=cid,
    )
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["reward_campaign_status"] == "expired"
    assert res["can_claim"] is False
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_voucher_only_campaign_cannot_fund_points_reward(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    cid = _seed_campaign(db, reward_kind="voucher", points=0)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.0, monthly_reward_campaign_id=cid,
    )
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["reward_configured"] is False  # voucher-only campaigns don't count as configured here
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_summary_reward_disabled_never_allows_claim(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    cid = _seed_campaign(db)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=False, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/attendance/monthly-summary", month="2026-08",
                class_id=None, student=_Student("stu_alice"))
    assert res["eligible"] is True         # attendance itself is still met
    assert res["reward_enabled"] is False
    assert res["reward_configured"] is False  # not even fetched when the master toggle is off
    assert res["can_claim"] is False        # but claiming stays gated off
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


# ─────────────────────────────────────────────────────────────────────────
# Monthly claim
# ─────────────────────────────────────────────────────────────────────────
def test_monthly_claim_404_when_v2_off(monkeypatch):
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)
    db, router = _build()
    try:
        _call(router, "POST", "/attendance/rewards/monthly/claim",
              payload={}, student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 404


def test_monthly_claim_403_when_reward_disabled(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(monthly_reward_enabled=False)
    try:
        _call(router, "POST", "/attendance/rewards/monthly/claim",
              payload={"period": "2026-08"}, student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 403
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_403_when_not_eligible(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build(wallet=_Wallet())
    cid = _seed_campaign(db)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.85, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    # Never check in — 0 attendance, definitely not eligible.
    try:
        _call(router, "POST", "/attendance/rewards/monthly/claim",
              payload={"period": "2026-08"}, student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 403
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_success_credits_the_real_configured_points(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    wallet = _Wallet()
    db, router = _build(wallet=wallet)
    cid = _seed_campaign(db, name="August Attendance Bonus", points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    calls_after_session_close = wallet.calls  # per-session reward already credited once here

    res = _call(router, "POST", "/attendance/rewards/monthly/claim",
                payload={"period": "2026-08"}, student=_Student("stu_alice"))
    assert res["ok"] is True
    assert res["already_claimed"] is False
    assert res["points"] == 50
    assert res["reward_name"] == "August Attendance Bonus"
    assert wallet.calls == calls_after_session_close + 1
    claim = run(db[att.COLL_CLAIMS].find_one(
        {"idempotency_key": "attendance_monthly:2026-08:stu_alice"}))
    assert claim is not None
    assert claim["status"] == "claimed"
    assert claim["source_campaign_id"] == cid
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_uses_the_points_value_at_claim_time_not_a_stale_cached_number(monkeypatch):
    """If the admin changes the campaign's points between when the student
    loaded the summary and when they tap Claim, the amount actually
    credited is whatever the campaign says RIGHT NOW — proving nothing is
    cached/copied into attendance_settings."""
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    wallet = _Wallet()
    db, router = _build(wallet=wallet)
    cid = _seed_campaign(db, points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())

    # Admin bumps the campaign's points AFTER the student's summary loaded.
    db["login_reward_campaigns"].docs[cid]["reward_points"] = 999

    res = _call(router, "POST", "/attendance/rewards/monthly/claim",
                payload={"period": "2026-08"}, student=_Student("stu_alice"))
    assert res["points"] == 999
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_409_when_campaign_became_unavailable(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build(wallet=_Wallet())
    cid = _seed_campaign(db, enabled=False)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    try:
        _call(router, "POST", "/attendance/rewards/monthly/claim",
              payload={"period": "2026-08"}, student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 409
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_is_idempotent_never_double_credits(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    wallet = _Wallet()
    db, router = _build(wallet=wallet)
    cid = _seed_campaign(db, points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    calls_after_session_close = wallet.calls

    first = _call(router, "POST", "/attendance/rewards/monthly/claim",
                  payload={"period": "2026-08"}, student=_Student("stu_alice"))
    second = _call(router, "POST", "/attendance/rewards/monthly/claim",
                   payload={"period": "2026-08"}, student=_Student("stu_alice"))
    assert first["already_claimed"] is False
    assert second["already_claimed"] is True
    assert second["reward_name"] == "August Attendance Bonus"
    # The second request short-circuits on the existing "claimed" row before
    # ever touching the wallet again — only the first claim call reaches it.
    assert wallet.calls == calls_after_session_close + 1
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_success_fires_congratulations_push_with_real_points(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    wallet = _Wallet()
    db, router, pushes = _build_capturing(wallet=wallet)
    cid = _seed_campaign(db, name="August Attendance Bonus", points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    pushes.clear()  # only care about the claim's own push from here

    _call(router, "POST", "/attendance/rewards/monthly/claim",
          payload={"period": "2026-08"}, student=_Student("stu_alice"))
    assert len(pushes) == 1
    assert "50" in pushes[0]["body"]
    assert pushes[0]["query"]["studentId"]["$in"] == ["stu_alice"]
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_retry_never_resends_the_congratulations_push(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    wallet = _Wallet()
    db, router, pushes = _build_capturing(wallet=wallet)
    cid = _seed_campaign(db, points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    pushes.clear()

    _call(router, "POST", "/attendance/rewards/monthly/claim",
          payload={"period": "2026-08"}, student=_Student("stu_alice"))
    assert len(pushes) == 1
    # A retry (double-tap, refresh, retry-after-timeout) hits the
    # already-claimed early return — must never re-send the congratulations.
    _call(router, "POST", "/attendance/rewards/monthly/claim",
          payload={"period": "2026-08"}, student=_Student("stu_alice"))
    assert len(pushes) == 1
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_monthly_claim_400_when_no_campaign_configured(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build(wallet=_Wallet())
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5, monthly_reward_campaign_id=None,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close", session_id="ses_1", admin=_Admin())
    try:
        _call(router, "POST", "/attendance/rewards/monthly/claim",
              payload={"period": "2026-08"}, student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 400
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


# ─────────────────────────────────────────────────────────────────────────
# Pure campaign-status helper
# ─────────────────────────────────────────────────────────────────────────
def test_derive_campaign_status_disabled_wins_over_dates():
    assert att._derive_campaign_status({"enabled": False}) == att.CAMP_DISABLED


def test_derive_campaign_status_live_with_no_dates():
    assert att._derive_campaign_status({"enabled": True}) == att.CAMP_LIVE


def test_derive_campaign_status_scheduled_before_start():
    from datetime import datetime, timedelta, timezone
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert att._derive_campaign_status({"enabled": True, "start_at": future}) == att.CAMP_SCHEDULED


def test_derive_campaign_status_expired_after_end():
    from datetime import datetime, timedelta, timezone
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert att._derive_campaign_status({"enabled": True, "end_at": past}) == att.CAMP_EXPIRED


# ─────────────────────────────────────────────────────────────────────────
# Teacher QR endpoint
# ─────────────────────────────────────────────────────────────────────────
def test_session_qr_success_for_matching_url():
    db, router = _build()
    _seed_class(db)
    _seed_open_session(db, slug="abc123", sid="ses_1")
    res = _call(router, "GET", "/admin/attendance/sessions/{session_id}/qr",
                session_id="ses_1",
                join_url="https://eduhub-studio-test.vercel.app/attendance/j/abc123",
                admin=_Admin())
    assert res["ok"] is True
    assert res["qr_png_data_uri"].startswith("data:image/png;base64,")


def test_session_qr_rejects_mismatched_url():
    db, router = _build()
    _seed_class(db)
    _seed_open_session(db, slug="abc123", sid="ses_1")
    try:
        _call(router, "GET", "/admin/attendance/sessions/{session_id}/qr",
              session_id="ses_1",
              join_url="https://evil.example.com/phishing",
              admin=_Admin())
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 400


def test_session_qr_404_for_unknown_session():
    db, router = _build()
    try:
        _call(router, "GET", "/admin/attendance/sessions/{session_id}/qr",
              session_id="ses_missing",
              join_url="https://eduhub-studio-test.vercel.app/attendance/j/xyz",
              admin=_Admin())
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 404


# ─────────────────────────────────────────────────────────────────────────
# /attendance/me — verification_status surfaced for the new UI's "Verifying" tag
# ─────────────────────────────────────────────────────────────────────────
def test_me_history_surfaces_verification_status_when_v2_on(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings()
    _seed_class(db)
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/attendance/me", student=_Student("stu_alice"))
    assert res["history"][0]["verification_status"] == "pending"
    assert res["history"][0]["status"] == att.ST_PRESENT_FULL  # never Partial
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_me_history_verification_status_absent_on_legacy_records(monkeypatch):
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)
    db, router = _build()
    _seed_class(db)
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/attendance/me", student=_Student("stu_alice"))
    assert res["history"][0]["verification_status"] is None
    assert res["history"][0]["status"] == att.ST_PRESENT_PARTIAL  # legacy unchanged


# ─────────────────────────────────────────────────────────────────────────
# _shift_period — pure "YYYY-MM" arithmetic
# ─────────────────────────────────────────────────────────────────────────
def test_shift_period_one_month_back():
    assert att._shift_period("2026-08", 1) == "2026-07"


def test_shift_period_crosses_year_boundary():
    assert att._shift_period("2026-08", 8) == "2025-12"


def test_shift_period_zero_is_identity():
    assert att._shift_period("2026-08", 0) == "2026-08"


# ─────────────────────────────────────────────────────────────────────────
# GET /attendance/monthly-history — Attendance History card's own data,
# separate from the per-session recent list.
# ─────────────────────────────────────────────────────────────────────────
def test_monthly_history_404_when_v2_off():
    db, router = _build()
    try:
        _call(router, "GET", "/attendance/monthly-history", months=6, class_id=None,
              student=_Student("stu_alice"))
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 404


def test_monthly_history_current_month_first_reflects_real_attendance(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(monthly_reward_threshold_pct=0.5)
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/attendance/monthly-history", months=3, class_id=None,
                student=_Student("stu_alice"))
    assert len(res["months"]) == 3
    current = res["months"][0]
    assert current["period"] == "2026-08"
    assert current["stats"]["total"] == 1
    assert current["eligible"] is True
    # Older months with nothing recorded are never a fake passing grade.
    assert res["months"][1]["stats"]["total"] == 0
    assert res["months"][1]["eligible"] is False


def test_monthly_history_months_param_clamped(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router = _build()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings()
    _seed_class(db)
    res = _call(router, "GET", "/attendance/monthly-history", months=999, class_id=None,
                student=_Student("stu_alice"))
    assert len(res["months"]) == 12  # clamped, never an unbounded scan
    res2 = _call(router, "GET", "/attendance/monthly-history", months=0, class_id=None,
                 student=_Student("stu_alice"))
    assert len(res2["months"]) == 1  # clamped to at least 1
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


# ─────────────────────────────────────────────────────────────────────────
# GET /admin/attendance/monthly-reward/preview — live "N/M qualify" for the
# Settings threshold slider, server-side, same eligibility functions as the
# real per-student routes.
# ─────────────────────────────────────────────────────────────────────────
def test_admin_preview_counts_qualifying_students_against_class_roster():
    db, router = _build()
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    # stu_bob never checks in — 0% this month.
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/admin/attendance/monthly-reward/preview",
                threshold_pct=0.5, month="2026-08", class_id=None, admin=_Admin())
    assert res["total"] == 2       # whole class roster, not just those with records
    assert res["qualifying"] == 1  # only stu_alice meets 50%


def test_admin_preview_scoped_to_one_class_excludes_other_classes_roster():
    db, router = _build()
    _seed_class(db, roster=("stu_alice",), cid="cls_a")
    _seed_class(db, roster=("stu_bob",), cid="cls_b")
    res = _call(router, "GET", "/admin/attendance/monthly-reward/preview",
                threshold_pct=0.5, month="2026-08", class_id="cls_a", admin=_Admin())
    assert res["total"] == 1
    assert res["class_id"] == "cls_a"


def test_admin_preview_unscoped_dedupes_students_across_classes():
    db, router = _build()
    _seed_class(db, roster=("stu_alice",), cid="cls_a")
    _seed_class(db, roster=("stu_alice", "stu_bob"), cid="cls_b")
    res = _call(router, "GET", "/admin/attendance/monthly-reward/preview",
                threshold_pct=0.5, month="2026-08", class_id=None, admin=_Admin())
    assert res["total"] == 2  # stu_alice counted once, not twice


# ─────────────────────────────────────────────────────────────────────────
# GET /admin/attendance/sessions/{session_id}/roster — real-time per-student
# roster for ONE session (name, check-in time, status), never invented.
# ─────────────────────────────────────────────────────────────────────────
def test_admin_session_roster_shows_present_pending_and_absent():
    db, router = _build()
    _seed_class(db, roster=("stu_alice", "stu_bob", "stu_carol"))
    _seed_open_session(db, sid="ses_1", slug="s1")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    res = _call(router, "GET", "/admin/attendance/sessions/{session_id}/roster",
                session_id="ses_1", admin=_Admin())
    assert res["total"] == 3
    by_id = {r["student_id"]: r for r in res["roster"]}
    assert by_id["stu_alice"]["status"] == att.ST_PRESENT_FULL
    assert by_id["stu_alice"]["checked_in_at"] is not None
    assert by_id["stu_alice"]["display_name"] == "STU_ALICE"
    # Session still open — never-checked-in students are "pending", not
    # falsely marked absent while there's still time to check in.
    assert by_id["stu_bob"]["status"] == "pending"
    assert by_id["stu_bob"]["checked_in_at"] is None
    assert res["checked_in"] == 1
    assert res["present"] == 1


def test_admin_session_roster_marks_absent_once_session_closed():
    db, router = _build()
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    _seed_open_session(db, sid="ses_1", slug="s1")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    res = _call(router, "GET", "/admin/attendance/sessions/{session_id}/roster",
                session_id="ses_1", admin=_Admin())
    by_id = {r["student_id"]: r for r in res["roster"]}
    assert by_id["stu_bob"]["status"] == att.ST_ABSENT
    assert res["absent"] == 1


def test_admin_session_roster_404_unknown_session():
    db, router = _build()
    try:
        _call(router, "GET", "/admin/attendance/sessions/{session_id}/roster",
              session_id="ses_missing", admin=_Admin())
        assert False, "expected HTTPException"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 404


# ─────────────────────────────────────────────────────────────────────────
# Monthly goal-reached / monthly-reward-ready pushes (session-close trigger)
# ─────────────────────────────────────────────────────────────────────────
def test_close_fires_goal_reached_push_when_threshold_met_no_campaign(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router, pushes = _build_capturing()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["goal_reached_sent"] == 1
    assert res["monthly_reward_ready_sent"] == 0  # no campaign attached
    goal_pushes = [p for p in pushes if p["title"] and "goal" in p["title"].lower()]
    assert len(goal_pushes) == 1
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_fires_both_pushes_when_a_live_campaign_is_attached(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router, pushes = _build_capturing()
    cid = _seed_campaign(db, name="August Attendance Bonus", points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5,
        monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["goal_reached_sent"] == 1
    assert res["monthly_reward_ready_sent"] == 1
    assert len(pushes) == 2
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_never_resends_goal_reached_or_reward_ready_same_month(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router, pushes = _build_capturing()
    cid = _seed_campaign(db, name="August Attendance Bonus", points=50)
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.5,
        monthly_reward_campaign_id=cid,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    assert len(pushes) == 2

    # A second session closes for the same student, same month — already
    # eligible from the first close, must never re-notify.
    _seed_open_session(db, sid="ses_2", slug="s2", date="2026-08-02")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s2"), student=_Student("stu_alice"))
    res2 = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                 session_id="ses_2", admin=_Admin())
    assert res2["goal_reached_sent"] == 0
    assert res2["monthly_reward_ready_sent"] == 0
    assert len(pushes) == 2  # unchanged
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_no_push_when_below_threshold(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router, pushes = _build_capturing()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=True, monthly_reward_threshold_pct=0.99,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    # stu_alice never checks in — 0% this month, well below 99%. Session
    # close still legitimately fires ITS OWN unrelated absentee pushes
    # (miss_followup etc.) — this test only asserts the NEW monthly
    # goal/reward pushes stay silent, not that close() sends nothing at all.
    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["goal_reached_sent"] == 0
    assert res["monthly_reward_ready_sent"] == 0
    assert not any("goal" in p["title"].lower() or "reward" in p["title"].lower() for p in pushes)
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_no_push_when_monthly_reward_disabled(monkeypatch):
    monkeypatch.setenv(att.V2_ENV_VAR, "true")
    db, router, pushes = _build_capturing()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = _v2_settings(
        monthly_reward_enabled=False, monthly_reward_threshold_pct=0.5,
    )
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["goal_reached_sent"] == 0
    assert res["monthly_reward_ready_sent"] == 0
    assert len(pushes) == 0
    monkeypatch.delenv(att.V2_ENV_VAR, raising=False)


def test_close_no_monthly_push_when_v2_off():
    db, router, pushes = _build_capturing()
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = {
        "_id": att.SETTINGS_ID,  # v2_enabled deliberately absent/false
        "monthly_reward_enabled": True, "monthly_reward_threshold_pct": 0.5,
    }
    _seed_class(db)
    _seed_open_session(db, sid="ses_1", slug="s1", date="2026-08-01")
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="s1"), student=_Student("stu_alice"))
    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["goal_reached_sent"] == 0
    assert res["monthly_reward_ready_sent"] == 0
    assert len(pushes) == 0
