"""Iteration-2 fix verification for the Video Library product.

Verifies only the fixes reported in /app/test_reports/iteration_1.json:
 1. POST /api/studio/video/lessons -> 400 (not 500) for invalid
    category/difficulty/cefrLevel, and 400 for blank/whitespace title.
 2. POST /api/studio/sync/{syncId}/review -> no editHistory/redoHistory leak,
    includes undoDepth/redoDepth.
 3. Seeded lessons expose real thumbnails + durationSec == 3.
Runs against the public preview URL.
"""
import io
import os
import struct
import time
import wave

import pytest
import requests

# Zero-trust fix: see test_video_library_e2e.py's identical fix — this file
# shipped with the same hardcoded /app/frontend/.env Emergent-preview path
# and unconditional RuntimeError, replaced with the established
# REACT_APP_BACKEND_URL + skipif pattern.
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
API = f"{BASE_URL}/api"
pytestmark = pytest.mark.skipif(
    not BASE_URL,
    reason="live E2E suite requires REACT_APP_BACKEND_URL to point at a deployed backend",
)

ADMIN_H = {"Authorization": "Bearer testadmintoken123"}
STUDENT_H = {"Authorization": "Bearer teststudenttoken123"}


def make_wav(seconds=3, rate=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", (i % 200) * 100 - 10000) for i in range(rate * seconds)))
    return buf.getvalue()


@pytest.fixture(scope="module")
def created_lessons():
    ids = []
    yield ids
    for lid in ids:
        requests.patch(f"{API}/studio/video/lessons/{lid}", json={"status": "draft"}, headers=ADMIN_H, timeout=60)
        requests.delete(f"{API}/studio/video/lessons/{lid}/media", headers=ADMIN_H, timeout=60)
        requests.delete(f"{API}/studio/video/lessons/{lid}", headers=ADMIN_H, timeout=60)


# ── FIX 1: create-lesson validation returns 400, not 500 ───────────────────
class TestCreateValidation:
    @pytest.mark.parametrize(
        "field,value",
        [("category", "nonsense"), ("difficulty", "nope"), ("cefrLevel", "Z9")],
    )
    def test_invalid_enum_returns_400(self, field, value):
        payload = {"title": "TEST_ invalid enum", "price": 0, field: value}
        r = requests.post(f"{API}/studio/video/lessons", json=payload, headers=ADMIN_H, timeout=60)
        assert r.status_code == 400, f"{field}={value} -> {r.status_code}: {r.text[:300]}"
        body = r.json()
        detail = body.get("detail", body)
        text = str(detail).lower()
        assert "invalid" in text, detail

    @pytest.mark.parametrize("title", ["", "   ", "\t\n "])
    def test_blank_title_returns_400(self, title):
        r = requests.post(
            f"{API}/studio/video/lessons",
            json={"title": title, "price": 0},
            headers=ADMIN_H,
            timeout=60,
        )
        assert r.status_code == 400, f"title={title!r} -> {r.status_code}: {r.text[:300]}"
        assert "title" in r.text.lower()

    def test_valid_lesson_still_creates(self, created_lessons):
        r = requests.post(
            f"{API}/studio/video/lessons",
            json={
                "title": "TEST_ iter2 fix verification",
                "price": 0,
                "category": "ielts",
                "difficulty": "intermediate",
                "cefrLevel": "B2",
            },
            headers=ADMIN_H,
            timeout=60,
        )
        assert r.status_code == 200, r.text
        lesson = r.json()["lesson"]
        created_lessons.append(lesson["lessonId"])
        assert lesson["title"] == "TEST_ iter2 fix verification"
        assert lesson["cefrLevel"] == "B2"
        # persistence check via the studio list route (no single-GET route exists)
        g = requests.get(f"{API}/studio/video/lessons", headers=ADMIN_H, timeout=60)
        assert g.status_code == 200, g.text
        match = [l for l in g.json()["lessons"] if l["lessonId"] == lesson["lessonId"]]
        assert match, "created lesson not persisted"
        assert match[0]["title"] == "TEST_ iter2 fix verification"


# ── FIX 2: review response no longer leaks history ─────────────────────────
class TestReviewResponseNoHistoryLeak:
    def test_review_response_strips_history(self, created_lessons):
        # create lesson + upload media + run pipeline to obtain a sync doc
        r = requests.post(
            f"{API}/studio/video/lessons",
            json={"title": "TEST_ iter2 review leak", "price": 0, "category": "ielts"},
            headers=ADMIN_H,
            timeout=60,
        )
        assert r.status_code == 200, r.text
        lesson_id = r.json()["lesson"]["lessonId"]
        created_lessons.append(lesson_id)

        up = requests.post(
            f"{API}/studio/video/lessons/{lesson_id}/media",
            files={"file": ("test.wav", make_wav(), "audio/wav")},
            headers=ADMIN_H,
            timeout=180,
        )
        assert up.status_code == 200, up.text
        sync_id = up.json()["lesson"].get("syncId")
        assert sync_id, "no syncId bound after upload"

        # wait for the (mock) pipeline to finish so segments exist
        for _ in range(40):
            pr = requests.get(f"{API}/studio/video/lessons/{lesson_id}/pipeline", headers=ADMIN_H, timeout=60)
            assert pr.status_code == 200, pr.text
            if (pr.json().get("pipeline") or {}).get("state") in ("complete", "failed"):
                break
            time.sleep(3)
        assert (pr.json().get("pipeline") or {}).get("state") == "complete"

        # make at least one edit so history is non-empty
        doc = requests.get(f"{API}/studio/sync/{sync_id}", headers=ADMIN_H, timeout=60).json()["sync"]
        assert doc.get("paragraphs"), "mock pipeline produced no paragraphs"
        ed = requests.post(
            f"{API}/studio/sync/{sync_id}/edit",
            json={"operations": [{"op": "replace_sentence_text", "p": 0, "s": 0,
                                  "text": "TEST edited sentence here"}]},
            headers=ADMIN_H,
            timeout=60,
        )
        assert ed.status_code == 200, ed.text
        assert ed.json()["sync"].get("undoDepth", 0) >= 1

        rev = requests.post(
            f"{API}/studio/sync/{sync_id}/review",
            json={"reviewStatus": "approved"},
            headers=ADMIN_H,
            timeout=60,
        )
        assert rev.status_code == 200, rev.text
        sync = rev.json()["sync"]
        assert "editHistory" not in sync, "editHistory leaked in review response"
        assert "redoHistory" not in sync, "redoHistory leaked in review response"
        assert "undoDepth" in sync and isinstance(sync["undoDepth"], int)
        assert "redoDepth" in sync and isinstance(sync["redoDepth"], int)
        assert sync["undoDepth"] >= 1
        assert sync["reviewStatus"] == "approved"


# ── FIX 5: seeded lessons have real thumbnails + 3s duration ───────────────
class TestSeededLessonMedia:
    def test_seeded_lessons_have_thumbnails_and_3s_duration(self):
        r = requests.get(f"{API}/video/lessons", headers=STUDENT_H, timeout=60)
        assert r.status_code == 200, r.text
        lessons = r.json()["lessons"]
        assert len(lessons) >= 4
        for lesson in lessons:
            thumb = lesson.get("thumbnailUrl")
            assert thumb, f"{lesson['title']} has no thumbnailUrl"
            img = requests.get(f"{BASE_URL}{thumb}" if thumb.startswith("/") else thumb, timeout=60)
            assert img.status_code == 200, f"thumbnail {thumb} -> {img.status_code}"
            assert img.headers.get("content-type", "").startswith("image/")
            assert len(img.content) > 1000
            assert float(lesson["durationSec"]) == pytest.approx(3.0, abs=0.6), lesson["title"]
