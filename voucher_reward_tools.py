# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ voucher_reward_tools.py — Student-facing Book Voucher LISTING layer        ║
# ║ (reward-kind integration v1.0.2)                                          ║
# ╠══════════════════════════════════════════════════════════════════════════╣
# ║ DESIGN                                                                     ║
# ║   • Vouchers are ISSUED by login_reward_tools.py as part of the Login     ║
# ║     Reward campaign claim (reward_kind = "voucher" | "points_voucher").   ║
# ║     That module owns the `student_vouchers` collection, the coupon        ║
# ║     creation (via the EXISTING db.coupons schema + _generate_coupon_code) ║
# ║     and the compose/status helpers. This module is a thin READ surface.   ║
# ║   • Source of truth = MongoDB (`student_vouchers` + `db.coupons`). NEVER  ║
# ║     localStorage.                                                          ║
# ║   • Redemption uses the EXISTING /api/coupons/validate + /api/coupons/    ║
# ║     redeem endpoints, which this module does NOT touch.                   ║
# ║                                                                            ║
# ║ LOADING                                                                    ║
# ║   exec()'d into server.py's namespace immediately AFTER login_reward_     ║
# ║   tools.py, so it reuses: api, db, require_student, Student, _norm_       ║
# ║   student_id, and the login-reward helpers _lrc_student_vouchers /        ║
# ║   _lrc_compose_voucher_payload / _lrc_iso / _lrc_now. Failure is non-     ║
# ║   fatal (the loader wraps this in try/except).                            ║
# ╚══════════════════════════════════════════════════════════════════════════╝

import logging as _vrt_logging

_VRT_LOG = _vrt_logging.getLogger("eduhub")

# Reuse the issuer module's collection handle + helpers (already present in
# the shared exec namespace). Defensive fallbacks keep this importable even
# if the names ever move.
_vrt_student_vouchers = globals().get("_lrc_student_vouchers") or db["student_vouchers"]


def _vrt_norm(value) -> str:
    fn = globals().get("_norm_student_id")
    if callable(fn):
        return fn(value or "")
    return (value or "").strip().lower()


async def _vrt_compose(row: dict) -> dict:
    """Delegate to the login-reward composer when available; otherwise
    return a minimal shape so the endpoint never hard-fails."""
    composer = globals().get("_lrc_compose_voucher_payload")
    if callable(composer):
        return await composer(row)
    return {
        "voucher_id": row.get("id") or "",
        "campaign_id": row.get("campaign_id"),
        "coupon_code": row.get("coupon_code") or "",
        "title": row.get("title") or "Book Voucher",
        "discount_label": row.get("discount_label") or "",
        "status": (row.get("status") or "active"),
        "eligible_books": list(row.get("eligible_books") or []),
        "applies_to_all_books": not bool(row.get("eligible_books")),
        "expires_at": row.get("expires_at"),
        "cta_label": row.get("cta_label") or "Use Voucher",
    }


@api.get("/student/vouchers")
async def vrt_list_student_vouchers(student: Student = Depends(require_student)):  # type: ignore[name-defined]
    """List the logged-in student's vouchers. Status (active / used /
    expired / exhausted / unavailable) is computed by the backend from the
    EXISTING coupon doc (`uses_count`, `max_uses`, `expires_at`, `enabled`).
    """
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _vrt_norm(sid_clean)
    if not sid_norm:
        return {"vouchers": [], "count": 0}

    rows = []
    try:
        cur = _vrt_student_vouchers.find(
            {"student_id_norm": sid_norm}, {"_id": 0}
        ).sort("claimed_at", -1).limit(200)
        async for v in cur:
            rows.append(v)
    except Exception as _e:
        _VRT_LOG.warning("voucher_reward: list query failed: %s", _e)
        return {"vouchers": [], "count": 0}

    iso = globals().get("_lrc_iso")
    now = globals().get("_lrc_now")

    out = []
    for v in rows:
        code = v.get("coupon_code")
        coupon = None
        if code:
            try:
                coupon = await db.coupons.find_one({"code": code}, {"_id": 0})
            except Exception:
                coupon = None
        # Opportunistic "used" backfill: if the EXISTING coupon already has a
        # redemption by this student, mark the voucher used. (Single-use
        # vouchers also flip to "used" purely from uses_count in the composer,
        # so this is a best-effort enrichment, not a correctness dependency.)
        if coupon and not v.get("used_at"):
            for r in (coupon.get("redemptions") or []):
                rid = r.get("student_id") or ""
                if rid == v.get("student_id") or _vrt_norm(rid) == sid_norm:
                    stamp = r.get("redeemed_at") or (iso(now()) if callable(iso) and callable(now) else None)
                    try:
                        await _vrt_student_vouchers.update_one(
                            {"campaign_id": v.get("campaign_id"), "student_id_norm": sid_norm},
                            {"$set": {
                                "used_at": stamp,
                                "redeemed_book_slug": r.get("book_slug"),
                                "status": "used",
                            }},
                        )
                        v["used_at"] = stamp
                        v["redeemed_book_slug"] = r.get("book_slug")
                        v["status"] = "used"
                    except Exception:
                        pass
                    break
        out.append(await _vrt_compose(v))

    return {"vouchers": out, "count": len(out)}


_VRT_LOG.info("voucher_reward_tools: student voucher listing route registered")
