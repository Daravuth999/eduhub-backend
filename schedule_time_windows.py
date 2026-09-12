"""schedule_time_windows.py — admin-configurable time-of-day windows for
Speaking Lab Schedule A/B (and any future schedule label), built entirely
on the existing eduhub_platform.config three-tier resolver
(resolve_flag/set_override/get_audit_history) rather than new settings
infrastructure — the same pattern that module's own docstring establishes
and that its already-mounted /api/v1/platform-config* routes demonstrate,
just with domain-specific validation and student-facing exposure this
generic module deliberately does not provide itself.

STRICTLY ADDITIVE — confirmed by a full-codebase audit before writing a
line of this file: every existing consumer of a student's schedule label
(teacher_admission.py's ALLOWED_SCHEDULE_VALUES/_normalize_schedule/
_validate_schedule_target/session_schedule_eligibility, speaking_lab_
direct_join.py's eligibility checks, speaking_lab_eligibility.py's
Attendance Passport binding, event_engine.py's event schedule field,
server.py's Speaking Lab session CRUD + P2P pool matching + Push Studio
targeting, notification_center.py's push-audience resolution, and the
voice_treasure_*_tools.py family's feature-eligibility targeting) treats
the label as a bare identity string compared for equality or Mongo-
filtered — never parsed for time content, never combined with a date/
time field. This module attaches NO new field to `students.group` or any
existing schedule/eligibility document; it is a wholly separate,
label-keyed config namespace. A student's eligibility for anything is
unaffected by whether their schedule has a configured time window at
all.

CRITICAL constraint honored: teacher_admission.py's own _normalize_schedule
explicitly discards anything after a ":" in a raw group value (a legacy
"A:Beginner"-style tolerance) — every existing eligibility check reuses
that same normalizer. Storing time-window data as a suffix on the group
field itself would therefore be silently truncated by every one of those
checks. This module never touches students.group; it reuses
_normalize_schedule ONLY as the canonical way to turn a raw label into
the same uppercase, colon-stripped identity token every other consumer
already treats as canonical, so a time window set for "A" is found
regardless of how the caller happened to capitalize or suffix it.

Storage shape: one eduhub_platform.config key per schedule label
(schedule_time_window_<LABEL>, e.g. schedule_time_window_A), holding
{"start": "HH:MM", "end": "HH:MM", "timezone": "Asia/Phnom_Penh"}. Times
are plain 24-hour wall-clock strings, never a UTC-normalized datetime —
this is a RECURRING time-of-day (e.g. "Schedule A meets 7:00 PM-8:00 PM
every session"), not a one-off dated window like attendance_tools.py's
opens_at/closes_at (which genuinely are specific-date UTC instants,
correctly stored differently for a genuinely different concept). The
"timezone" field is descriptive metadata only (matching this codebase's
existing Cambodia-only convention — see tuition_tools.py's own fixed
UTC+7 _TTN_KH_TZ, never a full IANA zoneinfo conversion pipeline, since
this platform has one operating timezone) — no conversion math is
performed anywhere in this module.

Generic by label, not hardcoded to exactly two (Architecture rule):
every function here takes `label: str` as a plain parameter and resolves
its own eduhub_platform.config key from it. Adding a time window for a
brand-new schedule "C" the day it exists requires ZERO changes to this
file — purely a new admin API call with label="C". The one place "A"/"B"
appear literally is list_known_schedule_labels' union with teacher_
admission.py's own ALLOWED_SCHEDULE_VALUES, purely so the admin UI always
offers the two currently-assignable labels even before any student has
been assigned to them yet — any additional label already in real use
(any value found via students.distinct("group")) is included
automatically, with no code change.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from eduhub_platform.config import get_audit_history, resolve_flag, set_override
from teacher_admission import ALLOWED_SCHEDULE_VALUES, _normalize_schedule

logger = logging.getLogger("eduhub.schedule_time_windows")

_CONFIG_KEY_PREFIX = "schedule_time_window_"
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_DEFAULT_TIMEZONE = "Asia/Phnom_Penh"


def _config_key(label: str) -> str:
    return f"{_CONFIG_KEY_PREFIX}{label}"


def _validate_time_str(value: Any, field_name: str) -> str:
    s = str(value or "").strip()
    if not _TIME_RE.match(s):
        raise HTTPException(
            422, f"{field_name} must be a 24-hour HH:MM time (e.g. '19:00'), got {value!r}",
        )
    return s


def _minutes_since_midnight(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


async def get_schedule_time_window(db, label: str) -> dict | None:
    """Resolve the current effective time window for one schedule label.

    Deliberately never falls back to a legacy env var or a hardcoded
    default — an admin-set `published` override is the ONLY tier that
    makes sense for a per-schedule time window (there is no meaningful
    environment-variable equivalent, and no honest default a schedule
    with no configured time could fall back to — see Rule 3, "never show
    an invented or guessed time"). Returns None when nothing has ever
    been configured for this label, so callers can render an honest
    "time not yet set" state rather than a fabricated one.
    """
    norm = _normalize_schedule(label)
    if not norm:
        return None
    value, _source = await resolve_flag(db, _config_key(norm), default=None)
    if not isinstance(value, dict) or "start" not in value or "end" not in value:
        return None
    return value


async def list_known_schedule_labels(db) -> list[str]:
    """Every schedule label worth surfacing in the admin time-window
    editor: every label currently assigned to at least one real student,
    UNION teacher_admission.py's own ALLOWED_SCHEDULE_VALUES (so "A"/"B"
    are always editable even before any student holds them). A future
    label automatically appears here the moment it is actually assigned
    to a student — no code change needed (Rule 4)."""
    try:
        raw = await db.students.distinct("group")
    except Exception as exc:  # noqa: BLE001
        logger.warning("schedule_time_windows: students.distinct('group') failed (non-fatal): %s", exc)
        raw = []
    labels = {_normalize_schedule(g) for g in raw if isinstance(g, str)}
    labels |= set(ALLOWED_SCHEDULE_VALUES)
    labels.discard("")
    return sorted(labels)


async def list_schedule_time_windows(db) -> list[dict[str, Any]]:
    labels = await list_known_schedule_labels(db)
    return [{"label": label, "window": await get_schedule_time_window(db, label)} for label in labels]


async def set_schedule_time_window(
    db, label: str, *, start: Any, end: Any, timezone_name: str = _DEFAULT_TIMEZONE,
    updated_by: str = "",
) -> dict:
    """Admin-only. Validates BEFORE writing — eduhub_platform.config's own
    set_override accepts any JSON-serializable value with no domain
    validation of its own; this is the layer that actually rejects
    nonsensical configuration (Rule 2.4: end time after start time, no
    silent acceptance). Writes through the existing generic
    set_override, which already handles versioning and audit-history
    recording — no separate/parallel audit mechanism invented here."""
    norm = _normalize_schedule(label)
    if not norm:
        raise HTTPException(422, "label is required")
    start_s = _validate_time_str(start, "start")
    end_s = _validate_time_str(end, "end")
    if _minutes_since_midnight(end_s) <= _minutes_since_midnight(start_s):
        raise HTTPException(422, "end time must be after start time")
    value = {"start": start_s, "end": end_s, "timezone": (timezone_name or _DEFAULT_TIMEZONE).strip()}
    doc = await set_override(db, _config_key(norm), value, updated_by=updated_by)
    return {"label": norm, "window": value, "version": doc.get("version")}


async def get_schedule_time_window_history(db, label: str, *, limit: int = 50) -> list[dict]:
    norm = _normalize_schedule(label)
    if not norm:
        return []
    return await get_audit_history(db, _config_key(norm), limit=limit)


def register_schedule_time_window_routes(api: APIRouter, db, require_admin, require_student) -> None:
    """Mounts admin CRUD + audit-history routes, plus one narrow student-
    facing read route (a student may only ever read their OWN resolved
    schedule + window, never list or edit anything — this route takes no
    label parameter at all, it derives the label from the authenticated
    student's own `group`)."""

    @api.get("/admin/schedule-time-windows")
    async def admin_list_schedule_time_windows(_admin=Depends(require_admin)):
        return {"schedules": await list_schedule_time_windows(db)}

    @api.post("/admin/schedule-time-windows/{label}")
    async def admin_set_schedule_time_window(
        label: str, payload: dict = Body(...), admin=Depends(require_admin),
    ):
        result = await set_schedule_time_window(
            db, label,
            start=payload.get("start"),
            end=payload.get("end"),
            timezone_name=payload.get("timezone") or _DEFAULT_TIMEZONE,
            updated_by=getattr(admin, "email", "") or "",
        )
        return {"ok": True, **result}

    @api.get("/admin/schedule-time-windows/{label}/history")
    async def admin_schedule_time_window_history(label: str, _admin=Depends(require_admin)):
        return {"history": await get_schedule_time_window_history(db, label)}

    @api.get("/student/schedule-time-window")
    async def student_schedule_time_window(student=Depends(require_student)):
        raw_group = getattr(student, "group", "") or ""
        norm = _normalize_schedule(raw_group)
        window = await get_schedule_time_window(db, norm) if norm else None
        return {"schedule": norm, "window": window}

    logger.info("schedule_time_windows: routes registered")
