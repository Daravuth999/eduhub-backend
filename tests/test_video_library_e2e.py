"""End-to-end API tests for the Video Library product (Video Factory studio
workflow + student marketplace routes). Runs against the public preview URL.

Covers: lesson create/patch, media upload (GridFS fallback), AI pipeline
(mock provider) with log array, sync edit/undo/redo + history leak check,
review transitions + publish gate, media delete 409/clear, stats,
teleprompterConfig merge/validation, and student routes.
"""
import io
import os
import struct
import time
import wave

import pytest
import requests

# Zero-trust fix: the delivered version of this file read a hardcoded
# /app/frontend/.env path (an Emergent-preview-environment-specific
# location, not portable to this or any other deployment) and raised
# RuntimeError at collection time when REACT_APP_BACKEND_URL was unset —
# crashing the whole pytest run instead of skipping. Matches the same
# fix already applied to test_video_factory_e2e.py.
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
API = f"{BASE_URL}/api"
pytestmark = pytest.mark.skipif(
    not BASE_URL,
    reason="live E2E suite requires REACT_APP_BACKEND_URL to point at a deployed backend",
)

ADMIN_TOKEN = "testadmintoken123"
STUDENT_TOKEN = "teststudenttoken123"

ADMIN_H = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
STUDENT_H = {"Authorization": f"Bearer {STUDENT_TOKEN}"}


def make_wav(seconds=3, rate=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = b"".join(struct.pack("<h", (i % 200) * 100 - 10000) for i in range(rate * seconds))
        w.writeframes(frames)
    return buf.getvalue()


@pytest.fixture(scope="module")
def created_lessons():
    ids = []
    yield ids
    for lid in ids:
        requests.patch(f"{API}/studio/video/lessons/{lid}", json={"status": "draft"}, headers=ADMIN_H, timeout=60)
        requests.delete(f"{API}/studio/video/lessons/{lid}", headers=ADMIN_H, timeout=60)


def _create(created_lessons, **over):
    payload = {
        "title": "TEST_ Video Factory Lesson",
        "description": "TEST description for automated QA",
        "tags": ["TEST", "ielts", "qa"],
        "category": "ielts",
        "difficulty": "intermediate",
        "cefrLevel": "B2",
        "price": 40,
    }
    payload.update(over)
    r = requests.post(f"{API}/studio/video/lessons", json=payload, headers=ADMIN_H, timeout=60)
    assert r.status_code == 200, r.text
    lesson = r.json()["lesson"]
    created_lessons.append(lesson["lessonId"])
    return lesson


# ── Module: lesson metadata CRUD ───────────────────────────────────────────
class TestLessonCreation:
    def test_create_lesson_defaults_and_tags(self, created_lessons):
        lesson = _create(created_lessons)
        assert lesson["lessonId"].startswith("vid_")
        assert lesson["category"] == "ielts"
        assert lesson["difficulty"] == "intermediate"
        assert lesson["cefrLevel"] == "B2"
        assert lesson["price"] == 40
        assert lesson["status"] == "draft"
        assert lesson["tags"] == ["TEST", "ielts", "qa"]
        tp = lesson["teleprompterConfig"]
        assert tp["mode"] == "auto"
        assert tp["karaoke"] is False
        assert tp["fontScale"] == 1.0
        assert tp["autoScroll"] is True
        assert "_id" not in lesson

        # verify persistence via admin listing
        got = requests.get(f"{API}/studio/video/lessons", headers=ADMIN_H, timeout=60).json()["lessons"]
        match = [l for l in got if l["lessonId"] == lesson["lessonId"]]
        assert match, "created lesson not present in admin listing"
        assert match[0]["description"] == "TEST description for automated QA"

    def test_create_invalid_category_rejected(self):
        r = requests.post(f"{API}/studio/video/lessons",
                          json={"title": "TEST_ bad", "price": 0, "category": "nonsense"},
                          headers=ADMIN_H, timeout=60)
        assert r.status_code in (400, 422), r.text

    def test_admin_routes_require_auth(self):
        r = requests.get(f"{API}/studio/video/lessons", timeout=60)
        assert r.status_code in (401, 403), r.text


# ── Module: teleprompterConfig merge/validation ────────────────────────────
class TestTeleprompterConfig:
    def test_patch_merges_with_defaults(self, created_lessons):
        lesson = _create(created_lessons, title="TEST_ teleprompter")
        lid = lesson["lessonId"]
        r = requests.patch(f"{API}/studio/video/lessons/{lid}",
                           json={"teleprompterConfig": {"karaoke": True, "fontScale": 1.3}},
                           headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        cfg = r.json()["lesson"]["teleprompterConfig"]
        assert cfg["karaoke"] is True
        assert cfg["fontScale"] == 1.3
        assert cfg["mode"] == "auto"
        assert cfg["lineSpacing"] == 1.9
        assert set(cfg) >= {"mode", "wordHighlight", "sentenceHighlight", "autoScroll", "scrollSpeed"}

        # persisted?
        got = [l for l in requests.get(f"{API}/studio/video/lessons", headers=ADMIN_H, timeout=60).json()["lessons"]
               if l["lessonId"] == lid][0]
        assert got["teleprompterConfig"]["karaoke"] is True
        assert got["teleprompterConfig"]["fontScale"] == 1.3

    def test_invalid_teleprompter_config_rejected(self, created_lessons):
        lesson = _create(created_lessons, title="TEST_ bad teleprompter")
        r = requests.patch(f"{API}/studio/video/lessons/{lesson['lessonId']}",
                           json={"teleprompterConfig": "not-an-object"}, headers=ADMIN_H, timeout=60)
        assert r.status_code == 400, r.text


# ── Module: media upload → pipeline → sync edit/undo/redo → publish ───────
class TestProductionWorkflow:
    lesson_id = None
    sync_id = None

    def test_01_upload_media_schedules_pipeline(self, created_lessons):
        lesson = _create(created_lessons, title="TEST_ Production Workflow")
        TestProductionWorkflow.lesson_id = lesson["lessonId"]
        files = {"file": ("test.wav", make_wav(), "audio/wav")}
        r = requests.post(f"{API}/studio/video/lessons/{lesson['lessonId']}/media",
                          files=files, headers=ADMIN_H, timeout=120)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["pipelineScheduled"] is True
        doc = body["lesson"]
        assert doc["mediaRef"], "mediaRef not bound after upload"
        assert doc["syncId"], "syncId not bound after upload"
        assert doc["contentType"] == "audio/wav"
        TestProductionWorkflow.sync_id = doc["syncId"]

    def test_02_pipeline_completes_with_log(self):
        lid = TestProductionWorkflow.lesson_id
        assert lid
        state, pipeline = None, None
        for _ in range(40):
            r = requests.get(f"{API}/studio/video/lessons/{lid}/pipeline", headers=ADMIN_H, timeout=60)
            assert r.status_code == 200, r.text
            pipeline = r.json().get("pipeline") or {}
            state = pipeline.get("state")
            if state in ("complete", "failed"):
                break
            time.sleep(3)
        assert state == "complete", f"pipeline state={state} pipeline={pipeline}"
        log = pipeline.get("log")
        assert isinstance(log, list) and len(log) > 0, f"pipeline log missing/empty: {log}"
        assert all(isinstance(e, dict) for e in log)
        assert any("provider" in str(pipeline).lower() or e.get("step") for e in log)

    def test_03_sync_document_has_paragraphs_and_no_history_leak(self):
        sid = TestProductionWorkflow.sync_id
        r = requests.get(f"{API}/studio/sync/{sid}", headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        doc = r.json()["sync"]
        assert doc["alignmentStatus"] == "complete", doc.get("alignmentStatus")
        assert doc.get("paragraphs"), "no paragraphs produced by mock pipeline"
        assert "editHistory" not in doc
        assert "redoHistory" not in doc
        assert doc["undoDepth"] == 0
        assert doc["redoDepth"] == 0

    def test_04_edit_undo_redo(self):
        sid = TestProductionWorkflow.sync_id
        before = requests.get(f"{API}/studio/sync/{sid}", headers=ADMIN_H, timeout=60).json()["sync"]
        original_words = [w["word"] for w in before["paragraphs"][0]["sentences"][0]["words"]]

        r = requests.post(f"{API}/studio/sync/{sid}/edit",
                          json={"operations": [{"op": "replace_sentence_text", "p": 0, "s": 0,
                                                "text": "QA edited sentence here"}]},
                          headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        edited = r.json()["sync"]
        assert "editHistory" not in edited and "redoHistory" not in edited
        assert edited["undoDepth"] == 1
        assert edited["redoDepth"] == 0
        assert edited["reviewStatus"] == "in_review"
        new_words = [w["word"] for w in edited["paragraphs"][0]["sentences"][0]["words"]]
        assert new_words == ["QA", "edited", "sentence", "here"], new_words

        r = requests.post(f"{API}/studio/sync/{sid}/undo", headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        undone = r.json()["sync"]
        assert undone["undoDepth"] == 0
        assert undone["redoDepth"] == 1
        assert [w["word"] for w in undone["paragraphs"][0]["sentences"][0]["words"]] == original_words

        r = requests.post(f"{API}/studio/sync/{sid}/redo", headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        redone = r.json()["sync"]
        assert redone["undoDepth"] == 1
        assert redone["redoDepth"] == 0
        assert [w["word"] for w in redone["paragraphs"][0]["sentences"][0]["words"]] == \
            ["QA", "edited", "sentence", "here"]

        # undo beyond history
        requests.post(f"{API}/studio/sync/{sid}/undo", headers=ADMIN_H, timeout=60)
        r = requests.post(f"{API}/studio/sync/{sid}/undo", headers=ADMIN_H, timeout=60)
        assert r.status_code == 409, r.text

    def test_05_publish_blocked_until_sync_approved(self):
        lid, sid = TestProductionWorkflow.lesson_id, TestProductionWorkflow.sync_id
        cur = requests.get(f"{API}/studio/sync/{sid}", headers=ADMIN_H, timeout=60).json()["sync"]
        assert cur["reviewStatus"] != "approved"
        r = requests.patch(f"{API}/studio/video/lessons/{lid}", json={"status": "published"},
                           headers=ADMIN_H, timeout=60)
        assert r.status_code == 409, f"publish should be rejected without approved sync: {r.status_code} {r.text}"
        assert "approve" in r.text.lower()

    def test_06_review_transitions_and_publish(self):
        lid, sid = TestProductionWorkflow.lesson_id, TestProductionWorkflow.sync_id
        r = requests.post(f"{API}/studio/sync/{sid}/review", json={"reviewStatus": "in_review"},
                          headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        assert r.json()["sync"]["reviewStatus"] == "in_review"

        r = requests.post(f"{API}/studio/sync/{sid}/review", json={"reviewStatus": "approved"},
                          headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        approved = r.json()["sync"]
        assert approved["reviewStatus"] == "approved"
        assert approved.get("approvedAt")
        TestProductionWorkflow.review_response_keys = list(approved.keys())

        r = requests.patch(f"{API}/studio/video/lessons/{lid}", json={"status": "published"},
                           headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        assert r.json()["lesson"]["status"] == "published"

    def test_06b_review_response_does_not_leak_history(self):
        keys = getattr(TestProductionWorkflow, "review_response_keys", None)
        assert keys, "review response not captured"
        assert "editHistory" not in keys and "redoHistory" not in keys, \
            "POST /studio/sync/{id}/review leaks editHistory/redoHistory (route omits strip_history)"
        assert "undoDepth" in keys and "redoDepth" in keys, \
            "POST /studio/sync/{id}/review omits undoDepth/redoDepth counters"

    def test_07_delete_media_conflicts_while_published(self):
        lid = TestProductionWorkflow.lesson_id
        r = requests.delete(f"{API}/studio/video/lessons/{lid}/media", headers=ADMIN_H, timeout=60)
        assert r.status_code == 409, r.text
        assert "unpublish" in r.text.lower()

    def test_08_delete_lesson_conflicts_while_published(self):
        r = requests.delete(f"{API}/studio/video/lessons/{TestProductionWorkflow.lesson_id}",
                            headers=ADMIN_H, timeout=60)
        assert r.status_code == 409, r.text
        assert "unpublish" in r.text.lower()

    def test_09_stats_shape(self):
        lid = TestProductionWorkflow.lesson_id
        r = requests.get(f"{API}/studio/video/lessons/{lid}/stats", headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        for key in ("owners", "revenuePoints", "learners", "completions", "avgProgress", "bookmarks", "purchases"):
            assert key in stats, f"missing {key} in {stats}"
        assert stats["lessonId"] == lid
        assert isinstance(stats["owners"], int)
        assert isinstance(stats["avgProgress"], float)

    def test_10_unpublish_then_delete_media_clears_refs(self):
        lid = TestProductionWorkflow.lesson_id
        r = requests.patch(f"{API}/studio/video/lessons/{lid}", json={"status": "draft"},
                           headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        r = requests.delete(f"{API}/studio/video/lessons/{lid}/media", headers=ADMIN_H, timeout=60)
        assert r.status_code == 200, r.text
        lesson = r.json()["lesson"]
        assert lesson["mediaRef"] is None
        assert lesson["syncId"] is None
        assert lesson["durationSec"] == 0.0
        assert "pipeline" not in lesson
        assert "contentType" not in lesson

        p = requests.get(f"{API}/studio/video/lessons/{lid}/pipeline", headers=ADMIN_H, timeout=60)
        assert p.status_code in (200, 404)
        if p.status_code == 200:
            assert not (p.json().get("pipeline") or {})


# ── Module: student-facing routes ──────────────────────────────────────────
class TestStudentRoutes:
    def test_list_published_only_and_media_gating(self):
        r = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60)
        assert r.status_code == 200, r.text
        lessons = r.json()["lessons"]
        assert lessons, "no published lessons visible to student"
        assert all(l["status"] == "published" for l in lessons)
        for l in lessons:
            if l["price"] > 0 and not l["owned"]:
                assert "mediaRef" not in l, f"paid unowned lesson leaks mediaRef: {l['lessonId']}"
                assert "syncId" not in l, f"paid unowned lesson leaks syncId: {l['lessonId']}"
            if l["price"] <= 0:
                assert l["owned"] is True
                assert "mediaRef" in l

    def test_student_routes_require_auth(self):
        r = requests.get(f"{API}/video/lessons", timeout=60)
        assert r.status_code in (401, 403), r.text

    def test_free_lesson_detail_has_mediaref(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        free = [l for l in lessons if l["price"] <= 0 and l.get("mediaRef")]
        assert free, "expected at least one free lesson with media"
        lid = free[0]["lessonId"]
        r = requests.get(f"{API}/video/lessons/{lid}", headers=STUDENT_H, timeout=60)
        assert r.status_code == 200, r.text
        lesson = r.json()["lesson"]
        assert lesson["owned"] is True
        assert lesson["mediaRef"]

    def test_progress_roundtrip(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        lid = [l for l in lessons if l["price"] <= 0][0]["lessonId"]
        r = requests.post(f"{API}/video/lessons/{lid}/progress",
                          json={"positionSec": 5.5, "durationSec": 30.0}, headers=STUDENT_H, timeout=60)
        assert r.status_code == 200, r.text
        prog = r.json()["progress"]
        assert prog["positionSec"] == 5.5
        assert prog["completed"] is False
        mine = requests.get(f"{API}/video/progress/mine", headers=STUDENT_H, timeout=60).json()["progress"]
        assert any(p["lessonId"] == lid and p["positionSec"] == 5.5 for p in mine), mine

    def test_bookmark_toggle(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        lid = [l for l in lessons if l["price"] <= 0][0]["lessonId"]
        first = requests.post(f"{API}/video/lessons/{lid}/bookmark", headers=STUDENT_H, timeout=60)
        assert first.status_code == 200, first.text
        state1 = first.json()["bookmarked"]
        listed = requests.get(f"{API}/video/bookmarks/mine", headers=STUDENT_H, timeout=60).json()["bookmarks"]
        assert (any(b["lessonId"] == lid for b in listed)) is state1
        second = requests.post(f"{API}/video/lessons/{lid}/bookmark", headers=STUDENT_H, timeout=60)
        assert second.json()["bookmarked"] is (not state1)

    def test_notes_roundtrip(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        lid = [l for l in lessons if l["price"] <= 0][0]["lessonId"]
        text = "TEST_ my study note 123"
        r = requests.put(f"{API}/video/lessons/{lid}/notes", json={"text": text}, headers=STUDENT_H, timeout=60)
        assert r.status_code == 200, r.text
        assert r.json()["note"]["text"] == text
        got = requests.get(f"{API}/video/lessons/{lid}/notes", headers=STUDENT_H, timeout=60)
        assert got.status_code == 200
        assert got.json()["note"]["text"] == text

    def test_sync_public_route_serves_only_approved(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        with_sync = [l for l in lessons if l.get("syncId")]
        assert with_sync, "no lesson with syncId available to student"
        for l in with_sync[:4]:
            r = requests.get(f"{API}/sync/{l['syncId']}", headers=STUDENT_H, timeout=60)
            assert r.status_code in (200, 403, 404), r.text
            if r.status_code == 200:
                doc = r.json()["sync"]
                assert doc.get("reviewStatus") == "approved", \
                    f"non-approved sync served publicly: {l['syncId']} {doc.get('reviewStatus')}"
                assert "editHistory" not in doc and "redoHistory" not in doc

    def test_purchase_paid_lesson_fails_safely(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        paid = [l for l in lessons if l["price"] > 0 and not l["owned"]]
        if not paid:
            pytest.skip("no paid unowned lesson available")
        lid = paid[0]["lessonId"]
        r = requests.post(f"{API}/video/lessons/{lid}/purchase", json={"password": "student123"},
                          headers=STUDENT_H, timeout=120)
        assert r.status_code in (200, 409), r.text
        if r.status_code == 200:
            body = r.json()
            assert body["ok"] is False, "purchase should not succeed without GAS wallet"
            assert body["purchase"]["state"] in ("failed", "reconcile"), body["purchase"]["state"]
        # no entitlement granted
        after = requests.get(f"{API}/video/lessons/{lid}", headers=STUDENT_H, timeout=60).json()["lesson"]
        assert after["owned"] is False
        assert "mediaRef" not in after

    def test_free_lesson_purchase_rejected(self):
        lessons = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60).json()["lessons"]
        free = [l for l in lessons if l["price"] <= 0]
        r = requests.post(f"{API}/video/lessons/{free[0]['lessonId']}/purchase",
                          json={"password": "student123"}, headers=STUDENT_H, timeout=60)
        assert r.status_code == 400, r.text
