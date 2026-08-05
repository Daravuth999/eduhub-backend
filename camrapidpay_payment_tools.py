# ===========================================================================
# CamRapidPay Points Top Up - EduHub integration tools
#
# Registered via register_camrapidpay_payment_routes(api, db, require_student,
# complete_points_payment) from server.py (normal import, explicit DI --
# matches the established register_*_routes convention; Architecture
# Reconstruction Phase 1, item 2). ``complete_points_payment`` is the
# existing proven credit path (payment_bridge._complete_points_payment)
# passed in explicitly rather than resolved via globals() lookup, so this
# module's conversion is decoupled from payment_bridge.py's own conversion
# timing. The register call returns (reconcile_once, ensure_indexes,
# verify_via_bank_notification) -- reconcile_once for server.py's existing
# 60s background loop, ensure_indexes (Phase 1e, Collection Ownership) so
# server.py's startup handler creates camrapidpay_intents' indexes via this
# owning module instead of touching the collection directly itself, and
# verify_via_bank_notification (Aug 2026 hybrid-verification restore) which
# server.py wires into payment_bridge.py's existing late_binds dict so its
# ABA/Bakong Telegram-notification bridge can offer a second, independent
# confirmation source for a CamRapidPay-created intent.
#
# SECURITY / TRUTH MODEL (non-negotiable):
#   - The webhook is a WAKE-UP TRIGGER ONLY. It never credits from its body.
#   - The ONLY proof of payment is a server-to-server CamRapidPay status call
#     returning Success -- OR (Aug 2026 hybrid-verification restore, see
#     _camrapidpay_verify_via_bank_notification below) a strictly single-
#     matched ABA/Bakong Telegram bank notification via payment_bridge.py's
#     existing bridge, used only as a second confirmation source for the
#     confirmed CamRapidPay reconciliation outage.
#   - All CamRapidPay-Success trigger paths (webhook, polling, "I've paid")
#     funnel through verify_camrapidpay_payment_and_credit_once(reference),
#     UNCHANGED. The bank-notification bridge is a separate function that
#     claims the same camrapidpay_intents document via the same atomic gate.
#   - Crediting is guarded by an ATOMIC find_one_and_update flip so two
#     racing triggers -- from either source -- can never both credit
#     (provably once, regardless of which one arrives first).
#   - Points/amount/currency come from the internal intent (source of truth),
#     never from the frontend or the webhook body.
# ===========================================================================

import logging as _cam_logging
import os as _cam_os
import re as _cam_re
import sys as _cam_sys
import secrets as _cam_secrets
from decimal import Decimal as _Decimal, InvalidOperation as _InvalidOperation
from datetime import datetime, timezone, timedelta

import httpx
from bson import ObjectId
from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel as _CamPM

# Ensure the backend directory (which contains the payment_providers package)
# is importable regardless of the process working directory.
_cam_pkg_dir = _cam_os.path.dirname(_cam_os.path.abspath(__file__))
if _cam_pkg_dir and _cam_pkg_dir not in _cam_sys.path:
    _cam_sys.path.insert(0, _cam_pkg_dir)

from payment_providers import camrapidpay_provider as _cam

_CAM_LOG = _cam_logging.getLogger("eduhub")

# v1.2: how long an intent may sit in "crediting" before the sweep treats it
# as stale (a crash between the atomic flip and the terminal state).
_CAM_CREDITING_STALE_SECONDS = 180  # 3 minutes


class _CamCreateIntent(_CamPM):
    package_id: str


def _cam_amount_matches(expected, got) -> bool:
    """Safe decimal compare of two USD amounts (got may be a string)."""
    try:
        e = _Decimal(str(expected))
        g = _Decimal(str(got))
    except (_InvalidOperation, ValueError, TypeError):
        return False
    # Exact match to the cent; CamRapidPay echoes the amount we set.
    return abs(e - g) <= _Decimal("0.001")


# ---------------------------------------------------------------------------
# v1.6.1 hotfix: EMV TLV → PNG data URI
# ---------------------------------------------------------------------------
# CamRapidPay's ``qr_code`` response field returns the **raw KHQR EMV TLV
# payload string** (e.g. ``00020101021230510016abaakhppxxx@abaa...6304XXXX``)
# — NOT a base64 image or data URI. The v1.6 in-PWA checkout assumed the
# field was already an image, so the student-facing modal correctly fell
# through to "KHQR is temporarily unavailable" because the payload string
# contains characters (``@``, ``:``, etc.) that are not valid base64.
#
# This helper renders the EMV TLV text into a small (1–2 KB) PNG and
# returns a self-contained ``data:image/png;base64,...`` URI which is
# what the frontend already knows how to display. The raw ``qr_code``
# text is still returned unchanged so any other client/automation that
# was already using it continues to work.
#
# ``segno`` is a pure-Python, zero-dependency QR encoder (~120 KB on
# disk). Failure to import is non-fatal: the response simply omits
# ``qr_image`` and the frontend can fall back to its existing handling
# (or render the safe error). No money-movement logic is touched.
# ---------------------------------------------------------------------------
def _cam_emv_to_data_uri(emv_text: str) -> str:
    """Render a KHQR EMV TLV payload into a data:image/png;base64 URI.

    Returns an empty string when ``emv_text`` is empty or rendering fails;
    the caller treats an empty string as "no image available".
    """
    if not emv_text or not isinstance(emv_text, str):
        return ""
    try:
        import io as _qr_io
        import base64 as _qr_base64
        import segno as _qr_segno  # pure-Python, no compiled deps
        # Error level "M" matches the recoverability level used by the
        # major bank apps (ABA / Bakong) when generating their own KHQR.
        # scale=8 gives a crisp ~210 px PNG on retina screens at 24-pt size
        # and stays under 2 KB on the wire for typical KHQR payloads.
        qr = _qr_segno.make(emv_text, error="m")
        buf = _qr_io.BytesIO()
        qr.save(buf, kind="png", scale=8, border=2)
        b64 = _qr_base64.b64encode(buf.getvalue()).decode("ascii")
        return "data:image/png;base64," + b64
    except Exception as exc:  # noqa: BLE001
        # Never break the payment flow on a rendering failure — the
        # student can still scan from the raw EMV text via any wallet
        # that supports paste-payload, and the frontend's safe error
        # block will tell them another method is available.
        try:
            _CAM_LOG.warning(
                "camrapidpay: qr image render failed type=%s",
                type(exc).__name__,
            )
        except Exception:
            pass
        return ""


def register_camrapidpay_payment_routes(api, db, require_student, complete_points_payment):
    """Register CamRapidPay KHQR top-up routes + reconciliation onto ``api``.

    Explicit-DI replacement for the previous ``exec()``-into-server-namespace
    loading. Behaviour is identical: same routes, same storage collections,
    same truth model. Returns ``(_camrapidpay_reconcile_once,
    _camrapidpay_ensure_indexes, _camrapidpay_verify_via_bank_notification)``
    -- the first for the caller's existing 60s background sweep loop, the
    third (Aug 2026 hybrid-verification restore) for wiring into
    payment_bridge.py's late_binds dict as a second confirmation source.
    """
    _cam_intents = db["camrapidpay_intents"]
    _cam_webhook_log = db["camrapidpay_webhook_log"]

    def _cam_httpx_factory():
        """Return an httpx.AsyncClient context manager with safe timeouts."""
        return httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        )

    def _cam_now():
        return datetime.now(timezone.utc)

    async def _cam_load_package(pkg_id):
        """Look up a points package - the SERVER-SIDE source of truth."""
        try:
            doc = await db.payment_settings.find_one({"_id": ObjectId(pkg_id)})
        except Exception:  # noqa: BLE001
            doc = None
        return doc

    async def _camrapidpay_ensure_indexes() -> None:
        """Create camrapidpay_intents indexes. Architecture Reconstruction
        Phase 1e (Collection Ownership): this index creation used to live
        directly in server.py's monolithic startup handler — the collection-
        ownership lint (tools/check_collection_ownership.py) flagged that as
        a second module touching a collection this file owns. Moved here so
        server.py only ever calls the owning module's own function, matching
        the pattern already used by login_reward_tools.py / referral_tools.py
        / login_mystery_box_tools.py. Non-fatal — a Mongo error here can
        never block app boot (server.py's own belt-and-braces try/except
        around the call is the second layer)."""
        try:
            await _cam_intents.create_index("reference", unique=True)
            await _cam_intents.create_index([("status", 1), ("expires_at", 1)])
            _CAM_LOG.info("camrapidpay: indexes ensured")
        except Exception as _idx_exc:  # noqa: BLE001
            _CAM_LOG.warning("camrapidpay: index setup skipped: %s", _idx_exc)

    # -----------------------------------------------------------------------
    # THE one-and-only credit function. Race-proof via atomic status flip.
    # -----------------------------------------------------------------------
    async def verify_camrapidpay_payment_and_credit_once(reference: str) -> dict:
        """Verify a payment with CamRapidPay and credit points exactly once.

        Called by: webhook, status polling, and "I've paid - check now".
        Returns a dict describing the resulting state. Never raises.

        TRUTH MODEL (v1.4):
          - The ONLY thing that authorizes a credit is a server-to-server
            CamRapidPay status call returning Success. Webhook body is never
            trusted for crediting OR for blocking.
          - The atomic claim filter accepts pending / paid / expired (v1.4).
            "expired" is included so a legitimately paid intent that was marked
            expired locally before provider confirmation can still be credited
            once via the atomic gate. paid_not_credited is NOT claimable because
            we cannot prove a prior attempt did not already credit at GAS
            (_complete_points_payment is NOT reference-idempotent - Blocker 4).
          - Local expiry (now > expires_at) only marks "expired" when the
            provider does NOT say Success. A late SUCCESS still credits, because
            payment really happened for our unique reference (Blocker 3).
          - Webhook mismatch is audit-only and never moves status, so it can
            never block a real Success (Blocker 1 fix - enforced in the webhook
            handler; this function ignores webhook fields entirely).

        Flow:
          1. Load intent. If already credited -> idempotent no-op.
          2. If manual_review -> return immediately (human must resolve).
          3. If crediting -> return pending (sweep handles stale case).
          4. [expired falls through - v1.4] Server-to-server status check.
          5. If Success -> atomic claim (pending|paid|expired) -> credit once.
          6. If not Success and locally expired -> mark expired.
          7. Otherwise -> still pending.
        """
        intent = await _cam_intents.find_one({"reference": reference})
        if not intent:
            return {"ok": False, "status": "not_found", "credited": False}

        # Already done? Idempotent.
        if intent.get("status") == "credited" or intent.get("credited_at"):
            return {
                "ok": True, "status": "credited", "credited": True,
                "points_added": int(intent.get("base_points", 0)),
                "bonus_points": int(intent.get("bonus_points", 0)),
                "total_points": int(intent.get("total_points", 0)),
            }

        # manual_review: a human must resolve this intent. Auto-processing would
        # risk crediting an outcome that is already under investigation. Terminal.
        if intent.get("status") == "manual_review":
            return {"ok": True, "status": "manual_review", "credited": False}

        # crediting: the atomic claim is held (possibly by another concurrent
        # call or a mid-crash process). Do not call the status API again here;
        # the reconcile sweep handles stale crediting -> manual_review. Return a
        # safe non-blocking response so the caller knows to wait.
        if intent.get("status") == "crediting":
            return {"ok": True, "status": "pending", "credited": False}

        # v4.1 security hardening: a "failed" intent means create_payment never
        # produced a provider invoice (e.g. provider HTTP 500, auth rejected).
        # There is NO point hitting check-transaction-api for a reference the
        # provider never received — that just wastes a request and (before the
        # logging filter was added) leaked the api_key in the URL. Short-circuit
        # the entire verify path so this reference is dormant. The sweep filter
        # ({"status": {"$in": ["pending","paid"]}}) already excludes failed.
        if intent.get("status") == "failed":
            return {"ok": True, "status": "failed", "credited": False}

        # v1.4 fix: do NOT treat local "expired" as a terminal state before
        # checking the provider. A student may have paid just before the 5-minute
        # window closed, but our local expiry sweep ran first. CamRapidPay is the
        # authority: if it returns Success for our reference, we credit once.
        # If it does NOT return Success and the intent is locally expired, the
        # existing expiry logic below marks it expired.
        # (Previously this block returned immediately for "expired", preventing
        #  any recovery for legitimately paid late intents - Blocker fixed here.)

        # ---- Server-to-server verification: the ONLY proof of payment ----
        status_res = await _cam.check_status(_cam_httpx_factory, reference)
        if not status_res.get("ok"):
            # Diagnostics fix (production incident, Aug 2026): this branch was
            # previously silent — a transport failure or provider outage left
            # zero trace, indistinguishable in logs from an invoice that was
            # simply never checked. Transport failure - do NOT change state,
            # let caller / sweep retry (behavior unchanged).
            _CAM_LOG.warning(
                "camrapidpay: verify ref=%s check_status not ok error=%s -> staying %s",
                reference, status_res.get("error"), intent.get("status", "pending"),
            )
            return {"ok": False, "status": intent.get("status", "pending"),
                    "credited": False, "error": "status_unavailable"}

        prov_status = status_res.get("status")

        # Local expiry check (Blocker 3). Compute once.
        now = _cam_now()
        expired_locally = False
        try:
            exp_raw = intent.get("expires_at", "")
            if exp_raw:
                exp_dt = datetime.fromisoformat(exp_raw)
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
                expired_locally = now > exp_dt
        except Exception:  # noqa: BLE001
            expired_locally = False

        # If the provider explicitly says Expired, OR (not Success AND locally
        # expired), mark expired and stop. A late SUCCESS still credits below.
        if prov_status == _cam.STATUS_EXPIRED or (prov_status != _cam.STATUS_SUCCESS and expired_locally):
            await _cam_intents.update_one(
                {"reference": reference, "status": {"$nin": ["credited"]}, "credited_at": None},
                {"$set": {"status": "expired", "updated_at": now.isoformat()}},
            )
            return {"ok": True, "status": "expired", "credited": False}

        if prov_status != _cam.STATUS_SUCCESS:
            # Diagnostics fix: this was the single most consequential silent
            # branch in the whole module. Every verify call that doesn't
            # result in a credit ends up here or above; without a log line,
            # "stuck pending forever" and "genuinely still unpaid" are
            # indistinguishable from Render logs. Still pending and not yet
            # expired - keep waiting (behavior unchanged).
            _CAM_LOG.info(
                "camrapidpay: verify ref=%s provider_status=%s expired_locally=%s -> still pending",
                reference, prov_status, expired_locally,
            )
            return {"ok": True, "status": "pending", "credited": False}

        # ---- Payment verified Success. ATOMIC flip to claim the credit. ----
        # v1.3: only pending|paid are claimable. paid_not_credited is intentionally
        # NOT in this set - it is treated as unknown-outcome (Blocker 4 fix) and
        # must be resolved by a human via manual_review. Allowing claim of an
        # intent that a fake webhook may have nudged is still safe here, but ONLY
        # because we ourselves just verified Success server-to-server.
        # v1.4: include "expired" in the claim filter so a legitimately paid
        # intent that was marked expired locally before the provider confirmed
        # Success can still be credited once (atomic gate still prevents double).
        claimed = await _cam_intents.find_one_and_update(
            {"reference": reference,
             "status": {"$in": ["pending", "paid", "expired"]},
             "credited_at": None},
            {"$set": {"status": "crediting",
                      "verified_at": now.isoformat(),
                      "crediting_at": now.isoformat()}},  # v1.2: stale-recovery marker
        )
        if not claimed:
            # Someone else won the race (or already crediting/credited).
            fresh = await _cam_intents.find_one({"reference": reference})
            already = bool(fresh and (fresh.get("status") == "credited" or fresh.get("credited_at")))
            return {
                "ok": True,
                "status": "credited" if already else (fresh.get("status") if fresh else "pending"),
                "credited": already,
                "points_added": int(fresh.get("base_points", 0)) if fresh else 0,
                "bonus_points": int(fresh.get("bonus_points", 0)) if fresh else 0,
                "total_points": int(fresh.get("total_points", 0)) if fresh else 0,
            }

        # We are the sole winner. Credit via the EXISTING proven once-only path.
        student_id = claimed.get("student_id")
        pkg = {
            "label":        claimed.get("package_label", "KHQR Top-Up"),
            "points":       int(claimed.get("base_points", 0)),
            "bonus_points": int(claimed.get("bonus_points", 0)),
        }
        txn = {
            "transaction_id": claimed.get("reference"),   # stable idempotency base
            "apv":            "",
            "order_id":       claimed.get("reference"),
            "amount":         claimed.get("amount_khr", 0),
            "source":         "camrapidpay",
        }
        # v1.3 Blocker 4 fix: an EXCEPTION here is an UNKNOWN OUTCOME. We cannot
        # tell whether the exception happened before GAS was called (safe) or
        # AFTER GAS already credited (catastrophic if we retry). Because
        # _complete_points_payment is NOT reference-idempotent (it uses a fresh
        # random nonce and has no GAS-side dedup), automatic retry could double-
        # credit. Money-safety rule: unknown outcome MUST go to manual_review so a
        # human verifies the points history / GAS / payment logs and closes it
        # out. credited_at stays null. The atomic claim filter no longer accepts
        # manual_review, so this intent is locked from any auto-retry path.
        try:
            credit_res = await complete_points_payment(db, student_id, txn, pkg)
        except Exception as _credit_exc:  # noqa: BLE001
            await _cam_intents.update_one(
                {"reference": reference, "credited_at": None},
                {"$set": {"status": "manual_review",
                          "error_message":
                              f"credit_exception_unknown_outcome:{type(_credit_exc).__name__}"[:200],
                          "updated_at": _cam_now().isoformat()}},
            )
            _CAM_LOG.error(
                "camrapidpay: credit raised %s ref=%s -> manual_review "
                "(UNKNOWN OUTCOME; do NOT auto-retry GAS - not reference-idempotent)",
                type(_credit_exc).__name__, reference,
            )
            return {"ok": False, "status": "manual_review", "credited": False}

        if credit_res.get("ok"):
            try:
                await _cam_intents.update_one(
                    {"reference": reference},
                    {"$set": {
                        "status":       "credited",
                        "credited_at":  _cam_now().isoformat(),
                        "points_added": pkg["points"] + pkg["bonus_points"],
                        "crediting_at": None,  # clear stale marker on success
                    }},
                )
            except Exception as _mark_exc:  # noqa: BLE001
                # GAS credited but we could not mark "credited". Do NOT retry the
                # GAS call (not idempotent). The sweep will find this stuck
                # "crediting" intent and route it to manual_review for a human to
                # confirm the single GAS credit and close it out. Log loudly.
                _CAM_LOG.error(
                    "camrapidpay: CREDIT SUCCEEDED but mark-credited FAILED ref=%s err=%s "
                    "(sweep will route to manual_review; do NOT auto-retry GAS)",
                    reference, type(_mark_exc).__name__,
                )
                return {"ok": True, "status": "crediting", "credited": True,
                        "points_added": pkg["points"], "bonus_points": pkg["bonus_points"],
                        "total_points": pkg["points"] + pkg["bonus_points"]}
            _CAM_LOG.info("camrapidpay: credited %s pts to %s ref=%s",
                          pkg["points"] + pkg["bonus_points"], student_id, reference)
            return {
                "ok": True, "status": "credited", "credited": True,
                "points_added": pkg["points"],
                "bonus_points": pkg["bonus_points"],
                "total_points": pkg["points"] + pkg["bonus_points"],
            }

        # v1.3 Blocker 4 fix: an ok:false return is ALSO an UNKNOWN OUTCOME
        # unless the helper can prove it failed pre-credit. Because
        # _complete_points_payment is not reference-idempotent and does not
        # distinguish pre-credit-validation failures from post-GAS-error failures
        # in its return value, we treat ok:false as unknown and route to
        # manual_review. The safer-default rule: only clearly pre-credit
        # validation failures may ever be paid_not_credited; we have no such
        # guarantee from this helper today, so we never set paid_not_credited
        # from this code path. credited_at stays null.
        await _cam_intents.update_one(
            {"reference": reference, "credited_at": None},
            {"$set": {"status": "manual_review",
                      "error_message":
                          f"credit_unknown_outcome:{str(credit_res.get('error', ''))[:160]}",
                      "updated_at": _cam_now().isoformat()}},
        )
        _CAM_LOG.error(
            "camrapidpay: verified but credit returned ok:false ref=%s err=%s -> manual_review "
            "(UNKNOWN OUTCOME; do NOT auto-retry GAS - not reference-idempotent)",
            reference, credit_res.get("error"),
        )
        return {"ok": False, "status": "manual_review", "credited": False}

    # -------------------------------------------------------------------
    # Hybrid verification restore (Aug 2026 incident) — bank-notification
    # bridge, second verification source
    # -------------------------------------------------------------------
    # ROOT CAUSE (confirmed with bank receipt + CamRapidPay's own merchant
    # dashboard, both cross-checked against Render logs): CamRapidPay is not
    # a custodial processor here — KHQR settlement lands directly in our
    # linked Bakong/ABA account the instant a student pays. check-transaction
    # -api is supposed to separately confirm that settlement and report
    # Success; that reconciliation step is broken on CamRapidPay's side —
    # confirmed transactions sit in "Pending" on BOTH their API and their own
    # dashboard indefinitely (support case pending with CamRapidPay).
    #
    # This restores the hybrid resilience the ABA/manual flow already has:
    # payment_bridge.py's existing Telegram-notification bridge (proven in
    # production for ABA PayWay notifications, "via Bakong" transfers
    # included per _parse_payway_message's own payment_method capture) is
    # wired here as a SECOND, independent confirmation source for a
    # CamRapidPay-created intent — used only when CamRapidPay's own
    # check-transaction-api hasn't (yet, or ever) reported Success.
    #
    # Everything else about the money-safety model is reused, not
    # reinvented:
    #   - verify_camrapidpay_payment_and_credit_once() above is NOT modified
    #     and remains the CamRapidPay-Success path exactly as today.
    #   - This function claims the SAME camrapidpay_intents document via the
    #     SAME atomic find_one_and_update flip (status pending/paid/expired
    #     + credited_at:None -> "crediting"), so MongoDB's own atomicity is
    #     what guarantees "credited only once regardless of which source
    #     arrives first" — whichever caller's find_one_and_update reaches
    #     Mongo first wins the claim; the other sees claimed=None and safely
    #     no-ops. No new locking mechanism, no schema change to the intent
    #     model, no change to duplicate-credit protection.
    #   - Both paths converge on the exact same complete_points_payment(...)
    #     call (the same parameter both this module and payment_bridge.py
    #     have shared since Phase 1's explicit-DI conversion) — the same
    #     wallet update, the same downstream receipt/notification flow.
    #   - Strict single-match discipline mirrors payment_bridge.py's own
    #     _find_best_intent(): exact amount match, unexpired only, and an
    #     AMBIGUOUS match (more than one candidate) is never auto-credited —
    #     routed to manual_review exactly like an unknown credit outcome, so
    #     a human decides rather than the system guessing.
    async def _camrapidpay_verify_via_bank_notification(txn: dict) -> dict:
        """Second confirmation source for a CamRapidPay-created intent.

        Called by payment_bridge.py's _process_transaction() ONLY when its
        own ABA-intent (payment_intents) matching found nothing — this never
        competes with or alters that existing matching/scoring/dispatch path.
        ``txn`` is the SAME parsed-transaction dict shape payment_bridge.py
        already stores in payment_transactions (amount, currency,
        transaction_id, apv, payer_name, ...).

        Returns {"status": "no_match"|"ambiguous"|"already_claimed"|
        "credited"|"manual_review", "credited": bool, "reference": str|None,
        ...}. Never raises.
        """
        try:
            txn_amount = float(txn.get("amount", 0) or 0)
        except (TypeError, ValueError):
            return {"status": "no_match", "credited": False, "reference": None}
        currency = str(txn.get("currency", "USD")).upper()
        now = _cam_now()

        def _amount_matches_intent(intent: dict) -> bool:
            # Compare against whichever side of the intent matches the
            # notification's own currency, exactly like payment_bridge.py's
            # own strict-match compares against amount_khr for KHR notices.
            if currency == "KHR":
                return _cam_amount_matches(intent.get("amount_khr", 0), txn_amount)
            return _cam_amount_matches(intent.get("amount", 0), txn_amount)

        try:
            candidates_raw = _cam_intents.find({
                "provider": "camrapidpay",
                "status": {"$in": ["pending", "paid"]},
                "credited_at": None,
            }).limit(200)
            candidates = [d async for d in candidates_raw]
        except Exception:  # noqa: BLE001
            return {"status": "no_match", "credited": False, "reference": None}

        matches = []
        for intent in candidates:
            exp_raw = intent.get("expires_at", "")
            try:
                exp_dt = datetime.fromisoformat(exp_raw) if exp_raw else None
                if exp_dt and exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            except Exception:  # noqa: BLE001
                exp_dt = None
            if exp_dt and now > exp_dt:
                continue  # locally expired -- not a candidate for this bridge
            if _amount_matches_intent(intent):
                matches.append(intent)

        if len(matches) == 0:
            # Secondary check: the live pending/paid search found nothing,
            # but this notification might simply confirm a payment CamRapidPay's
            # own path already credited moments ago (the common race outcome
            # once both sources are active). Bounded to RECENTLY credited
            # intents only -- deliberately NOT an unbounded search, so a
            # coincidental amount match against some unrelated transaction
            # credited days/weeks ago (e.g. every past $0.50 top-up) can
            # never falsely report "already claimed" or pollute future
            # ambiguity checks.
            try:
                recent_cutoff = (now - timedelta(seconds=_CAM_CREDITING_STALE_SECONDS * 5)).isoformat()
                recently_credited_raw = _cam_intents.find({
                    "provider": "camrapidpay",
                    "status": "credited",
                    "credited_at": {"$gt": recent_cutoff},
                }).limit(50)
                recently_credited = [d async for d in recently_credited_raw
                                      if _amount_matches_intent(d)]
            except Exception:  # noqa: BLE001
                recently_credited = []
            if len(recently_credited) == 1:
                ref = recently_credited[0].get("reference", "")
                _CAM_LOG.info(
                    "camrapidpay: bank-notification bridge ref=%s already credited via another "
                    "source moments ago -> no double credit",
                    ref,
                )
                return {"status": "already_claimed", "credited": True, "reference": ref}
            return {"status": "no_match", "credited": False, "reference": None}
        if len(matches) > 1:
            _CAM_LOG.warning(
                "camrapidpay: bank-notification bridge AMBIGUOUS %d candidates for amount=%s%s "
                "-> not auto-crediting (never guess)",
                len(matches), txn_amount, currency,
            )
            return {"status": "ambiguous", "credited": False, "reference": None,
                    "candidate_count": len(matches)}

        reference = matches[0].get("reference", "")

        # ---- Same atomic claim verify_camrapidpay_payment_and_credit_once
        # uses on the SAME collection -- this is the single-winner gate. ----
        claimed = await _cam_intents.find_one_and_update(
            {"reference": reference,
             "status": {"$in": ["pending", "paid", "expired"]},
             "credited_at": None},
            {"$set": {"status": "crediting",
                      "verified_at": now.isoformat(),
                      "crediting_at": now.isoformat(),
                      "credited_via": "bank_notification"}},
        )
        if not claimed:
            # CamRapidPay's own check (or a concurrent bank-notification
            # bridge call) already won the race for this reference.
            fresh = await _cam_intents.find_one({"reference": reference})
            already = bool(fresh and (fresh.get("status") == "credited" or fresh.get("credited_at")))
            _CAM_LOG.info(
                "camrapidpay: bank-notification bridge ref=%s lost the atomic claim "
                "(already %s) -> no double credit",
                reference, "credited" if already else (fresh.get("status") if fresh else "gone"),
            )
            return {"status": "already_claimed", "credited": already, "reference": reference}

        student_id = claimed.get("student_id")
        pkg = {
            "label":        claimed.get("package_label", "KHQR Top-Up"),
            "points":       int(claimed.get("base_points", 0)),
            "bonus_points": int(claimed.get("bonus_points", 0)),
        }
        credit_txn = {
            "transaction_id": str(txn.get("transaction_id") or reference),
            "apv":            str(txn.get("apv") or ""),
            "order_id":       reference,
            "amount":         claimed.get("amount_khr", 0),
            "source":         "camrapidpay_bank_notification",
        }
        try:
            credit_res = await complete_points_payment(db, student_id, credit_txn, pkg)
        except Exception as _credit_exc:  # noqa: BLE001
            await _cam_intents.update_one(
                {"reference": reference, "credited_at": None},
                {"$set": {"status": "manual_review",
                          "error_message":
                              f"bank_notification_credit_exception_unknown_outcome:{type(_credit_exc).__name__}"[:200],
                          "updated_at": _cam_now().isoformat()}},
            )
            _CAM_LOG.error(
                "camrapidpay: bank-notification bridge credit raised %s ref=%s -> manual_review "
                "(UNKNOWN OUTCOME; do NOT auto-retry GAS - not reference-idempotent)",
                type(_credit_exc).__name__, reference,
            )
            return {"status": "manual_review", "credited": False, "reference": reference}

        if credit_res.get("ok"):
            try:
                await _cam_intents.update_one(
                    {"reference": reference},
                    {"$set": {
                        "status":       "credited",
                        "credited_at":  _cam_now().isoformat(),
                        "points_added": pkg["points"] + pkg["bonus_points"],
                        "crediting_at": None,
                    }},
                )
            except Exception as _mark_exc:  # noqa: BLE001
                _CAM_LOG.error(
                    "camrapidpay: bank-notification bridge CREDIT SUCCEEDED but mark-credited FAILED "
                    "ref=%s err=%s (sweep will route to manual_review; do NOT auto-retry GAS)",
                    reference, type(_mark_exc).__name__,
                )
                return {"status": "crediting", "credited": True, "reference": reference,
                        "points_added": pkg["points"] + pkg["bonus_points"]}
            _CAM_LOG.info(
                "camrapidpay: bank-notification bridge credited %s pts to %s ref=%s",
                pkg["points"] + pkg["bonus_points"], student_id, reference,
            )
            return {"status": "credited", "credited": True, "reference": reference,
                     "points_added": pkg["points"] + pkg["bonus_points"]}

        await _cam_intents.update_one(
            {"reference": reference, "credited_at": None},
            {"$set": {"status": "manual_review",
                      "error_message":
                          f"bank_notification_credit_unknown_outcome:{str(credit_res.get('error', ''))[:160]}",
                      "updated_at": _cam_now().isoformat()}},
        )
        _CAM_LOG.error(
            "camrapidpay: bank-notification bridge matched but credit returned ok:false ref=%s err=%s "
            "-> manual_review (UNKNOWN OUTCOME; do NOT auto-retry GAS)",
            reference, credit_res.get("error"),
        )
        return {"status": "manual_review", "credited": False, "reference": reference}

    # -------------------------------------------------------------------
    # Endpoint 1: create intent  (authenticated student)
    # -------------------------------------------------------------------
    @api.get("/payments/camrapidpay/config")
    async def camrapidpay_config():
        """Lightweight config check — no invoice created, no DB write, no auth.

        Returns ``{"enabled": bool, "reason": str}`` so the frontend can show or
        hide the KHQR button without calling create-intent as a probe.

        NOTE on auth: this endpoint is intentionally PUBLIC. It returns only a
        boolean feature flag plus a coarse, non-sensitive reason code — no API
        keys, no callback URLs, no merchant IDs are exposed. Making it public
        eliminates a class of iOS Safari ITP / cross-site cookie failures that
        otherwise silently hides the KHQR button (frontend swallows 401 as
        ``enabled: false``).

        The ``reason`` codes are admin-friendly diagnostics, never secrets:
          * ``"ok"``                – feature is live
          * ``"flag_off"``          – ``CAMRAPIDPAY_ENABLED`` is not ``"true"``
          * ``"missing_api_key"``   – flag is on but ``CAMRAPIDPAY_API_KEY`` is empty
          * ``"missing_base_url"``  – flag is on but ``CAMRAPIDPAY_BASE_URL`` is empty
        """
        enabled = (_cam_os.environ.get("CAMRAPIDPAY_ENABLED", "false").strip().lower() == "true")
        api_key = _cam_os.environ.get("CAMRAPIDPAY_API_KEY", "").strip()
        base_url = _cam_os.environ.get("CAMRAPIDPAY_BASE_URL", "").strip()
        if not enabled:
            return {"enabled": False, "reason": "flag_off"}
        if not api_key:
            return {"enabled": False, "reason": "missing_api_key"}
        if not base_url:
            return {"enabled": False, "reason": "missing_base_url"}
        # Final sanity: ask the provider helper too (catches anything the helper
        # may add in the future). Still no secrets leaked.
        if not _cam.is_enabled():
            return {"enabled": False, "reason": "provider_disabled"}
        return {"enabled": True, "reason": "ok"}

    @api.post("/payments/camrapidpay/create-intent")
    async def camrapidpay_create_intent(payload: _CamCreateIntent, student=Depends(require_student)):
        """Create a CamRapidPay KHQR invoice for a points package.

        Student-facing UI labels this 'KHQR Payment'. Amount + points come from
        the package (server-side source of truth); the frontend only sends a
        package_id.
        """
        if not _cam.is_enabled():
            # Dormant - tell frontend to use the existing fallback.
            return {"success": False, "error": "khqr_unavailable", "fallback": True}

        pkg = await _cam_load_package(payload.package_id)
        if not pkg or not pkg.get("active", True):
            raise HTTPException(status_code=404, detail="Package not found")

        amount_khr = int(pkg.get("amount_khr", 0) or 0)
        base_points = int(pkg.get("points", 0))
        bonus_points = int(pkg.get("bonus_points", 0))
        total_points = base_points + bonus_points
        # v4 (USD packages): a package is valid if EITHER amount_usd > 0 OR
        # amount_khr > 0 (we'll cross-derive the missing side below). Points
        # still must be > 0.
        try:
            _pkg_amount_usd_probe = float(pkg.get("amount_usd") or 0)
        except (ValueError, TypeError):
            _pkg_amount_usd_probe = 0.0
        if (amount_khr <= 0 and _pkg_amount_usd_probe <= 0) or total_points <= 0:
            raise HTTPException(status_code=400, detail="Invalid package configuration")

        # CamRapidPay is invoiced in USD (the CamRapidPay Client Portal explicitly
        # asks for "Amount (USD)" and renders the checkout / KHQR invoice in USD).
        # Convert the package KHR price -> USD using a fixed configurable rate.
        #
        # v3 (USD gateway restore, 4000 rate):
        #   - Rate is read from CAMRAPIDPAY_USD_KHR_RATE (default 4000).
        #   - Default is 4000 (not 4100) per product owner instruction.
        #   - If the package has an explicit positive ``amount_usd`` field we
        #     prefer it (lets ops tune individual packages); otherwise we
        #     compute amount_usd = round(amount_khr / rate, 2).
        # Student-facing UI still displays the package in KHR / ៛ — only the
        # provider gateway leg is denominated in USD.
        try:
            _rate_raw = _cam_os.environ.get("CAMRAPIDPAY_USD_KHR_RATE", "4000").strip()
            _khr_per_usd = float(_rate_raw) if _rate_raw else 4000.0
            if _khr_per_usd <= 0:
                _khr_per_usd = 4000.0
        except (ValueError, TypeError):
            _khr_per_usd = 4000.0

        amount_usd_pkg = pkg.get("amount_usd")
        try:
            amount_usd_pkg = float(amount_usd_pkg) if amount_usd_pkg is not None else None
        except (ValueError, TypeError):
            amount_usd_pkg = None
        if amount_usd_pkg is not None and amount_usd_pkg > 0:
            amount_usd = round(amount_usd_pkg, 2)
        else:
            amount_usd = round(amount_khr / _khr_per_usd, 2)
        amount_usd = float(amount_usd)
        if amount_usd <= 0:
            raise HTTPException(status_code=400, detail="Invalid package amount")

        # v4 (USD packages): if the admin authored a USD-only package the
        # ``amount_khr`` field on disk is 0. Derive it from the USD price using
        # the same rate so the ABA / manual matching path (which keys on
        # amount_khr) and the intent doc (which stores amount_khr for downstream
        # crediting reference) both keep working.
        if amount_khr <= 0:
            amount_khr = int(round(amount_usd * _khr_per_usd))

        student_id = getattr(student, "clean_id", None) or getattr(student, "student_id", "")
        short_ts = _cam_now().strftime("%m%d%H%M%S")
        rand = _cam_secrets.token_hex(3)
        # v4.4 contract fix: CamRapidPay silently rejects references starting with
        # ``POI-`` (or any non-test-style prefix) with the generic HTTP 500
        # ``Failed to generate KHQR``. Operator-confirmed direct PowerShell tests
        # on the SAME API key (verified by api_key_fingerprint match) succeed
        # only with prefixes like ``TEST050-...``, ``TEST125-...``,
        # ``MANUAL-TEST-...``. Switching to a neutral ``EDUHUB-`` prefix with
        # NO student_id leak matches the proven shape and removes the only
        # remaining variable. Reference is UPPER + HYPHEN + alnum only,
        # ≤ 50 chars. The student is still tracked via the intent doc
        # (``student_id`` column) — only the gateway-facing reference changes.
        _rand_upper = str(rand).upper()
        reference = f"EDUHUB-{short_ts}-{_rand_upper}"
        # Defence-in-depth: ensure charset is [A-Z0-9-] and clip.
        reference = _cam_re.sub(r"[^A-Z0-9-]+", "-", reference.upper())
        reference = _cam_re.sub(r"-+", "-", reference).strip("-")[:50]

        now = _cam_now()
        expires = now + timedelta(minutes=5)  # CamRapidPay expiry

        cfg = _cam.read_config()
        base_webhook = cfg.get("callback_url") or "https://eduhub-backend-td3a.onrender.com/api/payments/camrapidpay/webhook"
        # v4.2 contract fix: CamRapidPay's create-payments endpoint rejects (HTTP
        # 500 "Failed to generate KHQR") when ``webhook_url`` contains a
        # query string. The official docs example uses a clean URL
        # (``https://yourdomain.com/webhook/callback`` — no query). Therefore we
        # send the bare ``base_webhook`` to the gateway and rely on the existing
        # server-to-server status check + atomic single-credit gate as the
        # security primitive. The webhook handler now treats the body as a
        # wake-up trigger only (status comes from check-transaction-api), so the
        # ``?token=...`` defense-in-depth is no longer required at the URL level.
        webhook_url = base_webhook
        # Append the internal intent ID to the return URL so the frontend can
        # recover the pending intent after CamRapidPay redirects the student back.
        # The intent_id is not a secret - it is a MongoDB ObjectId used only as
        # a lookup key. Crediting is always decided by server-to-server status
        # check, never by the URL alone.
        _return_base = (cfg.get("return_url") or "").rstrip("/")
        # v4.4: ``success_url`` is sent to CamRapidPay as a CLEAN base URL with
        # NO query string. The internal intent ObjectId is no longer placed
        # in the redirect URL (CamRapidPay's gateway rejects URLs that carry
        # a query). See the comment above the create_payment() call for
        # details.

        # Insert internal pending intent FIRST (so a fast webhook can find it).
        intent_doc = {
            "provider":            "camrapidpay",
            "student_id":          student_id,
            "package_id":          payload.package_id,
            "package_label":       pkg.get("label", "KHQR Top-Up"),
            "amount":              amount_usd,
            "amount_khr":          amount_khr,
            "currency":            "USD",
            "base_points":         base_points,
            "bonus_points":        bonus_points,
            "total_points":        total_points,
            "reference":           reference,
            "internal_order_id":   reference,
            "provider_invoice_id": "",
            "status":              "pending",
            "credited_at":         None,
            "created_at":          now.isoformat(),
            "expires_at":          expires.isoformat(),
            "raw_provider_response": {},
            "raw_webhook_payload": {},
            "idempotency_key":     reference,
            "error_message":       "",
        }
        ins = await _cam_intents.insert_one(intent_doc)

        # Call CamRapidPay to create the invoice.
        # v4.4 contract fix: CamRapidPay's create-payments endpoint silently
        # rejects (HTTP 500 "Failed to generate KHQR") when ``success_url``
        # contains ANY query string. v4.2 already cleaned ``webhook_url`` for
        # the same reason; v4.3 cleaned the reference; the v4.3 diagnostic log
        # accidentally hid this remaining mismatch via ``_safe_url_path()``
        # which strips queries before display. Operator-confirmed PowerShell
        # tests with the SAME API key (api_key_fingerprint match) succeed only
        # with a CLEAN ``success_url`` (no ``?khqr_intent=...``).
        #
        # The internal intent ObjectId is NOT a secret, but it is also not
        # needed in the redirect URL: the frontend's existing modal-state
        # polling + sessionStorage recovery covers the "student returns to tab"
        # case. Crediting was, is, and remains decided ONLY by the
        # server-to-server status check — never by the redirect URL.
        success_url = _return_base  # clean — no query string

        created = await _cam.create_payment(
            _cam_httpx_factory, amount_usd, reference, success_url, webhook_url,
        )
        if not created.get("ok"):
            # v4.1 security hardening: mark the intent failed AND force the
            # expiry into the past so the reconcile sweep (which still also
            # filters by expires_at > now) can never pick it up. The intent
            # exists on disk for audit only; no further check-transaction-api
            # request will be issued for this reference.
            _past_iso = (_cam_now() - timedelta(days=1)).isoformat()
            await _cam_intents.update_one(
                {"_id": ins.inserted_id},
                {"$set": {
                    "status":        "failed",
                    "error_message": str(created.get("error", ""))[:200],
                    "expires_at":    _past_iso,
                    "updated_at":    _cam_now().isoformat(),
                }},
            )
            _CAM_LOG.warning(
                "camrapidpay: create-intent FAILED ref=%s reason=%s (no provider invoice; "
                "polling suppressed)",
                reference, str(created.get("error", ""))[:80],
            )
            raise HTTPException(status_code=502, detail="Could not create KHQR payment. Please try again.")

        await _cam_intents.update_one(
            {"_id": ins.inserted_id},
            {"$set": {
                "provider_invoice_id":   created.get("bill_number", ""),
                "raw_provider_response": created.get("raw", {}),
            }},
        )

        # v1.6.1 hotfix: CamRapidPay's ``qr_code`` is the raw KHQR EMV TLV
        # payload text, not an image. Pre-render it into a tiny PNG data URI
        # (``qr_image``) so the in-PWA checkout can simply <img src=...>. The
        # raw text is preserved in ``qr_code`` for any consumer that wants it.
        _qr_emv_text = created.get("qr_code", "") or ""
        _qr_image_data_uri = _cam_emv_to_data_uri(_qr_emv_text)

        return {
            "success":            True,
            "payment_intent_id":  str(ins.inserted_id),
            "provider":           "camrapidpay",
            "provider_invoice_id": created.get("bill_number", ""),
            "reference":          reference,
            # v3: ``amount`` remains the USD gateway amount (back-compat with any
            # existing consumer); ``amount_khr`` is what the student-facing
            # KHQR/Bakong screen renders. ``currency`` stays USD because that is
            # the currency the CamRapidPay invoice is denominated in.
            "amount":             amount_usd,
            "amount_khr":         amount_khr,
            "amount_usd":         amount_usd,
            "currency":           "USD",
            "payment_url":        created.get("payment_url", ""),
            "qr_code":            _qr_emv_text,
            # v1.6.1: new fields for the in-PWA renderer.
            "qr_image":           _qr_image_data_uri,
            "qr_payload":         _qr_emv_text,
            "qr_available":       bool(_qr_image_data_uri),
            "expires_at":         expires.isoformat(),
            "base_points":        base_points,
            "bonus_points":       bonus_points,
            "total_points":       total_points,
        }

    # -------------------------------------------------------------------
    # Endpoint 2: webhook  (public + token filter; trigger only, never proof)
    # -------------------------------------------------------------------
    @api.post("/payments/camrapidpay/webhook")
    async def camrapidpay_webhook(request: Request):
        """CamRapidPay payment notification. WAKE-UP TRIGGER ONLY.

        This endpoint NEVER credits from the webhook body. It records the raw
        payload, then calls the server-to-server verify-and-credit-once function,
        which is the only thing that can authorize a credit.
        """
        cfg = _cam.read_config()
        # v4.2 contract fix: the ``?token=...`` query-string defense-in-depth was
        # removed from the webhook URL we register with CamRapidPay (the gateway
        # rejects webhook URLs that contain query strings — see PATCH_NOTES.md).
        # We accept the webhook on any path now and rely on the existing
        # security primitives that were ALREADY the source of truth before this
        # patch:
        #   1. The ``reference`` must already exist in our intents collection
        #      (random callers cannot guess our ObjectId-derived references).
        #   2. The atomic credit gate refuses to credit twice for the same
        #      reference, even under concurrent webhook+poll calls.
        #   3. The actual credit decision is made by a server-to-server call
        #      to CamRapidPay's check-transaction-api -- the webhook body is
        #      NEVER trusted for status.
        # If a ``token`` is present (legacy webhook URLs registered with the
        # previous version) we still validate it for back-compat; if absent we
        # accept the call and let the credit gate decide.
        if cfg and cfg.get("webhook_secret"):
            token = request.query_params.get("token", "")
            if token and token != cfg["webhook_secret"]:
                _CAM_LOG.warning("camrapidpay: webhook rejected - bad token (legacy URL)")
                raise HTTPException(status_code=403, detail="forbidden")

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}

        reference = str(body.get("reference", "")).strip()
        # Audit log every webhook regardless of outcome.
        try:
            await _cam_webhook_log.insert_one({
                "reference":   reference,
                "received_at": _cam_now().isoformat(),
                "payload":     body,
            })
        except Exception:  # noqa: BLE001
            pass

        if not reference:
            return {"received": True}

        # v1.1 Blocker 1 fix: the webhook body is AUDIT-ONLY. A webhook is
        # unsigned, so a fake/malformed one must NEVER move the intent's status
        # (it could otherwise push a real, payable intent into a blocked state
        # that the atomic credit gate refuses). We record the webhook and any
        # amount/currency discrepancy as plain audit FIELDS, then let the trusted
        # server-to-server status check decide everything.
        intent = await _cam_intents.find_one({"reference": reference})
        if intent:
            wh_amount = body.get("amount")
            wh_currency = str(body.get("currency", "USD")).upper()
            amount_ok = _cam_amount_matches(intent.get("amount", 0), wh_amount)
            currency_ok = (wh_currency == str(intent.get("currency", "USD")).upper())
            audit_set = {"raw_webhook_payload": body}
            if not (amount_ok and currency_ok):
                # Audit ONLY - does NOT change status, does NOT block crediting.
                audit_set["webhook_mismatch"] = True
                audit_set["webhook_mismatch_reason"] = (
                    f"amount got={wh_amount} expected={intent.get('amount')} "
                    f"currency got={wh_currency} expected={intent.get('currency')}"
                )[:200]
                _CAM_LOG.warning("camrapidpay: webhook mismatch (audit only) ref=%s", reference)
            else:
                audit_set["webhook_mismatch"] = False
            await _cam_intents.update_one(
                {"reference": reference},
                {"$set": audit_set},
            )

        # The webhook is only a WAKE-UP trigger. Crediting is decided solely by
        # the trusted server-to-server status check inside this function.
        await verify_camrapidpay_payment_and_credit_once(reference)
        return {"received": True}

    # -------------------------------------------------------------------
    # Endpoint 3: status  (authenticated student; can also credit after Success)
    # -------------------------------------------------------------------
    @api.get("/payments/camrapidpay/status/{payment_intent_id}")
    async def camrapidpay_status(payment_intent_id: str, student=Depends(require_student)):
        """Student-facing status check. Credits once if verified Success."""
        try:
            intent = await _cam_intents.find_one({"_id": ObjectId(payment_intent_id)})
        except Exception:  # noqa: BLE001
            intent = None
        if not intent:
            raise HTTPException(status_code=404, detail="Payment not found")

        # Ownership: a student can only check their own intent.
        student_id = getattr(student, "clean_id", None) or getattr(student, "student_id", "")
        if intent.get("student_id") != student_id:
            raise HTTPException(status_code=403, detail="forbidden")

        # Already credited -> return immediately.
        if intent.get("status") == "credited" or intent.get("credited_at"):
            return {
                "success": True, "status": "credited", "credited": True,
                "points_added": int(intent.get("base_points", 0)),
                "bonus_points": int(intent.get("bonus_points", 0)),
                "total_points": int(intent.get("total_points", 0)),
            }

        # Otherwise verify (this may credit if CamRapidPay says Success).
        res = await verify_camrapidpay_payment_and_credit_once(intent.get("reference", ""))
        return {
            "success": True,
            "status":  res.get("status", "pending"),
            "credited": bool(res.get("credited")),
            "points_added": int(res.get("points_added", 0)),
            "bonus_points": int(res.get("bonus_points", 0)),
            "total_points": int(res.get("total_points", 0)),
        }

    # -------------------------------------------------------------------
    # Reconciliation sweep: catch lost webhooks AND lost client polls.
    # Re-verifies still-pending intents inside their window. Called by
    # server.py's existing 60s background task loop (see return value).
    # -------------------------------------------------------------------
    async def _camrapidpay_recover_stale_crediting():
        """Route stale 'crediting' intents to manual_review. Never raises.

        A 'crediting' intent means we atomically claimed it and were about to (or
        did) call GAS sendPoints. Because _complete_points_payment is NOT
        idempotent for the same reference (it uses a random nonce, no
        reference-based dedup at GAS), we must NOT auto-retry a stale 'crediting'
        intent - a retry could double-credit if GAS actually succeeded before the
        crash. Instead we mark manual_review with credited_at still null so a human
        confirms whether the single GAS credit happened, then closes it out.
        """
        if not _cam.is_enabled():
            return
        now = _cam_now()
        cutoff = (now - timedelta(seconds=_CAM_CREDITING_STALE_SECONDS)).isoformat()
        try:
            cursor = _cam_intents.find({
                "provider": "camrapidpay",
                "status":   "crediting",
                "credited_at": None,
                "crediting_at": {"$lt": cutoff},
            }).limit(25)
            stale = [d.get("reference") async for d in cursor if d.get("reference")]
        except Exception:  # noqa: BLE001
            stale = []
        for ref in stale:
            try:
                # Atomic, conservative: only flip if still stuck and not credited.
                res = await _cam_intents.update_one(
                    {"reference": ref, "status": "crediting", "credited_at": None},
                    {"$set": {"status": "manual_review",
                              "error_message": "stale_crediting_recovered: needs human "
                                                "confirmation of single GAS credit (not auto-retried "
                                                "because GAS credit is not reference-idempotent)",
                              "updated_at": _cam_now().isoformat()}},
                )
                if getattr(res, "modified_count", 0):
                    _CAM_LOG.error("camrapidpay: stale crediting ref=%s -> manual_review", ref)
            except Exception:  # noqa: BLE001
                pass

    async def _camrapidpay_recover_legacy_paid_not_credited():
        """Route any pre-v1.3 paid_not_credited intents to manual_review. Never raises.

        Before v1.3, two unsafe code paths could leave intents in
        paid_not_credited (an exception inside _complete_points_payment, and an
        ok:false return). Both are now treated as UNKNOWN OUTCOMES and routed
        directly to manual_review at the moment of failure. Any rows still in
        paid_not_credited on disk are legacy pre-v1.3 rows that we cannot prove
        safe to auto-retry, because _complete_points_payment is not reference-
        idempotent. This sweep moves them to manual_review so a human verifies
        whether the prior attempt actually credited at GAS before closing them.
        """
        if not _cam.is_enabled():
            return
        try:
            cursor = _cam_intents.find({
                "provider": "camrapidpay",
                "status":   "paid_not_credited",
                "credited_at": None,
            }).limit(25)
            refs = [d.get("reference") async for d in cursor if d.get("reference")]
        except Exception:  # noqa: BLE001
            refs = []
        for ref in refs:
            try:
                res = await _cam_intents.update_one(
                    {"reference": ref, "status": "paid_not_credited", "credited_at": None},
                    {"$set": {"status": "manual_review",
                              "error_message": "legacy_paid_not_credited_unknown_outcome:"
                                                "needs human confirmation of single GAS credit "
                                                "(not auto-retried because GAS credit is not "
                                                "reference-idempotent)",
                              "updated_at": _cam_now().isoformat()}},
                )
                if getattr(res, "modified_count", 0):
                    _CAM_LOG.error(
                        "camrapidpay: legacy paid_not_credited ref=%s -> manual_review "
                        "(v1.3 money-safety: UNKNOWN OUTCOME, no auto-retry)",
                        ref,
                    )
            except Exception:  # noqa: BLE001
                pass

    async def _camrapidpay_reconcile_once():
        """Re-verify pending intents, recover stale crediting, migrate legacy
        paid_not_credited. Never raises."""
        if not _cam.is_enabled():
            return
        now_iso = _cam_now().isoformat()
        # 1) Re-verify still-open intents within their window (lost webhook/poll).
        #    v1.3: paid_not_credited is no longer included here. It is treated as
        #    UNKNOWN OUTCOME and handled by step 3 below (legacy migration), not
        #    by a verify-and-retry call that could risk double-credit.
        try:
            cursor = _cam_intents.find({
                "provider": "camrapidpay",
                "status":   {"$in": ["pending", "paid"]},
                "expires_at": {"$gt": now_iso},
                "credited_at": None,
            }).limit(25)
            refs = [d.get("reference") async for d in cursor if d.get("reference")]
        except Exception:  # noqa: BLE001
            refs = []
        for ref in refs:
            try:
                await verify_camrapidpay_payment_and_credit_once(ref)
            except Exception:  # noqa: BLE001
                pass
        # 2) Recover stale 'crediting' intents (crash recovery) -> manual_review.
        await _camrapidpay_recover_stale_crediting()
        # 3) v1.3: migrate any legacy paid_not_credited rows -> manual_review.
        await _camrapidpay_recover_legacy_paid_not_credited()

    return _camrapidpay_reconcile_once, _camrapidpay_ensure_indexes, _camrapidpay_verify_via_bank_notification
