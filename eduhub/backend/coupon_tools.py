# ===========================================================================
# Coupon System — v1.0 (moved out of server.py, Architecture Reconstruction
# Phase 1f — "server.py partial router split, proof-of-pattern")
# ---------------------------------------------------------------------------
# This is the FIRST of a deliberately small, bounded slice of server.py's own
# inline @api.* routes extracted into a per-domain module, matching the
# register_*_routes(api, db, ...) explicit-DI convention already used for
# every previously-exec()'d module (Phase 1b/1c). It is not a claim that the
# whole ~7800-line server.py has been decomposed — see server.py's own
# comment at the old location for the current extraction scope.
#
# Behaviour is byte-for-byte identical to the original inline routes: same
# collection (``coupons``), same validation, same response shapes, same
# helper functions. Nothing about the coupon system's logic changed — only
# where the code lives.
#
# Registered via register_coupon_routes(api, db, require_admin, User) from
# server.py. Returns ``_generate_coupon_code`` because login_reward_tools.py's
# own registration call passes it in as its shared code-generator (see
# server.py's login_reward_tools wiring) — every other helper here
# (_calc_discount, _find_valid_coupon) is purely internal to this module's
# own routes and is not consumed anywhere else (edutalk_coupon_tools.py reads
# the same ``coupons`` collection directly with its own separate fields and
# never touches these helpers, per its own module docstring).
#
# Collections: coupons
# Endpoints: POST/GET/PATCH/DELETE /api/coupons  (admin)
#            POST /api/coupons/validate           (student)
#            POST /api/coupons/redeem             (student)
# ===========================================================================

import logging
import secrets as _secrets_coupon
import string as _string_coupon
from datetime import datetime, timezone

from fastapi import Depends, HTTPException

log = logging.getLogger("eduhub")


def register_coupon_routes(api, db, require_admin, User):
    """Register the book-discount coupon admin + student routes onto ``api``.

    Explicit-DI replacement for the previous inline server.py routes.
    Returns ``_generate_coupon_code`` for server.py to pass on to
    login_reward_tools.py, matching this module's original cross-module
    dependency.
    """

    def _generate_coupon_code(length: int = 8) -> str:
        """Generate a random uppercase alphanumeric coupon code."""
        alphabet = _string_coupon.ascii_uppercase + _string_coupon.digits
        return "".join(_secrets_coupon.choice(alphabet) for _ in range(length))

    def _calc_discount(original_price: int, coupon: dict) -> int:
        """Return the discounted price (never below 0)."""
        if coupon.get("type") == "percent":
            discount = round(original_price * coupon.get("value", 0) / 100)
        else:  # fixed
            discount = int(coupon.get("value", 0))
        return max(0, original_price - discount)

    async def _find_valid_coupon(
        code: str,
        student_id: str,
        book_slug: str,
    ) -> dict | None:
        """
        Look up a coupon by code and verify all constraints.
        Returns the coupon doc on success, raises HTTPException on failure.
        """
        doc = await db.coupons.find_one({"code": code.strip().upper()}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Coupon code not found.")
        # §EduTalk coupon Checkpoint 3 stabilization: mandatory bidirectional
        # isolation. An old/missing benefit_type is ALWAYS "book_discount" (every
        # existing coupon), so this is a no-op for every coupon that predates
        # this field. A Live Voice Coach coupon (benefit_type="edutalk_points")
        # has no meaningful type/value (None, not a fake "fixed"/1 pair since the
        # Checkpoint 3 fix) — without this guard, _calc_discount would receive
        # value=None and raise a raw TypeError instead of a clean 404. Returning
        # the SAME generic "not found" here (rather than a distinguishing
        # message) never leaks that a Live Coach code exists.
        if (doc.get("benefit_type") or "book_discount") != "book_discount":
            raise HTTPException(status_code=404, detail="Coupon code not found.")
        if not doc.get("enabled", True):
            raise HTTPException(status_code=400, detail="This coupon has been disabled.")
        now_iso = datetime.now(timezone.utc)
        valid_from = doc.get("valid_from")
        expires_at = doc.get("expires_at")
        if valid_from:
            vf = datetime.fromisoformat(valid_from) if isinstance(valid_from, str) else valid_from
            if vf.tzinfo is None:
                vf = vf.replace(tzinfo=timezone.utc)
            if now_iso < vf:
                raise HTTPException(status_code=400, detail="This coupon is not yet active.")
        if expires_at:
            ex = datetime.fromisoformat(expires_at) if isinstance(expires_at, str) else expires_at
            if ex.tzinfo is None:
                ex = ex.replace(tzinfo=timezone.utc)
            if now_iso > ex:
                raise HTTPException(status_code=400, detail="This coupon has expired.")
        max_uses = doc.get("max_uses")
        if max_uses is not None and doc.get("uses_count", 0) >= max_uses:
            raise HTTPException(status_code=400, detail="This coupon has reached its usage limit.")
        assigned_to = doc.get("assigned_to") or []
        if assigned_to and student_id not in assigned_to:
            raise HTTPException(status_code=403, detail="This coupon is not assigned to your account.")
        book_slugs = doc.get("book_slugs") or []
        if book_slugs and book_slug not in book_slugs:
            raise HTTPException(status_code=400, detail="This coupon cannot be used for this book.")
        # Check if student already redeemed this coupon for this book
        already = any(
            r.get("student_id") == student_id and r.get("book_slug") == book_slug
            for r in (doc.get("redemptions") or [])
        )
        if already:
            raise HTTPException(status_code=400, detail="You have already used this coupon for this book.")
        return doc

    # ── Admin endpoints ────────────────────────────────────────────────────

    @api.post("/coupons")
    async def create_coupon(payload: dict, admin: User = Depends(require_admin)):
        """Create a new coupon. Set code='' to auto-generate.

        §EduTalk coupon Checkpoint 3 stabilization: benefit_type branches the
        validation explicitly instead of requiring a dummy type/value pair for a
        non-book coupon. An absent/omitted benefit_type is ALWAYS "book_discount"
        — every existing creation payload (no benefit_type key) hits the EXACT
        same "book_discount" branch with the EXACT same checks/error messages as
        before this change, producing the identical document shape (proven by
        tests/test_coupon_schema_backward_compat.py, re-executed against this
        branched version). An edutalk_points coupon no longer semantically
        depends on type/value at all — they are stored as None, never a fake
        "fixed"/1 pair — so nothing downstream can mistake them for a real
        discount.
        """
        code = (payload.get("code") or "").strip().upper() or _generate_coupon_code()
        if await db.coupons.find_one({"code": code}):
            raise HTTPException(status_code=409, detail=f"Coupon code '{code}' already exists.")

        # video_library_points (Video Library Voucher) is a THIRD, additive
        # benefit_type — same flat-points-grant shape as edutalk_points, just
        # consumed by video_library_coupon_tools.py's own isolated redemption
        # routes instead of edutalk_coupon_tools.py's. book_discount's own
        # branch/behavior below is completely untouched by this addition.
        benefit_type = payload.get("benefit_type") or "book_discount"
        if benefit_type not in ("book_discount", "edutalk_points", "video_library_points"):
            raise HTTPException(
                status_code=400,
                detail="benefit_type must be 'book_discount', 'edutalk_points', or 'video_library_points'.",
            )

        if benefit_type == "book_discount":
            discount_type = payload.get("type", "percent")
            if discount_type not in ("percent", "fixed"):
                raise HTTPException(status_code=400, detail="type must be 'percent' or 'fixed'.")
            value = float(payload.get("value", 0))
            if value <= 0:
                raise HTTPException(status_code=400, detail="value must be > 0.")
            if discount_type == "percent" and value > 100:
                raise HTTPException(status_code=400, detail="Percent discount cannot exceed 100.")
            benefit_amount = None
        else:  # edutalk_points / video_library_points — flat points grant, no discount fields
            discount_type = None
            value = None
            benefit_amount = payload.get("benefit_amount")
            if not isinstance(benefit_amount, int) or isinstance(benefit_amount, bool) or not (1 <= benefit_amount <= 1000):
                raise HTTPException(status_code=400, detail="benefit_amount must be an integer between 1 and 1000.")

        now_iso = datetime.now(timezone.utc).isoformat()
        assigned_to = payload.get("assigned_to") or []
        if benefit_type in ("edutalk_points", "video_library_points"):
            # §Live Voice Coach Coupon diagnostics: assigned_to is free-typed by
            # an admin (CouponStudio's CSV field has no normalization), and
            # the redemption module compares it against the student's own
            # clean_id. Normalizing at storage time here (book_discount coupons
            # are completely unaffected — this branch never runs for them)
            # prevents a case/whitespace mismatch from ever being written in
            # the first place. Video Library Vouchers share this exact
            # normalization since video_library_coupon_tools.py's own
            # _norm_sid() does the identical strip().lower().
            assigned_to = [str(x).strip().lower() for x in assigned_to if x]
        doc = {
            "code":        code,
            "type":        discount_type,
            "value":       value,
            "max_uses":    payload.get("max_uses"),           # None = unlimited
            "uses_count":  0,
            "assigned_to": assigned_to,                       # [] = public
            "book_slugs":  payload.get("book_slugs") or [],   # [] = all books
            "valid_from":  payload.get("valid_from") or now_iso,
            "expires_at":  payload.get("expires_at"),         # None = never
            "enabled":     True,
            "created_by":  admin.email,
            "created_at":  now_iso,
            "redemptions": [],
            "benefit_type":   benefit_type,
            "benefit_amount": benefit_amount,
        }
        await db.coupons.insert_one(doc)
        doc.pop("_id", None)
        log.info("coupon: created %s by %s", code, admin.email)
        return {"ok": True, "coupon": doc}

    @api.get("/coupons")
    async def list_coupons(admin: User = Depends(require_admin)):
        """List all coupons (admin only)."""
        cursor = db.coupons.find({}, {"_id": 0}).sort("created_at", -1)
        coupons = await cursor.to_list(length=500)
        return {"ok": True, "coupons": coupons}

    @api.get("/coupons/{code}")
    async def get_coupon(code: str, admin: User = Depends(require_admin)):
        doc = await db.coupons.find_one({"code": code.upper()}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Coupon not found.")
        return {"ok": True, "coupon": doc}

    @api.patch("/coupons/{code}")
    async def update_coupon(code: str, payload: dict, admin: User = Depends(require_admin)):
        """Update coupon fields. Supports: enabled, expires_at, max_uses, assigned_to, book_slugs, value,
        benefit_type, benefit_amount."""
        allowed = {"enabled", "expires_at", "max_uses", "assigned_to", "book_slugs", "value", "valid_from",
                   "benefit_type", "benefit_amount"}
        updates = {k: v for k, v in payload.items() if k in allowed}
        if not updates:
            raise HTTPException(status_code=400, detail="No valid fields to update.")
        if updates.get("benefit_type") in ("edutalk_points", "video_library_points"):
            amt = updates.get("benefit_amount")
            if not isinstance(amt, int) or isinstance(amt, bool) or not (1 <= amt <= 1000):
                raise HTTPException(status_code=400, detail="benefit_amount must be an integer between 1 and 1000.")
        if "assigned_to" in updates:
            # §Live Voice Coach Coupon diagnostics: normalize only for a
            # points-grant coupon (edutalk_points or video_library_points —
            # this update payload's own benefit_type if given, else the
            # coupon's EXISTING benefit_type) — a book_discount coupon's
            # assigned_to is completely unaffected.
            effective_benefit_type = updates.get("benefit_type")
            if effective_benefit_type is None:
                existing_doc = await db.coupons.find_one({"code": code.upper()}, {"_id": 0, "benefit_type": 1})
                effective_benefit_type = (existing_doc or {}).get("benefit_type") or "book_discount"
            if effective_benefit_type in ("edutalk_points", "video_library_points"):
                updates["assigned_to"] = [str(x).strip().lower() for x in (updates.get("assigned_to") or []) if x]
        res = await db.coupons.update_one({"code": code.upper()}, {"$set": updates})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="Coupon not found.")
        log.info("coupon: updated %s by %s", code, admin.email)
        return {"ok": True}

    @api.delete("/coupons/{code}")
    async def delete_coupon(code: str, admin: User = Depends(require_admin)):
        res = await db.coupons.delete_one({"code": code.upper()})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Coupon not found.")
        log.info("coupon: deleted %s by %s", code, admin.email)
        return {"ok": True}

    # ── Student endpoints ──────────────────────────────────────────────────

    @api.post("/coupons/validate")
    async def validate_coupon(payload: dict):
        """
        Preview a coupon's discount without consuming it.
        Accepts student_id from payload (GAS-authenticated students pass their clean_id).
        Returns { ok, original_price, discounted_price, discount_amount, coupon }.
        """
        code       = (payload.get("code") or "").strip()
        book_slug  = (payload.get("book_slug") or "").strip()
        original   = int(payload.get("original_price") or 0)
        student_id = (payload.get("student_id") or "").strip()
        if not code or not book_slug or original <= 0:
            raise HTTPException(status_code=400, detail="code, book_slug, and original_price are required.")
        coupon = await _find_valid_coupon(code, student_id, book_slug)
        discounted = _calc_discount(original, coupon)
        return {
            "ok":               True,
            "original_price":   original,
            "discounted_price": discounted,
            "discount_amount":  original - discounted,
            "coupon_type":      coupon["type"],
            "coupon_value":     coupon["value"],
            "code":             coupon["code"],
        }

    @api.post("/coupons/redeem")
    async def redeem_coupon(payload: dict):
        """
        Atomically redeem a coupon at purchase time.
        Accepts student_id from payload (GAS-authenticated students pass their clean_id).
        Uses findOneAndUpdate with $lt guard to prevent concurrent over-use.
        Returns { ok, discounted_price }.
        """
        code       = (payload.get("code") or "").strip()
        book_slug  = (payload.get("book_slug") or "").strip()
        original   = int(payload.get("original_price") or 0)
        student_id = (payload.get("student_id") or "").strip()
        if not code or not book_slug or original <= 0:
            raise HTTPException(status_code=400, detail="code, book_slug, and original_price are required.")

        # Validate first (raises HTTPException on any failure)
        coupon = await _find_valid_coupon(code, student_id, book_slug)
        discounted = _calc_discount(original, coupon)
        now_iso = datetime.now(timezone.utc).isoformat()

        # Atomic increment with max_uses guard — prevents race conditions
        max_uses = coupon.get("max_uses")
        query: dict = {"code": code.upper()}
        if max_uses is not None:
            query["uses_count"] = {"$lt": max_uses}

        redemption_entry = {
            "student_id":  student_id,
            "book_slug":   book_slug,
            "redeemed_at": now_iso,
            "original":    original,
            "discounted":  discounted,
        }
        result = await db.coupons.find_one_and_update(
            query,
            {
                "$inc":  {"uses_count": 1},
                "$push": {"redemptions": redemption_entry},
            },
            return_document=True,
        )
        if not result:
            raise HTTPException(status_code=400, detail="Coupon is no longer available (usage limit reached).")

        log.info("coupon: redeemed %s by %s for book=%s saved=%dpts",
                 code, student_id, book_slug, original - discounted)
        return {
            "ok":               True,
            "code":             code.upper(),
            "original_price":   original,
            "discounted_price": discounted,
            "discount_amount":  original - discounted,
        }

    log.info("coupon_tools: routes registered (/api/coupons/*)")
    return _generate_coupon_code
