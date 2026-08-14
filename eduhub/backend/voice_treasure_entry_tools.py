"""voice_treasure_entry_tools.py
================================
Voice Treasure — Phase 3: paid mission access and recovery (GAS-authoritative).

Adds the "paid mission access" milestone ONLY. No recorder, no Gemini
evaluation, no chest, no reward payout UI. Points authority is GAS, via the
isolated ``voice_treasure_points_adapter``. This module never imports
premium_ai_tools / wallet_service / payment_bridge, and never touches Mongo
points_wallets.

Mounted by
``register_voice_treasure_entry_routes(api, db, require_admin, require_student)``.

Student routes
--------------
  GET  /api/voice-treasure/today                  → today's mission offer + cost
  POST /api/voice-treasure/entry/confirm          → preview balance (confirm=false)
                                                     or at-most-once debit (confirm=true)
  GET  /api/voice-treasure/entry/{entry_id}        → recover an entry's state

Admin routes
------------
  GET  /api/admin/voice-treasure/entries
  GET  /api/admin/voice-treasure/entries/{entry_id}
  GET  /api/admin/voice-treasure/reconciliation    → ambiguous entries queue

Collections (owned here)
------------------------
  voice_treasure_missions   _id = vt-mission:{student_id}:{date}
  voice_treasure_entries    _id = vt-entry:{student_id}:{date}:{mission_id}

ENTRY STATE MACHINE
-------------------
  created → initiating → succeeded
                       → confirmed_failed            (retryable: GAS rejected,
                                                       or insufficient balance)
                       → needs_manual_reconciliation  (ambiguous: never auto-retry)
  confirmed_failed / refunded_or_restored → (new controlled attempt) → initiating

At-most-once concurrent initiation per controlled operation: confirmed
non-transfer outcomes (GAS rejection) may be explicitly retried by a new
student-confirmed POST (each retry gets a fresh operation id), while ambiguous
outcomes are permanently blocked from automatic retry and require manual
reconciliation. This is NOT a single lifetime initiation.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from pymongo import ReturnDocument

# Own modules only — never premium_ai_tools / wallet_service / payment_bridge.
import voice_treasure_config_tools as vt_cfg
import voice_treasure_points_adapter as vt_points

log = logging.getLogger("eduhub.voice_treasure.entry")

COLL_MISSIONS = "voice_treasure_missions"
COLL_ENTRIES = "voice_treasure_entries"

# Entry states
S_CREATED = "created"
S_INITIATING = "initiating"
S_SUCCEEDED = "succeeded"
S_RECONCILE = "needs_manual_reconciliation"
S_FAILED = "confirmed_failed"
S_RESTORED = "refunded_or_restored"

# States from which a NEW controlled attempt may begin.
_RETRYABLE = {S_FAILED, S_RESTORED}
# States that consume a completed-play allowance (daily limit). Only a
# confirmed paid play counts. Preview, initiating, confirmed_failed, and
# needs_manual_reconciliation NEVER count. Future paid/playable states derived
# from `succeeded` (e.g. an evaluated/claimed play) should be added here.
QUALIFYING_DAILY_STATES = {S_SUCCEEDED}
# Approved fallback mission (Phase 3 uses fallback only; Gemini is Phase 4).
FALLBACK_IMAGE_REF = "vt-fallback-default"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _mission_id_for(date: str) -> str:
    # One mission per student per day in Phase 3 (fallback). Stable per date.
    return f"m-{date}"


def _mission_key(sid: str, date: str) -> str:
    return f"vt-mission:{sid}:{date}"


def _entry_key(sid: str, date: str, mission_id: str) -> str:
    return f"vt-entry:{sid}:{date}:{mission_id}"


# --------------------------------------------------------------------------- #
# Indexes                                                                      #
# --------------------------------------------------------------------------- #
async def ensure_voice_treasure_entry_indexes(db) -> None:
    try:
        await db[COLL_ENTRIES].create_index([("student_id", 1), ("mission_date", 1)])
        await db[COLL_ENTRIES].create_index([("state", 1), ("updated_at", -1)])
        await db[COLL_MISSIONS].create_index([("student_id", 1), ("date", 1)])
    except Exception as exc:  # noqa: BLE001 — never fatal at startup
        log.warning("voice_treasure: entry index ensure failed (non-fatal): %s", exc)


# --------------------------------------------------------------------------- #
# Mission offer (recover-or-create). Phase 3 = approved fallback image only.   #
# --------------------------------------------------------------------------- #
async def get_or_create_today_mission(db, sid: str, cfg: dict) -> dict[str, Any]:
    date = _today()
    key = _mission_key(sid, date)
    existing = await db[COLL_MISSIONS].find_one({"_id": key}, {"_id": 0})
    if existing and existing.get("playable"):
        return existing
    mission_id = _mission_id_for(date)

    # Assign a real bundled scene server-side (rotation, avoid recent repeats,
    # prefer the student's configured difficulty when set). Falls back to the
    # legacy fallback ref only if the scene library is somehow empty/disabled.
    import voice_treasure_scenes as vt_scenes
    recent = []
    try:
        cur = db[COLL_MISSIONS].find(
            {"student_id": sid}, {"_id": 0, "scene_id": 1}).sort("date", -1).limit(3)
        async for m in cur:
            if m.get("scene_id"):
                recent.append(m["scene_id"])
    except Exception:  # noqa: BLE001
        recent = []
    difficulty = (cfg.get("images") or {}).get("difficulty_mode") or "adaptive"
    scene = vt_scenes.assign_scene(cfg, recent_scene_ids=recent, preferred_difficulty=difficulty)

    # ── (A) Authoritative server-side generated-image path ───────────────
    # When the backend master switch + Author Studio image-generation toggle +
    # provider config are all ON, attempt a controlled Gemini image generation
    # FROM THE MISSION-CREATION PATH (not just tests). Validated bytes are
    # persisted to the durable media store and the mission record carries an
    # opaque media reference — never bytes, never a backend filesystem path,
    # never the model name. Any failure transparently falls back to the
    # bundled scene below; play is never blocked and no double charge occurs.
    generated_descriptor: dict[str, Any] | None = None
    image_kind = "bundled" if scene else "fallback"
    try:
        import voice_treasure_config_tools as _vt_cfg
        import voice_treasure_gemini as _vt_gemini
        import voice_treasure_media as _vt_media
        cfg_imgs = (cfg.get("images") or {})
        wants_generated = (
            _vt_cfg.master_image_generation_enabled()
            and bool(cfg_imgs.get("image_generation_enabled"))
            and _vt_gemini.image_generation_available()
        )
        if wants_generated and scene:
            # Capturing sink: prepare_mission_image's adapter calls this
            # synchronously with the validated (bytes, mime). We capture them
            # and persist durably AFTER the adapter returns, on the same
            # event loop, via the proper async durable layer (GridFS).
            _captured: dict[str, Any] = {}

            def _capture_sink(_ref, _bytes, _mime):
                _captured["ref"] = _ref
                _captured["bytes"] = _bytes
                _captured["mime"] = _mime
                # The adapter only needs a non-empty "stored_path" return so
                # it knows the store succeeded. The REAL durable write happens
                # below.
                return "captured"

            outcome = await _vt_gemini.prepare_mission_image(
                theme=scene.get("theme") or "school",
                difficulty=scene.get("difficulty") or "beginner",
                store=_capture_sink,
            )
            if outcome.get("outcome") == _vt_gemini.IMG_GENERATED and _captured.get("bytes"):
                desc = await _vt_media.store_generated_image_durable(
                    db, _captured["bytes"], _captured["mime"],
                )
                generated_descriptor = {
                    "image_kind": "generated",
                    "object_key": desc["object_key"],
                    "image_mime": desc["mime"],
                    "size": desc.get("size"),
                    "sha256": desc.get("sha256"),
                    "width": desc.get("width"),
                    "height": desc.get("height"),
                    "generated_at": desc.get("created_at"),
                }
                image_kind = "generated"
    except Exception as _gen_exc:  # noqa: BLE001 — never block mission on a gen failure
        log.warning("voice_treasure: generated mission path failed (non-fatal): %s",
                    type(_gen_exc).__name__)
        generated_descriptor = None
        image_kind = "bundled" if scene else "fallback"

    if generated_descriptor and scene:
        doc = {
            "_id": key,
            "mission_id": mission_id,
            "student_id": sid,
            "date": date,
            "scene_id": scene["scene_id"],
            "theme": scene.get("theme"),
            "difficulty": scene.get("difficulty"),
            "title": scene.get("title"),
            "alt": scene.get("alt"),
            "prompt": scene.get("prompt"),
            "image_kind": "generated",
            # The image_ref the student sees is OPAQUE (the durable object key).
            # The backend resolves it to GridFS bytes via the authenticated
            # content endpoint.
            "image_ref": generated_descriptor["object_key"],
            "generated_image_meta": generated_descriptor,
            "playable": True,
            "created_at": _utcnow_iso(),
        }
    elif scene:
        doc = {
            "_id": key,
            "mission_id": mission_id,
            "student_id": sid,
            "date": date,
            "scene_id": scene["scene_id"],
            "theme": scene.get("theme"),
            "difficulty": scene.get("difficulty"),
            "title": scene.get("title"),
            "alt": scene.get("alt"),
            "prompt": scene.get("prompt"),
            "image_kind": "bundled",
            "image_ref": scene["image_ref"],
            "playable": True,
            "created_at": _utcnow_iso(),
        }
    else:
        doc = {
            "_id": key, "mission_id": mission_id, "student_id": sid, "date": date,
            "scene_id": None, "theme": "fallback", "difficulty": difficulty,
            "title": "Today's Picture", "alt": "A friendly illustrated scene to describe.",
            "prompt": "Describe this picture in 2 sentences.",
            "image_kind": "fallback", "image_ref": FALLBACK_IMAGE_REF,
            "playable": True, "created_at": _utcnow_iso(),
        }
    await db[COLL_MISSIONS].update_one(
        {"_id": key}, {"$setOnInsert": doc}, upsert=True
    )
    fresh = await db[COLL_MISSIONS].find_one({"_id": key}, {"_id": 0})
    return fresh or {k: v for k, v in doc.items() if k != "_id"}


def _mission_offer_view(mission: dict) -> dict[str, Any]:
    """Student-safe mission projection (no internal flags)."""
    return {
        "mission_id": mission.get("mission_id"),
        "date": mission.get("date"),
        "scene_id": mission.get("scene_id"),
        "difficulty": mission.get("difficulty"),
        "title": mission.get("title"),
        "alt": mission.get("alt"),
        "prompt": mission.get("prompt"),
        "image_kind": mission.get("image_kind"),
        "image_ref": mission.get("image_ref"),
        "playable": bool(mission.get("playable")),
    }


def _entry_view(entry: dict) -> dict[str, Any]:
    """Student-safe entry projection. Never leaks nonce or raw provider text."""
    return {
        "entry_id": entry.get("entry_id"),
        "mission_id": entry.get("mission_id"),
        "mission_date": entry.get("mission_date"),
        "state": entry.get("state"),
        "cost_points": entry.get("cost_points"),
        "paid": entry.get("state") == S_SUCCEEDED,
        "balance_after": entry.get("points_after"),
        # student-safe reason code only (already normalised, never raw GAS text)
        "reason": entry.get("public_reason"),
        "updated_at": entry.get("updated_at"),
    }


async def _count_succeeded_today(db, sid: str, date: str) -> int:
    return await db[COLL_ENTRIES].count_documents(
        {"student_id": sid, "mission_date": date,
         "state": {"$in": list(QUALIFYING_DAILY_STATES)}}
    )


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_voice_treasure_entry_routes(api, db, require_admin, require_student) -> None:
    from fastapi import Depends, HTTPException, Body

    def _sid(student) -> str:
        return str(getattr(student, "student_id", "") or "")

    def _clean(student) -> str:
        return str(getattr(student, "clean_id", "") or getattr(student, "student_id", "") or "")

    def _groups(student) -> list[str]:
        for attr in ("groups", "group", "class_name", "class_id", "level"):
            v = getattr(student, attr, None)
            if isinstance(v, list):
                return v
            if isinstance(v, str) and v.strip():
                return [v.strip()]
        return []

    async def _availability(student) -> tuple[dict, dict]:
        """Return (config, public_projection) and enforce the availability
        gate. Raises 404/403 when unavailable so the feature stays hidden."""
        cfg = await vt_cfg.load_config(db)
        pub = vt_cfg.public_projection(cfg, student_id=_sid(student), groups=_groups(student))
        return cfg, pub

    # ── GET /today : mission offer + entry cost (no balance; GET has no pw) ──
    @api.get("/voice-treasure/today")
    async def vt_today(student=Depends(require_student)):
        cfg, pub = await _availability(student)
        if not pub.get("available"):
            return {"available": False}
        # GAS must be configured for a paid feature; otherwise stay unavailable.
        if not vt_points.gas_debit_configured():
            log.warning("vt: GAS debit not configured — feature unavailable")
            return {"available": False, "reason": "unconfigured"}

        sid = _sid(student)
        date = _today()
        mission = await get_or_create_today_mission(db, sid, cfg)
        # Recover any existing entry for today's mission.
        ekey = _entry_key(sid, date, mission["mission_id"])
        entry = await db[COLL_ENTRIES].find_one({"_id": ekey}, {"_id": 0})
        used_today = await _count_succeeded_today(db, sid, date)
        daily_limit = int(pub["limits"]["daily_play_limit"])
        # Server-authoritative bilingual text. The student client NEVER
        # decides what language to evaluate in — we only tell it what to
        # display. Falls back gracefully if helpers are unavailable.
        instruction_block: dict[str, Any] = {
            "primary": mission.get("prompt") or "Describe the picture.",
            "secondary": "",
            "lang": "en",
        }
        unavailable_text = "Evaluation is temporarily unavailable. Your entry is preserved — please try again shortly."
        retry_text = "You can try again. We won't charge you again."
        try:
            import voice_treasure_bilingual as vt_lang
            policy = vt_cfg.evaluation_language_policy(cfg)
            lang_cfg = (cfg or {}).get("language") or {}
            instruction_block = vt_lang.resolve_instruction_text(policy, lang_cfg)
            unavailable_text = vt_lang.localize_unavailable_text(policy, lang_cfg)
            retry_text = vt_lang.localize_retry_text(policy, lang_cfg)
            response_label = vt_lang.accepted_response_language_label(policy)
        except Exception:  # noqa: BLE001
            response_label = "English"
        return {
            "available": True,
            "mission": _mission_offer_view(mission),
            "entry": {
                "entry_cost_points": int(pub["entry"]["entry_cost_points"]),
                "minimum_balance_points": int(pub["entry"]["minimum_balance_points"]),
                "free_first_play": bool(pub["entry"]["free_first_play"]),
            },
            "limits": {
                "daily_play_limit": daily_limit,
                "used_today": used_today,
                "limit_reached": daily_limit > 0 and used_today >= daily_limit,
            },
            "existing_entry": _entry_view(entry) if entry else None,
            # Server-authoritative localized text (display only).
            "language": {
                "instruction": instruction_block,
                "accepted_response_label": response_label,
                "unavailable_text": unavailable_text,
                "retry_text": retry_text,
            },
        }

    # ── POST /entry/confirm : preview (confirm=false) OR debit (confirm=true)
    @api.post("/voice-treasure/entry/confirm")
    async def vt_entry_confirm(payload: dict = Body(default_factory=dict),
                               student=Depends(require_student)):
        cfg, pub = await _availability(student)
        if not pub.get("available"):
            raise HTTPException(status_code=403, detail="voice_treasure_unavailable")
        if not vt_points.gas_debit_configured():
            raise HTTPException(status_code=503, detail="points_unconfigured")

        sid = _sid(student)
        clean = _clean(student)
        date = _today()
        password = str((payload or {}).get("password") or "")
        do_commit = bool((payload or {}).get("confirm") is True)
        cost = int(pub["entry"]["entry_cost_points"])
        daily_limit = int(pub["limits"]["daily_play_limit"])

        # 1) Playable mission must exist BEFORE any charge.
        mission = await get_or_create_today_mission(db, sid, cfg)
        if not mission.get("playable"):
            raise HTTPException(status_code=409, detail="no_playable_mission")
        mission_id = mission["mission_id"]
        ekey = _entry_key(sid, date, mission_id)

        # 2) If already paid (refresh / reopen / duplicate), return it — no
        #    charge and NOT subject to the daily limit (recovery must work).
        existing = await db[COLL_ENTRIES].find_one({"_id": ekey}, {"_id": 0})
        if existing and existing.get("state") == S_SUCCEEDED:
            return {"entry": _entry_view(existing), "mission": _mission_offer_view(mission),
                    "already_paid": True}

        # 3) Authoritative GAS balance (requires the student's password).
        if not password:
            raise HTTPException(status_code=400, detail="password_required")
        balance, breason = await vt_points.get_authoritative_balance(clean, password)
        if balance is None:
            # Could not read balance — never charge on an unknown balance.
            safe = "auth_failed" if breason == "missing_password" else "balance_unavailable"
            raise HTTPException(status_code=502, detail=safe)
        sufficient = balance >= max(cost, int(pub["entry"]["minimum_balance_points"]))

        # ── PREVIEW (confirm=false): show authoritative balance, never charge ──
        if not do_commit:
            return {
                "mode": "preview",
                "mission": _mission_offer_view(mission),
                "entry_cost_points": cost,
                "balance": balance,
                "sufficient": bool(sufficient),
                "existing_entry": _entry_view(existing) if existing else None,
            }

        # ── COMMIT (confirm=true): at-most-once local initiation ──
        # 4) Mission-before-charge proof (server-authoritative; never trust a
        #    client-supplied mission id or cost). If the client echoes a stale
        #    offer, refuse BEFORE any GAS call.
        client_mission_id = (payload or {}).get("mission_id")
        if client_mission_id is not None and str(client_mission_id) != str(mission_id):
            raise HTTPException(status_code=409, detail="mission_offer_stale")
        client_cost = (payload or {}).get("expected_cost")
        if client_cost is not None and int(client_cost) != int(cost):
            raise HTTPException(status_code=409, detail="cost_changed")
        if mission.get("student_id") != sid or mission.get("date") != date:
            raise HTTPException(status_code=409, detail="mission_mismatch")
        if not mission.get("playable") or not mission.get("image_ref"):
            raise HTTPException(status_code=409, detail="mission_not_playable")

        # 5) Daily limit applies only to a NEW paid attempt (qualifying states).
        used_today = await _count_succeeded_today(db, sid, date)
        if daily_limit > 0 and used_today >= daily_limit:
            raise HTTPException(status_code=429, detail="daily_limit_reached")

        if not sufficient:
            # No charge. Frontend routes to existing Top-Up flow.
            raise HTTPException(status_code=402, detail="insufficient_balance")

        now = _utcnow_iso()
        # (a) ensure a record exists in `created` (idempotent insert).
        seed = {
            "_id": ekey,
            "entry_id": ekey,
            "student_id": sid,
            "mission_id": mission_id,
            "mission_date": date,
            "state": S_CREATED,
            "cost_points": cost,
            # audit history
            "initiation_count": 0,
            "last_operation_id": None,
            "last_attempted_at": None,
            "last_failure_reason": None,
            "state_history": [{"state": S_CREATED, "at": now}],
            "nonce": None,
            "points_before": None,
            "points_after": None,
            "reason": None,
            "public_reason": None,
            "created_at": now,
            "updated_at": now,
        }
        await db[COLL_ENTRIES].update_one({"_id": ekey}, {"$setOnInsert": seed}, upsert=True)

        # (b) atomically claim a NEW operation: created/retryable → initiating.
        #     Exactly one concurrent request wins per operation. A new internal
        #     operation_id + nonce is minted for THIS controlled attempt. A
        #     confirmed_failed entry can only reach here via this explicit
        #     student-confirmed POST — never via GET/refresh/poll. Ambiguous
        #     (needs_manual_reconciliation) is NOT in the retryable set, so it
        #     can never be auto-claimed here.
        op_id = uuid.uuid4().hex
        new_nonce = uuid.uuid4().hex
        attempt_at = _utcnow_iso()
        claimed = await db[COLL_ENTRIES].find_one_and_update(
            {"_id": ekey, "state": {"$in": [S_CREATED, *(_RETRYABLE)]}},
            {
                "$set": {
                    "state": S_INITIATING,
                    "nonce": new_nonce,
                    "last_operation_id": op_id,
                    "last_attempted_at": attempt_at,
                    "points_before": balance,
                    "reason": None,
                    "public_reason": None,
                    "updated_at": attempt_at,
                },
                "$inc": {"initiation_count": 1},
                "$push": {"state_history": {"state": S_INITIATING, "at": attempt_at, "op": op_id}},
            },
            return_document=ReturnDocument.AFTER,
        )
        if not claimed:
            # We did not win the claim (another request is initiating, or the
            # entry is in a non-retryable state). Return current state — no
            # second debit, no auto-retry of reconciliation.
            cur = await db[COLL_ENTRIES].find_one({"_id": ekey}, {"_id": 0})
            return {"entry": _entry_view(cur or existing or {}), "mission": _mission_offer_view(mission),
                    "already_in_progress": True}

        # (c) initiate the single GAS debit for THIS attempt's nonce.
        result = await vt_points.debit_entry(clean, password, cost, nonce=new_nonce)
        outcome = result.get("outcome")

        if outcome == vt_points.OUTCOME_OK:
            # Confirmed success. Best-effort post-debit balance (safe if it
            # fails — we still know the debit applied).
            post_bal, _r = await vt_points.get_authoritative_balance(clean, password)
            ts = _utcnow_iso()
            await db[COLL_ENTRIES].update_one(
                {"_id": ekey, "state": S_INITIATING},
                {"$set": {
                    "state": S_SUCCEEDED,
                    "points_after": post_bal if post_bal is not None else None,
                    "public_reason": None,
                    "updated_at": ts,
                 },
                 "$push": {"state_history": {"state": S_SUCCEEDED, "at": ts, "op": op_id}}},
            )
        elif outcome == vt_points.OUTCOME_REJECTED:
            # Definitive failure — no points moved. Retryable via a NEW
            # explicit student confirmation (new operation id).
            ts = _utcnow_iso()
            await db[COLL_ENTRIES].update_one(
                {"_id": ekey, "state": S_INITIATING},
                {"$set": {
                    "state": S_FAILED,
                    "reason": result.get("reason"),
                    "last_failure_reason": result.get("reason"),
                    "public_reason": "debit_failed",
                    "updated_at": ts,
                 },
                 "$push": {"state_history": {"state": S_FAILED, "at": ts, "op": op_id}}},
            )
        else:  # OUTCOME_AMBIGUOUS
            # We don't know if points moved. NEVER auto-retry.
            ts = _utcnow_iso()
            await db[COLL_ENTRIES].update_one(
                {"_id": ekey, "state": S_INITIATING},
                {"$set": {
                    "state": S_RECONCILE,
                    "reason": result.get("reason"),
                    "last_failure_reason": result.get("reason"),
                    "public_reason": "pending_review",
                    "updated_at": ts,
                 },
                 "$push": {"state_history": {"state": S_RECONCILE, "at": ts, "op": op_id}}},
            )

        final = await db[COLL_ENTRIES].find_one({"_id": ekey}, {"_id": 0})
        return {"entry": _entry_view(final or {}), "mission": _mission_offer_view(mission)}

    # ── GET /entry/{entry_id} : refresh / direct recovery ──
    @api.get("/voice-treasure/entry/{entry_id}")
    async def vt_get_entry(entry_id: str, student=Depends(require_student)):
        sid = _sid(student)
        entry = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        if not entry or entry.get("student_id") != sid:
            raise HTTPException(status_code=404, detail="entry_not_found")
        return {"entry": _entry_view(entry)}

    # ── Admin: entries list ──
    @api.get("/admin/voice-treasure/entries")
    async def vt_admin_entries(state: str | None = None, limit: int = 100,
                               admin=Depends(require_admin)):
        q: dict[str, Any] = {}
        if state:
            q["state"] = state
        limit = max(1, min(int(limit or 100), 500))
        cur = db[COLL_ENTRIES].find(q, {"_id": 0}).sort("updated_at", -1).limit(limit)
        rows = [r async for r in cur]
        return {"entries": rows, "count": len(rows)}

    @api.get("/admin/voice-treasure/entries/{entry_id}")
    async def vt_admin_entry(entry_id: str, admin=Depends(require_admin)):
        entry = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        if not entry:
            raise HTTPException(status_code=404, detail="entry_not_found")
        return {"entry": entry}  # admin sees full record (incl. reason codes)

    # ── Admin: reconciliation queue (ambiguous entries) ──
    @api.get("/admin/voice-treasure/reconciliation")
    async def vt_admin_reconciliation(limit: int = 200, admin=Depends(require_admin)):
        limit = max(1, min(int(limit or 200), 1000))
        cur = db[COLL_ENTRIES].find(
            {"state": S_RECONCILE}, {"_id": 0}
        ).sort("updated_at", 1).limit(limit)
        rows = [r async for r in cur]
        return {"reconciliation_queue": rows, "count": len(rows)}

    @api.post("/admin/voice-treasure/entries/{entry_id}/reconcile")
    async def vt_admin_entry_reconcile(entry_id: str, payload: dict = Body(...),
                                       admin=Depends(require_admin)):
        """Explicit, auditable resolution for an ambiguous (stuck) paid entry.
        `resolved_paid` marks the entry usable (the debit is confirmed to have
        applied); `resolved_failed` marks it confirmed_failed (no debit), which
        is retryable by the student. Requires explicit evidence. Never calls GAS."""
        outcome = str((payload or {}).get("outcome") or "")
        evidence = str((payload or {}).get("evidence") or "").strip()
        actor = str(getattr(admin, "username", "") or getattr(admin, "user_id", "") or "admin")
        if outcome not in ("resolved_paid", "resolved_failed"):
            raise HTTPException(status_code=400, detail="invalid_outcome")
        if not evidence:
            raise HTTPException(status_code=400, detail="evidence_required")
        entry = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        if not entry:
            raise HTTPException(status_code=404, detail="entry_not_found")
        if entry.get("state") != S_RECONCILE:
            raise HTTPException(status_code=409, detail="not_in_reconciliation")
        audit = {"actor": actor, "evidence": evidence, "at": _utcnow_iso(), "outcome": outcome}
        new_state = S_SUCCEEDED if outcome == "resolved_paid" else S_FAILED
        await db[COLL_ENTRIES].update_one(
            {"_id": entry_id},
            {"$set": {"state": new_state, "reconciliation": audit, "updated_at": _utcnow_iso()},
             "$push": {"state_history": {"state": new_state, "at": _utcnow_iso(), "op": "reconcile"}}})
        fresh = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        return {"entry": fresh}

    @api.post("/admin/voice-treasure/entries/{entry_id}/reopen")
    async def vt_admin_entry_reopen(entry_id: str, payload: dict = Body(...),
                                    admin=Depends(require_admin)):
        """Restore an already-PAID entry to a playable state (e.g. after a
        technical failure) WITHOUT charging again and WITHOUT calling GAS.
        Audited. Only valid for a paid entry."""
        reason = str((payload or {}).get("reason") or "").strip()
        actor = str(getattr(admin, "username", "") or getattr(admin, "user_id", "") or "admin")
        if not reason:
            raise HTTPException(status_code=400, detail="reason_required")
        entry = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        if not entry:
            raise HTTPException(status_code=404, detail="entry_not_found")
        prior = entry.get("state")
        if prior not in (S_SUCCEEDED,):
            raise HTTPException(status_code=409, detail="entry_not_paid")
        audit = {"action": "reopen", "actor": actor, "reason": reason,
                 "prior_state": prior, "result_state": S_SUCCEEDED, "at": _utcnow_iso()}
        await db[COLL_ENTRIES].update_one(
            {"_id": entry_id},
            {"$set": {"state": S_SUCCEEDED, "reopened": True, "updated_at": _utcnow_iso()},
             "$push": {"admin_actions": audit,
                       "state_history": {"state": S_SUCCEEDED, "at": _utcnow_iso(), "op": "reopen"}}})
        # Reset the attempt for this entry so the student can replay (no GAS).
        akey = f"vt-attempt:{entry.get('student_id')}:{entry_id}"
        try:
            await db["voice_treasure_attempts"].delete_one({"_id": akey})
        except Exception:  # noqa: BLE001
            pass
        fresh = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        return {"entry": fresh, "audit": audit}

    @api.post("/admin/voice-treasure/entries/{entry_id}/replace-mission")
    async def vt_admin_entry_replace_mission(entry_id: str, payload: dict = Body(...),
                                             admin=Depends(require_admin)):
        """Assign a NEW bundled mission to an already-PAID entry after a
        technical failure, preserving the original paid entry. No GAS, no second
        charge. Resets only the mission/evaluation state needed for replay.
        Audited."""
        reason = str((payload or {}).get("reason") or "").strip()
        actor = str(getattr(admin, "username", "") or getattr(admin, "user_id", "") or "admin")
        if not reason:
            raise HTTPException(status_code=400, detail="reason_required")
        entry = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        if not entry:
            raise HTTPException(status_code=404, detail="entry_not_found")
        if entry.get("state") != S_SUCCEEDED:
            raise HTTPException(status_code=409, detail="entry_not_paid")

        sid = entry.get("student_id")
        date = entry.get("mission_date") or _today()
        mkey = _mission_key(sid, date)
        cfg = await vt_cfg.load_config(db)
        import voice_treasure_scenes as vt_scenes
        old = await db[COLL_MISSIONS].find_one({"_id": mkey}, {"_id": 0})
        recent = [old.get("scene_id")] if old and old.get("scene_id") else []
        difficulty = (cfg.get("images") or {}).get("difficulty_mode") or "adaptive"
        scene = vt_scenes.assign_scene(cfg, recent_scene_ids=recent, preferred_difficulty=difficulty)
        if not scene:
            raise HTTPException(status_code=409, detail="no_replacement_scene_available")
        audit = {"action": "replace_mission", "actor": actor, "reason": reason,
                 "prior_scene": (old or {}).get("scene_id"), "new_scene": scene["scene_id"],
                 "at": _utcnow_iso()}
        await db[COLL_MISSIONS].update_one(
            {"_id": mkey},
            {"$set": {"scene_id": scene["scene_id"], "theme": scene.get("theme"),
                      "difficulty": scene.get("difficulty"), "title": scene.get("title"),
                      "alt": scene.get("alt"), "prompt": scene.get("prompt"),
                      "image_kind": "bundled", "image_ref": scene["image_ref"],
                      "playable": True, "updated_at": _utcnow_iso()},
             "$push": {"admin_actions": audit}}, upsert=True)
        # Reset attempt + record the action on the entry (entry stays paid).
        akey = f"vt-attempt:{sid}:{entry_id}"
        try:
            await db["voice_treasure_attempts"].delete_one({"_id": akey})
        except Exception:  # noqa: BLE001
            pass
        await db[COLL_ENTRIES].update_one(
            {"_id": entry_id},
            {"$set": {"updated_at": _utcnow_iso()}, "$push": {"admin_actions": audit}})
        fresh = await db[COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        return {"entry": fresh, "mission_scene": scene["scene_id"], "audit": audit}

    log.info("voice_treasure: entry routes registered (Phase 3).")
