"""tests/test_lucky_draw_winner_showcase.py
=====================================================
Friday Speaking Labs Feature 1: the classroom Lucky Draw finalize route
(POST /speaking-lab/sessions/{id}/lucky-draw/finalize) now auto-publishes
a PWA Home Dashboard winner showcase, tagged `source:
"speaking_lab_classroom_draw"`, reusing event_engine.py's own generalized
`_publish_winner_showcase` — the SAME publish path Event Engine's own
settlement uses, not a second showcase system.

Harness (fake Mongo with arrayFilters/positional-update support, and the
pre-seeded "already prepared" draw pattern) copied from
tests/test_lucky_draw_recovery.py, which already proves this shape is
sufficient to drive the real, unmodified `_finalize_draw` per-winner state
machine (FIX 2-13) end to end with mock_gas=True.

Exercises the ACTUAL HTTP route (dev-mode registration, require_admin=None,
so no admin-auth scaffolding is needed) rather than calling
`_publish_winner_showcase` directly, so this specifically proves the new
wiring inside `lucky_draw_finalize_post`/`lucky_draw_finalize_post_dev`
— not just that the underlying function works in isolation (that is
covered separately in tests/test_event_engine.py).
"""
from __future__ import annotations

import copy
import datetime as _dt

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import lucky_draw as ld


# ── fake Mongo supporting arrayFilters + positional updates (copied from
# test_lucky_draw_recovery.py's own proven harness) ────────────────────────
def _match_value(actual, cond) -> bool:
    if isinstance(cond, dict):
        if "$ne" in cond:
            return actual != cond["$ne"]
        if "$in" in cond:
            return actual in cond["$in"]
        if "$exists" in cond:
            return (actual is not None) == bool(cond["$exists"])
        if "$gte" in cond:
            return actual is not None and actual >= cond["$gte"]
        if "$lt" in cond:
            return actual is not None and actual < cond["$lt"]
    return actual == cond


def _match(doc, query) -> bool:
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if not _match_value(doc.get(k), v):
            return False
    return True


def _match_elem(elem, filters) -> bool:
    for filt in filters:
        for k, cond in filt.items():
            field = k.split(".", 1)[1] if "." in k else k
            if not _match_value(elem.get(field), cond):
                return False
    return True


def _deep(d):
    return copy.deepcopy(d)


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Col:
    def __init__(self, name):
        self.name = name
        self._docs: list[dict] = []

    async def create_index(self, *a, **k):
        return "idx"

    async def insert_one(self, doc):
        self._docs.append(_deep(doc))
        return type("R", (), {"inserted_id": "x"})()

    async def find_one(self, query, projection=None, sort=None):
        docs = [d for d in self._docs if _match(d, query)]
        if sort:
            for field, direction in reversed(sort):
                docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return _deep(docs[0]) if docs else None

    def find(self, query, projection=None):
        return _Cursor([_deep(d) for d in self._docs if _match(d, query)])

    async def count_documents(self, query):
        return sum(1 for d in self._docs if _match(d, query))

    async def update_one(self, query, update, array_filters=None, upsert=False):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = dict(query)
                nd.update(update.get("$set", {}))
                self._docs.append(nd)
                return type("R", (), {"matched_count": 1, "modified_count": 1})()
            return type("R", (), {"matched_count": 0, "modified_count": 0})()
        changed = self._apply(target, update, array_filters or [])
        return type("R", (), {"matched_count": 1, "modified_count": 1 if changed else 0})()

    def _apply(self, doc, update, array_filters) -> bool:
        changed = False
        matched_ids: dict[str, set] = {}
        for op, fields in update.items():
            for key in fields:
                if ".$[" in key:
                    arr_field = key.split(".$[", 1)[0]
                    if arr_field not in matched_ids:
                        ids = set()
                        for i, elem in enumerate(doc.get(arr_field, [])):
                            if _match_elem(elem, array_filters):
                                ids.add(i)
                        matched_ids[arr_field] = ids
        for op, fields in update.items():
            for key, val in fields.items():
                if ".$[" in key:
                    arr_field = key.split(".$[", 1)[0]
                    sub = key.rsplit(".", 1)[1]
                    for i in matched_ids.get(arr_field, set()):
                        elem = doc[arr_field][i]
                        if op == "$set":
                            if elem.get(sub) != val:
                                elem[sub] = val
                                changed = True
                        elif op == "$inc":
                            elem[sub] = (elem.get(sub) or 0) + val
                            changed = True
                else:
                    if op == "$set":
                        if doc.get(key) != val:
                            doc[key] = val
                            changed = True
                    elif op == "$inc":
                        doc[key] = (doc.get(key) or 0) + val
                        changed = True
        return changed


class _DB:
    def __init__(self):
        self._cols: dict[str, _Col] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _Col(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


def _now_iso(offset_seconds=0):
    return (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_seconds)).isoformat()


async def _seed_prepared_draw(db, *, draw_id="draw-1", session_id="sess-1", winners=None):
    """Insert a session + a prepared (un-finalized) draw, mirroring what the
    protected `_run_draw` would persist (transfer_ok=None per winner) —
    lets the finalize route be exercised directly without also driving the
    separate prepare step."""
    if winners is None:
        winners = [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None, "transfer_err": "", "was_slot_picked": False},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None, "transfer_err": "", "was_slot_picked": False},
        ]
    await db.speaking_lab_sessions.insert_one({
        "session_id": session_id, "lucky_draw_done": True,
        "lucky_draw_prepared_draw_id": draw_id,
    })
    await db.speaking_lab_lucky_draws.insert_one({
        "draw_id": draw_id, "session_id": session_id, "pool_total": 80,
        "num_winners": len(winners), "split": [50, 30, 20],
        "results": winners, "mock": False, "finalized": False,
        "prepared_at": _now_iso(-300), "drawn_at": _now_iso(-300),
    })
    return draw_id, session_id


async def _noop_publish(session_id, event):
    return None


def _build_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ld.register_lucky_draw_routes(
        api, db, _noop_publish, "https://gas.example/exec", "stu092", "secret-pw",
        log=None, mock_gas=True, require_admin=None, push_notify=None,
    )
    app.include_router(api)
    return TestClient(app)


@pytest.mark.asyncio
async def test_classroom_finalize_route_publishes_winner_showcase_tagged_classroom_draw():
    db = _DB()
    await _seed_prepared_draw(db, session_id="sl_showcase_1")
    client = _build_client(db)

    fin = client.post("/api/speaking-lab/sessions/sl_showcase_1/lucky-draw/finalize")
    assert fin.status_code == 200, fin.text
    resp = fin.json()
    assert resp["winners"]
    assert resp["finalized"] is True

    showcase = await db["experience_configs"].find_one(
        {"experienceType": "winner_showcase", "key": "sl:sl_showcase_1"},
    )
    assert showcase is not None
    assert showcase["content"]["source"] == "speaking_lab_classroom_draw"
    assert showcase["content"]["eventName"] == "Friday Speaking Lab"
    assert showcase["content"]["champion"]["student_id"] == "stuA"
    assert showcase["content"]["topWinners"] == resp["winners"]


@pytest.mark.asyncio
async def test_classroom_finalize_route_response_unaffected_by_showcase_publish_failure(monkeypatch):
    """A showcase-publish failure must never affect the finalize response
    the teacher's screen already depends on — same fail-safe contract
    Event Engine's own showcase publish already has."""
    import event_engine as ee

    async def _boom(*a, **k):
        raise RuntimeError("display layer is down")
    monkeypatch.setattr(ee, "_publish_winner_showcase", _boom)

    db = _DB()
    await _seed_prepared_draw(db, session_id="sl_showcase_2")
    client = _build_client(db)

    fin = client.post("/api/speaking-lab/sessions/sl_showcase_2/lucky-draw/finalize")
    assert fin.status_code == 200, fin.text
    assert fin.json()["ok"] is True
    assert db["experience_configs"]._docs == []  # publish never succeeded, and that's fine


@pytest.mark.asyncio
async def test_classroom_finalize_route_skips_showcase_when_no_winners():
    db = _DB()
    await _seed_prepared_draw(db, session_id="sl_showcase_3", winners=[])
    client = _build_client(db)

    fin = client.post("/api/speaking-lab/sessions/sl_showcase_3/lucky-draw/finalize")
    assert fin.status_code == 200, fin.text
    assert db["experience_configs"]._docs == []
