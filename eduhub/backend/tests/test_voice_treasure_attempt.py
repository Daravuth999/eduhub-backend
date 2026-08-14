"""tests/test_voice_treasure_attempt.py
========================================
Core Game milestone — backend tests for mission image, submit-attempt,
multimodal evaluation contract, attempt persistence, ownership, and result
recovery. Self-contained fakes; the Gemini adapter is monkeypatched so no
network/key is needed. Runnable under real pytest where fastapi/pymongo/httpx
import (calls are stubbed).
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import voice_treasure_config_tools as vt_cfg
import voice_treasure_entry_tools as vt_entry
import voice_treasure_gemini as vt_gemini
import voice_treasure_scenes as vt_scenes
from voice_treasure_attempt_tools import (
    register_voice_treasure_attempt_routes,
    A_EVALUATED, A_UNAVAILABLE, A_FAILED, COLL_ATTEMPTS,
)


def run(coro):
    return asyncio.run(coro)


def _match(doc, query):
    for k, v in query.items():
        dv = doc.get(k)
        if isinstance(v, dict) and "$in" in v:
            if dv not in v["$in"]:
                return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(self, docs): self._docs = docs
    def sort(self, f, d=1): self._docs.sort(key=lambda x: x.get(f) or "", reverse=(d == -1)); return self
    def limit(self, n): self._docs = self._docs[:n]; return self
    def __aiter__(self):
        async def gen():
            for d in self._docs: yield d
        return gen()


class _Coll:
    def __init__(self): self.docs = {}
    async def create_index(self, *a, **k): return None
    async def find_one(self, q, p=None):
        for d in self.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0: o.pop("_id", None)
                return o
        return None
    def _apply(self, doc, up):
        if "$setOnInsert" in up:
            for k, v in up["$setOnInsert"].items(): doc.setdefault(k, v)
        if "$set" in up: doc.update(up["$set"])
        if "$inc" in up:
            for k, v in up["$inc"].items(): doc[k] = (doc.get(k) or 0) + v
        return doc
    async def update_one(self, q, up, upsert=False):
        for d in self.docs.values():
            if _match(d, q): self._apply(d, up); return
        if upsert:
            base = {"_id": q.get("_id")}; self._apply(base, up); self.docs[base["_id"]] = base
    async def find_one_and_update(self, q, up, projection=None, return_document=None):
        # In-memory analogue of Mongo's atomic findAndModify; the test loop
        # runs synchronously so concurrent calls execute serially — which is
        # the EXACT property the production code now relies on (Mongo gives
        # us this at the document level). Returns the POST-update doc when
        # return_document indicates AFTER (anything other than 'BEFORE'),
        # else the pre-update doc. Returns None if no document matches.
        for d in self.docs.values():
            if _match(d, q):
                before = copy.deepcopy(d)
                self._apply(d, up)
                out = copy.deepcopy(d) if (return_document is None or
                                            str(return_document).upper().endswith("AFTER")) \
                      else before
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None
    def find(self, q, p=None):
        out = []
        for d in self.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0: o.pop("_id", None)
                out.append(o)
        return _Cursor(out)


class _DB:
    def __init__(self): self._c = {}
    def __getitem__(self, n): return self._c.setdefault(n, _Coll())


class _Router:
    def __init__(self): self.routes = {}
    def get(self, p):
        def d(fn): self.routes[("GET", p)] = fn; return fn
        return d
    def post(self, p):
        def d(fn): self.routes[("POST", p)] = fn; return fn
        return d


class _Student:
    def __init__(self, sid="stu_alice"): self.student_id = sid; self.clean_id = sid; self.groups = []


class _Upload:
    def __init__(self, data=b"AUDIODATA", content_type="audio/webm"):
        self._data = data; self.content_type = content_type
    async def read(self): return self._data


def _http_status(e): return getattr(e, "status_code", None)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    yield


def _cfg():
    c = vt_cfg.default_config()
    c["access"]["enabled"] = True
    c["access"]["open_to_all"] = True
    return c


def _build(monkeypatch, eval_outcome=("ok", None)):
    db = _DB(); router = _Router()
    register_voice_treasure_attempt_routes(router, db, require_admin=object(), require_student=object())
    monkeypatch.setattr(vt_cfg, "load_config", lambda _db: _aval(copy.deepcopy(_cfg())))
    captured = {}

    async def fake_eval(**kw):
        captured.update(kw)  # record image_bytes/image_mime/audio_bytes for assertions
        kind, reason = eval_outcome
        if kind == "ok":
            return {"ok": True, "result": {
                "scores": {k: 70 for k in vt_gemini.EVAL_CATEGORIES},
                "overall": 70,
                "understanding_summary": "You described the main scene.",
                "strongest_skill": "relevance",
                "next_improvement": "Add more detail about the people.",
                "coach_feedback": "Nice work. Try organizing from big to small next time.",
            }}
        return {"ok": False, "reason": reason}
    monkeypatch.setattr(vt_gemini, "evaluate_speaking", fake_eval)
    return db, router, captured


def _aval(v):
    async def f(): return v
    return f()


def _seed_paid_entry(db, sid="stu_alice", scene_id="balloon"):
    date = vt_entry._today()
    mid = vt_entry._mission_id_for(date)
    mkey = vt_entry._mission_key(sid, date)
    scene = vt_scenes.SCENES_BY_ID.get(scene_id, {})
    db[vt_entry.COLL_MISSIONS].docs[mkey] = {
        "_id": mkey, "mission_id": mid, "student_id": sid, "date": date,
        "scene_id": scene_id, "image_kind": "bundled",
        "image_ref": scene.get("image_ref", "vt-scene-balloon"),
        "title": scene.get("title"), "alt": scene.get("alt"), "prompt": scene.get("prompt"),
        "playable": True,
    }
    ekey = vt_entry._entry_key(sid, date, mid)
    db[vt_entry.COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": sid, "mission_id": mid,
        "mission_date": date, "state": vt_entry.S_SUCCEEDED, "cost_points": 10,
    }
    return ekey, mid


def _call(router, m, p, **kw): return run(router.routes[(m, p)](**kw))


# ── mission image ─────────────────────────────────────────────────────────
def test_mission_image_returns_bundled_scene(monkeypatch):
    db, router, _cap = _build(monkeypatch)
    _, mid = _seed_paid_entry(db, scene_id="balloon")
    res = _call(router, "GET", "/voice-treasure/mission/{mission_id}/image",
                mission_id=mid, student=_Student())
    assert res["image_kind"] == "bundled"
    assert res["image_ref"] == "vt-scene-balloon"
    assert res.get("prompt")


# ── submit-attempt: gating + validation ────────────────────────────────────
def test_submit_requires_paid_entry(monkeypatch):
    db, router, _cap = _build(monkeypatch)
    # entry exists but NOT paid
    date = vt_entry._today(); mid = vt_entry._mission_id_for(date)
    ekey = vt_entry._entry_key("stu_alice", date, mid)
    db[vt_entry.COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "student_id": "stu_alice", "state": vt_entry.S_CREATED,
        "mission_date": date, "mission_id": mid,
    }
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/submit-attempt",
              entry_id=ekey, audio=_Upload(), student=_Student())
    assert _http_status(ei.value) == 409


def test_submit_rejects_bad_mime(monkeypatch):
    db, router, _cap = _build(monkeypatch)
    ekey, _ = _seed_paid_entry(db)
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/submit-attempt",
              entry_id=ekey, audio=_Upload(content_type="application/json"), student=_Student())
    assert _http_status(ei.value) == 415


def test_submit_rejects_oversize(monkeypatch):
    import voice_treasure_attempt_tools as vta
    db, router, _cap = _build(monkeypatch)
    ekey, _ = _seed_paid_entry(db)
    big = b"x" * (vta.MAX_AUDIO_BYTES + 1)
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/submit-attempt",
              entry_id=ekey, audio=_Upload(data=big), student=_Student())
    assert _http_status(ei.value) == 413


# ── successful evaluation contract ──────────────────────────────────────────
def test_submit_evaluates_and_returns_contract(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db)
    res = _call(router, "POST", "/voice-treasure/submit-attempt",
                entry_id=ekey, audio=_Upload(), student=_Student())
    a = res["attempt"]
    assert a["state"] == A_EVALUATED
    assert a["evaluated"] is True
    # exactly the five score categories, nothing else
    assert set(a["result"]["scores"].keys()) == set(vt_gemini.EVAL_CATEGORIES)
    for f in ("understanding_summary", "strongest_skill", "next_improvement", "coach_feedback", "overall"):
        assert f in a["result"]


def test_no_invented_metric_fields(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db)
    res = _call(router, "POST", "/voice-treasure/submit-attempt",
                entry_id=ekey, audio=_Upload(), student=_Student())
    blob = str(res)
    for banned in ("pronunciation", "fluency", "vocabulary", "pause", "confidence", "acoustic"):
        assert banned not in blob


def test_raw_audio_not_persisted(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db)
    _call(router, "POST", "/voice-treasure/submit-attempt",
          entry_id=ekey, audio=_Upload(data=b"SECRET_AUDIO_BYTES"), student=_Student())
    assert "SECRET_AUDIO_BYTES" not in str(db[COLL_ATTEMPTS].docs)


# ── provider failure / unavailable (retryable, no fabricated scores) ────────
def test_evaluation_unavailable_is_retryable(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("fail", "evaluation_unavailable"))
    ekey, _ = _seed_paid_entry(db)
    res = _call(router, "POST", "/voice-treasure/submit-attempt",
                entry_id=ekey, audio=_Upload(), student=_Student())
    assert res["attempt"]["state"] == A_UNAVAILABLE
    assert "result" not in res["attempt"]  # no fabricated scores


def test_provider_failure_state(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("fail", "provider_rejected"))
    ekey, _ = _seed_paid_entry(db)
    res = _call(router, "POST", "/voice-treasure/submit-attempt",
                entry_id=ekey, audio=_Upload(), student=_Student())
    assert res["attempt"]["state"] == A_FAILED


def test_retry_after_failure_then_success(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("fail", "evaluation_failed"))
    ekey, _ = _seed_paid_entry(db)
    r1 = _call(router, "POST", "/voice-treasure/submit-attempt",
               entry_id=ekey, audio=_Upload(), student=_Student())
    assert r1["attempt"]["state"] == A_FAILED

    async def ok_eval(**kw):
        return {"ok": True, "result": {
            "scores": {k: 80 for k in vt_gemini.EVAL_CATEGORIES}, "overall": 80,
            "understanding_summary": "x", "strongest_skill": "detail",
            "next_improvement": "y", "coach_feedback": "z"}}
    monkeypatch.setattr(vt_gemini, "evaluate_speaking", ok_eval)
    r2 = _call(router, "POST", "/voice-treasure/submit-attempt",
               entry_id=ekey, audio=_Upload(), student=_Student())
    assert r2["attempt"]["state"] == A_EVALUATED


# ── idempotency + recovery + ownership ──────────────────────────────────────
def test_resubmit_evaluated_is_idempotent(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db)
    calls = {"n": 0}

    async def counting(**kw):
        calls["n"] += 1
        return {"ok": True, "result": {
            "scores": {k: 70 for k in vt_gemini.EVAL_CATEGORIES}, "overall": 70,
            "understanding_summary": "x", "strongest_skill": "relevance",
            "next_improvement": "y", "coach_feedback": "z"}}
    monkeypatch.setattr(vt_gemini, "evaluate_speaking", counting)
    r1 = _call(router, "POST", "/voice-treasure/submit-attempt",
               entry_id=ekey, audio=_Upload(), student=_Student())
    r2 = _call(router, "POST", "/voice-treasure/submit-attempt",
               entry_id=ekey, audio=_Upload(), student=_Student())
    assert r2.get("already_evaluated") is True
    assert calls["n"] == 1  # not re-evaluated


def test_result_recovery_by_id(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db)
    r = _call(router, "POST", "/voice-treasure/submit-attempt",
              entry_id=ekey, audio=_Upload(), student=_Student())
    aid = r["attempt"]["attempt_id"]
    got = _call(router, "GET", "/voice-treasure/attempt/{attempt_id}",
                attempt_id=aid, student=_Student())
    assert got["attempt"]["state"] == A_EVALUATED


def test_attempt_ownership_rejected(monkeypatch):
    db, router, _cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db)
    r = _call(router, "POST", "/voice-treasure/submit-attempt",
              entry_id=ekey, audio=_Upload(), student=_Student())
    aid = r["attempt"]["attempt_id"]
    with pytest.raises(Exception) as ei:
        _call(router, "GET", "/voice-treasure/attempt/{attempt_id}",
              attempt_id=aid, student=_Student(sid="stu_mallory"))
    assert _http_status(ei.value) == 404


# ── normalize_evaluation drops invented fields ──────────────────────────────
def test_normalize_drops_invented_fields():
    raw = {
        "scores": {k: 65 for k in vt_gemini.EVAL_CATEGORIES} | {"pronunciation": 99, "fluency": 12},
        "understanding_summary": "s", "strongest_skill": "notacategory",
        "next_improvement": "n", "coach_feedback": "c",
        "confidence": 88, "acoustic_quality": 50,
    }
    norm = vt_gemini.normalize_evaluation(raw)
    assert set(norm["scores"].keys()) == set(vt_gemini.EVAL_CATEGORIES)
    assert "pronunciation" not in norm["scores"] and "fluency" not in norm["scores"]
    assert "confidence" not in norm and "acoustic_quality" not in norm
    # invalid strongest_skill snapped to a real category
    assert norm["strongest_skill"] in vt_gemini.EVAL_CATEGORIES


# ── final pass: exact image bytes → evaluation ──────────────────────────────
def test_assigned_image_bytes_passed_to_adapter(monkeypatch):
    db, router, cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db, scene_id="balloon")
    _call(router, "POST", "/voice-treasure/submit-attempt",
          entry_id=ekey, audio=_Upload(), student=_Student())
    # exact bundled scene bytes + a real image MIME were passed
    assert cap.get("image_bytes") and len(cap["image_bytes"]) > 100
    assert cap.get("image_mime") in ("image/svg+xml", "image/png", "image/webp", "image/jpeg")
    # both image and audio present in the same provider request
    assert cap.get("audio_bytes")


def test_image_bytes_match_assigned_scene(monkeypatch):
    db, router, cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db, scene_id="zoo")
    _call(router, "POST", "/voice-treasure/submit-attempt",
          entry_id=ekey, audio=_Upload(), student=_Student())
    expected, _mime = vt_scenes.load_scene_image_bytes("zoo")
    assert cap["image_bytes"] == expected  # exact assigned scene, not a substitute


def test_missing_image_prevents_evaluation_safely(monkeypatch):
    db, router, cap = _build(monkeypatch, eval_outcome=("ok", None))
    # mission with an unknown scene_id ⇒ no loadable bytes
    ekey, _ = _seed_paid_entry(db, scene_id="balloon")
    date = vt_entry._today()
    mkey = vt_entry._mission_key("stu_alice", date)
    db[vt_entry.COLL_MISSIONS].docs[mkey]["scene_id"] = "does_not_exist"
    res = _call(router, "POST", "/voice-treasure/submit-attempt",
                entry_id=ekey, audio=_Upload(), student=_Student())
    assert res["attempt"]["state"] == A_UNAVAILABLE
    assert "result" not in res["attempt"]      # no fabricated scores
    assert cap == {}                            # adapter never called without image


def test_raw_image_not_persisted(monkeypatch):
    db, router, cap = _build(monkeypatch, eval_outcome=("ok", None))
    ekey, _ = _seed_paid_entry(db, scene_id="balloon")
    _call(router, "POST", "/voice-treasure/submit-attempt",
          entry_id=ekey, audio=_Upload(data=b"SECRET_AUDIO"), student=_Student())
    blob = str(db[COLL_ATTEMPTS].docs)
    assert "SECRET_AUDIO" not in blob
    assert "image_bytes" not in blob and "<svg" not in blob  # no raw image persisted
