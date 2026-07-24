"""tests/test_event_engine.py
=====================================================
Event Engine v1 (architecture.md §4.3, Migration Phase 3 continuation).
Speaking Lab becomes the first event *type* rather than its own hard-
coded system. These tests cover event_engine.py's pure functions
(template CRUD/lifecycle, event state machine, registration delegation
to the EXISTING speaking_lab_direct_join._run_direct_join) against an
in-memory fake Mongo, plus the HTTP routes via a real APIRouter +
FastAPI + TestClient (matching the Phase 1f/Phase 2 pattern already
established in this codebase).
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import event_engine as ee
import prize_pool as pp


# ── fake Mongo ──────────────────────────────────────────────────────────
class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key, direction=None):
        self._docs = sorted(self._docs, key=lambda d: d.get(key) or "", reverse=(direction == -1) or True)
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


class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def insert_one(self, doc):
        self.docs[doc["_id"]] = dict(doc)
        return _Result(inserted_id=doc["_id"])

    async def find_one(self, query, projection=None):
        _id = query.get("_id")
        if _id is not None:
            doc = self.docs.get(_id)
            return dict(doc) if doc else None
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                return dict(d)
        return None

    async def update_one(self, query, update):
        _id = query.get("_id") or query.get("session_id")
        target = None
        for d in self.docs.values():
            key = d.get("_id") or d.get("session_id")
            if key == _id:
                target = d
                break
        if target is None:
            return _Result(matched_count=0)
        if "$set" in update:
            target.update(update["$set"])
        if "$push" in update:
            for k, v in update["$push"].items():
                target.setdefault(k, []).append(v)
        return _Result(matched_count=1)

    def find(self, query=None, projection=None):
        query = query or {}
        return _Cursor([d for d in self.docs.values()
                         if all(d.get(k) == v for k, v in query.items())])

    async def count_documents(self, query=None):
        query = query or {}
        return sum(1 for d in self.docs.values() if all(d.get(k) == v for k, v in query.items()))

    async def create_index(self, *a, **k):
        return None


class _SessionsColl(_Coll):
    """speaking_lab_sessions is keyed by session_id, not _id, matching
    the real collection's own convention."""

    async def insert_one(self, doc):
        self.docs[doc["session_id"]] = dict(doc)
        return _Result(inserted_id=doc["session_id"])

    async def find_one(self, query, projection=None):
        sid = query.get("session_id")
        if sid is not None:
            for d in self.docs.values():
                if d.get("session_id") == sid:
                    return dict(d)
            return None
        return await super().find_one(query, projection)


class _IdKeyedColl(_Coll):
    """prize_pools / experience_configs are keyed by their own ``_id``/``id``
    string field the SAME way ``events``/``templates`` already are here —
    but experience_configs uses the field name ``id`` (matching
    experience_config_tools.py's own convention), not ``_id``."""

    def __init__(self, id_field="_id"):
        super().__init__()
        self._id_field = id_field

    async def insert_one(self, doc):
        self.docs[doc[self._id_field]] = dict(doc)
        return _Result(inserted_id=doc[self._id_field])

    async def find_one(self, query, projection=None):
        _id = query.get(self._id_field)
        if _id is not None:
            doc = self.docs.get(_id)
            return dict(doc) if doc else None
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                return dict(d)
        return None

    async def update_one(self, query, update):
        _id = query.get(self._id_field)
        target = self.docs.get(_id) if _id is not None else None
        if target is None:
            return _Result(matched_count=0)
        if "$set" in update:
            target.update(update["$set"])
        return _Result(matched_count=1)


class _FakeDB:
    def __init__(self):
        self.templates = _Coll()
        self.events = _Coll()
        self.prize_pools = _IdKeyedColl(id_field="_id")
        self.experience_configs = _IdKeyedColl(id_field="id")

    def __getitem__(self, name):
        return {
            ee.TEMPLATES_COLL: self.templates,
            ee.EVENTS_COLL: self.events,
            "prize_pools": self.prize_pools,
            "experience_configs": self.experience_configs,
        }[name]


def _norm_student_id(raw):
    return str(raw or "").strip().lower()




# ═════════════════════════════════════════════════════════════════════════
# Event Templates — CRUD + lifecycle
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_template_defaults_to_draft():
    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="Weekly Speaking Lab", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 10}}, created_by="admin@test",
    )
    assert tmpl["status"] == "draft"
    assert tmpl["version"] == 1
    assert tmpl["runtime_defaults"] == {"entry_fee": 10}


@pytest.mark.asyncio
async def test_create_template_rejects_unknown_event_type():
    db = _FakeDB()
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.create_template(
            db, name="X", event_type="tournament", content={}, created_by="a",
        )
    assert exc.value.code == "invalid_event_type"


@pytest.mark.asyncio
async def test_create_template_rejects_empty_name():
    db = _FakeDB()
    with pytest.raises(ee.EventEngineError):
        await ee.create_template(
            db, name="  ", event_type="speaking_lab_session", content={}, created_by="a",
        )


@pytest.mark.asyncio
async def test_update_template_only_while_draft():
    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session", content={}, created_by="a",
    )
    updated = await ee.update_template(
        db, tmpl["_id"], {"name": "B", "timers": {"per_question_s": 30}}, updated_by="a",
    )
    assert updated["name"] == "B"
    assert updated["timers"] == {"per_question_s": 30}

    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.update_template(db, tmpl["_id"], {"name": "C"}, updated_by="a")
    assert exc.value.code == "template_not_editable"


@pytest.mark.asyncio
async def test_publish_unpublish_archive_lifecycle():
    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session", content={}, created_by="a",
    )
    published = await ee.publish_template(db, tmpl["_id"], updated_by="a")
    assert published["status"] == "published"
    assert published["published_at"] is not None

    reverted = await ee.unpublish_template(db, tmpl["_id"], updated_by="a")
    assert reverted["status"] == "draft"

    archived = await ee.archive_template(db, tmpl["_id"], updated_by="a")
    assert archived["status"] == "archived"
    assert archived["archived_at"] is not None

    with pytest.raises(ee.EventEngineError) as exc:
        await ee.publish_template(db, tmpl["_id"], updated_by="a")
    assert exc.value.code == "template_archived"


@pytest.mark.asyncio
async def test_duplicate_template_creates_new_draft_with_incremented_version():
    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="Original", event_type="speaking_lab_session",
        content={"timers": {"per_question_s": 20}}, created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    dup = await ee.duplicate_template(db, tmpl["_id"], created_by="b")
    assert dup["_id"] != tmpl["_id"]
    assert dup["status"] == "draft"
    assert dup["version"] == 2
    assert dup["name"] == "Original (copy)"
    assert dup["timers"] == {"per_question_s": 20}
    assert dup["duplicated_from"] == tmpl["_id"]


@pytest.mark.asyncio
async def test_list_templates_filters_by_status():
    db = _FakeDB()
    t1 = await ee.create_template(db, name="A", event_type="speaking_lab_session", content={}, created_by="a")
    t2 = await ee.create_template(db, name="B", event_type="speaking_lab_session", content={}, created_by="a")
    await ee.publish_template(db, t2["_id"], updated_by="a")

    drafts = await ee.list_templates(db, status="draft")
    published = await ee.list_templates(db, status="published")
    assert [t["_id"] for t in drafts] == [t1["_id"]]
    assert [t["_id"] for t in published] == [t2["_id"]]


# ═════════════════════════════════════════════════════════════════════════
# Events — creation requires a PUBLISHED template, config snapshot frozen
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_event_requires_published_template():
    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session", content={}, created_by="a",
    )
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    assert exc.value.code == "template_not_published"


@pytest.mark.asyncio
async def test_create_event_freezes_config_snapshot():
    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session",
        content={"timers": {"per_question_s": 15}, "runtime_defaults": {"entry_fee": 20}},
        created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    assert event["state"] == "draft"
    assert event["config_snapshot"]["timers"] == {"per_question_s": 15}
    assert event["entry_fee"] == 20

    # Now mutate the template's DRAFT-only content path is blocked once
    # published, but even if a later template version changes, THIS
    # event's frozen snapshot must never change.
    dup = await ee.duplicate_template(db, tmpl["_id"], created_by="a")
    await ee.update_template(db, dup["_id"], {"timers": {"per_question_s": 999}}, updated_by="a")
    reloaded = await ee.get_event(db, event["_id"])
    assert reloaded["config_snapshot"]["timers"] == {"per_question_s": 15}


@pytest.mark.asyncio
async def test_create_event_rejects_invalid_schedule():
    db = _FakeDB()
    tmpl = await ee.create_template(db, name="A", event_type="speaking_lab_session", content={}, created_by="a")
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.create_event(db, template_id=tmpl["_id"], schedule="Z", created_by="a")
    assert exc.value.code == "invalid_schedule"


@pytest.mark.asyncio
async def test_create_event_creates_companion_prize_pool():
    db = _FakeDB()
    tmpl = await ee.create_template(db, name="Weekly SL", event_type="speaking_lab_session", content={}, created_by="a")
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    assert event["prize_pool_id"] is not None

    pool = await pp.get_pool(db, event["prize_pool_id"])
    assert pool is not None
    assert pool["owner_type"] == "event"
    assert pool["owner_ref"] == event["_id"]
    assert pool["status"] == "open"
    assert pool["name"] == "Weekly SL — Prize Pool"


@pytest.mark.asyncio
async def test_create_event_rejects_out_of_range_entry_fee():
    db = _FakeDB()
    tmpl = await ee.create_template(db, name="A", event_type="speaking_lab_session", content={}, created_by="a")
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.create_event(db, template_id=tmpl["_id"], entry_fee=999999, created_by="a")
    assert exc.value.code == "invalid_entry_fee"


# ═════════════════════════════════════════════════════════════════════════
# Event lifecycle state machine
# ═════════════════════════════════════════════════════════════════════════
async def _published_event(db, **overrides):
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 10}}, created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    return await ee.create_event(db, template_id=tmpl["_id"], created_by="a", **overrides)


@pytest.mark.asyncio
async def test_full_happy_path_transitions_and_creates_underlying_session():
    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _published_event(db)
    assert event["state"] == "draft"

    event = await ee.transition_event(db, sessions, event["_id"], "scheduled", actor="a")
    assert event["state"] == "scheduled"
    assert event["linked_session_id"] is None  # not created until registration_open

    event = await ee.transition_event(db, sessions, event["_id"], "registration_open", actor="a")
    assert event["state"] == "registration_open"
    sid = event["linked_session_id"]
    assert sid is not None
    sess = await sessions.find_one({"session_id": sid})
    assert sess["status"] == "waiting"
    assert sess["entry_fee"] == 10
    assert sess["event_id"] == event["_id"]

    event = await ee.transition_event(db, sessions, event["_id"], "live", actor="a")
    sess = await sessions.find_one({"session_id": sid})
    assert sess["status"] == "active"

    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "settling", actor="a")
    sess = await sessions.find_one({"session_id": sid})
    assert sess["status"] == "closed"
    event = await ee.transition_event(db, sessions, event["_id"], "settled", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "archived", actor="a")
    assert event["state"] == "archived"
    assert len(event["state_history"]) == 8  # draft + 7 transitions

    # Reaching "settled" also closes the event's companion prize pool
    # (bookkeeping only — see _close_event_prize_pool).
    pool = await pp.get_pool(db, event["prize_pool_id"])
    assert pool["status"] == "settled"


@pytest.mark.asyncio
async def test_invalid_transition_is_rejected():
    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _published_event(db)
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.transition_event(db, sessions, event["_id"], "live", actor="a")
    assert exc.value.code == "invalid_transition"


@pytest.mark.asyncio
async def test_cancel_from_multiple_pre_settled_states():
    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _published_event(db)
    event = await ee.transition_event(db, sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "cancelled", actor="a")
    assert event["state"] == "cancelled"
    event = await ee.transition_event(db, sessions, event["_id"], "archived", actor="a")
    assert event["state"] == "archived"


@pytest.mark.asyncio
async def test_transition_on_unknown_event_raises_404():
    db = _FakeDB()
    sessions = _SessionsColl()
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.transition_event(db, sessions, "evt_missing", "scheduled", actor="a")
    assert exc.value.http_status == 404


# ═════════════════════════════════════════════════════════════════════════
# Draw/PrizePool wrapping — transition_event drives lucky_draw.py's
# EXISTING module-level _run_draw/_finalize_draw when lucky_draw_ctx is
# supplied. lucky_draw.py's own test suite already proves those two
# functions correct in depth; these tests only prove event_engine.py
# calls them at the right moment, with the right args, and handles
# their failures/idempotency correctly.
# ═════════════════════════════════════════════════════════════════════════
async def _live_event_with_ctx(db, sessions, *, prize_policy=None):
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 10}, "prize_policy": prize_policy or {}},
        created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    event = await ee.transition_event(db, sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "registration_open", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "live", actor="a")
    return event


def _lucky_draw_ctx(**overrides):
    ctx = {
        "sl_publish": None, "gas_url": "https://gas.example/exec",
        "treasury_id": "stu092", "treasury_password": "pw",
        "mock_gas": True, "log": None, "push_notify": None,
    }
    ctx.update(overrides)
    return ctx


@pytest.mark.asyncio
async def test_transition_to_drawing_without_ctx_is_pure_bookkeeping(monkeypatch):
    import lucky_draw
    calls = []

    async def _fake_run_draw(*a, **k):
        calls.append((a, k))
        return {}
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a")
    assert event["state"] == "drawing"
    assert calls == []  # no lucky_draw_ctx supplied -> unchanged bookkeeping-only behavior


@pytest.mark.asyncio
async def test_transition_to_drawing_with_ctx_calls_run_draw(monkeypatch):
    import lucky_draw
    calls = []

    async def _fake_run_draw(db_, sl_publish, session_id, config, gas_url, treasury_id,
                              treasury_password, mock_gas, log, *, granted_by, push_notify=None):
        calls.append({
            "session_id": session_id, "granted_by": granted_by,
            "num_winners": config.num_winners, "split": config.split,
        })
        return {"draw_id": "draw-1"}
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions, prize_policy={"num_winners": 2, "split": [60, 40]})
    ctx = _lucky_draw_ctx()
    updated = await ee.transition_event(
        db, sessions, event["_id"], "drawing", actor="teacher@test", lucky_draw_ctx=ctx,
    )
    assert updated["state"] == "drawing"
    assert len(calls) == 1
    assert calls[0]["session_id"] == updated["linked_session_id"]
    assert calls[0]["granted_by"] == "teacher@test"
    assert calls[0]["num_winners"] == 2
    assert calls[0]["split"] == [60, 40]


@pytest.mark.asyncio
async def test_transition_to_drawing_tolerates_already_run_409(monkeypatch):
    import lucky_draw
    from fastapi import HTTPException

    async def _fake_run_draw(*a, **k):
        raise HTTPException(status_code=409, detail="Lucky draw already run for this session")
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    updated = await ee.transition_event(
        db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=_lucky_draw_ctx(),
    )
    assert updated["state"] == "drawing"  # idempotent — treated as already succeeded


@pytest.mark.asyncio
async def test_transition_to_drawing_propagates_other_failures_and_blocks_state(monkeypatch):
    import lucky_draw
    from fastapi import HTTPException

    async def _fake_run_draw(*a, **k):
        raise HTTPException(status_code=503, detail="payout provider not configured")
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.transition_event(
            db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=_lucky_draw_ctx(),
        )
    assert exc.value.code == "lucky_draw_prepare_failed"
    assert exc.value.http_status == 503
    reloaded = await ee.get_event(db, event["_id"])
    assert reloaded["state"] == "live"  # state must NOT advance on a real failure


@pytest.mark.asyncio
async def test_transition_to_settling_calls_finalize_draw(monkeypatch):
    import lucky_draw
    calls = []

    async def _fake_run_draw(*a, **k):
        return {"draw_id": "draw-1"}

    async def _fake_finalize_draw(db_, sl_publish, session_id, gas_url, treasury_id,
                                   treasury_password, mock_gas, log, *, push_notify=None):
        calls.append(session_id)
        return {"draw_id": "draw-1", "finalized": True}
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)
    monkeypatch.setattr(lucky_draw, "_finalize_draw", _fake_finalize_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    ctx = _lucky_draw_ctx()
    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=ctx)
    event = await ee.transition_event(db, sessions, event["_id"], "settling", actor="a", lucky_draw_ctx=ctx)
    assert event["state"] == "settling"
    assert calls == [event["linked_session_id"]]


@pytest.mark.asyncio
async def test_transition_to_settling_propagates_failures_and_blocks_state(monkeypatch):
    import lucky_draw
    from fastapi import HTTPException

    async def _fake_run_draw(*a, **k):
        return {"draw_id": "draw-1"}

    async def _fake_finalize_draw(*a, **k):
        raise HTTPException(status_code=404, detail="No prepared draw found for this session")
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)
    monkeypatch.setattr(lucky_draw, "_finalize_draw", _fake_finalize_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    ctx = _lucky_draw_ctx()
    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=ctx)
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.transition_event(db, sessions, event["_id"], "settling", actor="a", lucky_draw_ctx=ctx)
    assert exc.value.code == "lucky_draw_finalize_failed"
    reloaded = await ee.get_event(db, event["_id"])
    assert reloaded["state"] == "drawing"  # state must NOT advance on a real failure


# ═════════════════════════════════════════════════════════════════════════
# Automatic Winner Showcase — auto-published right after a lucky draw
# finalizes (architecture continuation's "no manual dashboard editing").
# Champion/top winners/payout status all come from the SAME finalize
# response lucky_draw.py's own test suite already proves correct; these
# tests only prove event_engine.py reads it and auto-publishes correctly.
# ═════════════════════════════════════════════════════════════════════════
def _fake_winners(n=3):
    return [
        {"student_id": f"stu{i}", "display_name": f"Student {i}", "amount": 100 - i * 10,
         "transfer_ok": True, "transfer_err": ""}
        for i in range(n)
    ]


@pytest.mark.asyncio
async def test_settling_auto_publishes_winner_showcase(monkeypatch):
    import lucky_draw

    async def _fake_run_draw(*a, **k):
        return {"draw_id": "draw-1"}

    winners = _fake_winners(3)

    async def _fake_finalize_draw(*a, **k):
        return {"draw_id": "draw-1", "payout_status": "paid", "finalized_at": "2026-01-01T00:00:00+00:00",
                "winners": winners}
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)
    monkeypatch.setattr(lucky_draw, "_finalize_draw", _fake_finalize_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    ctx = _lucky_draw_ctx()
    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=ctx)
    event = await ee.transition_event(db, sessions, event["_id"], "settling", actor="teacher@test", lucky_draw_ctx=ctx)

    showcase = await db["experience_configs"].find_one({"experienceType": "winner_showcase", "key": event["_id"]})
    assert showcase is not None
    assert showcase["status"] == "published"
    assert showcase["content"]["eventId"] == event["_id"]
    assert showcase["content"]["champion"]["student_id"] == "stu0"
    assert showcase["content"]["topWinners"] == winners
    assert showcase["content"]["distributionCompleted"] is True
    assert showcase["content"]["payoutStatus"] == "paid"
    assert showcase["content"]["celebrationBanner"] is True
    assert showcase["createdBy"] == "event_engine:teacher@test"


@pytest.mark.asyncio
async def test_settling_does_not_publish_showcase_when_no_winners(monkeypatch):
    import lucky_draw

    async def _fake_run_draw(*a, **k):
        return {"draw_id": "draw-1"}

    async def _fake_finalize_draw(*a, **k):
        return {"draw_id": "draw-1", "payout_status": "paid", "winners": []}
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)
    monkeypatch.setattr(lucky_draw, "_finalize_draw", _fake_finalize_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    ctx = _lucky_draw_ctx()
    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=ctx)
    event = await ee.transition_event(db, sessions, event["_id"], "settling", actor="a", lucky_draw_ctx=ctx)

    assert db.experience_configs.docs == {}


@pytest.mark.asyncio
async def test_showcase_publish_failure_does_not_block_settlement(monkeypatch):
    import lucky_draw
    import experience_config_tools as ect

    async def _fake_run_draw(*a, **k):
        return {"draw_id": "draw-1"}

    async def _fake_finalize_draw(*a, **k):
        return {"draw_id": "draw-1", "payout_status": "paid", "winners": _fake_winners(1)}

    async def _boom_publish(*a, **k):
        raise RuntimeError("display layer is down")

    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)
    monkeypatch.setattr(lucky_draw, "_finalize_draw", _fake_finalize_draw)
    # _publish_winner_showcase does `from experience_config_tools import
    # auto_publish_experience_config` at call time, so patching the module
    # attribute here is what the real function will pick up.
    monkeypatch.setattr(ect, "auto_publish_experience_config", _boom_publish)

    db = _FakeDB()
    sessions = _SessionsColl()
    event = await _live_event_with_ctx(db, sessions)
    ctx = _lucky_draw_ctx()
    event = await ee.transition_event(db, sessions, event["_id"], "drawing", actor="a", lucky_draw_ctx=ctx)
    event = await ee.transition_event(db, sessions, event["_id"], "settling", actor="a", lucky_draw_ctx=ctx)
    assert event["state"] == "settling"  # settlement itself succeeded despite the showcase failure


def test_transition_route_threads_lucky_draw_ctx(monkeypatch):
    import lucky_draw
    calls = []

    async def _fake_run_draw(db_, sl_publish, session_id, config, gas_url, treasury_id,
                              treasury_password, mock_gas, log, *, granted_by, push_notify=None):
        calls.append(session_id)
        return {"draw_id": "draw-1"}
    monkeypatch.setattr(lucky_draw, "_run_draw", _fake_run_draw)

    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ee.register_event_engine_routes(
        api, db, sessions, entries, _norm_student_id, _admin_dep, _student_dep,
        lucky_draw_ctx=_lucky_draw_ctx(),
    )
    app.include_router(api)
    client = TestClient(app)

    tmpl_id = client.post("/api/v1/event-templates", json={
        "name": "A", "event_type": "speaking_lab_session",
    }).json()["template"]["_id"]
    client.post(f"/api/v1/event-templates/{tmpl_id}/publish")
    event_id = client.post("/api/v1/events", json={"template_id": tmpl_id}).json()["event"]["_id"]
    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "scheduled"})
    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "registration_open"})
    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "live"})
    resp = client.post(f"/api/v1/events/{event_id}/transition", json={"to": "drawing"})
    assert resp.status_code == 200
    assert len(calls) == 1


# ═════════════════════════════════════════════════════════════════════════
# Registration — delegates to the EXISTING _run_direct_join
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_register_participant_rejects_when_not_open():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    event = await _published_event(db)  # still "draft"
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.register_participant(
            db, sessions, entries, _norm_student_id,
            event_id=event["_id"], student_id="stu1", display_name="Stu One",
            idempotency_key="k1",
        )
    assert exc.value.code == "event_not_open"


@pytest.mark.asyncio
async def test_register_participant_delegates_to_run_direct_join(monkeypatch):
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    event = await _published_event(db)
    event = await ee.transition_event(db, sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "registration_open", actor="a")

    calls = []

    async def _fake_run_direct_join(db_, sl_sessions, sl_entries, norm_fn, session_id,
                                     canonical_id, display_name, idempotency_key):
        calls.append((session_id, canonical_id, display_name, idempotency_key))
        return {"outcome": "joined", "lucky_code": "ABC123"}

    import speaking_lab_direct_join as sldj
    monkeypatch.setattr(sldj, "_run_direct_join", _fake_run_direct_join)

    result = await ee.register_participant(
        db, sessions, entries, _norm_student_id,
        event_id=event["_id"], student_id="Stu1", display_name="Stu One",
        idempotency_key="k1",
    )
    assert result == {"outcome": "joined", "lucky_code": "ABC123"}
    assert calls == [(event["linked_session_id"], "stu1", "Stu One", "k1")]


# ═════════════════════════════════════════════════════════════════════════
# HTTP routes — real APIRouter + FastAPI + TestClient
# ═════════════════════════════════════════════════════════════════════════
class _Admin:
    email = "admin@test"


class _Student:
    student_id = "stu1"
    clean_id = "stu1"
    display_name = "Stu One"


async def _admin_dep():
    return _Admin()


async def _student_dep():
    return _Student()


def _make_client(db, sessions, entries):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ee.register_event_engine_routes(api, db, sessions, entries, _norm_student_id, _admin_dep, _student_dep)
    app.include_router(api)
    return TestClient(app)


def test_template_crud_routes():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    client = _make_client(db, sessions, entries)

    resp = client.post("/api/v1/event-templates", json={
        "name": "Weekly SL", "event_type": "speaking_lab_session",
        "runtime_defaults": {"entry_fee": 10},
    })
    assert resp.status_code == 200
    tmpl_id = resp.json()["template"]["_id"]

    assert client.get("/api/v1/event-templates").json()["templates"][0]["_id"] == tmpl_id
    assert client.get(f"/api/v1/event-templates/{tmpl_id}").status_code == 200

    resp = client.post(f"/api/v1/event-templates/{tmpl_id}/publish")
    assert resp.json()["template"]["status"] == "published"

    resp = client.post(f"/api/v1/event-templates/{tmpl_id}/duplicate")
    assert resp.json()["template"]["status"] == "draft"


def test_event_lifecycle_routes():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    client = _make_client(db, sessions, entries)

    tmpl_id = client.post("/api/v1/event-templates", json={
        "name": "A", "event_type": "speaking_lab_session",
    }).json()["template"]["_id"]
    client.post(f"/api/v1/event-templates/{tmpl_id}/publish")

    resp = client.post("/api/v1/events", json={"template_id": tmpl_id, "entry_fee": 5})
    assert resp.status_code == 200
    event_id = resp.json()["event"]["_id"]

    resp = client.post(f"/api/v1/events/{event_id}/transition", json={"to": "scheduled"})
    assert resp.json()["event"]["state"] == "scheduled"

    resp = client.post(f"/api/v1/events/{event_id}/transition", json={"to": "live"})
    assert resp.status_code == 400  # invalid transition from "scheduled"


# ═════════════════════════════════════════════════════════════════════════
# Runtime Dashboard — buckets, participant counts, health, prize estimate
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_runtime_dashboard_buckets_events_by_state():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    tmpl = await ee.create_template(db, name="A", event_type="speaking_lab_session", content={}, created_by="a")
    await ee.publish_template(db, tmpl["_id"], updated_by="a")

    draft_evt = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    live_evt = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    live_evt = await ee.transition_event(db, sessions, live_evt["_id"], "scheduled", actor="a")
    live_evt = await ee.transition_event(db, sessions, live_evt["_id"], "registration_open", actor="a")
    live_evt = await ee.transition_event(db, sessions, live_evt["_id"], "live", actor="a")
    done_evt = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    done_evt = await ee.transition_event(db, sessions, done_evt["_id"], "scheduled", actor="a")
    done_evt = await ee.transition_event(db, sessions, done_evt["_id"], "cancelled", actor="a")

    dashboard = await ee.get_runtime_dashboard(db, entries)
    assert [e["_id"] for e in dashboard["upcoming"]] == [draft_evt["_id"]]
    assert [e["_id"] for e in dashboard["active"]] == [live_evt["_id"]]
    assert [e["_id"] for e in dashboard["finished"]] == [done_evt["_id"]]


@pytest.mark.asyncio
async def test_runtime_dashboard_counts_participants_and_estimates_prize_pool():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 10}}, created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    event = await ee.transition_event(db, sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "registration_open", actor="a")
    session_id = event["linked_session_id"]
    await entries.insert_one({"_id": "e1", "session_id": session_id, "student_id": "stu1"})
    await entries.insert_one({"_id": "e2", "session_id": session_id, "student_id": "stu2"})

    dashboard = await ee.get_runtime_dashboard(db, entries)
    active = dashboard["active"][0]
    assert active["participant_count"] == 2
    assert active["estimated_prize_pool"] == 20
    assert active["health"] == "healthy"
    assert active["template_name"] == "A"


@pytest.mark.asyncio
async def test_runtime_dashboard_flags_no_registrations_health():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    tmpl = await ee.create_template(db, name="A", event_type="speaking_lab_session", content={}, created_by="a")
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    event = await ee.transition_event(db, sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, sessions, event["_id"], "registration_open", actor="a")

    dashboard = await ee.get_runtime_dashboard(db, entries)
    assert dashboard["active"][0]["health"] == "no_registrations"
    assert dashboard["active"][0]["participant_count"] == 0


def test_dashboard_route_is_registered_before_dynamic_event_id_route():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    client = _make_client(db, sessions, entries)

    resp = client.get("/api/v1/events/dashboard")
    assert resp.status_code == 200
    assert resp.json() == {"active": [], "upcoming": [], "finished": []}


def test_available_events_route_only_shows_open_events():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    client = _make_client(db, sessions, entries)

    tmpl_id = client.post("/api/v1/event-templates", json={
        "name": "A", "event_type": "speaking_lab_session",
    }).json()["template"]["_id"]
    client.post(f"/api/v1/event-templates/{tmpl_id}/publish")
    event_id = client.post("/api/v1/events", json={"template_id": tmpl_id}).json()["event"]["_id"]

    assert client.get("/api/v1/events/available").json()["events"] == []

    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "scheduled"})
    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "registration_open"})
    available = client.get("/api/v1/events/available").json()["events"]
    assert len(available) == 1
    assert available[0]["_id"] == event_id


def test_available_events_route_includes_template_name():
    db = _FakeDB()
    sessions = _SessionsColl()
    entries = _Coll()
    client = _make_client(db, sessions, entries)

    tmpl_id = client.post("/api/v1/event-templates", json={
        "name": "Weekly Speaking Lab", "event_type": "speaking_lab_session",
    }).json()["template"]["_id"]
    client.post(f"/api/v1/event-templates/{tmpl_id}/publish")
    event_id = client.post("/api/v1/events", json={"template_id": tmpl_id}).json()["event"]["_id"]
    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "scheduled"})
    client.post(f"/api/v1/events/{event_id}/transition", json={"to": "registration_open"})

    available = client.get("/api/v1/events/available").json()["events"]
    assert available[0]["template_name"] == "Weekly Speaking Lab"
