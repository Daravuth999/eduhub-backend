"""
Login Reward claim — celebration push wiring (bug report follow-up)
=====================================================================

A bug report claimed that push notifications stopped firing after a
student successfully claims a Login Reward campaign, allegedly regressed
by the Architecture Reconstruction Phase 1 conversion of
``login_reward_tools.py`` from ``exec()``-into-server-namespace loading to
explicit-DI (``register_login_reward_routes(api, db, ..., fan_out_push,
...)``).

Code review traced the DI wiring end-to-end (server.py -> factory params ->
closures) and found no ``globals().get(...)`` leftovers and correct
positional argument order. This test exercises the REAL production claim
endpoint (``POST /rewards/login-campaigns/{id}/claim``) registered by the
real module, with the GAS treasury HTTP call mocked (network boundary) and
a spy standing in for ``fan_out_push`` (also a collaborator boundary — the
real function is exercised in other suites). It proves the celebration
push actually fires after a successful credit, protecting this exact path
against a future regression.

Run from the backend folder:

    pytest -q tests/test_login_reward_claim_push.py --asyncio-mode=auto
"""

from __future__ import annotations

import asyncio
import copy
import pathlib
import sys
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import APIRouter

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# ─────────────────────────────────────────────────────────────────────────────
# Minimal Mongo-compatible fake (same shape as test_mystery_box_notifications.py)
# ─────────────────────────────────────────────────────────────────────────────
def _match(doc, query) -> bool:
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if isinstance(v, dict) and "$in" in v:
            if doc.get(k) not in v["$in"]:
                return False
            continue
        if isinstance(v, dict) and "$lt" in v:
            if not (doc.get(k) is not None and doc.get(k) < v["$lt"]):
                return False
            continue
        if doc.get(k) != v:
            return False
    return True


class _Result:
    def __init__(self, matched=0, modified=0, upserted_id=None):
        self.matched_count = matched
        self.modified_count = modified
        self.upserted_id = upserted_id


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return self

    def limit(self, n):
        self._docs = self._docs[: int(n)]
        return self

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
        self._lock = asyncio.Lock()

    async def insert_one(self, doc):
        async with self._lock:
            self._docs.append(copy.deepcopy(doc))
        return _Result()

    async def find_one(self, query, projection=None):
        async with self._lock:
            for d in self._docs:
                if _match(d, query):
                    return copy.deepcopy(d)
        return None

    def find(self, query, projection=None):
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])

    async def find_one_and_update(self, query, update, return_document=False):
        async with self._lock:
            target = next((d for d in self._docs if _match(d, query)), None)
            if target is None:
                return None
            if "$set" in update:
                target.update(update["$set"])
            if "$inc" in update:
                for k, v in update["$inc"].items():
                    target[k] = (target.get(k) or 0) + v
            if "$unset" in update:
                for k in update["$unset"]:
                    target.pop(k, None)
            return copy.deepcopy(target)

    async def update_one(self, query, update, upsert=False):
        async with self._lock:
            target = next((d for d in self._docs if _match(d, query)), None)
            if target is None:
                return _Result(matched=0, modified=0)
            before = copy.deepcopy(target)
            if "$set" in update:
                target.update(update["$set"])
            changed = target != before
            return _Result(matched=1, modified=1 if changed else 0)

    async def create_index(self, *a, **k):
        return "idx"


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


# ─────────────────────────────────────────────────────────────────────────────
# Fake collaborators for register_login_reward_routes(...)
# ─────────────────────────────────────────────────────────────────────────────
class _FakeStudent:
    def __init__(self, student_id="stu001"):
        self.student_id = student_id
        self.clean_id = student_id


async def _require_student():
    return _FakeStudent()


async def _require_admin():  # pragma: no cover - not exercised here
    return _FakeStudent()


class PushRecorder:
    """Fake `_fan_out_push` (the DI param the claim endpoint's celebration
    push closure captures)."""
    def __init__(self):
        self.calls = []

    async def __call__(self, subs_query, title, body, url):
        self.calls.append({"query": subs_query, "title": title, "body": body, "url": url})
        return (1, 0)


def _build_router(db, *, fan_out_push):
    import login_reward_tools as lrt_module

    api = APIRouter()
    hooks = lrt_module.register_login_reward_routes(
        api, db, _require_student, _require_admin, _FakeStudent, _FakeStudent,
        fan_out_push, "https://gas.example/exec", "treasury_id", "treasury_password",
        lambda *a, **k: {}, lambda n=8: "ABC12345",
    )
    db["login_reward_claims"].set_unique = lambda *a, **k: None  # unique-index no-op
    return api, hooks


def _find_endpoint(api, path, method):
    for route in api.routes:
        if route.path == path and method in route.methods:
            return route.endpoint
    raise AssertionError(f"route not found: {method} {path}")


async def _seed_campaign(db, *, campaign_id="camp1", points=20, reward_kind="points"):
    await db["login_reward_campaigns"].insert_one({
        "id": campaign_id,
        "enabled": True,
        "name": "Test campaign",
        "reward_kind": reward_kind,
        "reward_points": points,
        "start_at": None,
        "end_at": None,
        "audience_mode": "all",
        "include_ids": [],
        "exclude_ids": [],
    })
    return campaign_id


class _FakeGasResponse:
    status_code = 200

    def json(self):
        return {"success": True}


@pytest.mark.asyncio
async def test_successful_claim_fires_exactly_one_celebration_push():
    """The real regression-report scenario: student claims, GAS credit
    succeeds, and a celebratory push must fire exactly once."""
    db = _FakeDB()
    push = PushRecorder()
    api, _hooks = _build_router(db, fan_out_push=push)
    campaign_id = await _seed_campaign(db, points=20)

    claim_fn = _find_endpoint(api, "/rewards/login-campaigns/{campaign_id}/claim", "POST")

    with patch("login_reward_tools.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=_FakeGasResponse())
        result = await claim_fn(campaign_id, student=_FakeStudent("stu001"))

    assert result["success"] is True
    assert result["status"] == "credited"
    assert len(push.calls) == 1, f"expected exactly one celebration push, got {len(push.calls)}"
    assert "20" in push.calls[0]["title"] or "20" in push.calls[0]["body"]
    assert push.calls[0]["url"] == "/portal"


@pytest.mark.asyncio
async def test_failed_gas_credit_sends_no_push():
    """A failed treasury credit must never fire a celebration push — the
    student was not actually rewarded."""
    from fastapi import HTTPException

    db = _FakeDB()
    push = PushRecorder()
    api, _hooks = _build_router(db, fan_out_push=push)
    campaign_id = await _seed_campaign(db, points=20)

    claim_fn = _find_endpoint(api, "/rewards/login-campaigns/{campaign_id}/claim", "POST")

    class _FailResponse:
        status_code = 200
        def json(self):
            return {"success": False, "message": "insufficient treasury balance"}

    with patch("login_reward_tools.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=_FailResponse())
        with pytest.raises(HTTPException):
            await claim_fn(campaign_id, student=_FakeStudent("stu002"))

    assert push.calls == []


@pytest.mark.asyncio
async def test_push_helper_failure_never_breaks_the_claim_response():
    """Best-effort guarantee: if fan_out_push itself raises, the claim must
    still report success (the reward is already durably credited)."""
    db = _FakeDB()

    async def _raising_push(*a, **k):
        raise RuntimeError("webpush infra exception")

    api, _hooks = _build_router(db, fan_out_push=_raising_push)
    campaign_id = await _seed_campaign(db, points=15)

    claim_fn = _find_endpoint(api, "/rewards/login-campaigns/{campaign_id}/claim", "POST")

    with patch("login_reward_tools.httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=_FakeGasResponse())
        result = await claim_fn(campaign_id, student=_FakeStudent("stu003"))

    assert result["success"] is True
    assert result["status"] == "credited"
