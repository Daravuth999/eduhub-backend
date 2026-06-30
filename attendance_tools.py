"""attendance_tools.py
=====================
EduHub Smart Attendance — "Constellation Check-In" (additive, isolated).

Same style as voice_treasure_attempt_tools.py / login_reward_tools.py:
Pydantic models with ``model_config = ConfigDict(extra="ignore")`` and a
single ``register_attendance_routes(api, db, require_admin, require_student, ...)``
entry point wired into server.py alongside the other feature modules.

Scope & boundaries
------------------
* Lives entirely in NEW collections:
    attendance_classes, attendance_sessions, attendance_records,
    attendance_streaks, attendance_settings.
* Does NOT touch the legacy ``speaking_lab_attendance`` collection / routes.
* Interacts with protected modules ONLY through their public APIs, injected
  by server.py at registration time:
    - ``wallet`` (wallet_service.WalletService) for idempotent point credits.
    - ``fan_out_push`` / ``build_target_query`` for push (sender reused as-is).
    - ``norm_student_id`` for canonical id comparison.
* Reuses the existing ``require_student`` / ``cleanId`` login for identity —
  never Telegram / Google identity. No new auth path.

The mid-section "still here?", risk score, tiers, streaks and nudge
guardrails are implemented as PURE module-level functions so they are unit
testable without a database (see tests/test_attendance_*.py).
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("eduhub.attendance")

# ── collections ────────────────────────────────────────────────────────────
COLL_CLASSES = "attendance_classes"
COLL_SESSIONS = "attendance_sessions"
COLL_RECORDS = "attendance_records"
COLL_STREAKS = "attendance_streaks"
COLL_SETTINGS = "attendance_settings"
SETTINGS_ID = "attendance_settings"

# ── attendance statuses ──────────────────────────────────────────────────────
ST_PRESENT_FULL = "present_full"
ST_PRESENT_PARTIAL = "present_partial"
ST_LATE = "late"
ST_ABSENT = "absent"
_PRESENT_STATES = {ST_PRESENT_FULL, ST_PRESENT_PARTIAL, ST_LATE}

# ── session lifecycle ────────────────────────────────────────────────────────
SESS_SCHEDULED = "scheduled"
SESS_OPEN = "open"
SESS_CLOSED = "closed"

# ── reliability tiers (ascending) ────────────────────────────────────────────
TIER_BRONZE = "bronze"
TIER_SILVER = "silver"
TIER_GOLD = "gold"
TIER_DIAMOND = "diamond"
TIER_ORDER = [TIER_BRONZE, TIER_SILVER, TIER_GOLD, TIER_DIAMOND]

# Rolling at-risk nudge cap (guardrail): at most one predictive nudge per
# student per this many days.
AT_RISK_NUDGE_COOLDOWN_DAYS = 7

# Miss reasons (non-punitive). Stored verbatim, never used to punish.
MISS_REASONS = {"sick", "conflict", "forgot"}


# ─────────────────────────────────────────────────────────────────────────────
# time helpers
# ─────────────────────────────────────────────────────────────────────────────
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def _parse_iso(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────────────
# PURE LOGIC — status, risk score, tiers, streaks, nudge guardrails.
# Kept free of any DB access so they can be unit-tested with known inputs.
# ─────────────────────────────────────────────────────────────────────────────
def compute_checkin_status(now: datetime, opens_at: datetime | None,
                           grace_deadline: datetime | None) -> str:
    """Status to assign at the MOMENT a student checks in (joins).

    * On time (at or before the grace deadline) → ``present_full`` (may later
      be downgraded to ``present_partial`` if the mid-session tap is missed).
    * After the grace deadline → ``late``.
    A student who never checks in is marked ``absent`` at session close (see
    ``finalize_status``); that is handled by the close pass, not here.
    """
    if grace_deadline is not None and now > grace_deadline:
        return ST_LATE
    return ST_PRESENT_FULL


def finalize_status(checked_in: bool, checkin_status: str | None,
                    mid_session_confirmed: bool,
                    mid_session_required: bool) -> str:
    """Resolve the FINAL status for a session at close time.

    * No check-in at all → ``absent``.
    * ``late`` stays ``late`` regardless of the mid-session tap.
    * ``present_full`` is downgraded to ``present_partial`` ONLY when the
      mid-session confirmation was required and was not tapped. Missing the
      tap never marks someone absent.
    """
    if not checked_in:
        return ST_ABSENT
    if checkin_status == ST_LATE:
        return ST_LATE
    if mid_session_required and not mid_session_confirmed:
        return ST_PRESENT_PARTIAL
    return checkin_status or ST_PRESENT_FULL


def _clamp01(x: float) -> float:
    try:
        x = float(x)
    except Exception:
        return 0.0
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def compute_risk_score(on_time_rate_5: float, on_time_rate_15: float,
                       miss_threshold_proximity: float,
                       skipped_confirmation_rate: float) -> int:
    """Weighted, rule-based, fully explainable risk score (0–100).

    Higher = MORE at risk. All four inputs are normalised 0..1.

      | signal                                   | weight |
      |------------------------------------------|--------|
      | (1 - on-time rate, last 5 sessions)      | 40%    |
      | (1 - on-time rate, last 15 sessions)     | 30%    |
      | proximity to the configured miss thresh. | 20%    |
      | rate of skipped mid-session confirmations| 10%    |

    On-time rates are inverted: a perfect on-time record contributes 0 risk
    from those signals, while never being on time contributes the full
    weight. No ML, no black box — every term is auditable on request.
    """
    ot5 = _clamp01(on_time_rate_5)
    ot15 = _clamp01(on_time_rate_15)
    prox = _clamp01(miss_threshold_proximity)
    skip = _clamp01(skipped_confirmation_rate)
    score = (
        0.40 * (1.0 - ot5)
        + 0.30 * (1.0 - ot15)
        + 0.20 * prox
        + 0.10 * skip
    ) * 100.0
    return int(round(score))


def risk_band(score: int, escalation_threshold: int) -> str:
    """Map a risk score to an action band.

    * score ≥ threshold (default 70) → ``high`` (proactive nudge + teacher
      "needs encouragement now" flag).
    * 40 ≤ score < threshold → ``monitored`` (no extra nudge).
    * score < 40 → ``standard`` (standard flow only).
    """
    if score >= int(escalation_threshold):
        return "high"
    if score >= 40:
        return "monitored"
    return "standard"


def compute_signals(statuses_5: list[str], statuses_15: list[str],
                    miss_threshold: int, recent_absences: int,
                    confirmations_offered: int, confirmations_skipped: int) -> dict:
    """Derive the four risk signals from raw session history.

    * on-time rate = fraction of sessions whose status is present_full or
      present_partial (joined on time). ``late`` and ``absent`` are not
      on-time.
    * miss-threshold proximity = recent_absences / miss_threshold, clamped.
    * skipped-confirmation rate = skipped / offered.
    """
    def _on_time_rate(rows: list[str]) -> float:
        if not rows:
            return 1.0  # no history yet ⇒ assume reliable (no risk)
        good = sum(1 for s in rows if s in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        return good / len(rows)

    prox = 0.0
    if miss_threshold and miss_threshold > 0:
        prox = _clamp01(recent_absences / float(miss_threshold))
    skip = 0.0
    if confirmations_offered and confirmations_offered > 0:
        skip = _clamp01(confirmations_skipped / float(confirmations_offered))
    return {
        "on_time_rate_5": _on_time_rate(statuses_5),
        "on_time_rate_15": _on_time_rate(statuses_15),
        "miss_threshold_proximity": prox,
        "skipped_confirmation_rate": skip,
    }


def compute_tier(attendance_rate: float, on_time_rate: float,
                 tiers: list[dict]) -> str:
    """Resolve the highest tier whose thresholds are BOTH satisfied.

    ``tiers`` is the settings list, each: {tier, min_attendance_rate,
    min_on_time_rate, multiplier}. Falling short of a tier only lowers the
    multiplier — it never restricts access to anything.
    """
    ar = _clamp01(attendance_rate)
    otr = _clamp01(on_time_rate)
    best = TIER_BRONZE
    best_rank = -1
    for t in tiers or []:
        name = (t.get("tier") or "").lower()
        if name not in TIER_ORDER:
            continue
        if ar >= float(t.get("min_attendance_rate") or 0) and \
           otr >= float(t.get("min_on_time_rate") or 0):
            rank = TIER_ORDER.index(name)
            if rank > best_rank:
                best_rank = rank
                best = name
    return best


def tier_multiplier(tier: str, tiers: list[dict]) -> float:
    for t in tiers or []:
        if (t.get("tier") or "").lower() == (tier or "").lower():
            try:
                return float(t.get("multiplier") or 1.0)
            except Exception:
                return 1.0
    return 1.0


def compute_streak(dated_statuses: list[tuple[str, str]]) -> tuple[int, int]:
    """Compute (current_streak, longest_streak) from chronological history.

    ``dated_statuses`` is a list of (date_iso, status) in ANY order; sorted
    here ascending by date. A "present" day (present_full / present_partial /
    late) extends the streak; ``absent`` breaks it. Current streak counts the
    trailing run of present days.
    """
    rows = sorted(dated_statuses, key=lambda r: r[0])
    longest = 0
    run = 0
    current = 0
    for _date, status in rows:
        if status in _PRESENT_STATES:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    # current streak = trailing run
    for _date, status in reversed(rows):
        if status in _PRESENT_STATES:
            current += 1
        else:
            break
    return current, longest


def nudge_guardrail_allows(now: datetime,
                           last_at_risk_nudge_at: datetime | None,
                           closing_soon_sent_today: bool,
                           last_absence_reason_at: datetime | None) -> bool:
    """Enforce the at-risk (predictive) nudge guardrails.

    Returns True ONLY when ALL hold:
      * No predictive nudge sent within the rolling 7-day window.
      * No closing-soon nudge was already sent to this student TODAY
        (a same-day closing-soon suppresses that day's predictive nudge).
      * No absence reason was logged within the last 24h (a recently-logged
        absence reason suppresses the next at-risk nudge).
    """
    if closing_soon_sent_today:
        return False
    if last_at_risk_nudge_at is not None:
        if now - last_at_risk_nudge_at < timedelta(days=AT_RISK_NUDGE_COOLDOWN_DAYS):
            return False
    if last_absence_reason_at is not None:
        if now - last_absence_reason_at < timedelta(hours=24):
            return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# default settings (EN/KH bilingual copy — KH defaults are DRAFTS pending a
# native-speaker review; the teacher can edit every field in Author Studio).
# ─────────────────────────────────────────────────────────────────────────────
def default_settings() -> dict:
    return {
        "_id": SETTINGS_ID,
        "checkin_window_minutes": 90,
        "late_grace_minutes": 10,
        "mid_session_enabled": True,
        "mid_session_offset_minutes": 20,
        "shared_device_prompt_enabled": True,
        "miss_threshold": 3,
        "escalation_threshold": 70,
        # reward economy — base points credited per present session, scaled by
        # the student's reliability-tier multiplier.
        "base_attendance_points": 5,
        "reward_tiers": [
            {"tier": TIER_BRONZE, "min_attendance_rate": 0.0, "min_on_time_rate": 0.0, "multiplier": 1.0},
            {"tier": TIER_SILVER, "min_attendance_rate": 0.7, "min_on_time_rate": 0.6, "multiplier": 1.25},
            {"tier": TIER_GOLD, "min_attendance_rate": 0.85, "min_on_time_rate": 0.8, "multiplier": 1.5},
            {"tier": TIER_DIAMOND, "min_attendance_rate": 0.95, "min_on_time_rate": 0.9, "multiplier": 2.0},
        ],
        "notifications": {
            "live_now_enabled": True,
            "closing_soon_enabled": True,
            "closing_soon_offset_minutes": 15,
            "predictive_at_risk_enabled": True,
            "mid_session_push_enabled": True,
        },
        # bilingual nudge copy (EN + KH draft). KH = AI-drafted, pending review.
        "copy": {
            "live_now": {
                "title_en": "Class is live now",
                "title_kh": "ថ្នាក់រៀនកំពុងផ្សាយផ្ទាល់",
                "body_en": "Your class has started. Tap to join the Meet now.",
                "body_kh": "ថ្នាក់របស់អ្នកបានចាប់ផ្តើមហើយ។ ចុចដើម្បីចូលរួម Meet ឥឡូវនេះ។",
            },
            "closing_soon": {
                "title_en": "Check-in closing soon",
                "title_kh": "ការចុះឈ្មោះជិតបិទហើយ",
                "body_en": "You haven't joined yet. Check in before the window closes.",
                "body_kh": "អ្នកមិនទាន់បានចូលរួមនៅឡើយទេ។ សូមចុះឈ្មោះមុនពេលបិទ។",
            },
            "mid_session": {
                "title_en": "Still here?",
                "title_kh": "នៅទីនេះមែនទេ?",
                "body_en": "Tap once to confirm you're still in class.",
                "body_kh": "ចុចម្តងដើម្បីបញ្ជាក់ថាអ្នកនៅតែរៀន។",
            },
            "miss_followup": {
                "title_en": "We missed you today",
                "title_kh": "យើងបាននឹករអ្នកនៅថ្ងៃនេះ",
                "body_en": "No worries — let your teacher know what happened.",
                "body_kh": "កុំបារម្ភ — ប្រាប់គ្រូរបស់អ្នកថាមានរឿងអ្វីកើតឡើង។",
            },
            "at_risk": {
                "title_en": "A gentle reminder",
                "title_kh": "ការរំលឹកដ៏ស្និទ្ធស្នាល",
                "body_en": "Your next class is coming up. We'd love to see you there.",
                "body_kh": "ថ្នាក់បន្ទាប់របស់អ្នកជិតមកដល់ហើយ។ យើងរីករាយដែលបានឃើញអ្នកនៅទីនោះ។",
            },
        },
        "updated_at": _utcnow_iso(),
    }


def _merge_settings(stored: dict | None) -> dict:
    base = default_settings()
    if not stored:
        return base
    out = dict(base)
    for k, v in stored.items():
        if k == "_id":
            continue
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            merged = dict(base[k])
            merged.update(v)
            out[k] = merged
        else:
            out[k] = v
    return out


# ─────────────────────────────────────────────────────────────────────────────
# pydantic payloads
# ─────────────────────────────────────────────────────────────────────────────
class ClassIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title_en: str = "Untitled class"
    title_kh: str = ""
    teacher: str = ""
    recurrence: str = ""
    group: str = ""
    roster: list[str] = Field(default_factory=list)


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    class_id: str
    date: str | None = None
    meet_url: str = ""
    opens_at: str | None = None
    closes_at: str | None = None
    grace_minutes: int | None = None
    mid_session_enabled: bool | None = None


class CheckInIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    slug: str
    as_student_id: str | None = None  # "not you?" re-attribution target


class MidSessionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str


class MissReasonIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str
    reason: Literal["sick", "conflict", "forgot"]


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    settings: dict


# ─────────────────────────────────────────────────────────────────────────────
# indexes (idempotent, best-effort)
# ─────────────────────────────────────────────────────────────────────────────
async def ensure_attendance_indexes(db) -> None:
    try:
        await db[COLL_CLASSES].create_index("class_id", unique=True, sparse=True)
        await db[COLL_SESSIONS].create_index("session_id", unique=True, sparse=True)
        await db[COLL_SESSIONS].create_index("join_slug", unique=True, sparse=True)
        await db[COLL_SESSIONS].create_index([("class_id", 1), ("date", -1)])
        await db[COLL_SESSIONS].create_index([("status", 1), ("closes_at", 1)])
        await db[COLL_RECORDS].create_index(
            [("session_id", 1), ("student_id", 1)], unique=True,
            name="uniq_session_student",
        )
        await db[COLL_RECORDS].create_index("student_id")
        await db[COLL_RECORDS].create_index([("class_id", 1), ("checked_in_at", 1)])
        await db[COLL_STREAKS].create_index("student_id", unique=True, sparse=True)
        log.info("attendance: indexes ensured")
    except Exception as exc:  # noqa: BLE001
        log.warning("attendance: index ensure failed (non-fatal): %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# entry point
# ─────────────────────────────────────────────────────────────────────────────
def register_attendance_routes(api, db, require_admin, require_student, *,
                               current_student=None, fan_out_push=None,
                               build_target_query=None, norm_student_id=None,
                               wallet=None) -> None:
    from fastapi import Depends, HTTPException
    from fastapi.responses import RedirectResponse

    _norm = norm_student_id or (lambda v: (str(v or "")).strip().lower())

    # ── small DB helpers ─────────────────────────────────────────────────
    async def _load_settings() -> dict:
        stored = await db[COLL_SETTINGS].find_one({"_id": SETTINGS_ID})
        return _merge_settings(stored)

    def _sid(student) -> str:
        return _norm(getattr(student, "clean_id", "") or getattr(student, "student_id", ""))

    async def _class_roster(cls: dict) -> list[dict]:
        """Roster scoped to a class's ACTUAL enrolled students — never inferred
        from Telegram / Google. Resolves explicit roster ids first, else the
        class group."""
        ids = [_norm(x) for x in (cls.get("roster") or []) if x]
        query: dict = {}
        if ids:
            query = {"$or": [
                {"clean_id": {"$in": ids}},
                {"student_id": {"$in": ids}},
            ]}
        elif cls.get("group"):
            query = {"group": cls.get("group")}
        else:
            return []
        out = []
        cur = db.students.find(query, {"_id": 0, "student_id": 1, "clean_id": 1, "display_name": 1})
        async for s in cur:
            # ``student_id`` here is the human-facing clean_id used for ALL of
            # attendance's internal bookkeeping (records / streaks / roster
            # matching) — intentionally unchanged. ``wallet_student_id`` is the
            # internal UUID-style student_id assigned at signup (e.g.
            # "stu_a1b2c3d4e5f6"); it is the identity the points wallet/ledger
            # keys on, and is used ONLY at the wallet.credit() call site (§1),
            # never for attendance's own bookkeeping.
            out.append({
                "student_id": s.get("clean_id") or s.get("student_id"),
                "wallet_student_id": s.get("student_id") or s.get("clean_id"),
                "clean_id": s.get("clean_id") or s.get("student_id"),
                "display_name": s.get("display_name") or s.get("clean_id") or s.get("student_id"),
            })
        return out

    async def _record_id(session_id: str, sid: str) -> str:
        return f"{session_id}:{_norm(sid)}"

    async def _write_checkin(session: dict, sid: str, *, method: str,
                             attributed_via: str) -> dict:
        """Idempotently write/refresh an attendance_records row. Returns the
        record. Never raises on a benign duplicate."""
        now = _utcnow()
        settings = await _load_settings()
        opens_at = _parse_iso(session.get("opens_at"))
        grace_min = session.get("grace_minutes")
        if grace_min is None:
            grace_min = settings.get("late_grace_minutes", 10)
        grace_deadline = (opens_at + timedelta(minutes=int(grace_min))) if opens_at else None
        status = compute_checkin_status(now, opens_at, grace_deadline)
        rid = await _record_id(session["session_id"], sid)
        existing = await db[COLL_RECORDS].find_one({"_id": rid}, {"_id": 0})
        if existing and existing.get("checked_in_at"):
            return existing  # already checked in — idempotent
        doc = {
            "_id": rid,
            "student_id": _norm(sid),
            "session_id": session["session_id"],
            "class_id": session.get("class_id"),
            "status": status,
            "checkin_status": status,
            "checked_in_at": _iso(now),
            "mid_session_confirmed": False,
            "method": method,
            "attributed_via": attributed_via,
            "miss_reason": None,
            "finalized": False,
            "updated_at": _iso(now),
        }
        await db[COLL_RECORDS].update_one(
            {"_id": rid}, {"$set": doc}, upsert=True,
        )
        return doc

    # ── student: resolve a session by slug (no meet_url ever leaks here) ──
    async def _session_by_slug(slug: str) -> dict | None:
        return await db[COLL_SESSIONS].find_one({"join_slug": slug}, {"_id": 0})

    def _session_open(session: dict, now: datetime) -> bool:
        if session.get("status") == SESS_CLOSED:
            return False
        opens = _parse_iso(session.get("opens_at"))
        closes = _parse_iso(session.get("closes_at"))
        if opens and now < opens:
            return False
        if closes and now > closes:
            return False
        return True

    # ─────────────────────────────────────────────────────────────────────
    # STUDENT ROUTES
    # ─────────────────────────────────────────────────────────────────────

    # Convenience GET join link: redirects an authenticated student straight
    # into the Meet (best-effort check-in first). Degrades safely — if the
    # write fails the redirect to Meet still happens. Unidentified callers are
    # bounced to the in-app check-in page (picker + "not you?").
    if current_student is not None:
        @api.get("/attendance/join/{slug}")
        async def attendance_join(slug: str, student=Depends(current_student)):
            session = await _session_by_slug(slug)
            if not session or not session.get("meet_url"):
                # No safe Meet target — send to the in-app page to explain.
                return RedirectResponse(url=f"/attendance/j/{slug}", status_code=302)
            meet_url = session["meet_url"]
            if student is not None:
                try:
                    if _session_open(session, _utcnow()):
                        await _write_checkin(session, _sid(student),
                                             method="join_link",
                                             attributed_via="session_identity")
                except Exception as exc:  # noqa: BLE001 — never block class
                    log.warning("attendance: join check-in best-effort failed: %s", exc)
                return RedirectResponse(url=meet_url, status_code=302)
            # Not identified on this device → in-app picker page.
            return RedirectResponse(url=f"/attendance/j/{slug}", status_code=302)

    @api.get("/attendance/session/by-slug/{slug}")
    async def attendance_session_public(slug: str, student=Depends(require_student)):
        session = await _session_by_slug(slug)
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        settings = await _load_settings()
        roster = await _class_roster(cls or {})
        sid = _sid(student)
        rid = await _record_id(session["session_id"], sid)
        rec = await db[COLL_RECORDS].find_one({"_id": rid}, {"_id": 0})
        # meet_url is NEVER returned to students here.
        return {
            "session_id": session["session_id"],
            "class_id": session.get("class_id"),
            "title_en": (cls or {}).get("title_en"),
            "title_kh": (cls or {}).get("title_kh"),
            "status": session.get("status"),
            "is_open": _session_open(session, _utcnow()),
            "opens_at": session.get("opens_at"),
            "closes_at": session.get("closes_at"),
            "already_checked_in": bool(rec and rec.get("checked_in_at")),
            "my_status": (rec or {}).get("status"),
            "shared_device_prompt_enabled": settings.get("shared_device_prompt_enabled", True),
            "roster": roster,
            "copy": settings.get("copy"),
        }

    @api.post("/attendance/checkin")
    async def attendance_checkin(payload: CheckInIn, student=Depends(require_student)):
        session = await _session_by_slug(payload.slug)
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        now = _utcnow()
        meet_url = session.get("meet_url") or ""
        is_open = _session_open(session, now)

        # Resolve attribution target. "not you?" re-attributes to a different
        # ENROLLED student (shared family device) — validated against the
        # class roster, never trusted blindly.
        target_sid = _sid(student)
        attributed_via = "session_identity"
        if payload.as_student_id:
            cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
            roster_ids = {_norm(r["student_id"]) for r in await _class_roster(cls or {})}
            cand = _norm(payload.as_student_id)
            if cand not in roster_ids:
                raise HTTPException(status_code=400, detail="not_enrolled_in_class")
            target_sid = cand
            attributed_via = "shared_device_picker"

        record = None
        if is_open:
            try:
                record = await _write_checkin(
                    session, target_sid, method="checkin",
                    attributed_via=attributed_via,
                )
            except Exception as exc:  # noqa: BLE001 — tracking must never block class
                log.warning("attendance: checkin write failed (degrading): %s", exc)
                record = None
        else:
            log.info(
                "attendance: checkin outside open window — session=%s sid=%s "
                "status=%s opens=%s closes=%s now=%s",
                session.get("session_id"), target_sid, session.get("status"),
                session.get("opens_at"), session.get("closes_at"), _iso(now),
            )

        # Always surface the Meet URL so the student reaches class even if the
        # write failed (client retries, then "Join anyway").
        return {
            "ok": record is not None,
            "tracked": record is not None,
            "is_open": is_open,
            "status": (record or {}).get("status"),
            "session_id": session["session_id"],
            "student_id": target_sid,
            "attributed_via": attributed_via,
            "meet_url": meet_url,
        }

    @api.post("/attendance/mid-session-confirm")
    async def attendance_mid_confirm(payload: MidSessionIn, student=Depends(require_student)):
        rid = await _record_id(payload.session_id, _sid(student))
        res = await db[COLL_RECORDS].update_one(
            {"_id": rid, "checked_in_at": {"$ne": None}},
            {"$set": {"mid_session_confirmed": True, "updated_at": _utcnow_iso()}},
        )
        return {"ok": res.matched_count > 0}

    @api.post("/attendance/miss-reason")
    async def attendance_miss_reason(payload: MissReasonIn, student=Depends(require_student)):
        sid = _sid(student)
        rid = await _record_id(payload.session_id, sid)
        await db[COLL_RECORDS].update_one(
            {"_id": rid},
            {"$set": {"miss_reason": payload.reason, "updated_at": _utcnow_iso()},
             "$setOnInsert": {"student_id": sid, "session_id": payload.session_id,
                              "status": ST_ABSENT, "checked_in_at": None,
                              "mid_session_confirmed": False, "method": "miss_reason"}},
            upsert=True,
        )
        # A recently-logged absence reason suppresses the next at-risk nudge.
        await db[COLL_STREAKS].update_one(
            {"student_id": sid},
            {"$set": {"last_absence_reason_at": _utcnow_iso()},
             "$setOnInsert": {"student_id": sid}},
            upsert=True,
        )
        return {"ok": True, "reason": payload.reason}

    @api.get("/attendance/me")
    async def attendance_me(student=Depends(require_student)):
        sid = _sid(student)
        streak = await db[COLL_STREAKS].find_one({"student_id": sid}, {"_id": 0}) or {}
        cur = db[COLL_RECORDS].find(
            {"student_id": sid, "checked_in_at": {"$ne": None}}, {"_id": 0},
        ).sort("checked_in_at", -1).limit(60)
        history = [
            {"session_id": r.get("session_id"), "class_id": r.get("class_id"),
             "status": r.get("status"), "checked_in_at": r.get("checked_in_at")}
            async for r in cur
        ]
        return {
            "student_id": sid,
            "current_streak": int(streak.get("current_streak") or 0),
            "longest_streak": int(streak.get("longest_streak") or 0),
            "reliability_tier": streak.get("reliability_tier") or TIER_BRONZE,
            "on_time_rate_rolling": streak.get("on_time_rate_rolling"),
            "risk_score": streak.get("risk_score"),
            "history": history,
        }

    @api.get("/attendance/live")
    async def attendance_live(student=Depends(require_student)):
        """Currently-open session for any class the student is enrolled in —
        powers the home-tile live state + in-app fallback Join Link."""
        sid = _sid(student)
        now = _utcnow()
        cur = db[COLL_SESSIONS].find({"status": SESS_OPEN}, {"_id": 0})
        async for session in cur:
            if not _session_open(session, now):
                continue
            cls = await db[COLL_CLASSES].find_one(
                {"class_id": session.get("class_id")}, {"_id": 0})
            roster_ids = {_norm(r["student_id"]) for r in await _class_roster(cls or {})}
            if sid in roster_ids:
                return {
                    "live": True,
                    "slug": session.get("join_slug"),
                    "session_id": session.get("session_id"),
                    "title_en": (cls or {}).get("title_en"),
                    "title_kh": (cls or {}).get("title_kh"),
                }
        return {"live": False}

    # ─────────────────────────────────────────────────────────────────────
    # ADMIN ROUTES
    # ─────────────────────────────────────────────────────────────────────
    @api.get("/admin/attendance/settings")
    async def admin_get_settings(admin=Depends(require_admin)):
        return {"settings": await _load_settings()}

    @api.put("/admin/attendance/settings")
    async def admin_put_settings(payload: SettingsIn, admin=Depends(require_admin)):
        merged = _merge_settings(payload.settings)
        merged["_id"] = SETTINGS_ID
        merged["updated_at"] = _utcnow_iso()
        await db[COLL_SETTINGS].replace_one({"_id": SETTINGS_ID}, merged, upsert=True)
        return {"ok": True, "settings": merged}

    @api.get("/admin/attendance/classes")
    async def admin_list_classes(admin=Depends(require_admin)):
        cur = db[COLL_CLASSES].find({}, {"_id": 0}).sort("created_at", -1)
        return {"classes": [c async for c in cur]}

    @api.post("/admin/attendance/classes")
    async def admin_create_class(payload: ClassIn, admin=Depends(require_admin)):
        cid = "cls_" + secrets.token_hex(6)
        doc = {
            "class_id": cid,
            "title_en": payload.title_en.strip() or "Untitled class",
            "title_kh": payload.title_kh.strip(),
            "teacher": payload.teacher.strip(),
            "recurrence": payload.recurrence.strip(),
            "group": payload.group.strip(),
            "roster": [_norm(x) for x in payload.roster if x],
            "created_at": _utcnow_iso(),
        }
        await db[COLL_CLASSES].insert_one(doc)
        doc.pop("_id", None)
        return {"ok": True, "class": doc}

    @api.put("/admin/attendance/classes/{class_id}")
    async def admin_update_class(class_id: str, payload: ClassIn, admin=Depends(require_admin)):
        upd = {
            "title_en": payload.title_en.strip() or "Untitled class",
            "title_kh": payload.title_kh.strip(),
            "teacher": payload.teacher.strip(),
            "recurrence": payload.recurrence.strip(),
            "group": payload.group.strip(),
            "roster": [_norm(x) for x in payload.roster if x],
            "updated_at": _utcnow_iso(),
        }
        res = await db[COLL_CLASSES].update_one({"class_id": class_id}, {"$set": upd})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="class_not_found")
        return {"ok": True}

    @api.delete("/admin/attendance/classes/{class_id}")
    async def admin_delete_class(class_id: str, admin=Depends(require_admin)):
        await db[COLL_CLASSES].delete_one({"class_id": class_id})
        return {"ok": True}

    @api.get("/admin/attendance/sessions")
    async def admin_list_sessions(class_id: str | None = None, admin=Depends(require_admin)):
        q = {"class_id": class_id} if class_id else {}
        cur = db[COLL_SESSIONS].find(q, {"_id": 0}).sort("date", -1).limit(500)
        # meet_url IS returned to admins (teacher owns it); never to students.
        return {"sessions": [s async for s in cur]}

    @api.post("/admin/attendance/sessions")
    async def admin_create_session(payload: SessionIn, admin=Depends(require_admin)):
        cls = await db[COLL_CLASSES].find_one({"class_id": payload.class_id}, {"_id": 0})
        if not cls:
            raise HTTPException(status_code=404, detail="class_not_found")
        settings = await _load_settings()
        now = _utcnow()
        opens = _parse_iso(payload.opens_at) or now
        win = settings.get("checkin_window_minutes", 90)
        closes = _parse_iso(payload.closes_at) or (opens + timedelta(minutes=int(win)))
        sid = "ses_" + secrets.token_hex(6)
        slug = secrets.token_urlsafe(7)
        doc = {
            "session_id": sid,
            "class_id": payload.class_id,
            "date": (payload.date or opens.date().isoformat()),
            "meet_url": payload.meet_url.strip(),
            "join_slug": slug,
            "opens_at": _iso(opens),
            "closes_at": _iso(closes),
            "grace_minutes": (payload.grace_minutes if payload.grace_minutes is not None
                              else settings.get("late_grace_minutes", 10)),
            "mid_session_enabled": (payload.mid_session_enabled
                                    if payload.mid_session_enabled is not None
                                    else settings.get("mid_session_enabled", True)),
            "status": SESS_SCHEDULED,
            "created_at": _utcnow_iso(),
        }
        await db[COLL_SESSIONS].insert_one(doc)
        doc.pop("_id", None)
        return {"ok": True, "session": doc, "join_slug": slug}

    @api.put("/admin/attendance/sessions/{session_id}")
    async def admin_update_session(session_id: str, payload: SessionIn, admin=Depends(require_admin)):
        upd: dict = {"updated_at": _utcnow_iso()}
        if payload.meet_url is not None:
            upd["meet_url"] = payload.meet_url.strip()
        if payload.opens_at:
            upd["opens_at"] = _iso(_parse_iso(payload.opens_at))
        if payload.closes_at:
            upd["closes_at"] = _iso(_parse_iso(payload.closes_at))
        if payload.grace_minutes is not None:
            upd["grace_minutes"] = payload.grace_minutes
        if payload.mid_session_enabled is not None:
            upd["mid_session_enabled"] = payload.mid_session_enabled
        if payload.date:
            upd["date"] = payload.date
        res = await db[COLL_SESSIONS].update_one({"session_id": session_id}, {"$set": upd})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="session_not_found")
        return {"ok": True}

    @api.delete("/admin/attendance/sessions/{session_id}")
    async def admin_delete_session(session_id: str, admin=Depends(require_admin)):
        await db[COLL_SESSIONS].delete_one({"session_id": session_id})
        return {"ok": True}

    async def _bilingual(copy_block: dict) -> tuple[str, str]:
        title = f"{copy_block.get('title_en','')} / {copy_block.get('title_kh','')}".strip(" /")
        body = f"{copy_block.get('body_en','')}\n{copy_block.get('body_kh','')}".strip()
        return title, body

    async def _push(target: str, ids: list[str], title: str, body: str, url: str) -> tuple[int, int]:
        if not callable(fan_out_push) or not callable(build_target_query):
            return 0, 0
        try:
            query = build_target_query(target, ids, None)
            return await fan_out_push(query, title, body, url)
        except Exception as exc:  # noqa: BLE001
            log.warning("attendance: push fan-out failed: %s", exc)
            return 0, 0

    @api.post("/admin/attendance/sessions/{session_id}/open")
    async def admin_open_session(session_id: str, admin=Depends(require_admin)):
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        now = _utcnow()
        settings = await _load_settings()
        win = int(settings.get("checkin_window_minutes", 90))
        open_update: dict = {"status": SESS_OPEN, "opened_at": _iso(now)}
        # If the check-in window has already expired (closes_at in the past or unset),
        # reset it from the actual open time. This handles the common case where a
        # session was created hours before class (defaulting opens_at/closes_at to
        # creation time) and the teacher opens it when class actually starts.
        closes_at = _parse_iso(session.get("closes_at"))
        if closes_at is None or closes_at <= now:
            open_update["opens_at"] = _iso(now)
            open_update["closes_at"] = _iso(now + timedelta(minutes=win))
            log.info("attendance: open %s — window reset to now+%dmin (was expires=%s)",
                     session_id, win, _iso(closes_at))
        await db[COLL_SESSIONS].update_one(
            {"session_id": session_id},
            {"$set": open_update},
        )
        settings = await _load_settings()
        sent = 0
        if (settings.get("notifications") or {}).get("live_now_enabled"):
            cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
            ids = [r["student_id"] for r in await _class_roster(cls or {})]
            title, body = await _bilingual((settings.get("copy") or {}).get("live_now", {}))
            sent, _ = await _push("students", ids, title, body, f"/attendance/j/{session.get('join_slug')}")
        return {"ok": True, "live_now_push_sent": sent}

    @api.post("/admin/attendance/sessions/{session_id}/closing-soon-nudge")
    async def admin_closing_soon(session_id: str, admin=Depends(require_admin)):
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        settings = await _load_settings()
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        roster = await _class_roster(cls or {})
        # only students with NO check-in yet
        checked = set()
        cur = db[COLL_RECORDS].find(
            {"session_id": session_id, "checked_in_at": {"$ne": None}},
            {"_id": 0, "student_id": 1})
        async for r in cur:
            checked.add(_norm(r.get("student_id")))
        pending = [r["student_id"] for r in roster if _norm(r["student_id"]) not in checked]
        title, body = await _bilingual((settings.get("copy") or {}).get("closing_soon", {}))
        sent, _ = await _push("session_pending_checkin", pending, title, body,
                              f"/attendance/j/{session.get('join_slug')}")
        # mark closing-soon sent TODAY for each pending student (guardrail input)
        today = _utcnow().date().isoformat()
        for pid in pending:
            await db[COLL_STREAKS].update_one(
                {"student_id": _norm(pid)},
                {"$set": {"closing_soon_last_date": today},
                 "$setOnInsert": {"student_id": _norm(pid)}},
                upsert=True,
            )
        return {"ok": True, "pending_count": len(pending), "sent": sent}

    async def _recompute_student(sid: str, settings: dict) -> dict:
        """Recompute streak + tier + risk score for one student from records."""
        sid = _norm(sid)
        cur = db[COLL_RECORDS].find({"student_id": sid}, {"_id": 0}).sort("checked_in_at", 1)
        rows = [r async for r in cur]
        # build dated statuses (use checked_in_at or session date proxy)
        dated = [((r.get("checked_in_at") or r.get("updated_at") or ""), r.get("status") or ST_ABSENT)
                 for r in rows]
        current, longest = compute_streak(dated)
        statuses = [r.get("status") or ST_ABSENT for r in rows]
        last5 = statuses[-5:]
        last15 = statuses[-15:]
        total = len(statuses)
        present = sum(1 for s in statuses if s in _PRESENT_STATES)
        on_time = sum(1 for s in statuses if s in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        attendance_rate = (present / total) if total else 1.0
        on_time_rate = (on_time / total) if total else 1.0
        # recent absences = trailing absents within last `miss_threshold*?`
        recent_absences = sum(1 for s in statuses[-15:] if s == ST_ABSENT)
        offered = sum(1 for r in rows if r.get("status") in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        skipped = sum(1 for r in rows if r.get("status") == ST_PRESENT_PARTIAL)
        signals = compute_signals(
            last5, last15, int(settings.get("miss_threshold") or 3),
            recent_absences, offered, skipped,
        )
        score = compute_risk_score(
            signals["on_time_rate_5"], signals["on_time_rate_15"],
            signals["miss_threshold_proximity"], signals["skipped_confirmation_rate"],
        )
        tier = compute_tier(attendance_rate, on_time_rate, settings.get("reward_tiers") or [])
        upd = {
            "student_id": sid,
            "current_streak": current,
            "longest_streak": longest,
            "reliability_tier": tier,
            "on_time_rate_rolling": round(on_time_rate, 4),
            "attendance_rate": round(attendance_rate, 4),
            "risk_score": score,
            "risk_band": risk_band(score, int(settings.get("escalation_threshold") or 70)),
            "signals": signals,
            "updated_at": _utcnow_iso(),
        }
        await db[COLL_STREAKS].update_one(
            {"student_id": sid}, {"$set": upd}, upsert=True,
        )
        return upd

    @api.post("/admin/attendance/sessions/{session_id}/close")
    async def admin_close_session(session_id: str, admin=Depends(require_admin)):
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        settings = await _load_settings()
        mid_required = bool(session.get("mid_session_enabled", True)) and \
            bool((settings.get("notifications") or {}).get("mid_session_push_enabled", True))
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        roster = await _class_roster(cls or {})

        # 1) finalize every roster student's status.
        absentees: list[str] = []
        # Each entry is (roster_row, final_status). The whole roster row is kept
        # (not just its clean_id) so the reward-credit step (§1) can address the
        # wallet by the internal UUID student_id while every other bookkeeping
        # path keeps keying on clean_id.
        present_students: list[tuple[dict, str]] = []
        for r in roster:
            sid = _norm(r["student_id"])
            rid = f"{session_id}:{sid}"
            rec = await db[COLL_RECORDS].find_one({"_id": rid}, {"_id": 0})
            checked = bool(rec and rec.get("checked_in_at"))
            final = finalize_status(
                checked, (rec or {}).get("checkin_status"),
                bool((rec or {}).get("mid_session_confirmed")), mid_required,
            )
            await db[COLL_RECORDS].update_one(
                {"_id": rid},
                {"$set": {"status": final, "finalized": True, "updated_at": _utcnow_iso(),
                          "student_id": sid, "session_id": session_id,
                          "class_id": session.get("class_id")},
                 "$setOnInsert": {"checked_in_at": (rec or {}).get("checked_in_at"),
                                  "mid_session_confirmed": bool((rec or {}).get("mid_session_confirmed"))}},
                upsert=True,
            )
            if final == ST_ABSENT:
                absentees.append(r["student_id"])
            else:
                present_students.append((r, final))

        await db[COLL_SESSIONS].update_one(
            {"session_id": session_id},
            {"$set": {"status": SESS_CLOSED, "closed_at": _utcnow_iso()}},
        )

        # 2) recompute streaks/tiers/risk per roster student.
        for r in roster:
            await _recompute_student(r["student_id"], settings)

        # 3) idempotent reward credit for present students (tier multiplier).
        credited = 0
        base = int(settings.get("base_attendance_points") or 0)
        if wallet is not None and base > 0:
            for roster_row, _final in present_students:
                clean_sid = roster_row["student_id"]   # clean_id — bookkeeping key (unchanged)
                # §1 FIX: the points wallet/ledger keys on the internal
                # UUID-style student_id (assigned at signup, distinct from the
                # human-facing clean_id). Every other reward feature AND
                # GET /student/points/history look transactions up by that
                # student_id — a credit filed under clean_id would never surface
                # in the student's balance or history. So we pass the real
                # student_id as the primary wallet identity and keep clean_id
                # only as metadata, mirroring ai_assistant_voice_tools.py.
                wallet_sid = roster_row.get("wallet_student_id") or clean_sid
                streak = await db[COLL_STREAKS].find_one(
                    {"student_id": _norm(clean_sid)}, {"_id": 0}) or {}
                mult = tier_multiplier(streak.get("reliability_tier") or TIER_BRONZE,
                                       settings.get("reward_tiers") or [])
                amount = int(round(base * mult))
                if amount <= 0:
                    continue
                try:
                    await wallet.credit(
                        wallet_sid, amount,
                        source="attendance",
                        source_ref=session_id,
                        idempotency_key=f"attendance:{session_id}:{_norm(wallet_sid)}",
                        clean_id=clean_sid,
                    )
                    credited += 1
                except Exception as exc:  # noqa: BLE001 — reward never blocks close
                    log.warning("attendance: reward credit failed sid=%s: %s", wallet_sid, exc)

        # 4) miss follow-up push to absentees (non-punitive, with reason picker).
        miss_sent = 0
        if absentees:
            title, body = await _bilingual((settings.get("copy") or {}).get("miss_followup", {}))
            miss_sent, _ = await _push("students", absentees, title, body, "/attendance/me")

        return {
            "ok": True,
            "present_count": len(present_students),
            "absent_count": len(absentees),
            "rewards_credited": credited,
            "miss_followup_sent": miss_sent,
        }

    @api.post("/admin/attendance/at-risk-nudge")
    async def admin_at_risk_nudge(admin=Depends(require_admin)):
        """Fire predictive at-risk nudges, enforcing the guardrails."""
        settings = await _load_settings()
        if not (settings.get("notifications") or {}).get("predictive_at_risk_enabled"):
            return {"ok": True, "sent": 0, "reason": "disabled"}
        threshold = int(settings.get("escalation_threshold") or 70)
        now = _utcnow()
        today = now.date().isoformat()
        targets: list[str] = []
        cur = db[COLL_STREAKS].find({"risk_score": {"$gte": threshold}}, {"_id": 0})
        async for st in cur:
            sid = st.get("student_id")
            allowed = nudge_guardrail_allows(
                now,
                _parse_iso(st.get("last_at_risk_nudge_at")),
                (st.get("closing_soon_last_date") == today),
                _parse_iso(st.get("last_absence_reason_at")),
            )
            if allowed:
                targets.append(sid)
        sent = 0
        if targets:
            title, body = await _bilingual((settings.get("copy") or {}).get("at_risk", {}))
            sent, _ = await _push("at_risk_score", targets, title, body, "/attendance/me")
            for sid in targets:
                await db[COLL_STREAKS].update_one(
                    {"student_id": _norm(sid)},
                    {"$set": {"last_at_risk_nudge_at": _utcnow_iso()}},
                )
        return {"ok": True, "sent": sent, "candidates": len(targets)}

    @api.get("/admin/attendance/at-risk")
    async def admin_at_risk_list(admin=Depends(require_admin)):
        """Private teacher flag — students at/above the escalation threshold.
        Never a public list of any kind."""
        settings = await _load_settings()
        threshold = int(settings.get("escalation_threshold") or 70)
        cur = db[COLL_STREAKS].find({"risk_score": {"$gte": threshold}}, {"_id": 0}).sort("risk_score", -1)
        rows = [s async for s in cur]
        return {"threshold": threshold, "flag": "needs_encouragement_now", "students": rows}

    @api.get("/admin/attendance/report")
    async def admin_report(month: str | None = None, class_id: str | None = None,
                           admin=Depends(require_admin)):
        """Live monthly report — computed from attendance_records, never stored."""
        q: dict = {}
        if class_id:
            q["class_id"] = class_id
        # month filter on session date YYYY-MM
        sessions_q = dict(q)
        if month:
            sessions_q["date"] = {"$regex": f"^{month}"}
        scur = db[COLL_SESSIONS].find(sessions_q, {"_id": 0})
        session_ids = []
        by_date: dict[str, dict] = {}
        async for s in scur:
            session_ids.append(s["session_id"])
            d = s.get("date") or ""
            by_date.setdefault(d, {"date": d, "present": 0, "late": 0, "absent": 0, "partial": 0})
        if not session_ids:
            return {"month": month, "class_id": class_id, "per_student": [],
                    "per_class": {}, "by_date": [], "sessions": 0}
        rcur = db[COLL_RECORDS].find({"session_id": {"$in": session_ids}}, {"_id": 0})
        per_student: dict[str, dict] = {}
        totals = {"present_full": 0, "present_partial": 0, "late": 0, "absent": 0}
        records = [r async for r in rcur]
        # map session -> date
        sdmap = {}
        async for s in db[COLL_SESSIONS].find({"session_id": {"$in": session_ids}}, {"_id": 0}):
            sdmap[s["session_id"]] = s.get("date")
        for r in records:
            sid = r.get("student_id")
            status = r.get("status") or ST_ABSENT
            ps = per_student.setdefault(sid, {"student_id": sid, "present_full": 0,
                                               "present_partial": 0, "late": 0, "absent": 0})
            if status in ps:
                ps[status] += 1
            if status in totals:
                totals[status] += 1
            d = sdmap.get(r.get("session_id")) or ""
            bd = by_date.setdefault(d, {"date": d, "present": 0, "late": 0, "absent": 0, "partial": 0})
            if status == ST_PRESENT_FULL:
                bd["present"] += 1
            elif status == ST_PRESENT_PARTIAL:
                bd["partial"] += 1
            elif status == ST_LATE:
                bd["late"] += 1
            elif status == ST_ABSENT:
                bd["absent"] += 1
        # finalize per-student rates + tier/streak
        out_students = []
        for sid, ps in per_student.items():
            attended = ps["present_full"] + ps["present_partial"] + ps["late"]
            total = attended + ps["absent"]
            on_time = ps["present_full"] + ps["present_partial"]
            streak = await db[COLL_STREAKS].find_one({"student_id": sid}, {"_id": 0}) or {}
            out_students.append({
                **ps,
                "sessions": total,
                "attendance_pct": round(100 * attended / total, 1) if total else 0.0,
                "on_time_pct": round(100 * on_time / total, 1) if total else 0.0,
                "current_streak": int(streak.get("current_streak") or 0),
                "reliability_tier": streak.get("reliability_tier") or TIER_BRONZE,
                "risk_score": streak.get("risk_score"),
            })
        out_students.sort(key=lambda x: x["student_id"])
        return {
            "month": month,
            "class_id": class_id,
            "sessions": len(session_ids),
            "per_class": totals,
            "per_student": out_students,
            "by_date": sorted(by_date.values(), key=lambda x: x["date"]),
        }

    log.info("attendance: routes registered (Constellation Check-In).")
