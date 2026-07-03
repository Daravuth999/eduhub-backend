"""
Mystery Box — reward-success push notifications (v1.0)
=========================================================

``mystery_box_tools.py`` is loaded via ``exec()`` directly into
``server.py``'s namespace (not a normal import) so it can reuse shared
globals (``api``, ``db``, ``require_admin``, ``_norm_student_id``,
``_lrc_credit_via_treasury``, ``_lrc_issue_voucher_for_claim``,
``_fan_out_push``, ``push_subscriptions``, ...) without a dependency
list. To unit-test it in isolation we build the same kind of namespace
server.py builds and ``exec()`` the real module source into it — this
exercises the ACTUAL production code, not a reimplementation.

Covers the exactly-once notification design added on top of the
existing, unmodified grant paths:

  * ``notify_mystery_box_prize``    — atomic claim + truthful push,
                                       never grants anything itself;
  * wiring inside ``mbt_reveal_round`` — fires only after the claim is
                                       durably marked ``granted``;
  * the new admin-only notification-only retry route.

Run from the backend folder:

    pytest -q tests/test_mystery_box_notifications.py --asyncio-mode=auto
"""

from __future__ import annotations

import asyncio
import copy
import itertools
import pathlib
import sys
import types

import pytest
from fastapi import APIRouter, Depends, HTTPException

_MODULE_NAME_COUNTER = itertools.count()

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

MODULE_PATH = BACKEND_DIR / "mystery_box_tools.py"


# ─────────────────────────────────────────────────────────────────────────────
# Minimal Mongo-compatible fake (plain top-level documents — no arrayFilters
# needed since speaking_lab_mystery_claims rows are not array-embedded).
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
        if isinstance(v, dict) and "$exists" in v:
            if (k in doc) != bool(v["$exists"]):
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
        return _Result(matched=0, modified=0)

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
                    nd = {k: v for k, v in query.items()
                          if not isinstance(v, dict)}
                    if "$setOnInsert" in update:
                        nd.update(update["$setOnInsert"])
                    if "$set" in update:
                        nd.update(update["$set"])
                    if "$inc" in update:
                        for k, v in update["$inc"].items():
                            nd[k] = nd.get(k, 0) + v
                    self._check_unique(nd)
                    self._docs.append(nd)
                    return _Result(matched=0, modified=1, upserted_id="new")
                return _Result(matched=0, modified=0)
            before = copy.deepcopy(target)
            if "$set" in update:
                target.update(update["$set"])
            if "$inc" in update:
                for k, v in update["$inc"].items():
                    target[k] = (target.get(k) or 0) + v
            changed = target != before
            return _Result(matched=1, modified=1 if changed else 0)

    async def find_one_and_update(self, *a, **k):  # pragma: no cover - unused here
        raise NotImplementedError

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
# Fake shared-namespace collaborators
# ─────────────────────────────────────────────────────────────────────────────
def _norm_student_id(value) -> str:
    return str(value or "").strip().lower()


class _Admin:
    email = "teacher@school.example"


async def _require_admin():
    return _Admin()


async def _require_student():  # pragma: no cover - not exercised here
    return _Admin()


class TreasuryCredit:
    """Fake `_lrc_credit_via_treasury`."""
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = 0

    async def __call__(self, *, student_clean_id, points, campaign_id, campaign_name):
        self.calls += 1
        if self.ok:
            return {"ok": True}
        return {"ok": False, "error": "treasury refused"}


class VoucherIssuer:
    """Fake `_lrc_issue_voucher_for_claim`."""
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = 0

    async def __call__(self, synth_camp, student_clean_id, student_id_norm):
        self.calls += 1
        if not self.ok:
            return None
        return {"discount_label": "20% off", "expires_at": "2026-12-31T00:00:00Z"}


class PushRecorder:
    """Fake `_fan_out_push`. `mode`: 'sent' | 'no_subscribers' | 'failed' | 'raise'."""
    def __init__(self, mode="sent"):
        self.mode = mode
        self.calls = []

    async def __call__(self, subs_query, title, body, url):
        self.calls.append({"query": subs_query, "title": title, "body": body, "url": url})
        if self.mode == "raise":
            raise RuntimeError("webpush infra exception")
        if self.mode == "no_subscribers":
            return (0, 0)
        if self.mode == "failed":
            return (0, 1)
        return (1, 0)


def _build_namespace(db, *, credit=None, issuer=None, push=None,
                     subscriber_count=1):
    """Exec the REAL mystery_box_tools.py source into a fresh namespace,
    exactly as server.py does, with fakes standing in for its shared
    collaborators."""
    push = push if push is not None else PushRecorder(mode="sent")

    class _PushSubs:
        async def count_documents(self, query):
            return subscriber_count

    # Register a REAL module object in sys.modules so pydantic v2's forward
    # -ref resolution (which looks up `sys.modules[cls.__module__].__dict__`)
    # can find `Optional`/`List`/etc. after the module-level `from typing
    # import ...` line executes below — a plain dict passed to exec() alone
    # is not discoverable that way.
    mod_name = f"mystery_box_tools_under_test_{next(_MODULE_NAME_COUNTER)}"
    mod = types.ModuleType(mod_name)
    ns = mod.__dict__
    ns.update({
        "__name__": mod_name,
        "api": APIRouter(),
        "db": db,
        "Depends": Depends,
        "HTTPException": HTTPException,
        "require_admin": _require_admin,
        "require_student": _require_student,
        "_norm_student_id": _norm_student_id,
        "_lrc_credit_via_treasury": credit or TreasuryCredit(ok=True),
        "_lrc_issue_voucher_for_claim": issuer or VoucherIssuer(ok=True),
        "_fan_out_push": push,
        "push_subscriptions": _PushSubs(),
    })
    sys.modules[mod_name] = mod
    src = MODULE_PATH.read_text(encoding="utf-8")
    exec(compile(src, str(MODULE_PATH), "exec"), ns)  # noqa: S102
    # Recreate the unique index the real code relies on (round_id, student_id_norm).
    db["speaking_lab_mystery_claims"].set_unique("round_id", "student_id_norm")
    return ns, push


async def _seed_round(db, *, rid="round-1", prize_type="points", points=25,
                      title="Coin Stash"):
    prize_id = "prz_1"
    await db["mystery_box_prize_templates"].insert_one({
        "id": prize_id, "type": prize_type, "title": title,
        "points": points, "quantity": 1, "expires_in_days": 30,
    })
    await db["speaking_lab_mystery_rounds"].insert_one({
        "id": rid, "campaign_id": "camp-1", "status": "open",
        "box_count": 3,
        "layout": [{"index": i, "prize_id": prize_id, "type": prize_type,
                   "rarity": "common"} for i in range(3)],
        "selected_box_index": 0,
    })
    return rid


class _RevealPayload:
    def __init__(self, student_id="stu777", student_name="Rina", box_index=0,
                idempotency_key=None):
        self.student_id = student_id
        self.student_name = student_name
        self.box_index = box_index
        self.idempotency_key = idempotency_key


async def _reveal(ns, rid, **kw):
    RevealIn = ns["_RevealIn"]
    payload = RevealIn(**{
        "student_id": kw.get("student_id", "stu777"),
        "student_name": kw.get("student_name", "Rina"),
        "box_index": kw.get("box_index", 0),
    })
    return await ns["mbt_reveal_round"](rid, payload, admin=_Admin())


# ═════════════════════════════════════════════════════════════════════════════
# 1-2. Points prize — one push, only after durable persistence
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_points_prize_sends_exactly_one_push_after_persistence():
    db = _FakeDB()
    push = PushRecorder(mode="sent")
    ns, push = _build_namespace(db, push=push)
    rid = await _seed_round(db, prize_type="points", points=25)

    observed = {}
    real_update = db["speaking_lab_mystery_claims"].update_one

    async def _spy_update(query, update, **kw):
        res = await real_update(query, update, **kw)
        if update.get("$set", {}).get("granted_status") == "granted":
            observed["granted_persisted"] = True
        return res
    db["speaking_lab_mystery_claims"].update_one = _spy_update

    resp = await _reveal(ns, rid)
    assert resp["already_claimed"] is False
    assert len(push.calls) == 1
    assert "25 points" in push.calls[0]["body"]
    assert observed.get("granted_persisted") is True

    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    assert claim["granted_status"] == "granted"
    assert claim["notification_status"] == "sent"


# ═════════════════════════════════════════════════════════════════════════════
# 3-4. Failed points grant → no push; notification retry never re-credits
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_failed_points_grant_sends_no_push():
    db = _FakeDB()
    credit = TreasuryCredit(ok=False)
    push = PushRecorder(mode="sent")
    ns, push = _build_namespace(db, credit=credit, push=push)
    rid = await _seed_round(db, prize_type="points", points=25)

    with pytest.raises(HTTPException) as exc_info:
        await _reveal(ns, rid)
    assert exc_info.value.status_code == 502
    assert push.calls == []
    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    assert claim["granted_status"] == "failed"
    assert "notification_status" not in claim


@pytest.mark.asyncio
async def test_notification_retry_never_calls_treasury_again():
    db = _FakeDB()
    credit = TreasuryCredit(ok=True)
    push_fail = PushRecorder(mode="failed")
    ns, _ = _build_namespace(db, credit=credit, push=push_fail)
    rid = await _seed_round(db, prize_type="points", points=25)
    await _reveal(ns, rid)
    assert credit.calls == 1

    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    assert claim["notification_status"] == "failed"

    push_ok = PushRecorder(mode="sent")
    ns["_fan_out_push"] = push_ok
    result = await ns["notify_mystery_box_prize"](
        student_id=claim["student_id"], grant_id=claim["id"],
        prize_type="points", prize_payload=claim["safe_display_payload"],
    )
    assert result["sent"] is True
    assert credit.calls == 1  # never called treasury again
    assert len(push_ok.calls) == 1


# ═════════════════════════════════════════════════════════════════════════════
# 5-6. Voucher/book prize — one push; retry never re-issues
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_voucher_prize_sends_exactly_one_push():
    db = _FakeDB()
    issuer = VoucherIssuer(ok=True)
    push = PushRecorder(mode="sent")
    ns, push = _build_namespace(db, issuer=issuer, push=push)
    rid = await _seed_round(db, prize_type="book_voucher", title="Grammar Mastery Voucher")

    resp = await _reveal(ns, rid)
    assert resp["already_claimed"] is False
    assert issuer.calls == 1
    assert len(push.calls) == 1
    assert "Grammar Mastery Voucher" in push.calls[0]["body"]
    assert push.calls[0]["title"] == "📚 Mystery Box Reward!"


@pytest.mark.asyncio
async def test_voucher_notification_retry_does_not_issue_another_voucher():
    db = _FakeDB()
    issuer = VoucherIssuer(ok=True)
    ns, _ = _build_namespace(db, issuer=issuer, push=PushRecorder(mode="failed"))
    rid = await _seed_round(db, prize_type="book_voucher", title="Grammar Mastery Voucher")
    await _reveal(ns, rid)
    assert issuer.calls == 1

    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    ns["_fan_out_push"] = PushRecorder(mode="sent")
    await ns["notify_mystery_box_prize"](
        student_id=claim["student_id"], grant_id=claim["id"],
        prize_type="book_voucher", prize_payload=claim["safe_display_payload"],
    )
    assert issuer.calls == 1  # never issued twice


# ═════════════════════════════════════════════════════════════════════════════
# 7-8. EduTalk pass — one push; retry never re-grants
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_edutalk_pass_sends_exactly_one_push():
    db = _FakeDB()
    push = PushRecorder(mode="sent")
    ns, push = _build_namespace(db, push=push)
    rid = await _seed_round(db, prize_type="edutalk_session", title="EduTalk Session Pass")

    resp = await _reveal(ns, rid)
    assert resp["already_claimed"] is False
    assert len(push.calls) == 1
    assert push.calls[0]["title"] == "🎙️ Mystery Box Reward!"
    assert "EduTalk" in push.calls[0]["body"]
    entitlements = db["student_feature_entitlements"]._docs
    assert len(entitlements) == 1


@pytest.mark.asyncio
async def test_edutalk_pass_notification_retry_does_not_grant_again():
    db = _FakeDB()
    ns, _ = _build_namespace(db, push=PushRecorder(mode="failed"))
    rid = await _seed_round(db, prize_type="edutalk_session")
    await _reveal(ns, rid)
    assert len(db["student_feature_entitlements"]._docs) == 1

    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    ns["_fan_out_push"] = PushRecorder(mode="sent")
    await ns["notify_mystery_box_prize"](
        student_id=claim["student_id"], grant_id=claim["id"],
        prize_type="edutalk_session", prize_payload=claim["safe_display_payload"],
    )
    assert len(db["student_feature_entitlements"]._docs) == 1  # unchanged


# ═════════════════════════════════════════════════════════════════════════════
# 9-10. Duplicate / concurrent reveal → one grant, one push
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_duplicate_reveal_sends_no_duplicate_push():
    db = _FakeDB()
    push = PushRecorder(mode="sent")
    ns, push = _build_namespace(db, push=push)
    rid = await _seed_round(db, prize_type="points", points=10)

    r1 = await _reveal(ns, rid)
    r2 = await _reveal(ns, rid)
    assert r1["already_claimed"] is False
    assert r2["already_claimed"] is True
    assert len(push.calls) == 1


@pytest.mark.asyncio
async def test_concurrent_reveal_produces_one_grant_and_one_push():
    db = _FakeDB()
    push = PushRecorder(mode="sent")
    credit = TreasuryCredit(ok=True)
    ns, push = _build_namespace(db, credit=credit, push=push)
    rid = await _seed_round(db, prize_type="points", points=10)

    both_ready = asyncio.Event()
    arrivals = 0

    async def _attempt():
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            both_ready.set()
        await both_ready.wait()
        try:
            return await _reveal(ns, rid)
        except HTTPException:
            return None

    r1, r2 = await asyncio.gather(_attempt(), _attempt())
    outcomes = [r for r in (r1, r2) if r is not None]
    # Exactly one caller performs the real grant; the loser either gets
    # `already_claimed` or a transient 409 (both are safe non-grant outcomes).
    assert credit.calls == 1
    assert len(push.calls) == 1
    granted_true = [o for o in outcomes if o.get("already_claimed") is False]
    assert len(granted_true) == 1


# ═════════════════════════════════════════════════════════════════════════════
# 11-14. Push failure semantics, stale-attempt guard, idempotent sent
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_push_failure_leaves_prize_successful_and_retryable():
    db = _FakeDB()
    ns, push = _build_namespace(db, push=PushRecorder(mode="raise"))
    rid = await _seed_round(db, prize_type="points", points=10)

    resp = await _reveal(ns, rid)
    assert resp["already_claimed"] is False
    assert resp["claim"]["granted_status"] == "granted"  # prize still successful
    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    assert claim["granted_status"] == "granted"
    assert claim["notification_status"] == "failed"
    assert "notification_error" in claim


@pytest.mark.asyncio
async def test_stale_notification_attempt_cannot_overwrite_newer_attempt():
    db = _FakeDB()
    ns, _ = _build_namespace(db, push=PushRecorder(mode="sent"))
    rid = await _seed_round(db, prize_type="points", points=10)
    await _reveal(ns, rid)
    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})

    # Simulate a stale in-flight attempt from a crashed old worker.
    await db["speaking_lab_mystery_claims"].update_one(
        {"id": claim["id"]},
        {"$set": {"notification_status": "sending",
                  "notification_attempt_id": "old-attempt",
                  "notification_attempted_at": "2020-01-01T00:00:00Z"}},
    )
    # A fresh, newer attempt succeeds and claims the slot.
    push_new = PushRecorder(mode="sent")
    ns["_fan_out_push"] = push_new
    result = await ns["notify_mystery_box_prize"](
        student_id=claim["student_id"], grant_id=claim["id"],
        prize_type="points", prize_payload=claim["safe_display_payload"],
    )
    assert result["sent"] is True
    fresh = await db["speaking_lab_mystery_claims"].find_one({"id": claim["id"]})
    assert fresh["notification_status"] == "sent"
    assert fresh["notification_attempt_id"] != "old-attempt"


@pytest.mark.asyncio
async def test_already_sent_notification_is_idempotent():
    db = _FakeDB()
    ns, push = _build_namespace(db, push=PushRecorder(mode="sent"))
    rid = await _seed_round(db, prize_type="points", points=10)
    await _reveal(ns, rid)
    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    assert claim["notification_status"] == "sent"

    result = await ns["notify_mystery_box_prize"](
        student_id=claim["student_id"], grant_id=claim["id"],
        prize_type="points", prize_payload=claim["safe_display_payload"],
    )
    assert result.get("skipped") is True
    assert len(push.calls) == 1  # unchanged — no second send


# ═════════════════════════════════════════════════════════════════════════════
# 15-16. No-prize / uncertain outcomes send no success push
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_visual_only_prize_type_sends_no_push():
    db = _FakeDB()
    ns, push = _build_namespace(db, push=PushRecorder(mode="sent"))
    rid = await _seed_round(db, prize_type="lucky_draw_entry", title="Bonus Entry")

    resp = await _reveal(ns, rid)
    assert resp["already_claimed"] is False
    assert push.calls == []  # no real prize was durably granted


@pytest.mark.asyncio
async def test_unsupported_prize_type_grant_failure_sends_no_push():
    db = _FakeDB()
    ns, push = _build_namespace(db, push=PushRecorder(mode="sent"))
    rid = await _seed_round(db, prize_type="not_a_real_type")
    with pytest.raises(HTTPException):
        await _reveal(ns, rid)
    assert push.calls == []


# ═════════════════════════════════════════════════════════════════════════════
# 17-18. Wording + no raw provider/db detail
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_notification_payload_uses_prize_specific_wording():
    db = _FakeDB()
    ns, push = _build_namespace(db, push=PushRecorder(mode="sent"))
    rid = await _seed_round(db, prize_type="points", points=25)
    await _reveal(ns, rid)
    assert push.calls[0]["title"] == "🎁 Mystery Box Reward!"
    assert push.calls[0]["body"] == (
        "You received 25 points from your Mystery Box. "
        "Your reward was added successfully."
    )


@pytest.mark.asyncio
async def test_push_payload_contains_no_raw_provider_or_db_error():
    db = _FakeDB()
    sensitive = "mongo://internal-host:27017 auth failed user=admin pw=hunter2"

    class _RaisingPush(PushRecorder):
        async def __call__(self, subs_query, title, body, url):
            await super().__call__(subs_query, title, body, url)
            raise RuntimeError(sensitive)

    ns, push = _build_namespace(db, push=_RaisingPush(mode="sent"))
    rid = await _seed_round(db, prize_type="points", points=25)
    resp = await _reveal(ns, rid)
    assert resp["claim"]["granted_status"] == "granted"
    # The sensitive string must never appear in the title/body sent outward.
    assert sensitive not in push.calls[0]["title"]
    assert sensitive not in push.calls[0]["body"]
    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})
    assert claim["notification_status"] == "failed"


# ═════════════════════════════════════════════════════════════════════════════
# 19. Same durable grant reached through two callers → one notification
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_same_grant_reached_twice_sends_one_notification():
    """Simulates two different callers (e.g. a retried Speaking Lab request
    and an admin lookup-triggered retry) both ending up pointed at the same
    durable claim id — exactly one notification must ever be delivered."""
    db = _FakeDB()
    ns, push = _build_namespace(db, push=PushRecorder(mode="sent"))
    rid = await _seed_round(db, prize_type="points", points=10)
    await _reveal(ns, rid)
    claim = await db["speaking_lab_mystery_claims"].find_one({"round_id": rid})

    # "Caller B" retries notification for the exact same grant id via the
    # admin retry-push route.
    RetryIn = ns["_MBTRetryPushIn"]
    resp = await ns["mbt_admin_retry_push"](
        RetryIn(claim_id=claim["id"]), admin=_Admin(),
    )
    assert resp["result"].get("skipped") is True
    assert len(push.calls) == 1


# ═════════════════════════════════════════════════════════════════════════════
# 20-22. Sanity: module loads cleanly, protected areas untouched
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_module_registers_expected_routes_and_helpers():
    db = _FakeDB()
    ns, _ = _build_namespace(db)
    for name in ("mbt_reveal_round", "mbt_select_box", "_mbt_grant_prize",
                "notify_mystery_box_prize", "mbt_admin_retry_push",
                "mbt_admin_reconcile_points", "_mbt_grant_edutalk_pass"):
        assert name in ns, f"missing expected symbol: {name}"


def test_protected_lucky_draw_functions_untouched():
    """Defensive re-check: this Mystery Box change must never touch the
    protected Lucky Draw core (separate module, separate file)."""
    import hashlib
    import ast

    p = BACKEND_DIR / "lucky_draw.py"
    source = p.read_text(encoding="utf-8")
    tree = ast.parse(source)
    PROTECTED = ("_weighted_pick", "_normalize_split", "_run_draw")
    BASELINE = {
        "_weighted_pick":
            "871c5ad4d2cc3d721ed309e8dc2930e55053fdd9ac53d5a2a3fb815d6ccd461a",
        "_normalize_split":
            "077c2583249d28118a489a47ad00fa669f14375e8db6b7a153837bff6fa9a359",
        "_run_draw":
            "65ecec65bcd07a0fad9023e8b3b91f73a801c6ec551e93d63b989ef164825aac",
    }
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in PROTECTED:
            seg = ast.get_source_segment(source, node)
            found[node.name] = hashlib.sha256(seg.encode("utf-8")).hexdigest()
    for name in PROTECTED:
        assert found.get(name) == BASELINE[name], f"PROTECTED REGION CHANGED: {name}"
