"""assessment_tools.py — AI Assessment / Quiz Submission Lab routes.

Student flow: upload a photo/PDF of a completed paper worksheet ->
Gemini extracts the marked answers -> deterministic scoring against the
teacher's answer key -> teacher reviews/corrects in Author Studio ->
teacher awards points (individually or in bulk) via the EXISTING wallet
service, notified via the EXISTING push/notification pipeline. No second
wallet, no fabricated scores, no double-award — see the awarding section.

Collections OWNED by this module (tools/check_collection_ownership.py):
  assessments             — teacher-authored/approved question sets.
  assessment_submissions  — one per student attempt.
  assessment_awards       — one per submission's point-award reservation,
                            unique-indexed on submissionId so a double
                            click (or a retried request) can never award
                            twice — mirrors achievement_tools.py's claim
                            pattern.

Media storage follows sync_studio_tools.py's proven R2-first, GridFS-
fallback pattern exactly (own bucket/prefix, so the two features' media
never collide): R2 key prefix `assessment-media/`, GridFS bucket
`assessment_media`.

Point-awarding follows achievement_tools.py's claim/credit/finalize
pattern exactly: WalletService.credit(...) is the ONLY thing that ever
moves points, gated by a unique-indexed reservation document plus the
wallet's own idempotency_key — never a second, parallel point system.
Notification follows attendance_tools.py's injected fan_out_push/
build_target_query pattern — title/body are always server-rendered here,
never accepted from the client.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from motor.motor_asyncio import AsyncIOMotorGridFSBucket
from pymongo.errors import DuplicateKeyError

import assessment_ai_provider as ai
from assessment_schema import (
    VALID_ASSESSMENT_STATUSES,
    VALID_SUBMISSION_STATUSES,
    build_assessment_document,
    build_award_document,
    build_question,
    build_submission_document,
    new_assessment_id,
    new_award_id,
    new_submission_id,
    normalize_extracted_answer_key,
    normalize_extracted_submission_answers,
    total_points,
    validate_assessment_document,
    validate_submission_document,
)
from assessment_scoring import score_submission

log = logging.getLogger("eduhub.assessment")

COLL_ASSESSMENTS = "assessments"
COLL_SUBMISSIONS = "assessment_submissions"
COLL_AWARDS = "assessment_awards"
MEDIA_GRIDFS_BUCKET = "assessment_media"

# Student submissions: photo or scanned PDF of a completed worksheet.
SUBMISSION_CONTENT_TYPES: dict[str, str] = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/heic": "heic",
    "application/pdf": "pdf",
}
# Teacher answer-key uploads additionally accept a Word document (text is
# extracted server-side; Gemini never receives raw .docx bytes, which its
# multimodal API does not accept).
ANSWER_KEY_CONTENT_TYPES: dict[str, str] = {
    **SUBMISSION_CONTENT_TYPES,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}
HARD_MAX_MEDIA_BYTES = 25 * 1024 * 1024  # generous for a photographed worksheet page

_media_bucket_cache: AsyncIOMotorGridFSBucket | None = None


def get_media_bucket(db) -> AsyncIOMotorGridFSBucket:
    """Lazily constructs (and caches) this module's OWN GridFS bucket —
    never shares sync_studio_tools.py's `sync_media` bucket. See that
    module's identical accessor for why this must be lazy (Motor's
    AsyncIOMotorGridFSBucket resolves the running event loop on first
    use, which does not exist yet at import/registration time)."""
    global _media_bucket_cache
    if _media_bucket_cache is None:
        _media_bucket_cache = AsyncIOMotorGridFSBucket(db, bucket_name=MEDIA_GRIDFS_BUCKET)
    return _media_bucket_cache


def _r2_config() -> dict | None:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


async def _upload_media_to_r2(raw: bytes, key: str, content_type: str) -> str | None:
    """NEVER raises — returns None on any failure so the caller falls back
    to GridFS transparently. Identical contract to sync_studio_tools.py's
    `_upload_media_to_r2` (deliberately not duplicated as a shared import —
    each module owns its own storage call exactly like hero_artwork_tools.py
    / student_avatar.py / sync_studio_tools.py each do today)."""
    cfg = _r2_config()
    if cfg is None:
        return None
    try:
        import boto3
        from botocore.config import Config as _BotocoreConfig

        endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"

        def _do_upload():
            s3 = boto3.client(
                "s3", endpoint_url=endpoint,
                aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
                config=_BotocoreConfig(signature_version="s3v4"),
            )
            s3.put_object(Bucket=cfg["R2_BUCKET_NAME"], Key=key, Body=raw, ContentType=content_type)

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)
        url = f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
        log.info("assessment_tools: uploaded %s (%d bytes) url=%s", key, len(raw), url)
        return url
    except Exception:  # noqa: BLE001
        log.exception("assessment_tools: R2 upload failed for key=%s — falling back to GridFS", key)
        return None


async def _store_media(db, raw: bytes, ext: str, content_type: str, prefix: str) -> str:
    key = f"assessment-media/{prefix}/{uuid.uuid4().hex}.{ext}"
    media_ref = await _upload_media_to_r2(raw, key, content_type)
    if media_ref:
        return media_ref
    filename = f"{uuid.uuid4().hex}.{ext}"
    bucket = get_media_bucket(db)
    await bucket.upload_from_stream(filename, io.BytesIO(raw), metadata={"contentType": content_type})
    return f"gridfs://{MEDIA_GRIDFS_BUCKET}/{filename}"


def _extract_docx_text(raw: bytes) -> str:
    """Plain-text extraction from a teacher-uploaded .docx answer key,
    including table cells (a "Quick Answer Key" table is the realistic
    shape for this feature's first fixture) — python-docx is an existing
    project dependency (tuition_receipt_pdf.py's neighbors), not a new one."""
    from docx import Document

    doc = Document(io.BytesIO(raw))
    lines = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                lines.append(" | ".join(cells))
    return "\n".join(lines)


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def ensure_assessment_indexes(db) -> None:
    await db[COLL_ASSESSMENTS].create_index("assessmentId", unique=True)
    await db[COLL_ASSESSMENTS].create_index("status")
    await db[COLL_SUBMISSIONS].create_index("submissionId", unique=True)
    await db[COLL_SUBMISSIONS].create_index([("assessmentId", 1), ("studentId", 1)])
    await db[COLL_SUBMISSIONS].create_index("status")
    await db[COLL_AWARDS].create_index("submissionId", unique=True)
    log.info("assessment_tools: indexes ready")


def register_assessment_routes(api: APIRouter, db, require_admin, require_student, *,
                                wallet=None, fan_out_push=None, build_target_query=None) -> None:
    assessments = db[COLL_ASSESSMENTS]
    submissions = db[COLL_SUBMISSIONS]
    awards = db[COLL_AWARDS]

    async def _get_assessment_or_404(assessment_id: str) -> dict:
        doc = await assessments.find_one({"assessmentId": assessment_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Assessment not found.")
        return doc

    async def _get_submission_or_404(submission_id: str) -> dict:
        doc = await submissions.find_one({"submissionId": submission_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Submission not found.")
        return doc

    # ── Teacher: answer-key extraction (review-before-save, nothing persisted here) ──
    @api.post("/admin/assessments/extract-key")
    async def admin_extract_key(file: UploadFile = File(...), admin=Depends(require_admin)):
        _ = admin
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "Uploaded file is empty.")
        if len(raw) > HARD_MAX_MEDIA_BYTES:
            raise HTTPException(413, f"File exceeds the {HARD_MAX_MEDIA_BYTES}-byte limit.")
        content_type = (file.content_type or "").split(";")[0].strip().lower()
        ext = ANSWER_KEY_CONTENT_TYPES.get(content_type)
        if not ext:
            raise HTTPException(415, f"Unsupported content type: {content_type!r}.")

        if ext == "docx":
            try:
                text = _extract_docx_text(raw)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(400, f"Could not read .docx file: {exc}")
            result = await ai.extract_answer_key(raw_text=text)
        else:
            result = await ai.extract_answer_key(media_bytes=raw, content_type=content_type)

        if not result.get("ok"):
            raise HTTPException(502, f"Answer-key extraction failed: {result.get('reason')}")
        items = normalize_extracted_answer_key(result.get("items") or [])
        return {"ok": True, "engine": result.get("engine"), "questions": items}

    # ── Teacher: assessment CRUD ──────────────────────────────────────────
    @api.post("/admin/assessments")
    async def admin_create_assessment(payload: dict, admin=Depends(require_admin)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        title = str(payload.get("title") or "").strip()
        raw_questions = payload.get("questions") or []
        if not title or not isinstance(raw_questions, list) or not raw_questions:
            raise HTTPException(400, "title and a non-empty questions list are required.")
        questions = [
            build_question(
                str(q.get("qid") or f"q{i + 1}"), q.get("prompt"), q.get("correctAnswer"),
                points=q.get("points") or 1.0, choices=q.get("choices"),
            )
            for i, q in enumerate(raw_questions) if isinstance(q, dict)
        ]
        doc = build_assessment_document(
            new_assessment_id(), title, questions,
            subject=payload.get("subject") or "",
            created_by=getattr(admin, "email", "admin"),
            source_ref=payload.get("sourceRef"),
            status="published" if payload.get("publish") else "draft",
            generated_at=_iso_now(),
        )
        ok, errors = validate_assessment_document(doc)
        if not ok:
            raise HTTPException(400, "; ".join(errors))
        await assessments.insert_one(dict(doc))
        doc.pop("_id", None)
        return {"ok": True, "assessment": doc}

    @api.get("/admin/assessments")
    async def admin_list_assessments(admin=Depends(require_admin)):
        _ = admin
        docs = await assessments.find({}, {"_id": 0}).sort("generatedAt", -1).to_list(200)
        return {"ok": True, "assessments": docs}

    @api.get("/admin/assessments/{assessment_id}")
    async def admin_get_assessment(assessment_id: str, admin=Depends(require_admin)):
        _ = admin
        return {"ok": True, "assessment": await _get_assessment_or_404(assessment_id)}

    @api.patch("/admin/assessments/{assessment_id}")
    async def admin_update_assessment(assessment_id: str, payload: dict, admin=Depends(require_admin)):
        _ = admin
        existing = await _get_assessment_or_404(assessment_id)
        if "title" in payload:
            existing["title"] = str(payload["title"] or "").strip()[:200]
        if "questions" in payload and isinstance(payload["questions"], list):
            existing["questions"] = [
                build_question(
                    str(q.get("qid") or f"q{i + 1}"), q.get("prompt"), q.get("correctAnswer"),
                    points=q.get("points") or 1.0, choices=q.get("choices"),
                )
                for i, q in enumerate(payload["questions"]) if isinstance(q, dict)
            ]
            existing["totalPoints"] = total_points(existing["questions"])
        if payload.get("publish"):
            existing["status"] = "published"
        elif payload.get("archive"):
            existing["status"] = "archived"
        elif "status" in payload and payload["status"] in VALID_ASSESSMENT_STATUSES:
            existing["status"] = payload["status"]
        ok, errors = validate_assessment_document(existing)
        if not ok:
            raise HTTPException(400, "; ".join(errors))
        await assessments.update_one({"assessmentId": assessment_id}, {"$set": existing})
        return {"ok": True, "assessment": existing}

    # ── Teacher: submissions review ───────────────────────────────────────
    @api.get("/admin/assessments/{assessment_id}/submissions")
    async def admin_list_submissions(assessment_id: str, status: str | None = None,
                                      admin=Depends(require_admin)):
        _ = admin
        q: dict = {"assessmentId": assessment_id}
        if status:
            q["status"] = status
        docs = await submissions.find(q, {"_id": 0}).sort("submittedAt", -1).to_list(500)
        return {"ok": True, "submissions": docs}

    @api.get("/admin/assessments/submissions/{submission_id}")
    async def admin_get_submission(submission_id: str, admin=Depends(require_admin)):
        _ = admin
        return {"ok": True, "submission": await _get_submission_or_404(submission_id)}

    @api.post("/admin/assessments/submissions/{submission_id}/correct")
    async def admin_correct_submission(submission_id: str, payload: dict, admin=Depends(require_admin)):
        sub = await _get_submission_or_404(submission_id)
        corrections = payload.get("corrections") if isinstance(payload, dict) else None
        if not isinstance(corrections, list):
            raise HTTPException(400, "corrections must be a list of {qid, answer}.")
        asmt = await _get_assessment_or_404(sub["assessmentId"])
        known_ids = {q["qid"] for q in asmt["questions"]}

        by_qid = {a["qid"]: dict(a) for a in sub.get("extractedAnswers") or []}
        applied = []
        for c in corrections:
            if not isinstance(c, dict):
                continue
            qid = str(c.get("qid") or "")
            if qid not in known_ids:
                continue
            by_qid[qid] = {"qid": qid, "answer": str(c.get("answer") or "").strip()[:240], "confidence": 1.0}
            applied.append(qid)

        new_answers = list(by_qid.values())
        result = score_submission(asmt["questions"], new_answers)
        await submissions.update_one(
            {"submissionId": submission_id},
            {"$set": {
                "extractedAnswers": new_answers,
                "score": result,
                "status": "reviewed",
                "reviewedAt": _iso_now(),
                "reviewedBy": getattr(admin, "email", "admin"),
                "teacherCorrections": (sub.get("teacherCorrections") or []) + applied,
            }},
        )
        return {"ok": True, "score": result, "correctedQids": applied}

    # ── Teacher: award points (individual + bulk), idempotent ───────────
    async def _award_one(submission_id: str, admin_email: str) -> dict:
        if wallet is None:
            return {"submissionId": submission_id, "ok": False, "reason": "wallet_unavailable"}
        sub = await submissions.find_one({"submissionId": submission_id}, {"_id": 0})
        if not sub:
            return {"submissionId": submission_id, "ok": False, "reason": "submission_not_found"}
        if sub.get("status") == "awarded":
            existing = await awards.find_one({"submissionId": submission_id}, {"_id": 0})
            return {"submissionId": submission_id, "ok": True, "duplicate": True,
                     "points": (existing or {}).get("points")}

        score = sub.get("score") or {}
        points = float(score.get("pointsEarned") or 0.0)
        student_id = sub.get("studentId") or ""
        clean_id = sub.get("cleanId") or ""
        award_id = new_award_id()
        award_doc = build_award_document(
            award_id, submission_id, sub["assessmentId"],
            student_id=student_id, clean_id=clean_id, points=points,
            status="pending", generated_at=_iso_now(),
        )
        try:
            await awards.insert_one(dict(award_doc))
        except DuplicateKeyError:
            existing = await awards.find_one({"submissionId": submission_id}, {"_id": 0})
            return {"submissionId": submission_id, "ok": True, "duplicate": True,
                     "points": (existing or {}).get("points")}

        idem_key = f"assessment_award:{submission_id}"
        try:
            result = await wallet.credit(
                student_id, points,
                source="assessment_award", source_ref=submission_id,
                idempotency_key=idem_key, clean_id=clean_id or None,
                payload={"assessment_id": sub["assessmentId"], "submission_id": submission_id},
            )
        except BaseException as exc:
            await awards.delete_one({"awardId": award_id, "status": "pending"})
            if not isinstance(exc, Exception):
                raise
            log.error("assessment: wallet credit failed for %s: %s", submission_id, exc)
            return {"submissionId": submission_id, "ok": False, "reason": "credit_failed"}

        balance_after = float((result or {}).get("balance_after") or 0)
        try:
            await awards.update_one(
                {"awardId": award_id},
                {"$set": {"status": "credited", "creditedAt": _iso_now(), "balanceAfter": balance_after}},
            )
            await submissions.update_one(
                {"submissionId": submission_id},
                {"$set": {"status": "awarded"}},
            )
        except Exception as exc:  # noqa: BLE001
            log.critical(
                "assessment: award %s credited (student=%s submission=%s) but finalize "
                "write failed — manual reconciliation needed: %s",
                award_id, student_id, submission_id, exc,
            )

        if callable(fan_out_push) and callable(build_target_query) and points > 0:
            try:
                title = "Points awarded"
                body = f"You earned {points:g} points for your assessment. Great work!"
                query = build_target_query("students", [clean_id or student_id], None)
                await fan_out_push(query, title, body, "/portal")
                await awards.update_one({"awardId": award_id}, {"$set": {"notifiedAt": _iso_now()}})
            except Exception as exc:  # noqa: BLE001
                log.warning("assessment: award notification failed for %s: %s", submission_id, exc)

        return {"submissionId": submission_id, "ok": True, "duplicate": False,
                 "points": points, "balanceAfter": balance_after}

    @api.post("/admin/assessments/submissions/{submission_id}/award")
    async def admin_award_submission(submission_id: str, admin=Depends(require_admin)):
        result = await _award_one(submission_id, getattr(admin, "email", "admin"))
        if not result.get("ok"):
            raise HTTPException(409 if result.get("reason") == "already_awarded" else 502,
                                 result.get("reason") or "Award failed.")
        return result

    @api.post("/admin/assessments/submissions/bulk-award")
    async def admin_bulk_award(payload: dict, admin=Depends(require_admin)):
        ids = (payload or {}).get("submissionIds")
        if not isinstance(ids, list) or not ids:
            raise HTTPException(400, "submissionIds must be a non-empty list.")
        admin_email = getattr(admin, "email", "admin")
        results = []
        for sid in ids[:200]:
            try:
                results.append(await _award_one(str(sid), admin_email))
            except Exception as exc:  # noqa: BLE001
                log.exception("assessment: bulk award failed for %s", sid)
                results.append({"submissionId": sid, "ok": False, "reason": str(exc)[:200]})
        return {"ok": True, "results": results,
                "awarded": sum(1 for r in results if r.get("ok")),
                "failed": sum(1 for r in results if not r.get("ok"))}

    # ── Student: list, submit, own history ────────────────────────────────
    @api.get("/student/assessments")
    async def student_list_assessments(student=Depends(require_student)):
        docs = await assessments.find({"status": "published"}, {"_id": 0}).sort("generatedAt", -1).to_list(200)
        clean_id = getattr(student, "clean_id", "")
        student_id = getattr(student, "student_id", "")
        for d in docs:
            existing = await submissions.find_one(
                {"assessmentId": d["assessmentId"],
                 "$or": [{"studentId": student_id}, {"cleanId": clean_id}]},
                {"_id": 0, "submissionId": 1, "status": 1, "score": 1},
            )
            d["mySubmission"] = existing
        return {"ok": True, "assessments": docs}

    @api.post("/student/assessments/submit")
    async def student_submit_assessment(assessment_id: str = Form(...), file: UploadFile = File(...),
                                         student=Depends(require_student)):
        asmt = await _get_assessment_or_404(assessment_id)
        if asmt.get("status") != "published":
            raise HTTPException(423, "This assessment is not open for submissions.")

        raw = await file.read()
        if not raw:
            raise HTTPException(400, "Uploaded file is empty.")
        if len(raw) > HARD_MAX_MEDIA_BYTES:
            raise HTTPException(413, f"File exceeds the {HARD_MAX_MEDIA_BYTES}-byte limit.")
        content_type = (file.content_type or "").split(";")[0].strip().lower()
        ext = SUBMISSION_CONTENT_TYPES.get(content_type)
        if not ext:
            raise HTTPException(415, f"Unsupported content type: {content_type!r}.")

        student_id = str(getattr(student, "student_id", "") or "")
        clean_id = str(getattr(student, "clean_id", "") or "")
        media_ref = await _store_media(db, raw, ext, content_type, clean_id or student_id or "unknown")

        submission_id = new_submission_id()
        doc = build_submission_document(
            submission_id, assessment_id,
            student_id=student_id, clean_id=clean_id,
            media_ref=media_ref, content_type=content_type,
            status="processing", generated_at=_iso_now(),
        )
        ok, errors = validate_submission_document(doc)
        if not ok:
            raise HTTPException(500, "; ".join(errors))
        await submissions.insert_one(dict(doc))

        extraction = await ai.extract_submission_answers(raw, content_type, asmt["questions"])
        known_ids = [q["qid"] for q in asmt["questions"]]
        if not extraction.get("ok"):
            await submissions.update_one({"submissionId": submission_id}, {"$set": {"status": "failed"}})
            doc.pop("_id", None)
            doc["status"] = "failed"
            return {"ok": True, "submission": doc, "extractionError": extraction.get("reason")}

        answers = normalize_extracted_submission_answers(extraction.get("answers") or [], known_ids)
        result = score_submission(asmt["questions"], answers)
        status = "needs_review" if result["needsReview"] else "scored"
        await submissions.update_one(
            {"submissionId": submission_id},
            {"$set": {"extractedAnswers": answers, "score": result, "status": status}},
        )
        doc.pop("_id", None)
        doc.update({"extractedAnswers": answers, "score": result, "status": status})
        return {"ok": True, "submission": doc, "engine": extraction.get("engine")}

    @api.get("/student/assessments/submissions")
    async def student_list_submissions(student=Depends(require_student)):
        student_id = str(getattr(student, "student_id", "") or "")
        clean_id = str(getattr(student, "clean_id", "") or "")
        docs = await submissions.find(
            {"$or": [{"studentId": student_id}, {"cleanId": clean_id}]}, {"_id": 0},
        ).sort("submittedAt", -1).to_list(200)
        return {"ok": True, "submissions": docs}

    log.info("assessment_tools: routes registered")
