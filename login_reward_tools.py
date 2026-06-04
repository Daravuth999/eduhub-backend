# ===========================================================================
# login_reward_tools.py - EduHub Login Reward Campaign system
#
# Loaded via exec() into server.py's namespace (same pattern as
# payment_bridge.py / camrapidpay_payment_tools.py), so it shares:
#   api, db, log, httpx, require_admin, require_student,
#   _norm_student_id, SL_TREASURY_ID, SL_TREASURY_PASSWORD,
#   GAS_POINTS_LOGIN_URL, _fan_out_push, datetime, timezone, timedelta,
#   ObjectId, BaseModel, ConfigDict, Field, HTTPException, uuid, secrets.
#
# Feature (additive only, never touches existing modules):
#   * Admin (Author Studio) CRUD for login-reward campaigns.
#   * Student-facing endpoints to fetch the active eligible campaign and
#     to claim its reward once.
#   * Atomic single-claim guard via a unique compound index
#     (campaign_id + student_id_norm) on `login_reward_claims`.
#   * Points crediting reuses the SAME treasury -> student GAS sendPoints
#     pipeline that `/api/points/grant` already uses, so the wallet
#     migration flags and existing crediting behaviour are untouched.
#
# Design principles (per surgery brief):
#   * Backend is the source of truth: reward_points, audience and claim
#     state are NEVER trusted from the client - only campaign_id is.
#   * No new auth system - reuses require_admin / require_student.
#   * Default new campaigns are DISABLED to prevent accidental go-live.
# ===========================================================================

import re as _lrc_re
import secrets as _lrc_secrets

# JSONResponse is already imported by server.py; reuse from the shared namespace.
# If not available (defensive), fall back to a local import.
try:
    JSONResponse  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from fastapi.responses import JSONResponse  # noqa: F401

# Stale-pending takeover threshold: if a pending claim row is older than
# this many seconds, the NEXT caller can atomically take it over and retry.
# This protects students against a server interruption between the pending
# insert and the GAS credit step. Conservative default 90s — slightly above
# the GAS sendPoints timeout (12s + overhead) so genuine in-flight callers
# are never preempted.
_LRC_STALE_PENDING_SECONDS = 90

# ── collections ──────────────────────────────────────────────────────────────
_lrc_campaigns = db["login_reward_campaigns"]
_lrc_claims    = db["login_reward_claims"]
_LRC_LOG = log  # reuse server logger


# ── helpers ──────────────────────────────────────────────────────────────────
def _lrc_now():
    return datetime.now(timezone.utc)


def _lrc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _lrc_parse_iso(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Accept Z suffix and offset variants
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _lrc_norm_id_list(values) -> list[str]:
    """Normalize a list/string of student IDs into a clean list of lowercased
    canonical IDs. Tolerant of CSV strings, arrays, mixed-case inputs and
    accidental whitespace / zero-width chars."""
    if not values:
        return []
    if isinstance(values, str):
        parts = _lrc_re.split(r"[,\s]+", values)
    elif isinstance(values, (list, tuple, set)):
        parts = []
        for v in values:
            if isinstance(v, str):
                parts.extend(_lrc_re.split(r"[,\s]+", v))
            elif v is not None:
                parts.append(str(v))
    else:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        n = _norm_student_id(p)
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _lrc_campaign_status(camp: dict, now: datetime | None = None) -> str:
    """Compute a derived status for UI display only.
    Returns one of: disabled | scheduled | live | expired.
    """
    if not camp.get("enabled"):
        return "disabled"
    now = now or _lrc_now()
    start = _lrc_parse_iso(camp.get("start_at"))
    end   = _lrc_parse_iso(camp.get("end_at"))
    if start and now < start:
        return "scheduled"
    if end and now > end:
        return "expired"
    return "live"


def _lrc_eligible(camp: dict, student_norm_id: str) -> bool:
    aud = (camp.get("audience_type") or "all").lower()
    include = camp.get("include_student_ids") or []
    exclude = camp.get("exclude_student_ids") or []
    inc_norm = {_norm_student_id(x) for x in include if x}
    exc_norm = {_norm_student_id(x) for x in exclude if x}
    if student_norm_id in exc_norm:
        return False
    if aud == "all":
        return True
    if aud in ("specific_students", "specific", "include"):
        return student_norm_id in inc_norm
    if aud == "exclude_only":
        # everyone except excluded
        return student_norm_id not in exc_norm
    return False


def _lrc_serialize(camp: dict, *, with_status: bool = True) -> dict:
    if not camp:
        return camp
    out = dict(camp)
    out.pop("_id", None)
    # ensure id field exists
    if "id" not in out and "campaign_id" in out:
        out["id"] = out["campaign_id"]
    # ISO out datetimes
    for k in ("start_at", "end_at", "created_at", "updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = _lrc_iso(v)
    if with_status:
        out["status"] = _lrc_campaign_status(out)
    return out


# ── indexes (idempotent, best-effort, scheduled at FastAPI startup) ─────────
async def _lrc_ensure_indexes() -> None:
    try:
        await _lrc_campaigns.create_index("id", unique=True, sparse=True)
        await _lrc_campaigns.create_index("enabled")
        await _lrc_campaigns.create_index([("start_at", 1), ("end_at", 1)])
        # The critical single-claim guard.
        await _lrc_claims.create_index(
            [("campaign_id", 1), ("student_id_norm", 1)],
            unique=True,
            name="uniq_campaign_student",
        )
        await _lrc_claims.create_index("student_id_norm")
        await _lrc_claims.create_index("campaign_id")
        _LRC_LOG.info("login_reward_tools: indexes ensured")
    except Exception as _e:
        _LRC_LOG.warning("login_reward_tools: startup index ensure failed: %s", _e)


@app.on_event("startup")
async def _lrc_startup_indexes():
    await _lrc_ensure_indexes()


# ── pydantic models ─────────────────────────────────────────────────────────
class _LRCCampaignIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(default="Untitled campaign")
    enabled: bool = False
    notes: str | None = ""
    priority: int = 0

    start_at: str | None = None
    end_at: str | None = None
    timezone: str | None = "Asia/Phnom_Penh"

    reward_type: Literal["fixed"] = "fixed"
    reward_points: int = 20
    reward_label: str | None = ""

    audience_type: Literal["all", "specific_students", "exclude_only"] = "all"
    include_student_ids: list[str] | str | None = None
    exclude_student_ids: list[str] | str | None = None

    artwork_url: str | None = ""
    title: str = "Welcome back!"
    subtitle: str = "Claim your surprise learning points today."
    cta_text: str = "Claim Reward"
    success_message: str = "Your reward has been credited!"
    accent_color: str | None = "#D4A843"

    dismiss_mode: Literal["next_login", "after_24h", "never"] = "next_login"
    claim_limit_per_student: int = 1


def _lrc_validate_payload(p: _LRCCampaignIn) -> dict:
    """Convert + validate an inbound campaign body into a Mongo-ready dict."""
    name = (p.name or "").strip() or "Untitled campaign"
    if len(name) > 200:
        raise HTTPException(status_code=400, detail="Name too long (max 200 chars)")

    points = int(p.reward_points or 0)
    if points <= 0:
        raise HTTPException(status_code=400, detail="reward_points must be > 0")
    if points > 1000:
        raise HTTPException(status_code=400, detail="reward_points must be <= 1000")

    start_dt = _lrc_parse_iso(p.start_at) or _lrc_now()
    end_dt   = _lrc_parse_iso(p.end_at) or (start_dt + timedelta(days=7))
    if end_dt <= start_dt:
        raise HTTPException(
            status_code=400,
            detail="end_at must be strictly after start_at",
        )

    title    = (p.title or "Welcome back!").strip()
    subtitle = (p.subtitle or "").strip()
    cta_text = (p.cta_text or "Claim Reward").strip() or "Claim Reward"
    success_message = (p.success_message or "Your reward has been credited!").strip()
    artwork_url = (p.artwork_url or "").strip()
    accent_color = (p.accent_color or "#D4A843").strip() or "#D4A843"

    aud = (p.audience_type or "all").lower()
    include = _lrc_norm_id_list(p.include_student_ids)
    exclude = _lrc_norm_id_list(p.exclude_student_ids)
    if aud == "specific_students" and not include:
        raise HTTPException(
            status_code=400,
            detail="audience_type=specific_students requires include_student_ids",
        )

    claim_limit = int(p.claim_limit_per_student or 1)
    if claim_limit < 1:
        claim_limit = 1
    if claim_limit > 1:
        # Phase 1 enforces a single claim per student per campaign.
        claim_limit = 1

    return {
        "name": name,
        "enabled": bool(p.enabled),
        "notes": (p.notes or "").strip(),
        "priority": int(p.priority or 0),
        "start_at": _lrc_iso(start_dt),
        "end_at": _lrc_iso(end_dt),
        "timezone": (p.timezone or "Asia/Phnom_Penh").strip() or "Asia/Phnom_Penh",
        "reward_type": "fixed",
        "reward_points": points,
        "reward_label": (p.reward_label or "").strip(),
        "audience_type": aud,
        "include_student_ids": include,
        "exclude_student_ids": exclude,
        "artwork_url": artwork_url,
        "title": title,
        "subtitle": subtitle,
        "cta_text": cta_text,
        "success_message": success_message,
        "accent_color": accent_color,
        "dismiss_mode": (p.dismiss_mode or "next_login"),
        "claim_limit_per_student": claim_limit,
    }


# ── admin routes ────────────────────────────────────────────────────────────
@api.get("/admin/rewards/login-campaigns")
async def lrc_admin_list(admin: User = Depends(require_admin)):
    cur = _lrc_campaigns.find({}, {"_id": 0}).sort([("priority", -1), ("created_at", -1)])
    out = []
    async for doc in cur:
        out.append(_lrc_serialize(doc))
    return {"campaigns": out, "count": len(out)}


@api.post("/admin/rewards/login-campaigns")
async def lrc_admin_create(
    payload: _LRCCampaignIn,
    admin: User = Depends(require_admin),
):
    data = _lrc_validate_payload(payload)
    now_iso = _lrc_iso(_lrc_now())
    cid = "lrc_" + _lrc_secrets.token_hex(6)
    doc = {
        "id": cid,
        "campaign_id": cid,
        **data,
        "created_at": now_iso,
        "updated_at": now_iso,
        "created_by": getattr(admin, "email", "") or "",
    }
    await _lrc_campaigns.insert_one(doc)
    _LRC_LOG.info("login_reward: created %s by %s enabled=%s", cid, doc["created_by"], doc["enabled"])
    return {"success": True, "campaign": _lrc_serialize(doc)}


@api.get("/admin/rewards/login-campaigns/{campaign_id}")
async def lrc_admin_get(
    campaign_id: str,
    admin: User = Depends(require_admin),
):
    doc = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return {"campaign": _lrc_serialize(doc)}


@api.put("/admin/rewards/login-campaigns/{campaign_id}")
async def lrc_admin_update(
    campaign_id: str,
    payload: _LRCCampaignIn,
    admin: User = Depends(require_admin),
):
    existing = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Campaign not found")
    data = _lrc_validate_payload(payload)
    data["updated_at"] = _lrc_iso(_lrc_now())
    await _lrc_campaigns.update_one({"id": campaign_id}, {"$set": data})
    doc = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    _LRC_LOG.info(
        "login_reward: updated %s by %s enabled=%s",
        campaign_id, getattr(admin, "email", ""), data.get("enabled"),
    )
    return {"success": True, "campaign": _lrc_serialize(doc)}


@api.delete("/admin/rewards/login-campaigns/{campaign_id}")
async def lrc_admin_delete(
    campaign_id: str,
    admin: User = Depends(require_admin),
):
    res = await _lrc_campaigns.delete_one({"id": campaign_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Campaign not found")
    _LRC_LOG.info("login_reward: deleted %s by %s", campaign_id, getattr(admin, "email", ""))
    return {"success": True, "deleted": campaign_id}


@api.get("/admin/rewards/login-campaigns/{campaign_id}/claims")
async def lrc_admin_claims(
    campaign_id: str,
    admin: User = Depends(require_admin),
):
    cur = _lrc_claims.find({"campaign_id": campaign_id}, {"_id": 0}).sort("claimed_at", -1).limit(500)
    out = [doc async for doc in cur]
    return {"campaign_id": campaign_id, "count": len(out), "claims": out}


# ── student-facing helpers ──────────────────────────────────────────────────
async def _lrc_pick_active_for_student(student_norm_id: str) -> dict | None:
    """Return the highest-priority enabled+live campaign that the given
    student is eligible for AND has not yet claimed. None if nothing fits."""
    now = _lrc_now()
    cur = _lrc_campaigns.find(
        {"enabled": True},
        {"_id": 0},
    ).sort([("priority", -1), ("created_at", -1)])

    candidates: list[dict] = []
    async for doc in cur:
        start = _lrc_parse_iso(doc.get("start_at"))
        end = _lrc_parse_iso(doc.get("end_at"))
        if start and now < start:
            continue
        if end and now > end:
            continue
        if not _lrc_eligible(doc, student_norm_id):
            continue
        candidates.append(doc)

    if not candidates:
        return None

    # v1.2 — hide a campaign ONLY if a TRULY credited claim row exists for
    # this student. pending / failed / stale-pending rows must NOT hide the
    # campaign, so the student can still see the popup and finish/retry
    # after a refresh, crash recovery, or GAS outage.
    cids = [c["id"] for c in candidates if c.get("id")]
    credited_set: set[str] = set()
    claim_state_by_cid: dict[str, dict] = {}
    if cids:
        claim_cur = _lrc_claims.find(
            {"campaign_id": {"$in": cids}, "student_id_norm": student_norm_id},
            {"_id": 0, "campaign_id": 1, "status": 1, "claimed_at": 1, "failed_at": 1, "error": 1, "retry_count": 1},
        )
        async for cl in claim_cur:
            st = (cl.get("status") or "").lower()
            cid = cl.get("campaign_id")
            if not cid:
                continue
            if st == "credited":
                credited_set.add(cid)
            # Track the latest non-credited claim per campaign for metadata.
            claim_state_by_cid[cid] = cl

    for c in candidates:
        cid = c.get("id")
        if cid in credited_set:
            continue
        # Annotate the campaign with the student's current claim state so the
        # student endpoint can surface "pending"/"failed" UI hints without
        # leaking internal fields. The annotation is intentionally minimal.
        cl = claim_state_by_cid.get(cid)
        if cl:
            st = (cl.get("status") or "").lower()
            if st in ("pending", "failed"):
                # Decide whether the pending row is stale enough to be safely retried.
                claimed_at = _lrc_parse_iso(cl.get("claimed_at"))
                stale_threshold = now - timedelta(seconds=_LRC_STALE_PENDING_SECONDS)
                claim_status = st
                if st == "pending" and claimed_at and claimed_at < stale_threshold:
                    claim_status = "stale_pending"
                c = {**c, "_claim_status": claim_status, "_claim_retry_count": int(cl.get("retry_count") or 0)}
        return c
    return None


def _lrc_public_view(camp: dict) -> dict:
    """Strip internal fields before returning to students."""
    out = _lrc_serialize(camp)
    for k in (
        "include_student_ids", "exclude_student_ids", "notes",
        "created_by", "audience_type", "priority", "claim_limit_per_student",
    ):
        out.pop(k, None)
    # v1.2 — surface the student's per-campaign claim state in stable,
    # public-friendly field names so the popup can show "pending" / "failed"
    # hints without making a second API call.
    cs = out.pop("_claim_status", None)
    cr = out.pop("_claim_retry_count", None)
    if cs:
        out["claim_status"] = cs
        if cs in ("pending", "stale_pending"):
            out["retry_after_seconds"] = 3
        if cr is not None:
            out["claim_retry_count"] = int(cr)
    return out


@api.get("/rewards/login-campaigns/active")
async def lrc_student_active(student: Student = Depends(require_student)):
    sid_norm = _norm_student_id(getattr(student, "clean_id", "") or getattr(student, "student_id", ""))
    if not sid_norm:
        return {"campaign": None, "reason": "no_student_id"}
    camp = await _lrc_pick_active_for_student(sid_norm)
    if not camp:
        return {"campaign": None}
    return {"campaign": _lrc_public_view(camp)}


# ── claim flow ───────────────────────────────────────────────────────────────
async def _lrc_credit_via_treasury(*, student_clean_id: str, points: int,
                                   campaign_id: str, campaign_name: str) -> dict:
    """Reuse the EXACT same GAS-treasury-sendPoints path used by
    /api/points/grant. Returns {ok: bool, error?: str}.

    We do NOT touch the wallet migration flags. Source of truth for
    students remains GAS, exactly as production today.
    """
    if not SL_TREASURY_PASSWORD:
        return {"ok": False, "error": "SL_TREASURY_PASSWORD not configured"}
    if not GAS_POINTS_LOGIN_URL:
        return {"ok": False, "error": "GAS_POINTS_LOGIN_URL not configured"}

    nonce = _lrc_secrets.token_hex(12)
    gas_payload = {
        "action":     "sendPoints",
        "id":         SL_TREASURY_ID,
        "password":   SL_TREASURY_PASSWORD,
        "receiverId": student_clean_id,
        "amount":     str(int(points)),
        "nonce":      nonce,
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(GAS_POINTS_LOGIN_URL, data=gas_payload)
        if r.status_code != 200:
            return {"ok": False, "error": f"GAS HTTP {r.status_code}"}
        try:
            j = r.json()
        except Exception:
            return {"ok": False, "error": "GAS returned non-JSON"}
        if isinstance(j, dict) and j.get("success") is True:
            return {"ok": True, "gas": j}
        return {
            "ok": False,
            "error": str((j or {}).get("message") or (j or {}).get("error") or j)[:200],
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:200]}


# ── celebration push (best-effort, never blocks the claim) ──────────────────
async def _lrc_send_celebration_push(*, student_clean_id: str, student_raw_id: str,
                                     points: int, campaign_name: str) -> None:
    """Fire a celebratory OS push to the student's registered devices.

    Best-effort only: any failure is swallowed so a missing VAPID config or
    a network blip never breaks the claim response. Reuses the EXISTING
    `_fan_out_push` helper (the same one /api/points/grant uses for credit
    push), so this adds no new push infrastructure.
    """
    try:
        push_candidates: list[str] = []
        for _c in (
            student_clean_id,
            _norm_student_id(student_clean_id),
            student_raw_id,
            _norm_student_id(student_raw_id),
        ):
            if _c and _c not in push_candidates:
                push_candidates.append(_c)
        if not push_candidates:
            return
        await _fan_out_push(
            {"studentId": {"$in": push_candidates}},
            title=f"🎉 +{points} ពិន្ទុបានបន្ថែម! / Reward Claimed!",
            body=(
                f"អ្នកទទួលបាន +{points} ពិន្ទុ ✨\n"
                f"+{points} pts · {campaign_name or 'Login reward'}"
            ),
            url="/portal",
        )
    except Exception as _err:
        _LRC_LOG.warning("login_reward: celebration push error: %s", _err)


@api.post("/rewards/login-campaigns/{campaign_id}/claim")
async def lrc_student_claim(
    campaign_id: str,
    student: Student = Depends(require_student),
):
    """Claim a login-reward campaign with strong duplicate-safety semantics.

    State machine on `login_reward_claims` (one doc per campaign_id+student):
        (none)    → insert {status:"pending"} (this caller owns the credit attempt)
        pending   → another caller is mid-flight; return HTTP 202 "still processing"
                    UNLESS the row is older than _LRC_STALE_PENDING_SECONDS,
                    in which case this caller atomically takes ownership.
        failed    → previous credit attempt failed; this caller atomically
                    re-acquires the row (status flip + new attempt_id) and
                    retries the credit. No duplicate row, no duplicate credit.
        credited  → return HTTP 200 with already_claimed=true.

    The unique compound index (campaign_id + student_id_norm) keeps every
    state transition single-rowed. Duplicate-concurrent callers that try
    to take a fresh pending row will lose the find_one_and_update race and
    get the 202 path.
    """
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _norm_student_id(sid_clean)
    if not sid_norm:
        raise HTTPException(status_code=400, detail="No student identity")

    camp = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not camp:
        raise HTTPException(status_code=404, detail="Campaign not found")

    if not camp.get("enabled"):
        raise HTTPException(status_code=400, detail="Campaign is disabled")

    now = _lrc_now()
    start = _lrc_parse_iso(camp.get("start_at"))
    end = _lrc_parse_iso(camp.get("end_at"))
    if start and now < start:
        raise HTTPException(status_code=400, detail="Campaign has not started yet")
    if end and now > end:
        raise HTTPException(status_code=400, detail="Campaign has ended")

    if not _lrc_eligible(camp, sid_norm):
        raise HTTPException(status_code=403, detail="Not eligible for this campaign")

    points = int(camp.get("reward_points") or 0)
    if points <= 0:
        raise HTTPException(status_code=400, detail="Reward not configured")

    # ── duplicate-safe ownership acquisition ──────────────────────────────
    # An attempt_id binds THIS handler invocation to its row. Only the caller
    # that wrote attempt_id is allowed to flip the row to "credited"/"failed".
    attempt_id = _lrc_secrets.token_hex(12)
    now_iso = _lrc_iso(now)
    stale_threshold_iso = _lrc_iso(now - timedelta(seconds=_LRC_STALE_PENDING_SECONDS))

    # Step 1 — try to acquire (or re-acquire) the row atomically.
    # Match either:
    #   (a) status == "failed"  — previous attempt failed, safe to retry
    #   (b) status == "pending" AND claimed_at < stale_threshold — orphaned in-flight
    acquired = await _lrc_claims.find_one_and_update(
        {
            "campaign_id": campaign_id,
            "student_id_norm": sid_norm,
            "$or": [
                {"status": "failed"},
                {"status": "pending", "claimed_at": {"$lt": stale_threshold_iso}},
            ],
        },
        {
            "$set": {
                "status": "pending",
                "attempt_id": attempt_id,
                "claimed_at": now_iso,
                "points_awarded": points,
                "campaign_name": camp.get("name") or "",
                "treasury_wallet_id": _norm_student_id(SL_TREASURY_ID),
                "source": "login_reward_campaign",
            },
            "$inc": {"retry_count": 1},
            "$unset": {"failed_at": "", "error": ""},
        },
        return_document=True,  # return the updated doc
    )

    if acquired is None:
        # Step 2 — no failed/stale row to take over. Try a fresh insert.
        claim_doc = {
            "campaign_id": campaign_id,
            "student_id": sid_clean,
            "student_id_norm": sid_norm,
            "points_awarded": points,
            "claimed_at": now_iso,
            "status": "pending",
            "attempt_id": attempt_id,
            "retry_count": 0,
            "source": "login_reward_campaign",
            "treasury_wallet_id": _norm_student_id(SL_TREASURY_ID),
            "campaign_name": camp.get("name") or "",
        }
        try:
            await _lrc_claims.insert_one(claim_doc)
        except Exception:
            # Duplicate-key — an existing claim is either fresh-pending or credited.
            existing = await _lrc_claims.find_one(
                {"campaign_id": campaign_id, "student_id_norm": sid_norm},
                {"_id": 0},
            )
            if not existing:
                # Lost the race AND lost the read — surface a clean retry hint.
                _LRC_LOG.warning(
                    "login_reward: claim race with no readable doc student=%s campaign=%s",
                    sid_clean, campaign_id,
                )
                raise HTTPException(status_code=409, detail="Claim conflict, please try again")
            ex_status = (existing.get("status") or "").lower()
            if ex_status == "credited":
                return {
                    "success": True,
                    "duplicate": True,
                    "already_claimed": True,
                    "status": "credited",
                    "points_awarded": int(existing.get("points_awarded") or points),
                    "claimed_at": existing.get("credited_at") or existing.get("claimed_at"),
                    "campaign_id": campaign_id,
                    "success_message": camp.get("success_message") or "Reward already credited.",
                }
            if ex_status == "pending":
                # Another in-flight caller still owns the row. Tell client to retry shortly.
                _LRC_LOG.info(
                    "login_reward: pending in-flight student=%s campaign=%s",
                    sid_clean, campaign_id,
                )
                return JSONResponse(
                    status_code=202,
                    content={
                        "success": False,
                        "status": "pending",
                        "campaign_id": campaign_id,
                        "detail": "Reward claim is still processing. Please try again shortly.",
                        "retry_after_seconds": 3,
                    },
                )
            # Any other status (defensive) — refuse and surface for inspection.
            _LRC_LOG.warning(
                "login_reward: unexpected claim status student=%s campaign=%s status=%s",
                sid_clean, campaign_id, ex_status,
            )
            raise HTTPException(status_code=409, detail=f"Claim in unexpected state: {ex_status or 'unknown'}")

    # ── At this point THIS handler owns the credit attempt. attempt_id is
    #    the proof of ownership for the finalising update.

    credit = await _lrc_credit_via_treasury(
        student_clean_id=sid_clean,
        points=points,
        campaign_id=campaign_id,
        campaign_name=camp.get("name") or "",
    )

    if not credit.get("ok"):
        # Mark the claim as failed (do NOT delete — keep audit trail and
        # allow safe retry via the failed-acquisition branch above). The
        # attempt_id filter ensures we only mutate OUR row.
        try:
            await _lrc_claims.update_one(
                {
                    "campaign_id": campaign_id,
                    "student_id_norm": sid_norm,
                    "attempt_id": attempt_id,
                    "status": "pending",
                },
                {
                    "$set": {
                        "status": "failed",
                        "failed_at": _lrc_iso(_lrc_now()),
                        "error": str(credit.get("error") or "unknown")[:300],
                    },
                },
            )
        except Exception as _mfe:
            _LRC_LOG.warning("login_reward: mark-failed update error: %s", _mfe)
        _LRC_LOG.warning(
            "login_reward: GAS credit failed for %s campaign=%s err=%s",
            sid_clean, campaign_id, credit.get("error"),
        )
        raise HTTPException(
            status_code=502,
            detail=f"Points credit failed: {credit.get('error') or 'unknown'}",
        )

    # ── finalize: ONLY OUR attempt may flip pending → credited ──────────
    finalize_iso = _lrc_iso(_lrc_now())
    finalized = await _lrc_claims.update_one(
        {
            "campaign_id": campaign_id,
            "student_id_norm": sid_norm,
            "attempt_id": attempt_id,
            "status": "pending",
        },
        {
            "$set": {
                "status": "credited",
                "credited_at": finalize_iso,
            },
        },
    )

    if finalized.modified_count == 0:
        # Someone else (a concurrent retry that found us stale) raced and
        # already finalised. We've therefore caused a SECOND GAS credit on
        # this student — record a duplicate-credit warning row so operators
        # can reconcile. This should be statistically impossible unless the
        # stale-pending threshold is misconfigured to be very small.
        _LRC_LOG.error(
            "login_reward: finalize lost race — possible duplicate credit "
            "student=%s campaign=%s attempt=%s points=%d",
            sid_clean, campaign_id, attempt_id, points,
        )
        try:
            await db.login_reward_claims.update_one(
                {"campaign_id": campaign_id, "student_id_norm": sid_norm},
                {
                    "$push": {
                        "duplicate_credit_warnings": {
                            "attempt_id": attempt_id,
                            "points": points,
                            "at": finalize_iso,
                            "gas": credit.get("gas") or {},
                        }
                    }
                },
            )
        except Exception:
            pass
        # Still return success because GAS DID credit the student, so the
        # client truth matches the wallet. The dup warning row is for ops.
        return {
            "success": True,
            "duplicate": False,
            "status": "credited",
            "points_awarded": points,
            "campaign_id": campaign_id,
            "claimed_at": finalize_iso,
            "success_message": camp.get("success_message") or "Reward credited.",
            "warning": "duplicate_credit_race",
        }

    # Best-effort audit row in the EXISTING points_history collection.
    try:
        await db.points_history.insert_one({
            "student_id":         sid_clean,
            "from":               SL_TREASURY_ID,
            "to":                 sid_clean,
            "delta":              points,
            "source":             "login_reward",
            "description":        f"Login reward · {camp.get('name') or campaign_id}",
            "granted_by":         "login_reward_campaign",
            "created_at":         finalize_iso,
            "senderStudentId":    SL_TREASURY_ID,
            "recipientStudentId": sid_clean,
            "amount":             points,
            "display_sender":     "Treasury",
            "campaign_id":        campaign_id,
        })
    except Exception as _ph_err:
        _LRC_LOG.warning("login_reward: points_history insert failed: %s", _ph_err)

    # ── celebration push (best-effort, never raises into the response) ──
    try:
        await _lrc_send_celebration_push(
            student_clean_id=sid_clean,
            student_raw_id=getattr(student, "student_id", "") or sid_clean,
            points=points,
            campaign_name=camp.get("name") or "Login reward",
        )
    except Exception as _push_err:
        _LRC_LOG.warning("login_reward: celebration push failed: %s", _push_err)

    _LRC_LOG.info(
        "login_reward: credited student=%s campaign=%s points=%d attempt=%s",
        sid_clean, campaign_id, points, attempt_id,
    )

    return {
        "success": True,
        "duplicate": False,
        "status": "credited",
        "points_awarded": points,
        "campaign_id": campaign_id,
        "claimed_at": finalize_iso,
        "success_message": camp.get("success_message") or "Reward credited.",
    }
