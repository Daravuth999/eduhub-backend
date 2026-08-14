"""student_avatar.py — Premium Student Profile & Settings milestone.

Additive avatar upload/delete for the student-facing Profile page. Reuses
the EXACT R2 storage adapter and image-validation logic already proven in
hero_artwork_tools.py (same env vars, same magic-byte + size-ceiling
validation) — no new storage integration or validation logic is
duplicated here, per the "reuse everything possible / do not duplicate
business logic" instruction for this milestone.

Storage layout mirrors hero_artwork_tools.py's isolated-prefix convention:
avatars live under `avatars/{student_id}_{uuid8}.{ext}`, a separate
prefix from `hero-artwork/`, so the two features never collide and can be
audited/cleaned independently.

Nothing here changes authentication or authorization — require_student is
reused as-is (the same dependency already gating /auth/student/me and
/auth/student/change-password).
"""
from __future__ import annotations

import uuid

from fastapi import Depends, File, UploadFile

from hero_artwork_tools import _delete_from_r2, _upload_to_r2, _validate_image_bytes


def register_student_avatar_routes(api, db, *, require_student, log=None):
    """Mount POST/DELETE /auth/student/avatar onto the existing `api` router."""

    @api.post("/auth/student/avatar")
    async def upload_student_avatar(file: UploadFile = File(...), student=Depends(require_student)):
        raw = await file.read()
        ext, content_type = _validate_image_bytes(raw, file.content_type or "")

        existing = await db.students.find_one(
            {"student_id": student.student_id}, {"_id": 0, "avatar_r2_key": 1},
        )
        old_key = (existing or {}).get("avatar_r2_key")

        key = f"avatars/{student.student_id}_{uuid.uuid4().hex[:8]}.{ext}"
        url = await _upload_to_r2(raw, key, content_type, {"studentId": student.student_id})

        # avatar_r2_key is intentionally NOT on the Student pydantic model
        # (extra="ignore" drops it on read) — it's write-only bookkeeping
        # so a later re-upload/delete can clean up the previous R2 object,
        # mirroring how password_hash is stored but never modeled.
        await db.students.update_one(
            {"student_id": student.student_id},
            {"$set": {"avatar_url": url, "avatar_r2_key": key}},
        )
        if old_key and old_key != key:
            await _delete_from_r2(old_key)

        return {"ok": True, "avatar_url": url}

    @api.delete("/auth/student/avatar")
    async def delete_student_avatar(student=Depends(require_student)):
        existing = await db.students.find_one(
            {"student_id": student.student_id}, {"_id": 0, "avatar_r2_key": 1},
        )
        old_key = (existing or {}).get("avatar_r2_key")

        await db.students.update_one(
            {"student_id": student.student_id},
            {"$set": {"avatar_url": "", "avatar_r2_key": ""}},
        )
        if old_key:
            await _delete_from_r2(old_key)

        return {"ok": True}
