"""E2E integration tests for Video Factory pipeline, Sync Review Studio,
publish gate, student flows, and Books Library regression. Targets the
external REACT_APP_BACKEND_URL. Uses mock provider (no GEMINI key).
"""
from __future__ import annotations

import io
import os
import time
import wave

import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
API = f"{BASE_URL}/api"

# Zero-trust fix: the delivered version of this file defaulted BASE_URL to a
# third-party platform's own preview domain (emergentagent.com) when the env
# var was unset. That is an unwanted external dependency this project does
# not use (Gemini is the only AI/platform integration here) and would have
# silently sent live HTTP requests to someone else's infrastructure. This
# suite now requires REACT_APP_BACKEND_URL explicitly and skips otherwise.
pytestmark = pytest.mark.skipif(
    not BASE_URL,
    reason="live E2E suite requires REACT_APP_BACKEND_URL to point at a deployed backend",
)

ADMIN_TOKEN = "admin-test-token"
STUDENT_TOKEN = "student-test-token"
ADMIN_HDR = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
STUDENT_HDR = {"Authorization": f"Bearer {STUDENT_TOKEN}"}


def _wav_bytes(seconds: float = 1.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buf.getvalue()


# ─────────────────────────────────────────────────────────────────────────
# Fixtures: fresh lesson per test group
# ─────────────────────────────────────────────────────────────────────────
@pytest.fixture
def new_lesson():
    r = requests.post(
        f"{API}/studio/video/lessons",
        headers={**ADMIN_HDR, "Content-Type": "application/json"},
        json={"title": "TEST_e2e_lesson", "price": 0},
    )
    assert r.status_code == 200, r.text
    lesson = r.json()["lesson"]
    yield lesson
    # cleanup only if still draft
    requests.delete(
        f"{API}/studio/video/lessons/{lesson['lessonId']}", headers=ADMIN_HDR
    )


# ─────────────────────────────────────────────────────────────────────────
# 1. Lesson creation + media upload -> pipeline scheduled
# ─────────────────────────────────────────────────────────────────────────
class TestPipeline:
    def test_create_lesson_and_upload_media(self, new_lesson):
        lid = new_lesson["lessonId"]
        wav = _wav_bytes(1.0)
        r = requests.post(
            f"{API}/studio/video/lessons/{lid}/media",
            headers=ADMIN_HDR,
            files={"file": ("test.wav", wav, "audio/wav")},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("ok") is True
        assert j["lesson"]["syncId"], "syncId must be set after upload"
        assert j.get("pipelineScheduled") is True

    def test_pipeline_reaches_complete(self, new_lesson):
        lid = new_lesson["lessonId"]
        wav = _wav_bytes(1.0)
        r = requests.post(
            f"{API}/studio/video/lessons/{lid}/media",
            headers=ADMIN_HDR,
            files={"file": ("test.wav", wav, "audio/wav")},
        )
        assert r.status_code == 200

        # poll pipeline for up to 20s
        final = None
        for _ in range(40):
            time.sleep(0.5)
            pr = requests.get(
                f"{API}/studio/video/lessons/{lid}/pipeline", headers=ADMIN_HDR
            )
            assert pr.status_code == 200, pr.text
            data = pr.json()
            pipeline = data.get("pipeline") or {}
            if pipeline.get("state") == "complete":
                final = data
                break
        assert final is not None, "pipeline did not complete in 20s"
        steps = final["pipeline"]["steps"]
        # steps may be dict {name: {...}} or list; normalize
        if isinstance(steps, dict):
            iter_steps = list(steps.values())
        else:
            iter_steps = steps
        assert len(iter_steps) >= 5
        for step in iter_steps:
            assert step["status"] == "complete", f"step not complete: {step}"
        assert final.get("learning") is not None, "learning metadata must be set"
        assert final["learning"].get("cefrLevel") in {"A1", "A2", "B1", "B2", "C1", "C2"}


# ─────────────────────────────────────────────────────────────────────────
# 2. Publish gate: 409 before sync approval; success after approval
# ─────────────────────────────────────────────────────────────────────────
class TestPublishGate:
    def _upload_and_wait(self, lid):
        wav = _wav_bytes(1.0)
        r = requests.post(
            f"{API}/studio/video/lessons/{lid}/media",
            headers=ADMIN_HDR,
            files={"file": ("t.wav", wav, "audio/wav")},
        )
        assert r.status_code == 200
        for _ in range(40):
            time.sleep(0.5)
            pr = requests.get(
                f"{API}/studio/video/lessons/{lid}/pipeline", headers=ADMIN_HDR
            ).json()
            if (pr.get("pipeline") or {}).get("state") == "complete":
                return pr.get("syncId")
        raise AssertionError("pipeline never completed")

    def test_publish_blocked_before_approval(self, new_lesson):
        lid = new_lesson["lessonId"]
        self._upload_and_wait(lid)
        r = requests.patch(
            f"{API}/studio/video/lessons/{lid}",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"status": "published"},
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text}"
        assert "sync" in r.text.lower() or "approv" in r.text.lower()

    def test_publish_succeeds_after_approval(self, new_lesson):
        lid = new_lesson["lessonId"]
        sync_id = self._upload_and_wait(lid)
        # move sync in_review -> approved
        r1 = requests.post(
            f"{API}/studio/sync/{sync_id}/review",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"reviewStatus": "in_review"},
        )
        assert r1.status_code == 200, r1.text
        r2 = requests.post(
            f"{API}/studio/sync/{sync_id}/review",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"reviewStatus": "approved"},
        )
        assert r2.status_code == 200, r2.text
        assert r2.json().get("sync", {}).get("approvedAt")
        # now publish
        rp = requests.patch(
            f"{API}/studio/video/lessons/{lid}",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"status": "published"},
        )
        assert rp.status_code == 200, rp.text
        assert rp.json()["lesson"]["status"] == "published"

        # cleanup: unpublish so fixture teardown can delete
        requests.patch(
            f"{API}/studio/video/lessons/{lid}",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"status": "draft"},
        )


# ─────────────────────────────────────────────────────────────────────────
# 3. Sync Studio edit operations
# ─────────────────────────────────────────────────────────────────────────
class TestSyncEdits:
    @pytest.fixture
    def sync_id(self, new_lesson):
        lid = new_lesson["lessonId"]
        wav = _wav_bytes(1.0)
        requests.post(
            f"{API}/studio/video/lessons/{lid}/media",
            headers=ADMIN_HDR,
            files={"file": ("t.wav", wav, "audio/wav")},
        )
        for _ in range(40):
            time.sleep(0.5)
            pr = requests.get(
                f"{API}/studio/video/lessons/{lid}/pipeline", headers=ADMIN_HDR
            ).json()
            if (pr.get("pipeline") or {}).get("state") == "complete":
                return pr["syncId"]
        raise AssertionError("pipeline never completed")

    def test_edit_word_bumps_version_and_snapshots(self, sync_id):
        r = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"operations": [{"op": "edit_word", "p": 0, "s": 0, "w": 0, "word": "TEST"}]},
        )
        assert r.status_code == 200, r.text
        sync = r.json()["sync"]
        assert sync["reviewStatus"] == "in_review"
        assert sync.get("alignmentVersion", 1) >= 2
        assert sync.get("originalParagraphs") is not None

    def test_split_then_merge_preserves_word_count(self, sync_id):
        # snapshot word count
        s0 = requests.get(f"{API}/studio/sync/{sync_id}", headers=ADMIN_HDR).json()["sync"]
        total = sum(len(s["words"]) for p in s0["paragraphs"] for s in p["sentences"])

        r1 = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"operations": [{"op": "split_sentence", "p": 0, "s": 0, "at": 1}]},
        )
        assert r1.status_code == 200, r1.text

        r2 = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"operations": [{"op": "merge_sentences", "p": 0, "s": 0}]},
        )
        assert r2.status_code == 200, r2.text
        s2 = r2.json()["sync"]
        total_after = sum(len(s["words"]) for p in s2["paragraphs"] for s in p["sentences"])
        assert total_after == total

    def test_rename_speaker_changes_label(self, sync_id):
        cur = requests.get(f"{API}/studio/sync/{sync_id}", headers=ADMIN_HDR).json()["sync"]
        sp_id = cur["speakers"][0]["id"]
        r = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"operations": [{"op": "rename_speaker", "id": sp_id, "label": "Teacher"}]},
        )
        assert r.status_code == 200
        speakers = r.json()["sync"]["speakers"]
        assert any(sp["id"] == sp_id and sp["label"] == "Teacher" for sp in speakers)

    def test_invalid_op_returns_400(self, sync_id):
        r = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"operations": [{"op": "explode"}]},
        )
        assert r.status_code == 400

    def test_bad_index_returns_400(self, sync_id):
        r = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            headers={**ADMIN_HDR, "Content-Type": "application/json"},
            json={"operations": [{"op": "edit_word", "p": 999, "s": 0, "w": 0, "word": "x"}]},
        )
        assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────────
# 4. Student flows against seeded lesson vid_8d7b26341a204cc9
# ─────────────────────────────────────────────────────────────────────────
SEEDED_OWNED_LESSON = "vid_8d7b26341a204cc9"


class TestStudentFlow:
    def test_list_published_lessons(self):
        r = requests.get(f"{API}/video/lessons", headers=STUDENT_HDR)
        assert r.status_code == 200, r.text
        data = r.json()
        lessons = data.get("lessons") or data.get("items") or []
        assert isinstance(lessons, list)
        assert len(lessons) >= 1
        # owned lesson should exist and have syncId + owned true
        seeded = [l for l in lessons if l["lessonId"] == SEEDED_OWNED_LESSON]
        if seeded:
            assert seeded[0].get("owned") is True

    def test_paid_unowned_hides_syncid(self):
        r = requests.get(f"{API}/video/lessons", headers=STUDENT_HDR)
        lessons = r.json().get("lessons") or r.json().get("items") or []
        # find any paid unowned
        unowned_paid = [
            l for l in lessons
            if l.get("price", 0) > 0 and l.get("owned") is False
        ]
        for l in unowned_paid:
            assert "syncId" not in l, f"paid unowned lesson leaks syncId: {l['lessonId']}"
            assert "mediaRef" not in l

    def test_search_q_matches(self):
        r = requests.get(f"{API}/video/lessons?q=coffee", headers=STUDENT_HDR)
        assert r.status_code == 200
        lessons = r.json().get("lessons") or r.json().get("items") or []
        # coffee should match the seeded lesson
        assert len(lessons) >= 1

    def test_search_q_no_match(self):
        r = requests.get(f"{API}/video/lessons?q=zzznothingxyz", headers=STUDENT_HDR)
        assert r.status_code == 200
        lessons = r.json().get("lessons") or r.json().get("items") or []
        assert len(lessons) == 0

    def test_notes_put_then_get(self):
        put = requests.put(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}/notes",
            headers={**STUDENT_HDR, "Content-Type": "application/json"},
            json={"text": "hi"},
        )
        assert put.status_code == 200, put.text
        get = requests.get(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}/notes", headers=STUDENT_HDR
        )
        assert get.status_code == 200
        body = get.json()
        text = body.get("text") or (body.get("note") or {}).get("text")
        assert text == "hi"

    def test_progress_record_and_list_all(self):
        p = requests.post(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}/progress",
            headers={**STUDENT_HDR, "Content-Type": "application/json"},
            json={"positionSec": 12, "durationSec": 300},
        )
        assert p.status_code == 200, p.text
        g = requests.get(f"{API}/video/progress/mine?all=1", headers=STUDENT_HDR)
        assert g.status_code == 200
        records = g.json().get("progress") or g.json().get("records") or g.json().get("items") or []
        assert any(rec.get("lessonId") == SEEDED_OWNED_LESSON for rec in records)

    def test_bookmark_toggle(self):
        r1 = requests.post(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}/bookmark", headers=STUDENT_HDR
        )
        assert r1.status_code == 200, r1.text
        state1 = r1.json().get("bookmarked")
        r2 = requests.post(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}/bookmark", headers=STUDENT_HDR
        )
        assert r2.status_code == 200
        state2 = r2.json().get("bookmarked")
        assert state1 != state2


# ─────────────────────────────────────────────────────────────────────────
# 5. Sync visibility + media streaming
# ─────────────────────────────────────────────────────────────────────────
class TestSyncAccess:
    def test_student_sync_404_when_not_approved(self, new_lesson):
        lid = new_lesson["lessonId"]
        wav = _wav_bytes(1.0)
        requests.post(
            f"{API}/studio/video/lessons/{lid}/media",
            headers=ADMIN_HDR,
            files={"file": ("t.wav", wav, "audio/wav")},
        )
        sync_id = None
        for _ in range(40):
            time.sleep(0.5)
            pr = requests.get(
                f"{API}/studio/video/lessons/{lid}/pipeline", headers=ADMIN_HDR
            ).json()
            if (pr.get("pipeline") or {}).get("state") == "complete":
                sync_id = pr["syncId"]
                break
        assert sync_id
        r = requests.get(f"{API}/sync/{sync_id}", headers=STUDENT_HDR)
        assert r.status_code == 404

    def test_media_stream_supports_range(self):
        # first find a media file from the seeded lesson via sync
        # get lesson detail as student (owned so mediaRef available)
        r = requests.get(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}", headers=STUDENT_HDR
        )
        if r.status_code != 200:
            pytest.skip("seeded lesson detail not accessible")
        media_ref = r.json().get("lesson", {}).get("mediaRef") or r.json().get("mediaRef")
        if not media_ref or "sync_media/" not in str(media_ref):
            pytest.skip(f"seeded lesson has no gridfs mediaRef: {media_ref}")
        filename = media_ref.split("sync_media/")[-1]
        head = requests.get(
            f"{API}/sync/media/{filename}",
            headers={**STUDENT_HDR, "Range": "bytes=0-99"},
            stream=True,
        )
        assert head.status_code in (200, 206), f"status={head.status_code}"


# ─────────────────────────────────────────────────────────────────────────
# 6. Purchase behavior (GAS not configured → expected 'failed no_gas_url')
# ─────────────────────────────────────────────────────────────────────────
class TestPurchase:
    def test_duplicate_purchase_returns_already_owned(self):
        r = requests.post(
            f"{API}/video/lessons/{SEEDED_OWNED_LESSON}/purchase",
            headers={**STUDENT_HDR, "Content-Type": "application/json"},
            json={"password": "x"},
        )
        # seeded student already owns this lesson → 409 already_owned
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text}"
        assert "already_owned" in r.text.lower() or "own" in r.text.lower()

    def test_paid_unowned_purchase_reports_no_gas(self):
        # find a paid unowned lesson
        r = requests.get(f"{API}/video/lessons", headers=STUDENT_HDR)
        lessons = r.json().get("lessons") or r.json().get("items") or []
        target = next(
            (l for l in lessons if l.get("price", 0) > 0 and l.get("owned") is False),
            None,
        )
        if not target:
            pytest.skip("no paid unowned lesson to try")
        p = requests.post(
            f"{API}/video/lessons/{target['lessonId']}/purchase",
            headers={**STUDENT_HDR, "Content-Type": "application/json"},
            json={"password": "x"},
        )
        # expected: ok false, purchase.state failed reason no_gas_url
        assert p.status_code in (200, 400, 402, 409)
        body = p.json() if p.headers.get("content-type", "").startswith("application/json") else {}
        combined = str(body).lower()
        assert "no_gas" in combined or "gas" in combined or body.get("ok") is False


# ─────────────────────────────────────────────────────────────────────────
# 7. Regression: books library still works
# ─────────────────────────────────────────────────────────────────────────
def test_books_regression():
    r = requests.get(f"{API}/books")
    assert r.status_code == 200, r.text
    assert r.json().get("success") is True
