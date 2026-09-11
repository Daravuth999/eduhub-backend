"""
Friday Speaking Labs Feature 2 — extend-to-group
=====================================================
Proves the new POST /speaking-lab/mystery-box/rounds/{rid}/extend-to-group
route: clones an ALREADY-GRANTED Solo-Mode prize onto the rest of a Group
Mode representative's teammates, reusing the exact same
`_mbt_grant_prize`/idempotent-claim/`notify_mystery_box_prize` machinery
`mbt_reveal_round` itself uses — never a second reward system, never a
re-roll.

Reuses the SAME harness as test_mystery_box_notifications.py (import the
real mystery_box_tools.py module and call its register_mystery_box_routes
factory with fakes standing in for its explicit-DI collaborators), so this
exercises the ACTUAL production code end to end.
"""
from __future__ import annotations

import asyncio
import copy
import pathlib
import sys

import pytest
from fastapi import APIRouter, HTTPException

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# ── same minimal fake Mongo as test_mystery_box_notifications.py ──────────
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
        if doc.get(k) != v:
            return False
    return True


class _Result:
    def __init__(self, matched=0, modified=0):
        self.matched_count = matched
        self.modified_count = modified


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
        self._unique_keys: list[tuple[str, ...]] = []
        self._lock = asyncio.Lock()

    def set_unique(self, *fields):
        self._unique_keys.append(tuple(fields))

    def _check_unique(self, doc, ignore=None):
        for fields in self._unique_keys:
            key = tuple(doc.get(f) for f in fields)
            if any(v is None for v in key):
                continue
            for other in self._docs:
                if other is ignore:
                    continue
                if tuple(other.get(f) for f in fields) == key:
                    raise RuntimeError(f"duplicate key {fields}={key}")

    async def insert_one(self, doc):
        async with self._lock:
            d = copy.deepcopy(doc)
            self._check_unique(d)
            self._docs.append(d)
        return _Result()

    async def find_one(self, query, projection=None):
        async with self._lock:
            for d in self._docs:
                if _match(d, query):
                    return copy.deepcopy(d)
        return None

    def find(self, query, projection=None):
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])

    async def count_documents(self, query):
        async with self._lock:
            return sum(1 for d in self._docs if _match(d, query))

    async def update_one(self, query, update, upsert=False):
        async with self._lock:
            target = next((d for d in self._docs if _match(d, query)), None)
            if target is None:
                if upsert:
                    nd = {k: v for k, v in query.items() if not isinstance(v, dict)}
                    if "$setOnInsert" in update:
                        nd.update(update["$setOnInsert"])
                    if "$set" in update:
                        nd.update(update["$set"])
                    self._check_unique(nd)
                    self._docs.append(nd)
                    return _Result(matched=0, modified=1)
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


class _Admin:
    email = "teacher@school.example"


async def _require_admin():
    return _Admin()


async def _require_student():  # pragma: no cover - not exercised here
    return _Admin()


class TreasuryCredit:
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    async def __call__(self, *, student_clean_id, points, campaign_id, campaign_name):
        self.calls.append(student_clean_id)
        if self.ok:
            return {"ok": True}
        return {"ok": False, "error": "treasury refused"}


class VoucherIssuer:
    async def __call__(self, synth_camp, student_clean_id, student_id_norm):
        return {"discount_label": "20% off", "expires_at": "2026-12-31T00:00:00Z"}


class PushRecorder:
    def __init__(self, mode="sent"):
        self.mode = mode
        self.calls = []

    async def __call__(self, subs_query, title, body, url):
        self.calls.append({"query": subs_query, "title": title, "body": body})
        if self.mode == "raise":
            raise RuntimeError("webpush infra exception")
        return (1, 0)


class _FakeLoginRewardHooks:
    def __init__(self, credit, issuer):
        self.credit_via_treasury = credit
        self.issue_voucher_for_claim = issuer


def _build_namespace(db, *, credit=None, push=None, subscriber_count=1):
    push = push if push is not None else PushRecorder(mode="sent")

    class _PushSubs:
        async def count_documents(self, query):
            return subscriber_count

    import mystery_box_tools as mbt_module

    hooks = _FakeLoginRewardHooks(credit or TreasuryCredit(ok=True), VoucherIssuer())
    ns = mbt_module.register_mystery_box_routes(
        APIRouter(), db, _require_admin, _require_student, push, _PushSubs(), hooks,
    )
    db["speaking_lab_mystery_claims"].set_unique("round_id", "student_id_norm")
    return ns, push


async def _seed_round(db, *, rid="round-1", prize_type="points", points=25, title="Coin Stash"):
    prize_id = "prz_1"
    await db["mystery_box_prize_templates"].insert_one({
        "id": prize_id, "type": prize_type, "title": title,
        "points": points, "quantity": 1, "expires_in_days": 30,
    })
    await db["speaking_lab_mystery_rounds"].insert_one({
        "id": rid, "campaign_id": "camp-1", "status": "open", "box_count": 3,
        "layout": [{"index": i, "prize_id": prize_id, "type": prize_type, "rarity": "common"} for i in range(3)],
        "selected_box_index": 0,
    })
    return rid


async def _reveal(ns, rid, *, student_id="rep001", student_name="Rep", box_index=0):
    RevealIn = ns["_RevealIn"]
    payload = RevealIn(student_id=student_id, student_name=student_name, box_index=box_index)
    return await ns["mbt_reveal_round"](rid, payload, admin=_Admin())


async def _extend(ns, rid, *, representative_student_id="rep001", member_student_ids=None):
    ExtendIn = ns["_ExtendToGroupIn"]
    payload = ExtendIn(
        representative_student_id=representative_student_id,
        member_student_ids=member_student_ids or [],
    )
    return await ns["mbt_extend_to_group"](rid, payload, admin=_Admin())


@pytest.mark.asyncio
async def test_extend_to_group_grants_same_prize_to_all_members():
    db = _FakeDB()
    ns, push = _build_namespace(db)
    rid = await _seed_round(db, prize_type="points", points=25, title="Coin Stash")
    await _reveal(ns, rid, student_id="rep001")

    result = await _extend(ns, rid, representative_student_id="rep001",
                            member_student_ids=["memA", "memB"])

    assert result["prize_title"] == "Coin Stash"
    assert result["prize_type"] == "points"
    outcomes = {m["student_id"]: m for m in result["members"]}
    assert outcomes["memA"]["outcome"] == "granted"
    assert outcomes["memB"]["outcome"] == "granted"
    assert outcomes["memA"]["claim"]["prize_title"] == "Coin Stash"
    assert outcomes["memA"]["claim"]["selected_box_index"] == 0
    assert outcomes["memA"]["claim"]["granted_via"] == "group_extension"
    assert outcomes["memA"]["claim"]["representative_student_id"] == "rep001"

    # Real treasury credit happened for each member, same amount as the rep.
    assert push.calls  # notify fired for at least the granted members


@pytest.mark.asyncio
async def test_extend_to_group_is_idempotent_on_repeat_calls():
    db = _FakeDB()
    ns, push = _build_namespace(db)
    rid = await _seed_round(db)
    await _reveal(ns, rid, student_id="rep001")

    r1 = await _extend(ns, rid, member_student_ids=["memA", "memB"])
    r2 = await _extend(ns, rid, member_student_ids=["memA", "memB"])

    assert {m["outcome"] for m in r1["members"]} == {"granted"}
    # Second call finds both already granted — never a second grant.
    assert {m["outcome"] for m in r2["members"]} == {"already_claimed"}
    # Exactly one claim row per member exists, not two.
    assert await db["speaking_lab_mystery_claims"].count_documents({"student_id_norm": "mema"}) == 1
    assert await db["speaking_lab_mystery_claims"].count_documents({"student_id_norm": "memb"}) == 1


@pytest.mark.asyncio
async def test_extend_to_group_is_idempotent_with_a_partial_retry():
    """A retry after SOME members already succeeded only fills in what's
    genuinely missing — the already-granted member is reported as such and
    never re-granted."""
    db = _FakeDB()
    ns, push = _build_namespace(db)
    rid = await _seed_round(db)
    await _reveal(ns, rid, student_id="rep001")

    await _extend(ns, rid, member_student_ids=["memA"])
    result = await _extend(ns, rid, member_student_ids=["memA", "memB"])

    outcomes = {m["student_id"]: m["outcome"] for m in result["members"]}
    assert outcomes["memA"] == "already_claimed"
    assert outcomes["memB"] == "granted"


@pytest.mark.asyncio
async def test_extend_to_group_rejects_when_representative_not_granted():
    db = _FakeDB()
    ns, _push = _build_namespace(db)
    rid = await _seed_round(db)
    # No reveal ever happened for the representative.
    with pytest.raises(HTTPException) as exc:
        await _extend(ns, rid, representative_student_id="rep001", member_student_ids=["memA"])
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_extend_to_group_rejects_when_round_still_open():
    db = _FakeDB()
    ns, _push = _build_namespace(db)
    rid = await _seed_round(db)  # status stays "open" — never revealed
    with pytest.raises(HTTPException) as exc:
        await _extend(ns, rid, member_student_ids=["memA"])
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_extend_to_group_never_re_rolls_uses_the_representatives_exact_box():
    """Even with a multi-box layout of DIFFERENT prizes, every member gets
    the SAME box/prize the representative's own reveal already selected —
    never a fresh pick."""
    db = _FakeDB()
    ns, _push = _build_namespace(db)
    rid = "round-multi"
    await db["mystery_box_prize_templates"].insert_one({
        "id": "prz_gold", "type": "points", "title": "Gold Stash", "points": 100, "quantity": 1,
    })
    await db["mystery_box_prize_templates"].insert_one({
        "id": "prz_bronze", "type": "points", "title": "Bronze Stash", "points": 5, "quantity": 1,
    })
    await db["speaking_lab_mystery_rounds"].insert_one({
        "id": rid, "campaign_id": "camp-1", "status": "open", "box_count": 2,
        "layout": [
            {"index": 0, "prize_id": "prz_gold", "type": "points", "rarity": "rare"},
            {"index": 1, "prize_id": "prz_bronze", "type": "points", "rarity": "common"},
        ],
        "selected_box_index": 1,  # representative picked the BRONZE box
    })
    await _reveal(ns, rid, student_id="rep001", box_index=1)

    result = await _extend(ns, rid, member_student_ids=["memA"])
    assert result["prize_title"] == "Bronze Stash"
    claim = result["members"][0]["claim"]
    assert claim["prize_title"] == "Bronze Stash"
    assert claim["selected_box_index"] == 1


@pytest.mark.asyncio
async def test_extend_to_group_excludes_the_representative_from_member_list():
    db = _FakeDB()
    ns, _push = _build_namespace(db)
    rid = await _seed_round(db)
    await _reveal(ns, rid, student_id="rep001")

    result = await _extend(ns, rid, representative_student_id="rep001",
                            member_student_ids=["rep001", "memA"])
    student_ids = {m["student_id"] for m in result["members"]}
    assert "rep001" not in student_ids
    assert "memA" in student_ids


@pytest.mark.asyncio
async def test_extend_to_group_deduplicates_member_ids():
    db = _FakeDB()
    ns, _push = _build_namespace(db)
    rid = await _seed_round(db)
    await _reveal(ns, rid, student_id="rep001")

    result = await _extend(ns, rid, member_student_ids=["memA", "memA", "MEMA"])
    granted = [m for m in result["members"] if m["outcome"] == "granted"]
    assert len(granted) == 1
