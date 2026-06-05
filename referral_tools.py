# ===========================================================================
# referral_tools.py - EduHub Referral System v1
#
# Loaded via exec() into server.py's namespace (same pattern as
# payment_bridge.py / camrapidpay_payment_tools.py / login_reward_tools.py),
# so it shares:
#   api, db, log, httpx, require_admin, require_student,
#   _norm_student_id, BaseModel, ConfigDict, Field, HTTPException, datetime,
#   timezone, timedelta, uuid, secrets, asyncio.
#
# Feature (additive only, never touches existing modules):
#   * Lazy referral-code generation (one stable code per student)
#   * Public referral-lead capture endpoint (NO public account creation)
#   * Admin CRUD for referral config + leads + reward history
#   * Automatic referrer reward AFTER an existing confirmed points purchase
#     of >= the configured minimum USD threshold (currently $1.25)
#   * Admin-safe manual class-payment confirmation that runs the same
#     idempotent reward path (no fragile auto class detection)
#   * Monthly cap enforced server-side
#   * Reward is double-credit safe via a unique idempotency_key index and
#     atomic insert-or-skip semantics
#   * Feature defaults to OFF — no rewards are credited until admin enables
#
# Design principles (per brief):
#   * Backend is the source of truth — reward_points / monthly_cap /
#     minimum_payment_usd / qualifying_trigger are never trusted from the
#     client.
#   * NO public self-registration. Lead submission only stores a lead
#     document; admin must create the student account separately.
#   * Reuses existing require_admin / require_student deps — no new auth.
#   * Uses the same treasury -> student GAS sendPoints pipeline that
#     /api/points/grant + login_reward_tools.py already use, so wallet
#     migration flags and existing crediting behaviour are untouched.
#   * Default new config: enabled=false. Until an admin flips this, no
#     reward path can credit anyone.
# ===========================================================================

import os as _ref_os
import re as _ref_re
import secrets as _ref_secrets
import string as _ref_string
import logging as _ref_logging

# `JSONResponse` is already imported by server.py; defensive fallback.
try:
    JSONResponse  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from fastapi.responses import JSONResponse  # noqa: F401

_REF_LOG = _ref_logging.getLogger("eduhub.referral")

# ── collections ──────────────────────────────────────────────────────────────
_ref_codes    = db["referral_codes"]
_ref_leads    = db["referral_leads"]
_ref_rewards  = db["referral_rewards"]
_ref_config   = db["referral_config"]

# ── public share URL base (frontend host) ───────────────────────────────────
# Lives in env so we can move host without code changes. Falls back to the
# current Vercel test host listed in the brief.
_REF_SHARE_BASE = _ref_os.environ.get(
    "REFERRAL_SHARE_BASE_URL",
    "https://eduhub-studio-test.vercel.app",
).rstrip("/")


# ── default singleton config (feature OFF) ───────────────────────────────────
def _ref_default_config() -> dict:
    return {
        "enabled": False,
        "show_dashboard_card": True,
        "reward_type": "points",
        "reward_points": 20,
        "minimum_payment_usd": 1.25,
        "qualifying_trigger": "both",   # class | points | both
        "monthly_cap": 10,
        "referral_display_message": "Invite friends and earn points",
        "terms_message": (
            "Reward is credited after your invited friend joins class or "
            "buys at least $1.25 in points."
        ),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": "system",
    }


async def _ref_get_config() -> dict:
    doc = await _ref_config.find_one({"_id": "singleton"}, {"_id": 0})
    if not doc:
        defaults = _ref_default_config()
        try:
            await _ref_config.insert_one({"_id": "singleton", **defaults})
        except Exception as _exc:  # noqa: BLE001
            _REF_LOG.warning("referral: failed to seed default config: %s", _exc)
        return defaults
    merged = _ref_default_config()
    merged.update(doc)
    return merged


# ── code generator: 8 chars, upper + digits, ambiguous chars removed ────────
_REF_ALPHABET = "".join(
    c for c in (_ref_string.ascii_uppercase + _ref_string.digits)
    if c not in "O0I1L"
)


def _ref_generate_code(n: int = 8) -> str:
    return "".join(_ref_secrets.choice(_REF_ALPHABET) for _ in range(n))


async def _ref_ensure_indexes() -> None:
    try:
        await _ref_codes.create_index("student_id_norm", unique=True)
        await _ref_codes.create_index("code", unique=True)
        await _ref_leads.create_index("referral_code")
        await _ref_leads.create_index("referrer_id_norm")
        await _ref_leads.create_index("status")
        await _ref_leads.create_index([("created_at", -1)])
        await _ref_rewards.create_index("idempotency_key", unique=True)
        await _ref_rewards.create_index("referrer_id_norm")
        await _ref_rewards.create_index("status")
        await _ref_rewards.create_index("referral_lead_id")
        await _ref_rewards.create_index("referred_student_id_norm")
        _REF_LOG.info("referral: indexes ensured")
    except Exception as _exc:  # noqa: BLE001
        _REF_LOG.warning("referral: index creation skipped: %s", _exc)


# Fire-and-forget index creation on import. Mongo errors here must never
# break the rest of the app.
try:
    import asyncio as _ref_asyncio
    _ref_asyncio.create_task(_ref_ensure_indexes())
except Exception as _exc:  # noqa: BLE001
    _REF_LOG.warning("referral: could not schedule index task: %s", _exc)


# ── lazy code lookup / creation for a logged-in student ─────────────────────
async def _ref_get_or_create_code(student) -> dict:
    sid = (student.student_id or "").strip()
    norm = _norm_student_id(sid)
    if not norm:
        raise HTTPException(status_code=400, detail="Invalid student identity")

    existing = await _ref_codes.find_one({"student_id_norm": norm}, {"_id": 0})
    if existing and existing.get("code"):
        return existing

    # Try up to 6 times to dodge an unlikely collision on the unique index.
    for _ in range(6):
        code = _ref_generate_code()
        try:
            doc = {
                "student_id":      sid,
                "student_id_norm": norm,
                "code":            code,
                "created_at":      datetime.now(timezone.utc).isoformat(),
                "active":          True,
            }
            await _ref_codes.insert_one(doc)
            return doc
        except Exception:  # duplicate key — retry
            continue
    raise HTTPException(status_code=500, detail="Could not allocate referral code")


def _ref_build_share_url(code: str) -> str:
    return f"{_REF_SHARE_BASE}/?ref={code}"


# ── monthly cap helper ──────────────────────────────────────────────────────
def _ref_month_window():
    now = datetime.now(timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return start.isoformat(), now.isoformat()


async def _ref_monthly_count(referrer_norm: str) -> int:
    start_iso, _ = _ref_month_window()
    return await _ref_rewards.count_documents({
        "referrer_id_norm": referrer_norm,
        "status":           "rewarded",
        "rewarded_at":      {"$gte": start_iso},
    })


# ── reward credit (uses existing treasury → student GAS sendPoints) ─────────
async def _ref_credit_referrer_points(
    *,
    referrer_clean_id: str,
    points: int,
    description: str,
) -> tuple[bool, str]:
    """Credit referrer points using the existing GAS sendPoints path.

    Mirrors the proven flow already used by payment_bridge._complete_points_payment
    and login_reward_tools._lrc_credit_points. Returns (ok, message).
    """
    if not SL_TREASURY_PASSWORD:
        return False, "SL_TREASURY_PASSWORD not configured"

    nonce = _ref_secrets.token_hex(12)
    payload = {
        "action":     "sendPoints",
        "id":         SL_TREASURY_ID,
        "password":   SL_TREASURY_PASSWORD,
        "receiverId": referrer_clean_id,
        "amount":     str(int(points)),
        "nonce":      nonce,
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(GAS_POINTS_LOGIN_URL, data=payload)
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}"
        j = r.json() if r.content else {}
        if isinstance(j, dict) and j.get("success") is True:
            # Mirror the points_history audit row used elsewhere.
            try:
                await db.points_history.insert_one({
                    "student_id":  referrer_clean_id,
                    "from":        SL_TREASURY_ID,
                    "to":          referrer_clean_id,
                    "delta":       int(points),
                    "source":      "referral-reward",
                    "description": description,
                    "granted_by":  "referral_tools",
                    "created_at":  datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
            return True, "ok"
        return False, str(j.get("message") or j.get("error") or j)[:200]
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:200]


# ── core qualification / reward routine (idempotent + monthly-cap gated) ────
async def _ref_qualify_and_reward(
    *,
    lead_doc: dict,
    qualifying_payment_type: str,    # "class" | "points"
    qualifying_payment_amount_usd: float,
    payment_reference: str,
    referred_student_id: str | None = None,
) -> dict:
    """Run the gated reward pipeline for a single referral lead.

    Returns a dict with at least {"ok": bool, "reason": str}. Always idempotent:
    a unique idempotency_key on referral_rewards prevents double-credit even
    under repeated calls or webhook retries.

    Safety gates (in order):
      1. Config enabled
      2. Trigger type matches (class / points / both)
      3. Payment amount >= minimum_payment_usd
      4. Lead has a referrer and a referral_code
      5. No self-referral (referred student != referrer)
      6. Referrer monthly cap not exceeded
      7. Idempotency key not already used
    Any failure short-circuits and never credits.
    """
    cfg = await _ref_get_config()

    if not cfg.get("enabled"):
        return {"ok": False, "reason": "referral_disabled"}

    trigger = (cfg.get("qualifying_trigger") or "both").strip().lower()
    if trigger not in ("class", "points", "both"):
        trigger = "both"
    if qualifying_payment_type == "class" and trigger not in ("class", "both"):
        return {"ok": False, "reason": "class_trigger_disabled"}
    if qualifying_payment_type == "points" and trigger not in ("points", "both"):
        return {"ok": False, "reason": "points_trigger_disabled"}

    try:
        min_usd = float(cfg.get("minimum_payment_usd") or 0)
    except Exception:
        min_usd = 0.0
    try:
        amount_usd = float(qualifying_payment_amount_usd or 0)
    except Exception:
        amount_usd = 0.0
    if amount_usd <= 0 or amount_usd + 1e-6 < min_usd:
        return {"ok": False, "reason": "below_min_amount"}

    referrer_id = (lead_doc.get("referrer_id") or "").strip()
    referrer_norm = (lead_doc.get("referrer_id_norm") or _norm_student_id(referrer_id))
    referral_code = (lead_doc.get("referral_code") or "").strip()
    if not referrer_id or not referrer_norm or not referral_code:
        return {"ok": False, "reason": "no_referrer"}

    if referred_student_id and _norm_student_id(referred_student_id) == referrer_norm:
        return {"ok": False, "reason": "self_referral"}

    monthly_cap = int(cfg.get("monthly_cap") or 0)
    if monthly_cap > 0:
        used = await _ref_monthly_count(referrer_norm)
        if used >= monthly_cap:
            return {"ok": False, "reason": "monthly_cap_reached"}

    # Idempotency key: stable across retries. Includes type + reference +
    # lead id so the same payment can never credit twice and two distinct
    # qualifying events for the same lead also cannot double-credit.
    lead_id = str(lead_doc.get("_id") or lead_doc.get("id") or "")
    idem_key = f"ref:{qualifying_payment_type}:{lead_id}:{payment_reference}"

    reward_points = int(cfg.get("reward_points") or 0)
    if reward_points <= 0:
        return {"ok": False, "reason": "reward_points_zero"}

    # One-invited-person rule: never reward twice for the same lead, even
    # if a new payment_reference arrives later.
    already = await _ref_rewards.find_one(
        {"referral_lead_id": lead_id, "status": "rewarded"},
        {"_id": 1},
    )
    if already:
        return {"ok": False, "reason": "already_rewarded"}

    now_iso = datetime.now(timezone.utc).isoformat()
    pending_doc = {
        "referrer_id":              referrer_id,
        "referrer_id_norm":         referrer_norm,
        "referred_student_id":      referred_student_id or "",
        "referred_student_id_norm": _norm_student_id(referred_student_id or ""),
        "referral_lead_id":         lead_id,
        "referral_code":            referral_code,
        "qualifying_payment_type":  qualifying_payment_type,
        "qualifying_payment_amount": amount_usd,
        "reward_points":            reward_points,
        "status":                   "pending",
        "idempotency_key":          idem_key,
        "created_at":               now_iso,
        "payment_reference":        payment_reference,
    }

    # Atomic claim of the idempotency key. If the unique index rejects, we
    # have already processed this exact event — short-circuit cleanly.
    try:
        ins = await _ref_rewards.insert_one(pending_doc)
        reward_id = ins.inserted_id
    except Exception as _dup_exc:  # noqa: BLE001
        _REF_LOG.info(
            "referral: idempotency hit — skipping duplicate credit (%s)",
            idem_key,
        )
        return {"ok": False, "reason": "idempotent_skip"}

    # Resolve referrer clean_id (referrer_id may already be clean_id or full).
    stu_doc = await db.students.find_one(
        {"$or": [
            {"student_id":      referrer_id},
            {"clean_id":        referrer_id},
            {"student_id_norm": referrer_norm},
        ]},
        {"clean_id": 1, "_id": 0},
    )
    referrer_clean_id = (stu_doc or {}).get("clean_id") or referrer_id

    ok, reason = await _ref_credit_referrer_points(
        referrer_clean_id=referrer_clean_id,
        points=reward_points,
        description="Referral reward: qualified invited user",
    )

    if not ok:
        await _ref_rewards.update_one(
            {"_id": reward_id},
            {"$set": {"status": "rejected", "reject_reason": reason}},
        )
        return {"ok": False, "reason": f"credit_failed:{reason}"}

    rewarded_at = datetime.now(timezone.utc).isoformat()
    await _ref_rewards.update_one(
        {"_id": reward_id},
        {"$set": {"status": "rewarded", "rewarded_at": rewarded_at}},
    )
    await _ref_leads.update_one(
        {"_id": lead_doc.get("_id")},
        {"$set": {
            "status":     "rewarded",
            "updated_at": rewarded_at,
        }},
    )

    # Optional non-blocking push (only if the global helper exists in the
    # server.py namespace). NEVER mutates the service worker.
    try:
        _fan_out = globals().get("_fan_out_push")
        if _fan_out and referrer_clean_id:
            await _fan_out(
                student_clean_id=referrer_clean_id,
                title="Referral reward earned",
                body=f"+{reward_points} PTS — a friend you invited just qualified.",
                data={"kind": "referral_reward"},
            )
    except Exception:
        pass

    _REF_LOG.info(
        "referral: rewarded %s with %d PTS (lead=%s, type=%s, amount=%.2f)",
        referrer_clean_id, reward_points, lead_id, qualifying_payment_type, amount_usd,
    )
    return {"ok": True, "reason": "rewarded", "reward_points": reward_points}


# ──────────────────────────────────────────────────────────────────────────
# Public hook used by payment_bridge.py after a confirmed points purchase.
# Exposed via globals() so the additive hook in payment_bridge can pick it
# up at runtime without import order issues. NEVER raises.
# ──────────────────────────────────────────────────────────────────────────
async def _referral_on_points_purchase_success(
    *,
    clean_id: str,
    amount_usd: float,
    payment_reference: str,
) -> None:
    try:
        if not clean_id or not payment_reference:
            return
        norm = _norm_student_id(clean_id)
        # Find the most recent qualifying lead linked to this student, if any.
        lead = await _ref_leads.find_one(
            {"$or": [
                {"linked_student_id":      clean_id},
                {"linked_student_id_norm": norm},
            ]},
            sort=[("created_at", -1)],
        )
        if not lead:
            return
        await _ref_qualify_and_reward(
            lead_doc=lead,
            qualifying_payment_type="points",
            qualifying_payment_amount_usd=float(amount_usd or 0),
            payment_reference=str(payment_reference or ""),
            referred_student_id=clean_id,
        )
    except Exception as _exc:  # noqa: BLE001
        _REF_LOG.warning("referral: points-purchase hook error (non-fatal): %s", _exc)


# Publish the hook to the shared namespace so payment_bridge.py can call it.
globals()["_referral_on_points_purchase_success"] = _referral_on_points_purchase_success


# ===========================================================================
# STUDENT-FACING ROUTES
# ===========================================================================

@api.get("/referral/my-code")
async def referral_my_code(student: Student = Depends(require_student)):
    cfg = await _ref_get_config()
    doc = await _ref_get_or_create_code(student)
    code = doc.get("code") or ""
    return {
        "code":      code,
        "share_url": _ref_build_share_url(code),
        "enabled":   bool(cfg.get("enabled")),
        "show_card": bool(cfg.get("show_dashboard_card", True)),
    }


@api.get("/referral/stats")
async def referral_stats(student: Student = Depends(require_student)):
    cfg = await _ref_get_config()
    doc = await _ref_get_or_create_code(student)
    code = doc.get("code") or ""
    norm = doc.get("student_id_norm")

    pending = await _ref_leads.count_documents({
        "referrer_id_norm": norm,
        "status":           {"$in": ["new", "contacted", "paid", "account_created"]},
    })
    qualified = await _ref_rewards.count_documents({
        "referrer_id_norm": norm,
        "status":           "rewarded",
    })
    total_pts_doc = await _ref_rewards.aggregate([
        {"$match": {"referrer_id_norm": norm, "status": "rewarded"}},
        {"$group": {"_id": None, "sum": {"$sum": "$reward_points"}}},
    ]).to_list(length=1)
    total_points = int((total_pts_doc[0] or {}).get("sum") or 0) if total_pts_doc else 0

    monthly_used = await _ref_monthly_count(norm)

    return {
        "code":               code,
        "share_url":          _ref_build_share_url(code),
        "pending_count":      int(pending),
        "qualified_count":    int(qualified),
        "total_points":       int(total_points),
        "monthly_used":       int(monthly_used),
        "monthly_cap":        int(cfg.get("monthly_cap") or 0),
        "reward_points":      int(cfg.get("reward_points") or 0),
        "minimum_payment_usd": float(cfg.get("minimum_payment_usd") or 0),
        "enabled":            bool(cfg.get("enabled")),
        "show_card":          bool(cfg.get("show_dashboard_card", True)),
        "display_message":    cfg.get("referral_display_message") or "",
        "terms_message":      cfg.get("terms_message") or "",
    }


class _RefLeadIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    referral_code: str
    name:          str
    contact:       str
    interest:      str = "class"  # "class" | "app_only"


@api.post("/referral/leads")
async def referral_create_lead(payload: _RefLeadIn):
    """Public lead capture. NEVER creates a student account."""
    cfg = await _ref_get_config()
    if not cfg.get("enabled"):
        raise HTTPException(status_code=403, detail="Referral program is currently paused")

    code = (payload.referral_code or "").strip().upper()
    name = (payload.name or "").strip()
    contact = (payload.contact or "").strip()
    interest = (payload.interest or "class").strip().lower()
    if interest not in ("class", "app_only"):
        interest = "class"

    if not code or not name or not contact:
        raise HTTPException(status_code=400, detail="referral_code, name and contact are required")
    if not _ref_re.match(r"^[A-Z0-9]{4,16}$", code):
        raise HTTPException(status_code=400, detail="Invalid referral code format")

    code_doc = await _ref_codes.find_one({"code": code, "active": {"$ne": False}}, {"_id": 0})
    if not code_doc:
        raise HTTPException(status_code=404, detail="Referral code not found")

    # Soft duplicate-suppression: same code + same contact within 24h.
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    dup = await _ref_leads.find_one({
        "referral_code": code,
        "contact":       contact,
        "created_at":    {"$gte": cutoff},
    })
    if dup:
        return {"ok": True, "status": "duplicate", "lead_id": str(dup.get("_id"))}

    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "referral_code":     code,
        "referrer_id":       code_doc.get("student_id") or "",
        "referrer_id_norm":  code_doc.get("student_id_norm") or "",
        "name":              name[:120],
        "contact":           contact[:160],
        "interest":          interest,
        "status":            "new",
        "linked_student_id": "",
        "linked_student_id_norm": "",
        "created_at":        now_iso,
        "updated_at":        now_iso,
    }
    ins = await _ref_leads.insert_one(doc)
    return {"ok": True, "lead_id": str(ins.inserted_id), "status": "new"}


# ===========================================================================
# ADMIN ROUTES
# ===========================================================================

@api.get("/admin/referral/config")
async def admin_referral_config_get(admin: User = Depends(require_admin)):
    cfg = await _ref_get_config()
    return cfg


class _RefConfigIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled:             bool | None = None
    show_dashboard_card: bool | None = None
    reward_type:         str  | None = None
    reward_points:       int  | None = None
    minimum_payment_usd: float | None = None
    qualifying_trigger:  str  | None = None
    monthly_cap:         int  | None = None
    referral_display_message: str | None = None
    terms_message:       str  | None = None


@api.post("/admin/referral/config")
async def admin_referral_config_set(
    payload: _RefConfigIn,
    admin: User = Depends(require_admin),
):
    fields: dict = {}
    if payload.enabled is not None:             fields["enabled"] = bool(payload.enabled)
    if payload.show_dashboard_card is not None: fields["show_dashboard_card"] = bool(payload.show_dashboard_card)
    if payload.reward_type is not None:
        rt = (payload.reward_type or "").strip().lower()
        if rt not in ("points",):
            raise HTTPException(status_code=400, detail="reward_type must be 'points' in v1")
        fields["reward_type"] = rt
    if payload.reward_points is not None:
        if int(payload.reward_points) < 0:
            raise HTTPException(status_code=400, detail="reward_points must be >= 0")
        fields["reward_points"] = int(payload.reward_points)
    if payload.minimum_payment_usd is not None:
        if float(payload.minimum_payment_usd) < 0:
            raise HTTPException(status_code=400, detail="minimum_payment_usd must be >= 0")
        fields["minimum_payment_usd"] = float(payload.minimum_payment_usd)
    if payload.qualifying_trigger is not None:
        qt = (payload.qualifying_trigger or "").strip().lower()
        if qt not in ("class", "points", "both"):
            raise HTTPException(status_code=400, detail="qualifying_trigger must be class|points|both")
        fields["qualifying_trigger"] = qt
    if payload.monthly_cap is not None:
        if int(payload.monthly_cap) < 0:
            raise HTTPException(status_code=400, detail="monthly_cap must be >= 0")
        fields["monthly_cap"] = int(payload.monthly_cap)
    if payload.referral_display_message is not None:
        fields["referral_display_message"] = str(payload.referral_display_message)[:200]
    if payload.terms_message is not None:
        fields["terms_message"] = str(payload.terms_message)[:400]

    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    fields["updated_by"] = getattr(admin, "email", None) or getattr(admin, "id", "admin")

    await _ref_config.update_one(
        {"_id": "singleton"},
        {"$set": fields, "$setOnInsert": _ref_default_config()},
        upsert=True,
    )
    return await _ref_get_config()


@api.get("/admin/referral/leads")
async def admin_referral_leads_list(
    admin: User = Depends(require_admin),
    status: str | None = None,
    limit: int = 200,
):
    q: dict = {}
    if status:
        q["status"] = status
    limit = max(1, min(int(limit or 200), 500))
    rows = await _ref_leads.find(q).sort("created_at", -1).to_list(length=limit)
    for r in rows:
        r["id"] = str(r.pop("_id"))
    return {"items": rows, "count": len(rows)}


class _RefLeadPatch(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status:                str | None = None
    contact:               str | None = None
    linked_student_id:     str | None = None
    note:                  str | None = None


@api.put("/admin/referral/leads/{lead_id}")
async def admin_referral_lead_update(
    lead_id: str,
    payload: _RefLeadPatch,
    admin: User = Depends(require_admin),
):
    try:
        oid = ObjectId(lead_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid lead id")
    doc = await _ref_leads.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Lead not found")

    fields: dict = {}
    allowed_status = {
        "new", "contacted", "paid", "account_created",
        "rewarded", "rejected", "duplicate",
    }
    if payload.status is not None:
        st = (payload.status or "").strip().lower()
        if st not in allowed_status:
            raise HTTPException(status_code=400, detail="Invalid status value")
        fields["status"] = st
    if payload.contact is not None:
        fields["contact"] = str(payload.contact)[:160]
    if payload.linked_student_id is not None:
        sid = (payload.linked_student_id or "").strip()
        fields["linked_student_id"]      = sid
        fields["linked_student_id_norm"] = _norm_student_id(sid)
    if payload.note is not None:
        fields["admin_note"] = str(payload.note)[:500]

    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    fields["updated_by"] = getattr(admin, "email", None) or getattr(admin, "id", "admin")

    await _ref_leads.update_one({"_id": oid}, {"$set": fields})
    out = await _ref_leads.find_one({"_id": oid})
    if out:
        out["id"] = str(out.pop("_id"))
    return out


class _RefManualClassConfirm(BaseModel):
    model_config = ConfigDict(extra="ignore")
    payment_amount_usd: float
    payment_reference:  str | None = None
    note:               str | None = None


@api.post("/admin/referral/leads/{lead_id}/mark-class-paid")
async def admin_referral_mark_class_paid(
    lead_id: str,
    payload: _RefManualClassConfirm,
    admin: User = Depends(require_admin),
):
    """Admin-safe manual class-payment confirmation.

    Triggers the same idempotent reward pipeline used by the automatic
    points-purchase hook. Repeated calls are safe — the unique
    idempotency_key prevents double-credit.
    """
    try:
        oid = ObjectId(lead_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid lead id")
    lead = await _ref_leads.find_one({"_id": oid})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    ref = (payload.payment_reference or f"manual-class:{lead_id}").strip()
    res = await _ref_qualify_and_reward(
        lead_doc=lead,
        qualifying_payment_type="class",
        qualifying_payment_amount_usd=float(payload.payment_amount_usd or 0),
        payment_reference=ref,
        referred_student_id=lead.get("linked_student_id") or None,
    )

    note_extras: dict = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": getattr(admin, "email", None) or "admin",
    }
    if res.get("ok"):
        note_extras["status"] = "rewarded"
    else:
        # If not rewarded but admin confirmed payment, at least mark "paid"
        # unless the lead is already in a later state.
        cur_status = (lead.get("status") or "").lower()
        if cur_status in ("new", "contacted"):
            note_extras["status"] = "paid"
    if payload.note:
        note_extras["admin_note"] = str(payload.note)[:500]
    await _ref_leads.update_one({"_id": oid}, {"$set": note_extras})

    return {"ok": bool(res.get("ok")), "reason": res.get("reason"), "lead_id": lead_id}


@api.get("/admin/referral/rewards")
async def admin_referral_rewards_list(
    admin: User = Depends(require_admin),
    status: str | None = None,
    limit: int = 200,
):
    q: dict = {}
    if status:
        q["status"] = status
    limit = max(1, min(int(limit or 200), 500))
    rows = await _ref_rewards.find(q).sort("created_at", -1).to_list(length=limit)
    for r in rows:
        r["id"] = str(r.pop("_id"))
    return {"items": rows, "count": len(rows)}


_REF_LOG.info("referral_tools: registered routes (default config = OFF)")
