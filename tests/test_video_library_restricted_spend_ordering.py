"""tests/test_video_library_restricted_spend_ordering.py — §2 of the Video
Library coupons round: the highest-stakes item in that round (real
spendable currency, ordering/partial-spend arithmetic). Exercises
video_library_tools.initiate_purchase's restricted-first debit ordering
against an in-memory fake Mongo + a monkeypatched GAS points adapter
(never a real network call), covering:

  - full price covered entirely by restricted points (GAS never called)
  - partial restricted + remainder from GAS (GAS called with the REMAINDER
    only, never the full price)
  - zero restricted balance behaves EXACTLY as before this round (the
    existing, already-tested happy path — a real regression guard)
  - a GAS-rejected purchase refunds the restricted portion so a retry
    isn't stranded
  - a GAS-ambiguous purchase does NOT auto-refund restricted points
    (documented, deliberate — see the report for this open edge case)
  - a race where the balance read says "enough" but the atomic debit
    disagrees falls back to charging the full price to GAS, never guesses
  - structural proof that NO other feature module in the repo imports
    video_library_restricted_points.py at all — this addition cannot
    possibly affect any other points-spending path, by construction.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

import video_library_points_adapter as points
import video_library_restricted_points as restricted_points
import video_library_tools as vlt
import video_schema as schema


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def _matches(doc: dict, query: dict) -> bool:
    for k, v in query.items():
        if isinstance(v, dict) and "$in" in v:
            if doc.get(k) not in v["$in"]:
                return False
        else:
            if doc.get(k) != v:
                return False
    return True


class _Coll:
    """Matches tests/test_video_library.py's own established fake-Mongo
    convention for video_lessons/video_purchases/coupons."""

    def __init__(self):
        self.docs: dict = {}

    def _match_one(self, query):
        for doc in self.docs.values():
            if _matches(doc, query):
                return doc
        return None

    async def insert_one(self, doc):
        key = doc.get("_id") or doc.get("lessonId") or doc.get("purchaseId") or doc.get("code")
        self.docs[key] = dict(doc)
        return _Result(inserted_id=key)

    async def find_one(self, query, projection=None):
        doc = self._match_one(query)
        if not doc:
            return None
        out = dict(doc)
        if projection and projection.get("_id") == 0:
            out.pop("_id", None)
        return out

    async def update_one(self, query, update, upsert=False):
        doc = self._match_one(query)
        if doc is None:
            if upsert and "$setOnInsert" in update:
                new_doc = dict(update["$setOnInsert"])
                self.docs[new_doc["_id"]] = new_doc
                return _Result(matched_count=0, upserted_id=new_doc["_id"])
            return _Result(matched_count=0)
        if "$set" in update:
            doc.update(update["$set"])
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        if "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = doc.get(k, 0) + v
        return _Result(matched_count=1)

    async def find_one_and_update(self, query, update):
        doc = self._match_one(query)
        if doc is None:
            return None
        before = dict(doc)
        if "$set" in update:
            doc.update(update["$set"])
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        if "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = doc.get(k, 0) + v
        return before


class _RestrictedWalletsColl:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        sid = query.get("student_id")
        doc = self.docs.get(sid)
        return dict(doc) if doc is not None else None

    async def find_one_and_update(self, filt, update, upsert=False, return_document=None, projection=None):
        sid = filt.get("student_id")
        existing = self.docs.get(sid)
        if existing is None:
            if not upsert or "balance" in filt:
                return None
            existing = {"student_id": sid, "balance": 0}
            if "$setOnInsert" in update:
                existing.update(update["$setOnInsert"])
            self.docs[sid] = existing
        elif "balance" in filt:
            cond = filt["balance"]
            if isinstance(cond, dict) and "$gte" in cond and int(existing.get("balance") or 0) < cond["$gte"]:
                return None
        if "$inc" in update:
            for k, v in update["$inc"].items():
                existing[k] = existing.get(k, 0) + v
        if "$set" in update:
            existing.update(update["$set"])
        return dict(existing)

    async def create_index(self, *a, **k):
        return None


class _RestrictedTxnsColl:
    def __init__(self):
        self.rows: list[dict] = []

    async def find_one(self, query, projection=None):
        key = query.get("idempotency_key")
        for d in self.rows:
            if d.get("idempotency_key") == key:
                return dict(d)
        return None

    async def insert_one(self, doc):
        self.rows.append(dict(doc))
        return _Result(inserted_id=len(self.rows))

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self.video_lessons = _Coll()
        self.video_purchases = _Coll()
        self.coupons = _Coll()
        self._restricted_wallets = _RestrictedWalletsColl()
        self._restricted_txns = _RestrictedTxnsColl()

    def __getitem__(self, name):
        # video_library_coupon_tools.py reads `db.coupons` as a plain
        # attribute (already satisfied by `self.coupons` above via normal
        # attribute lookup); video_library_tools.py/video_library_
        # restricted_points.py use `db[name]` — both styles need to reach
        # the SAME underlying collections.
        if name == vlt.LESSONS_COLL:
            return self.video_lessons
        if name == vlt.PURCHASES_COLL:
            return self.video_purchases
        if name == "coupons":
            return self.coupons
        if name == restricted_points.COLL_WALLETS:
            return self._restricted_wallets
        if name == restricted_points.COLL_TRANSACTIONS:
            return self._restricted_txns
        raise AssertionError(f"unexpected collection: {name}")


async def _seed_lesson(db, *, price=50, lesson_id="vid_1"):
    lesson = schema.build_video_lesson(
        title="Ordering Coffee", price=price, lesson_id=lesson_id, sync_id="sync_1",
        media_ref="https://pub-x.r2.dev/vid.mp4", status="published", created_at="t0",
    )
    await db[vlt.LESSONS_COLL].insert_one(lesson)
    return lesson


@pytest.fixture
def db():
    return _FakeDB()


# ── restricted-first ordering + arithmetic ─────────────────────────────────
@pytest.mark.asyncio
async def test_restricted_balance_fully_covers_price_gas_never_called(db, monkeypatch):
    await _seed_lesson(db, price=50)
    await restricted_points.credit(db, "stu1", 50, source="video_library_coupon")

    async def _should_never_be_called(*a, **k):
        raise AssertionError("debit_purchase must not be called when restricted funds cover the full price")

    monkeypatch.setattr(vlt.points, "debit_purchase", _should_never_be_called)

    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "succeeded"
    assert purchase["restrictedUsed"] == 50
    assert await restricted_points.get_balance(db, "stu1") == 0


@pytest.mark.asyncio
async def test_partial_restricted_then_gas_covers_the_remainder_only(db, monkeypatch):
    await _seed_lesson(db, price=50)
    await restricted_points.credit(db, "stu1", 20, source="video_library_coupon")

    captured = {}

    async def _fake_debit(student_id, password, amount, **kw):
        captured["amount"] = amount
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", _fake_debit)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", lambda *a, **k: _async(( 30, "")))

    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "succeeded"
    assert captured["amount"] == 30  # NOT 50 — only the remainder after restricted points
    assert purchase["restrictedUsed"] == 20
    assert await restricted_points.get_balance(db, "stu1") == 0


@pytest.mark.asyncio
async def test_zero_restricted_balance_behaves_exactly_as_before_this_round(db, monkeypatch):
    """The existing, already-tested happy path (tests/test_video_library.py)
    for a student who has never redeemed a Video Library points coupon —
    the overwhelming common case. Must be byte-for-byte unaffected."""
    await _seed_lesson(db, price=50)

    captured = {}

    async def _fake_debit(student_id, password, amount, **kw):
        captured["amount"] = amount
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", _fake_debit)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", lambda *a, **k: _async((0, "")))

    purchase = await vlt.initiate_purchase(db, student_id="stu_never_redeemed", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "succeeded"
    assert captured["amount"] == 50  # the FULL price, unchanged
    assert purchase["restrictedUsed"] == 0


@pytest.mark.asyncio
async def test_gas_rejected_after_restricted_debit_refunds_restricted_points(db, monkeypatch):
    """§2.4/§2.6: a rejected purchase (RETRYABLE_STATES includes "failed")
    must refund any restricted points already spent for THIS attempt, or a
    retry would permanently strand them even though the purchase never
    completed."""
    await _seed_lesson(db, price=50)
    await restricted_points.credit(db, "stu1", 20, source="video_library_coupon")

    async def _fake_debit_rejected(student_id, password, amount, **kw):
        return {"outcome": points.OUTCOME_REJECTED, "reason": "insufficient_gas_funds", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", _fake_debit_rejected)

    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "failed"
    assert purchase["restrictedUsed"] == 0  # cleared on the purchase doc too
    assert await restricted_points.get_balance(db, "stu1") == 20  # refunded, NOT stranded at 0

    # And a genuine retry (same purchase key, now "failed" -> retryable)
    # must be able to spend restricted points again, fresh.
    async def _fake_debit_ok(student_id, password, amount, **kw):
        assert amount == 30
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n2"}

    monkeypatch.setattr(vlt.points, "debit_purchase", _fake_debit_ok)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", lambda *a, **k: _async((0, "")))
    retry = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert retry["state"] == "succeeded"
    assert retry["restrictedUsed"] == 20
    assert await restricted_points.get_balance(db, "stu1") == 0


@pytest.mark.asyncio
async def test_gas_ambiguous_does_not_auto_refund_restricted_points(db, monkeypatch):
    """Deliberate, documented edge case (§2.6): we do not know whether the
    GAS side actually applied, so we do not know whether the purchase
    actually succeeded — auto-refunding could double-spend restricted
    points if it turns out the purchase DID go through. restrictedUsed
    stays recorded on the purchase doc for admin reconciliation."""
    await _seed_lesson(db, price=50)
    await restricted_points.credit(db, "stu1", 20, source="video_library_coupon")

    async def _fake_debit_ambiguous(student_id, password, amount, **kw):
        return {"outcome": points.OUTCOME_AMBIGUOUS, "reason": "network_TimeoutException", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", _fake_debit_ambiguous)

    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "reconcile"
    assert purchase["restrictedUsed"] == 20  # NOT refunded, NOT cleared — left for admin review
    assert await restricted_points.get_balance(db, "stu1") == 0  # still debited


@pytest.mark.asyncio
async def test_restricted_balance_race_falls_back_to_full_gas_charge(db, monkeypatch):
    """The balance READ says funds are available, but the atomic DEBIT
    disagrees (a concurrent request spent them first against another
    lesson) — must fall back to charging the FULL price to GAS rather
    than guessing a partial amount or blocking the purchase."""
    await _seed_lesson(db, price=50)
    await restricted_points.credit(db, "stu1", 20, source="video_library_coupon")

    async def _raise_insufficient(db_, student_id, amount, **kw):
        raise restricted_points.InsufficientRestrictedFunds(student_id, 0, amount)

    monkeypatch.setattr(restricted_points, "debit", _raise_insufficient)

    captured = {}

    async def _fake_debit(student_id, password, amount, **kw):
        captured["amount"] = amount
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", _fake_debit)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", lambda *a, **k: _async((0, "")))

    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "succeeded"
    assert captured["amount"] == 50  # full price — never guessed a partial amount
    assert purchase["restrictedUsed"] == 0


# ── cross-feature safety (§2.5) ─────────────────────────────────────────────
def test_no_other_feature_module_imports_restricted_points():
    """Structural proof, not an assumption: this addition cannot possibly
    affect any other points-spending feature (books, EduTalk, mystery box,
    prize pool, etc.) because NOTHING outside the Video Library purchase/
    coupon path even imports this module."""
    repo_root = Path(__file__).resolve().parent.parent
    allowed = {"video_library_restricted_points.py", "video_library_tools.py", "video_library_coupon_tools.py",
               "server.py"}  # composition root: only ensure_indexes() at startup, no feature coupling
    importers: set[str] = set()
    for py_file in repo_root.glob("*.py"):
        if py_file.name in allowed:
            continue
        text = py_file.read_text(encoding="utf-8", errors="ignore")
        if "import video_library_restricted_points" in text or "from video_library_restricted_points" in text:
            importers.add(py_file.name)
    assert importers == set(), importers


def test_restricted_points_module_has_no_dependents_via_ast_too():
    """Belt-and-suspenders AST-based version of the check above (a plain
    substring check could theoretically false-positive on a comment) —
    same style of proof this codebase already uses for its other
    architectural-isolation guards (e.g. tests/test_video_word_alignment.py)."""
    repo_root = Path(__file__).resolve().parent.parent
    allowed = {"video_library_restricted_points.py", "video_library_tools.py", "video_library_coupon_tools.py",
               "server.py"}  # composition root: only ensure_indexes() at startup, no feature coupling
    importers = []
    for py_file in repo_root.glob("*.py"):
        if py_file.name in allowed:
            continue
        try:
            tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and any(a.name == "video_library_restricted_points" for a in node.names):
                importers.append(py_file.name)
            if isinstance(node, ast.ImportFrom) and node.module == "video_library_restricted_points":
                importers.append(py_file.name)
    assert importers == [], importers


async def _async(value):
    return value
