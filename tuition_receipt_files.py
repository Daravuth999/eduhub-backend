"""
tuition_receipt_files.py — Persistent Tuition Receipt Engine: file storage
and download/regenerate routes.

Registered via register_tuition_receipt_files_routes(api, db, require_student,
require_admin) from server.py — same explicit-DI convention as
register_tuition_routes. The GridFS bucket itself is set separately via
set_receipt_bucket(bucket) from server.py's `startup()` event handler —
NOT passed as a registration-time argument — because AsyncIOMotorGridFSBucket
construction needs a running event loop (the same reason server.py's own
`audio_bucket` is built inside `startup()`, not at plain import time). Route
handlers reference the module-level `_receipt_bucket` global directly, so
they always see whatever startup() most recently set, exactly like
server.py's `audio_bucket` global.

Storage model: GridFS cache with regenerate-on-miss (reuses the exact
pattern already proven in this backend for audio — see server.py's
`audio_bucket`). On download: try the cached file by filename; on a cache
miss, render fresh bytes from the immutable `receipt_doc` and upload them
so the next request is a hit. This is what makes "regenerate from stored
metadata if the file no longer exists" literally true, with zero new
external credentials.

Immutability (requirement C7): every route here either streams derived
FILE bytes or is the admin-only regenerate action, which takes only a
receipt_id path param — no route in this module accepts amount_usd,
student_id, method, or any date field for an existing receipt.
"""
from __future__ import annotations

import calendar
from datetime import datetime, timezone

import gridfs
from fastapi import Depends, HTTPException, Response

from tuition_tools import _TTN_COLL_RECEIPTS, _TTN_COLL_CONFIG
from tuition_receipt_pdf import render_receipt_pdf, render_receipt_png

_MEDIA_TYPES = {"pdf": "application/pdf", "png": "image/png"}

_receipt_bucket = None  # set by set_receipt_bucket(), called from server.py's startup()


def set_receipt_bucket(bucket) -> None:
    global _receipt_bucket
    _receipt_bucket = bucket


def _default_template_config() -> dict:
    return {
        "type": "receipt_template_config",
        "company_name":    "Eduhub Studio",
        "company_address": "Phnom Penh, Cambodia",
        "company_phone":   "",
        "company_email":   "",
        "notes": "Thank you for choosing EduHub Studio.",
        "terms_and_conditions": (
            "Payment received is non-refundable and non-transferable "
            "after enrollment confirmation."
        ),
    }


def register_tuition_receipt_files_routes(api, db, require_student, require_admin):

    async def _get_template_config() -> dict:
        doc = await db[_TTN_COLL_CONFIG].find_one({"type": "receipt_template_config"})
        return doc or _default_template_config()

    def _render(fmt: str, receipt_doc: dict, template_cfg: dict) -> bytes:
        if fmt == "pdf":
            return render_receipt_pdf(receipt_doc, template_cfg)
        return render_receipt_png(receipt_doc, template_cfg)

    async def _latest_revision_ids(filename: str) -> list:
        cursor = _receipt_bucket.find({"filename": filename}).sort("uploadDate", 1)
        return [doc._id async for doc in cursor]

    async def _stream_receipt_file(receipt_doc: dict, fmt: str) -> Response:
        if _receipt_bucket is None:
            raise HTTPException(status_code=503, detail="Receipt file storage not ready")
        receipt_id = receipt_doc["receipt_id"]
        filename = f"{receipt_id}.{fmt}"
        try:
            gridout = await _receipt_bucket.open_download_stream_by_name(filename)
            data = await gridout.read()
        except gridfs.errors.NoFile:
            template_cfg = await _get_template_config()
            data = _render(fmt, receipt_doc, template_cfg)
            try:
                await _receipt_bucket.upload_from_stream(
                    filename, data,
                    metadata={"receipt_id": receipt_id, "invoice_number": receipt_doc.get("invoice_number")},
                )
            except Exception:
                pass  # cache-write failure is non-fatal — caller still gets fresh bytes

        display_name = receipt_doc.get("invoice_number") or receipt_id
        return Response(
            content=data,
            media_type=_MEDIA_TYPES[fmt],
            headers={"Content-Disposition": f'inline; filename="{display_name}.{fmt}"'},
        )

    async def _regenerate(receipt_doc: dict) -> dict:
        """Re-renders PDF+PNG from the immutable receipt_doc and replaces
        GridFS revisions. Never touches tuition_receipts — file bytes only."""
        if _receipt_bucket is None:
            raise HTTPException(status_code=503, detail="Receipt file storage not ready")
        template_cfg = await _get_template_config()
        receipt_id = receipt_doc["receipt_id"]
        sizes = {}
        for fmt in ("pdf", "png"):
            filename = f"{receipt_id}.{fmt}"
            data = _render(fmt, receipt_doc, template_cfg)
            old_ids = await _latest_revision_ids(filename)
            await _receipt_bucket.upload_from_stream(
                filename, data,
                metadata={"receipt_id": receipt_id, "invoice_number": receipt_doc.get("invoice_number")},
            )
            for old_id in old_ids:
                try:
                    await _receipt_bucket.delete(old_id)
                except Exception:
                    pass
            sizes[f"{fmt}_bytes"] = len(data)
        return sizes

    # ── Student routes — own receipt only ───────────────────────────────────

    @api.get("/student/tuition/receipt/{receipt_id}/pdf")
    async def student_receipt_pdf(receipt_id: str, student=Depends(require_student)):
        receipt_doc = await db[_TTN_COLL_RECEIPTS].find_one(
            {"receipt_id": receipt_id, "student_id": student.student_id}, {"_id": 0},
        )
        if not receipt_doc:
            raise HTTPException(status_code=404, detail="Receipt not found")
        return await _stream_receipt_file(receipt_doc, "pdf")

    @api.get("/student/tuition/receipt/{receipt_id}/png")
    async def student_receipt_png(receipt_id: str, student=Depends(require_student)):
        receipt_doc = await db[_TTN_COLL_RECEIPTS].find_one(
            {"receipt_id": receipt_id, "student_id": student.student_id}, {"_id": 0},
        )
        if not receipt_doc:
            raise HTTPException(status_code=404, detail="Receipt not found")
        return await _stream_receipt_file(receipt_doc, "png")

    # ── Admin routes — any receipt ───────────────────────────────────────────

    @api.get("/admin/tuition/receipt/{receipt_id}/pdf")
    async def admin_receipt_pdf(receipt_id: str, admin=Depends(require_admin)):
        receipt_doc = await db[_TTN_COLL_RECEIPTS].find_one({"receipt_id": receipt_id}, {"_id": 0})
        if not receipt_doc:
            raise HTTPException(status_code=404, detail="Receipt not found")
        return await _stream_receipt_file(receipt_doc, "pdf")

    @api.get("/admin/tuition/receipt/{receipt_id}/png")
    async def admin_receipt_png(receipt_id: str, admin=Depends(require_admin)):
        receipt_doc = await db[_TTN_COLL_RECEIPTS].find_one({"receipt_id": receipt_id}, {"_id": 0})
        if not receipt_doc:
            raise HTTPException(status_code=404, detail="Receipt not found")
        return await _stream_receipt_file(receipt_doc, "png")

    @api.post("/admin/tuition/receipt/{receipt_id}/regenerate")
    async def admin_receipt_regenerate(receipt_id: str, admin=Depends(require_admin)):
        """Re-renders the PDF+PNG files only. Takes no body — financial
        fields on the receipt can never be changed through this route."""
        receipt_doc = await db[_TTN_COLL_RECEIPTS].find_one({"receipt_id": receipt_id}, {"_id": 0})
        if not receipt_doc:
            raise HTTPException(status_code=404, detail="Receipt not found")
        sizes = await _regenerate(receipt_doc)
        return {"ok": True, **sizes}

    # ── Admin: extended receipt search (filters on top of the existing
    #    unfiltered /admin/tuition/receipts list) ─────────────────────────────

    @api.get("/admin/tuition/receipts/search")
    async def admin_receipts_search(
        student_id: str | None = None,
        month: str | None = None,          # "YYYY-MM", matched against confirmed_at
        method: str | None = None,
        invoice_number: str | None = None,
        q: str | None = None,              # free text against reference/clean_id
        limit: int = 100,
        offset: int = 0,
        admin=Depends(require_admin),
    ):
        limit = min(max(limit, 1), 500)
        offset = max(offset, 0)
        query: dict = {}
        if student_id:
            query["student_id"] = student_id
        if method:
            query["method"] = method
        if invoice_number:
            query["invoice_number"] = invoice_number
        if month:
            # confirmed_at is stored as a real BSON datetime, not a string —
            # build actual datetime bounds so the comparison is type-correct.
            try:
                y, m = (int(part) for part in month.split("-", 1))
                start = datetime(y, m, 1, tzinfo=timezone.utc)
                last_day = calendar.monthrange(y, m)[1]
                end = datetime(y, m, last_day, 23, 59, 59, 999999, tzinfo=timezone.utc)
                query["confirmed_at"] = {"$gte": start, "$lte": end}
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        if q:
            query["$or"] = [
                {"reference": {"$regex": q, "$options": "i"}},
                {"clean_id": {"$regex": q, "$options": "i"}},
            ]
        cursor = (
            db[_TTN_COLL_RECEIPTS]
            .find(query, {"_id": 0})
            .sort("confirmed_at", -1)
            .skip(offset)
            .limit(limit)
        )
        receipts = []
        async for doc in cursor:
            for k in ("confirmed_at", "acknowledged_at"):
                v = doc.get(k)
                if hasattr(v, "isoformat"):
                    doc[k] = v.isoformat()
            receipts.append(doc)
        total = await db[_TTN_COLL_RECEIPTS].count_documents(query)
        unbackfilled = await db[_TTN_COLL_RECEIPTS].count_documents(
            {"invoice_number": {"$exists": False}}
        )
        return {"ok": True, "receipts": receipts, "total": total, "unbackfilled": unbackfilled}
