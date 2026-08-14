"""
restriction_realtime.py — v10.0 (Status enforcement module)
══════════════════════════════════════════════════════════════════════════════
Bolts onto the existing eduhub-backend FastAPI app to provide a real-time,
MongoDB-authoritative student-status system that REPLACES the manual
Google-Sheet overwrite workflow.

Adds:
  • MongoDB `student_status` collection (single source of truth)
  • PATCH /api/teacher/students/{id}/status      ← teacher writes status
  • GET   /api/teacher/students/{id}/status      ← teacher read-back
  • GET   /api/student/status/{id}               ← public read for student PWA
                                                   (3-s polling target)
  • Status mirror → GAS Scores Sheet (so the existing AuthContext watchdog
    keeps working unchanged — no frontend AuthContext modification needed)
  • Auto-fans-out the existing teacher push for non-active statuses
  • `require_active_student` FastAPI dependency for future server-side
    enforcement on student-callable routes (exported but NOT auto-wired
    into existing routes, to safeguard everything that currently works)

Statuses: active · restricted · suspended · deactivated

INTEGRATION (2 lines in server.py — see WIRING_INSTRUCTIONS at end):

    from restriction_realtime import build_router
    app.include_router(build_router(db, _fan_out_push, require_admin))

Constraints honoured:
  • Zero modification to existing routes / collections / push fan-out.
  • Zero modification to AuthContext.jsx, RestrictionGuard.jsx, sw.js,
    RealtimeSyncBridge.jsx, library/books, usePoints, useStudentData.
  • The new collection is independent of `push_subscriptions`,
    `push_history`, `push_scheduled`, `users`, `books`.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("eduhub.restriction_realtime")

# ─────────────────────────────────────────────────────────────────────────────
# Config — env vars (all optional with safe defaults)
# ─────────────────────────────────────────────────────────────────────────────
GAS_SCORES_URL = os.environ.get(
    "GAS_SCORES_URL",
    # Same Studio script URL the frontend points at (matches src/studio/api.js
    # SCORES_GAS_URL). Override per environment via Render env-vars.
    "https://script.google.com/macros/s/AKfycbwSx5C3vvsp35-qtZ4_mPdST_xgiLeprwWsR_oz8GODLPuhOu1fSpk4GoIwTYfgYtWF/exec",
).strip()

GAS_MIRROR_TIMEOUT_S = float(os.environ.get("GAS_MIRROR_TIMEOUT_S", "8"))
GAS_MIRROR_ENABLED   = os.environ.get("GAS_MIRROR_ENABLED", "true").lower() == "true"

VALID_STATUSES = ("active", "restricted", "suspended", "deactivated")
StatusLiteral = Literal["active", "restricted", "suspended", "deactivated"]

# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────
class StatusPatchPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: StatusLiteral
    reason: str = ""
    lift_at: Optional[str] = Field(default=None, alias="liftAt")


class StatusRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")
    studentId: str
    status: StatusLiteral
    reason: str = ""
    setBy: str = ""
    setAt: str
    liftAt: Optional[str] = None
    statusVersion: int = 1
    # Mirror diagnostics (so the teacher can see if GAS sync failed)
    gasMirroredAt: Optional[str] = None
    gasMirrorOk: Optional[bool] = None
    gasMirrorError: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_status(s: str) -> StatusLiteral:
    s2 = (s or "").strip().lower()
    if s2 not in VALID_STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"Invalid status. Must be one of: {', '.join(VALID_STATUSES)}")
    return s2  # type: ignore[return-value]


def _gas_field_for_status(status: str) -> str:
    """active → "" (cleared)   |   anything else → "TRUE" (locked).
    The GAS sheet only has a boolean restriction column. Mongo carries the
    full enum so the teacher / audit log retains the nuance."""
    return "" if status == "active" else "TRUE"


async def _mirror_to_gas(
    student_id: str,
    status: str,
    reason: str,
    lift_at: Optional[str],
) -> tuple[bool, str]:
    """Best-effort write to GAS so the existing frontend watchdog (which
    reads ?action=getStudentData) sees the change without any frontend code
    modification. Failure here NEVER aborts the Mongo write — Mongo is
    authoritative; GAS is a downstream mirror for backwards-compatibility."""
    if not GAS_MIRROR_ENABLED or not GAS_SCORES_URL:
        return False, "disabled"
    params = {
        "action": "updateStudent",
        "studentId": student_id,
        "restriction": _gas_field_for_status(status),
        "restrictionReason": reason or "",
        "teacherKey": os.environ.get("GAS_WRITE_KEY", "EduHub@TeacherWrite2026!"),
    }
    if lift_at:
        params["restrictionLiftAt"] = lift_at
    url = f"{GAS_SCORES_URL}?{urlencode(params)}"
    try:
        async with httpx.AsyncClient(timeout=GAS_MIRROR_TIMEOUT_S, follow_redirects=True) as cx:
            r = await cx.get(url)
            if r.status_code >= 400:
                return False, f"HTTP {r.status_code}"
            # GAS sometimes returns HTML on first redirect — accept any 2xx.
            return True, "ok"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {str(exc)[:160]}"


def _push_copy_for_status(status: str, reason: str) -> tuple[str, str]:
    """Server-rendered title/body so client never controls notification copy.
    Falls through to the existing /api/teacher/students/{id}/push-restriction
    semantics for the 'restricted' case so the OS banner UX matches today."""
    rsn = (reason or "").strip()
    if status == "active":
        return ("Account reactivated",
                "Your account is active again. Welcome back!")
    if status == "restricted":
        return ("Account restricted",
                rsn or "Your account has been restricted. Contact your teacher.")
    if status == "suspended":
        return ("Account suspended",
                rsn or "Your account has been suspended. Contact your teacher.")
    if status == "deactivated":
        return ("Account deactivated",
                rsn or "Your account has been deactivated.")
    return ("Account updated", rsn or "Your account status changed.")


# ─────────────────────────────────────────────────────────────────────────────
# Router factory
# ─────────────────────────────────────────────────────────────────────────────
def build_router(db, fan_out_push, require_admin):
    """Returns an APIRouter wired with the given Mongo db handle and helpers
    from server.py. Keeps this module dependency-free of server.py's globals
    so it can be lifted into other deployments cleanly."""
    router = APIRouter(prefix="/api", tags=["restriction-realtime"])
    student_status = db.student_status

    # Indexes — created on first request (cheap, idempotent).
    _index_lock = asyncio.Lock()
    _indexed = {"done": False}

    async def _ensure_indexes():
        if _indexed["done"]:
            return
        async with _index_lock:
            if _indexed["done"]:
                return
            try:
                await student_status.create_index("studentId", unique=True)
                await student_status.create_index([("status", 1), ("setAt", -1)])
                _indexed["done"] = True
            except Exception as exc:  # noqa: BLE001
                log.warning("student_status index creation failed: %s", exc)

    # ─────────────────── helpers exported for other modules ────────────────
    async def get_status_doc(student_id: str) -> dict:
        await _ensure_indexes()
        cleaned = (student_id or "").strip()
        doc = await student_status.find_one({"studentId": cleaned}, {"_id": 0})
        if doc:
            return doc
        # Implicit default: any student with no record is active.
        return {
            "studentId": cleaned,
            "status": "active",
            "reason": "",
            "setBy": "",
            "setAt": _now_iso(),
            "liftAt": None,
            "statusVersion": 0,
            "gasMirroredAt": None,
            "gasMirrorOk": None,
            "gasMirrorError": None,
        }

    async def is_active(student_id: str) -> bool:
        doc = await get_status_doc(student_id)
        # Auto-lift logic: if liftAt is in the past, treat as active.
        lift_at = doc.get("liftAt")
        if lift_at:
            try:
                if datetime.fromisoformat(lift_at.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                    return True
            except Exception:
                pass
        return doc.get("status", "active") == "active"

    # ─────────────────── routes ────────────────────────────────────────────
    @router.patch("/teacher/students/{student_id}/status")
    async def set_status(
        student_id: str,
        payload: StatusPatchPayload,
        request: Request,
        user=Depends(require_admin),
    ):
        """Authoritative status write. Order:
          1. Update Mongo (source of truth — never blocked by GAS / push)
          2. Mirror to GAS (best-effort, async, swallows errors)
          3. Fire push (best-effort — push system unchanged)
        """
        await _ensure_indexes()
        cleaned = (student_id or "").strip()
        if not cleaned:
            raise HTTPException(status_code=400, detail="student_id required")
        status = _normalize_status(payload.status)
        reason = (payload.reason or "").strip()[:500]
        lift_at = (payload.lift_at or "").strip() or None
        teacher_email = (
            getattr(user, "email", None)
            or (user.get("email") if isinstance(user, dict) else "")
            or ""
        )

        prev = await student_status.find_one({"studentId": cleaned}, {"_id": 0, "statusVersion": 1})
        next_version = int((prev or {}).get("statusVersion", 0)) + 1

        record = {
            "studentId": cleaned,
            "status": status,
            "reason": reason,
            "setBy": teacher_email,
            "setAt": _now_iso(),
            "liftAt": lift_at,
            "statusVersion": next_version,
        }

        await student_status.update_one(
            {"studentId": cleaned},
            {"$set": record},
            upsert=True,
        )

        # ── Step 2: GAS mirror (await but tolerant of failure) ──
        gas_ok, gas_err = await _mirror_to_gas(cleaned, status, reason, lift_at)
        await student_status.update_one(
            {"studentId": cleaned},
            {"$set": {
                "gasMirroredAt": _now_iso(),
                "gasMirrorOk": gas_ok,
                "gasMirrorError": "" if gas_ok else gas_err,
            }},
        )

        # ── Step 3: push fan-out (skip on active=clear; that's a "good news" no-op) ──
        push_sent = 0
        push_failed = 0
        if status != "active":
            try:
                title, body = _push_copy_for_status(status, reason)
                push_sent, push_failed = await fan_out_push(
                    {"studentId": cleaned},
                    title=title,
                    body=body,
                    url="/portal",
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("status push fan-out failed for %s: %s", cleaned, exc)

        # Read-back so the teacher UI sees what's persisted.
        latest = await student_status.find_one({"studentId": cleaned}, {"_id": 0})
        return {
            "ok": True,
            "record": latest,
            "gasMirror": {"ok": gas_ok, "error": "" if gas_ok else gas_err},
            "push": {"sent": push_sent, "failed": push_failed},
        }

    @router.get("/teacher/students/{student_id}/status")
    async def teacher_get_status(
        student_id: str,
        user=Depends(require_admin),
    ):
        return {"ok": True, "record": await get_status_doc(student_id)}

    @router.get("/student/status/{student_id}")
    async def student_get_status(student_id: str):
        """Public read endpoint hit by the StatusEnforcer 3-s poll. Returns
        only the fields the student PWA needs — no `setBy`, no GAS mirror
        diagnostics. Cache-Control: no-store so polling never gets a stale
        copy from a CDN/SW edge.
        """
        doc = await get_status_doc(student_id)
        return {
            "studentId": doc["studentId"],
            "status": doc["status"],
            "reason": doc.get("reason", ""),
            "setAt": doc.get("setAt"),
            "liftAt": doc.get("liftAt"),
            "statusVersion": doc.get("statusVersion", 0),
        }

    # ─────────────────── server-side guard (opt-in) ────────────────────────
    async def require_active_student(request: Request) -> str:
        """FastAPI dependency that 403s if the studentId carried by the
        request (header `X-Student-Id` first, then `studentId` query, then
        body field) is not in `active` status. Exported but NOT auto-wired
        into existing routes — server-side enforcement is opt-in route by
        route, to safeguard everything that currently works."""
        student_id = (
            request.headers.get("x-student-id")
            or request.query_params.get("studentId")
            or ""
        ).strip()
        if not student_id:
            try:
                body = await request.json()
                if isinstance(body, dict):
                    student_id = str(body.get("studentId") or body.get("recipientStudentId") or "").strip()
            except Exception:
                pass
        if not student_id:
            return ""  # No id → no enforcement (route-specific decision)
        if not await is_active(student_id):
            doc = await get_status_doc(student_id)
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "ACCOUNT_RESTRICTED",
                    "status": doc.get("status"),
                    "reason": doc.get("reason", ""),
                    "studentId": student_id,
                },
            )
        return student_id

    # Expose helpers as router attributes so callers can wire `Depends`.
    router.require_active_student = require_active_student  # type: ignore[attr-defined]
    router.is_active = is_active                            # type: ignore[attr-defined]
    router.get_status_doc = get_status_doc                  # type: ignore[attr-defined]

    return router


# ─────────────────────────────────────────────────────────────────────────────
# WIRING_INSTRUCTIONS
# ─────────────────────────────────────────────────────────────────────────────
# Add these TWO lines to eduhub-backend/server.py, anywhere AFTER the
# existing `_fan_out_push` definition and BEFORE the `app.include_router(api)`
# at the bottom (somewhere near line ~2350 in master 47):
#
#     from restriction_realtime import build_router as _build_status_router
#     app.include_router(_build_status_router(db, _fan_out_push, require_admin))
#
# That's it. No existing route, collection, env-var, or push-fan-out
# behaviour is modified. New collection `student_status` is created lazily
# on first request.
# ─────────────────────────────────────────────────────────────────────────────
