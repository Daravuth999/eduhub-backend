"""tests/test_speaking_lab_topic_questions.py
=====================================================
Automated Topic-Based Question Generation for Speaking Lab Group Mode.
Covers speaking_lab_topic_questions.py's pure functions (Gemini schema
validation + retry-once, the atomic pool-claim, the three-tier fallback
chain, and the refill top-up math) against an in-memory fake Mongo, plus
the HTTP routes via a real APIRouter + FastAPI + TestClient (matching the
test_question_bank.py pattern already established in this codebase).

Concurrency note (read before trusting the "never returns the same row
twice" test at face value): the fake collection's find_one_and_update
below has zero internal `await` points, so a single call runs to
completion without yielding to the event loop — the same
uninterruptible-single-operation guarantee real MongoDB's own
find_one_and_update gives server-side. asyncio.gather() firing N
concurrent claims against this fake therefore genuinely exercises
whether the CODE always asks for `status:"unused"` and immediately marks
what it claims as `status:"used"` in the same atomic step. It does not,
and cannot, prove true multi-process/multi-worker safety — that
guarantee comes from MongoDB's own server-side atomicity, not from
anything Python-level testing can simulate.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import speaking_lab_topic_questions as tq


# ── fake Mongo (same _Coll/_Result shape as test_question_bank.py) ──────
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
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                return dict(d)
        return None

    async def find_one_and_update(self, query, update, return_document=None):
        # No `await` anywhere in this method — see module docstring above.
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    d.update(update["$set"])
                return dict(d)
        return None

    async def create_index(self, *a, **kw):
        return None

    async def count_documents(self, query):
        return sum(1 for d in self.docs.values() if all(d.get(k) == v for k, v in query.items()))


class _FakeDB:
    def __init__(self):
        self._colls: dict[str, _Coll] = {}
        self.speaking_lab_settings = _Coll()

    def __getitem__(self, name):
        if name not in self._colls:
            self._colls[name] = _Coll()
        return self._colls[name]


_row_counter = {"n": 0}


def _pool_row(topic, text, status="unused", **extra):
    # A monotonic counter, not a text-derived id — two rows with a shared
    # text prefix (e.g. "Question 0".."Question 4") must never collide.
    _row_counter["n"] += 1
    row = {
        "_id": f"tq_row_{_row_counter['n']}",
        "topic": topic,
        "text": text,
        "status": status,
        "created_at": None,
        "used_at": None,
        "used_by_group_session_id": None,
    }
    row.update(extra)
    return row


# ── generate_question: schema validation + retry-once ───────────────────

@pytest.mark.asyncio
async def test_generate_question_requires_api_key(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "")
    with pytest.raises(RuntimeError):
        await tq.generate_question(topic="Sports")


@pytest.mark.asyncio
async def test_generate_question_succeeds_on_valid_json(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_call(prompt):
        return '{"text": "What sport do you like to play, and why?"}'

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    result = await tq.generate_question(topic="Sports")
    assert result == {"text": "What sport do you like to play, and why?"}


@pytest.mark.asyncio
async def test_generate_question_retries_once_then_succeeds(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")
    calls = {"n": 0}

    async def fake_call(prompt):
        calls["n"] += 1
        if calls["n"] == 1:
            return "not json at all"
        return '{"text": "Where would you like to travel and why?"}'

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    result = await tq.generate_question(topic="Travel")
    assert calls["n"] == 2
    assert result["text"] == "Where would you like to travel and why?"


@pytest.mark.asyncio
async def test_generate_question_raises_after_two_failed_attempts(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")
    calls = {"n": 0}

    async def fake_call(prompt):
        calls["n"] += 1
        return "still not json"

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    with pytest.raises(ValueError):
        await tq.generate_question(topic="Family")
    assert calls["n"] == 2  # exactly one retry, never more


@pytest.mark.asyncio
async def test_generate_question_rejects_missing_required_key(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_call(prompt):
        return '{"notes": "oops, wrong shape"}'

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    with pytest.raises(ValueError):
        await tq.generate_question(topic="School")


@pytest.mark.asyncio
async def test_generate_question_rejects_multi_question_output(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_call(prompt):
        return '{"text": "What is your favorite subject? Why do you like it? What about math?"}'

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    with pytest.raises(ValueError):
        await tq.generate_question(topic="School")


@pytest.mark.asyncio
async def test_generate_question_strips_markdown_fences(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_call(prompt):
        return '```json\n{"text": "What does your family usually do on weekends?"}\n```'

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    result = await tq.generate_question(topic="Family")
    assert result["text"] == "What does your family usually do on weekends?"


@pytest.mark.asyncio
async def test_generate_question_strips_a_conversational_preamble(monkeypatch):
    # Regression test for a real production failure: Gemini ignored both
    # responseMimeType="application/json" and the system instruction's
    # "Do not include explanations," on the SAME attempt on retry too —
    # see Render logs for topic=Travel and topic=Family, both attempts
    # failing identically with "Here is the JSON requested:" prefixed
    # before the actual object.
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_call(prompt):
        return 'Here is the JSON requested: {"text": "Where would you like to travel and why?"}'

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    result = await tq.generate_question(topic="Travel")
    assert result["text"] == "Where would you like to travel and why?"


@pytest.mark.asyncio
async def test_generate_question_strips_a_preamble_with_trailing_chatter_too(monkeypatch):
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_call(prompt):
        return (
            'Sure, here you go:\n'
            '{"text": "What do you usually do after school?"}\n'
            'Let me know if you need another one!'
        )

    monkeypatch.setattr(tq, "_call_gemini", fake_call)
    result = await tq.generate_question(topic="School")
    assert result["text"] == "What do you usually do after school?"


# ── Atomic pool claim: never the same row twice under concurrent calls ──

@pytest.mark.asyncio
async def test_atomic_claim_never_returns_the_same_row_twice_under_concurrency():
    db = _FakeDB()
    coll = db[tq.POOL_COLL]
    for i in range(5):
        row = _pool_row("Sports", f"Question {i}")
        coll.docs[row["_id"]] = row

    results = await asyncio.gather(*[
        tq.claim_or_generate_question(db, topic="Sports", session_id="sess-1")
        for _ in range(5)
    ])

    claimed_texts = [r["text"] for r in results]
    assert len(set(claimed_texts)) == 5, "every concurrent claim must get a DISTINCT row"
    assert all(r["source"] == "pool" for r in results)
    # All 5 unused rows are now consumed.
    remaining_unused = await coll.count_documents({"topic": "Sports", "status": "unused"})
    assert remaining_unused == 0


@pytest.mark.asyncio
async def test_atomic_claim_a_sixth_concurrent_caller_falls_through_when_pool_exhausted(monkeypatch):
    db = _FakeDB()
    coll = db[tq.POOL_COLL]
    for i in range(3):
        row = _pool_row("Travel", f"Question {i}")
        coll.docs[row["_id"]] = row
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "")  # force fallback, not inline-generate
    db.speaking_lab_settings.docs["questions"] = {
        "_id": "questions", "beginner": ["Fallback Q1"], "intermediate": [],
    }

    results = await asyncio.gather(*[
        tq.claim_or_generate_question(db, topic="Travel", session_id="sess-1")
        for _ in range(4)
    ])
    sources = sorted(r["source"] for r in results)
    assert sources == ["fallback_bank", "pool", "pool", "pool"]


# ── Three-tier fallback, exercised independently ─────────────────────────

@pytest.mark.asyncio
async def test_draw_tier1_pool_hit_never_calls_gemini(monkeypatch):
    db = _FakeDB()
    coll = db[tq.POOL_COLL]
    coll.docs["row1"] = _pool_row("Daily Routine", "What time do you wake up on school days?")

    async def fail_if_called(*a, **kw):
        raise AssertionError("generate_question must not be called when the pool has a row")

    monkeypatch.setattr(tq, "generate_question", fail_if_called)
    result = await tq.claim_or_generate_question(db, topic="Daily Routine", session_id="s1")
    assert result == {"text": "What time do you wake up on school days?", "topic": "Daily Routine", "source": "pool"}


@pytest.mark.asyncio
async def test_draw_tier2_inline_generate_when_pool_empty_and_gemini_enabled(monkeypatch):
    db = _FakeDB()
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_generate(*, topic):
        return {"text": f"Generated question about {topic}"}

    monkeypatch.setattr(tq, "generate_question", fake_generate)
    result = await tq.claim_or_generate_question(db, topic="Problem & Solution", session_id="s1")
    assert result == {
        "text": "Generated question about Problem & Solution",
        "topic": "Problem & Solution",
        "source": "generated",
    }
    # The freshly generated question is persisted as an already-used row
    # (audit trail), not left as a phantom unused duplicate.
    stored = await db[tq.POOL_COLL].find_one({"topic": "Problem & Solution"})
    assert stored["status"] == "used"
    assert stored["used_by_group_session_id"] == "s1"


@pytest.mark.asyncio
async def test_draw_tier3_static_bank_when_gemini_disabled(monkeypatch):
    db = _FakeDB()
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "")  # Gemini deliberately disabled
    db.speaking_lab_settings.docs["questions"] = {
        "_id": "questions",
        "beginner": ["Talk about your favorite food."],
        "intermediate": [],
    }
    result = await tq.claim_or_generate_question(db, topic="Family", session_id="s1")
    assert result == {"text": "Talk about your favorite food.", "topic": "Family", "source": "fallback_bank"}


@pytest.mark.asyncio
async def test_draw_tier3_static_bank_when_inline_generation_fails(monkeypatch):
    db = _FakeDB()
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def failing_generate(*, topic):
        raise ValueError("Gemini returned invalid JSON after 2 attempts")

    monkeypatch.setattr(tq, "generate_question", failing_generate)
    db.speaking_lab_settings.docs["questions"] = {
        "_id": "questions", "beginner": [], "intermediate": ["Describe your school."],
    }
    result = await tq.claim_or_generate_question(db, topic="School", session_id="s1")
    assert result == {"text": "Describe your school.", "topic": "School", "source": "fallback_bank"}


@pytest.mark.asyncio
async def test_draw_absolute_last_resort_when_static_bank_is_also_empty(monkeypatch):
    db = _FakeDB()
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "")
    # No speaking_lab_settings doc at all.
    result = await tq.claim_or_generate_question(db, topic="Sports", session_id="s1")
    assert result["source"] == "fallback_bank"
    assert result["text"]  # never blocks the group with an empty string


# ── refill_pool: top-up math ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_refill_pool_tops_up_topics_below_threshold(monkeypatch):
    db = _FakeDB()
    coll = db[tq.POOL_COLL]
    # "Sports" already has 6 unused (>= REFILL_THRESHOLD=5) — skip it.
    for i in range(6):
        row = _pool_row("Sports", f"S{i}")
        coll.docs[row["_id"]] = row
    # "Family" has only 2 unused — needs REFILL_TARGET(8) - 2 = 6 more.
    for i in range(2):
        row = _pool_row("Family", f"F{i}")
        coll.docs[row["_id"]] = row

    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def fake_generate(*, topic):
        return {"text": f"New {topic} question"}

    monkeypatch.setattr(tq, "generate_question", fake_generate)
    results = await tq.refill_pool(db)

    assert results["Sports"] == {"before": 6, "generated": 0}
    assert results["Family"] == {"before": 2, "generated": 6}
    family_unused = await coll.count_documents({"topic": "Family", "status": "unused"})
    assert family_unused == 8


@pytest.mark.asyncio
async def test_refill_pool_stops_for_a_topic_on_first_generation_failure(monkeypatch):
    db = _FakeDB()
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "fake-key")

    async def always_fails(*, topic):
        raise ValueError("Gemini unavailable")

    monkeypatch.setattr(tq, "generate_question", always_fails)
    results = await tq.refill_pool(db)
    # Every default topic starts at 0 unused; each attempt fails immediately.
    for topic in tq.DEFAULT_TOPICS:
        assert results[topic] == {"before": 0, "generated": 0}


@pytest.mark.asyncio
async def test_refill_pool_generates_nothing_when_gemini_disabled(monkeypatch):
    db = _FakeDB()
    monkeypatch.setattr(tq, "GEMINI_API_KEY", "")
    results = await tq.refill_pool(db)
    for topic in tq.DEFAULT_TOPICS:
        assert results[topic]["generated"] == 0


# ── Routes: auth gate + end-to-end wiring ────────────────────────────────

def _build_app(db, *, is_admin_user=False, cron_secret="test-cron-secret"):
    tq_module = tq
    tq_module.CRON_SECRET = cron_secret

    class _FakeUser:
        def __init__(self, is_admin):
            self.is_admin = is_admin

    async def fake_current_user():
        return _FakeUser(is_admin_user)

    def fake_is_super_admin(user):
        return bool(user and user.is_admin)

    async def fake_require_admin():
        return _FakeUser(True)

    router = APIRouter(prefix="/api")
    tq.register_topic_question_routes(
        router, db, fake_require_admin,
        current_user=fake_current_user, is_super_admin=fake_is_super_admin,
    )
    app = FastAPI()
    app.include_router(router)
    return app


def test_topics_route_returns_default_topics():
    db = _FakeDB()
    app = _build_app(db)
    client = TestClient(app)
    resp = client.get("/api/speaking-lab/topic-questions/topics")
    assert resp.status_code == 200
    assert resp.json() == {"topics": tq.DEFAULT_TOPICS}


def test_draw_route_requires_a_topic():
    db = _FakeDB()
    app = _build_app(db)
    client = TestClient(app)
    resp = client.post("/api/speaking-lab/sessions/sess-1/topic-questions/draw", json={})
    assert resp.status_code == 400


def test_draw_route_returns_pool_source_when_available():
    db = _FakeDB()
    db[tq.POOL_COLL].docs["row1"] = _pool_row("Sports", "Do you play any sports?")
    app = _build_app(db)
    client = TestClient(app)
    resp = client.post(
        "/api/speaking-lab/sessions/sess-1/topic-questions/draw",
        json={"topic": "Sports"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "pool"
    assert body["text"] == "Do you play any sports?"


def test_refill_due_rejects_without_valid_cron_secret_or_super_admin():
    db = _FakeDB()
    app = _build_app(db, is_admin_user=False, cron_secret="right-secret")
    client = TestClient(app)
    resp = client.post(
        "/api/speaking-lab/topic-questions/refill-due",
        headers={"x-cron-secret": "wrong-secret"},
    )
    assert resp.status_code == 403


def test_refill_due_accepts_valid_cron_secret():
    db = _FakeDB()
    app = _build_app(db, is_admin_user=False, cron_secret="right-secret")
    client = TestClient(app)
    resp = client.post(
        "/api/speaking-lab/topic-questions/refill-due",
        headers={"x-cron-secret": "right-secret"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_refill_due_accepts_super_admin_without_cron_secret():
    db = _FakeDB()
    app = _build_app(db, is_admin_user=True, cron_secret="right-secret")
    client = TestClient(app)
    resp = client.post("/api/speaking-lab/topic-questions/refill-due")
    assert resp.status_code == 200


def test_refill_due_route_is_absent_entirely_when_current_user_dependency_not_supplied():
    # register_topic_question_routes(current_user=None) — mirrors how every
    # OTHER register_*_routes function in this codebase omits an admin-only
    # route block entirely when its auth dependency wasn't supplied (see
    # lucky_draw.py's own `if require_admin:` gated route registration).
    db = _FakeDB()

    async def fake_require_admin():
        return object()

    router = APIRouter(prefix="/api")
    tq.register_topic_question_routes(router, db, fake_require_admin)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    resp = client.post("/api/speaking-lab/topic-questions/refill-due")
    assert resp.status_code == 404
