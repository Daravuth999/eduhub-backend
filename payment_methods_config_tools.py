# ===========================================================================
# Payment Methods Display Config — v1.6
# ---------------------------------------------------------------------------
# Tiny additive config layer that lets the Author Studio enable / disable
# individual payment-method buttons in the student Top-Up modal WITHOUT
# touching any money-movement code.
#
# Loaded via exec() into server.py's namespace, so it shares api / db / log /
# require_admin and the FastAPI HTTPException helper. The CamRapidPay
# (KHQR) provider helper is imported lazily so failure to import never
# breaks the rest of the server.
#
# It exposes:
#   GET   /api/payments/methods/public   – student-safe display config
#   GET   /api/admin/payments/methods    – diagnostic admin view
#   PATCH /api/admin/payments/methods    – admin toggle
#
# Storage:
#   Mongo collection ``payment_method_settings`` — a SINGLE document keyed
#   by ``_doc_id: "v1"``. The document only stores boolean toggles; no
#   secrets are ever persisted here.
#
# Default behaviour when the document does NOT yet exist:
#   - ABA visible (matches today's production)
#   - KHQR visible if and only if the CamRapidPay provider helper reports
#     it is configured (api key + base url) AND the env feature flag is on
#
# IMPORTANT: This module does NOT participate in payment verification,
# crediting, or wallet movement. It is purely a display gate.
# ===========================================================================

import logging as _pm_logging

_PM_LOG = _pm_logging.getLogger("eduhub.payment_methods")

# Single canonical doc key — never changes.
_PM_DOC_ID = "v1"
_pm_collection = db["payment_method_settings"]


def _pm_provider_ready_khqr() -> tuple[bool, str]:
    """Inspect the existing CamRapidPay provider helper for readiness.

    Returns ``(ready, reason)``. ``reason`` is a stable diagnostic code that
    matches the codes already returned by /payments/camrapidpay/config.
    """
    try:
        from payment_providers import camrapidpay_provider as _cam_local  # type: ignore
    except Exception:  # noqa: BLE001
        return False, "provider_module_missing"
    import os as _os_local
    enabled = (_os_local.environ.get("CAMRAPIDPAY_ENABLED", "false").strip().lower() == "true")
    if not enabled:
        return False, "flag_off"
    api_key = _os_local.environ.get("CAMRAPIDPAY_API_KEY", "").strip()
    base_url = _os_local.environ.get("CAMRAPIDPAY_BASE_URL", "").strip()
    if not api_key:
        return False, "missing_api_key"
    if not base_url:
        return False, "missing_base_url"
    try:
        if not _cam_local.is_enabled():
            return False, "provider_disabled"
    except Exception:  # noqa: BLE001
        return False, "provider_disabled"
    return True, "ok"


def _pm_provider_ready_aba() -> tuple[bool, str]:
    """ABA / manual is always considered configured in the current build.

    The ABA flow runs through payment_bridge.py which is bundled with the
    application. We expose a stub so future ops can swap the heuristic if
    required without changing the API contract.
    """
    return True, "ok"


async def _pm_load_doc() -> dict:
    """Load the config doc with safe defaults.

    Defaults are computed from environment readiness so first-deploy admins
    see exactly what is live without having to flip anything.
    """
    doc = await _pm_collection.find_one({"_doc_id": _PM_DOC_ID})
    if not doc:
        doc = {}
    aba_default = True
    khqr_ready, _ = _pm_provider_ready_khqr()
    khqr_default = bool(khqr_ready)
    aba = doc.get("aba") or {}
    khqr = doc.get("khqr") or {}
    return {
        "aba": {
            "enabled": bool(aba.get("enabled", aba_default)),
        },
        "khqr": {
            "enabled": bool(khqr.get("enabled", khqr_default)),
        },
    }


async def _pm_save_doc(cfg: dict) -> dict:
    """Persist the config doc (idempotent upsert)."""
    sanitized = {
        "_doc_id": _PM_DOC_ID,
        "aba": {
            "enabled": bool(cfg.get("aba", {}).get("enabled", True)),
        },
        "khqr": {
            "enabled": bool(cfg.get("khqr", {}).get("enabled", False)),
        },
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await _pm_collection.update_one(
        {"_doc_id": _PM_DOC_ID},
        {"$set": sanitized},
        upsert=True,
    )
    return sanitized


# ---------------------------------------------------------------------------
# Public: student-safe display config (no secrets, no provider diagnostics)
# ---------------------------------------------------------------------------
@api.get("/payments/methods/public")
async def payments_methods_public():
    """Return the safe display config used by the student Top-Up modal.

    Auth: PUBLIC (matches /payments/camrapidpay/config) — no PII, no
    secrets, only display booleans. This avoids iOS Safari ITP / cross-site
    cookie failures that would otherwise hide both payment methods.
    """
    saved = await _pm_load_doc()
    khqr_ready, khqr_reason = _pm_provider_ready_khqr()
    khqr_visible = bool(saved["khqr"]["enabled"]) and khqr_ready
    aba_visible = bool(saved["aba"]["enabled"])
    return {
        "aba": {
            "enabled": aba_visible,
            "label": "ABA Pay",
        },
        "khqr": {
            "enabled": khqr_visible,
            "label": "KHQR",
            "provider_ready": khqr_ready,
            "reason": khqr_reason,
        },
    }


# ---------------------------------------------------------------------------
# Admin: diagnostic view + toggle
# ---------------------------------------------------------------------------
@api.get("/admin/payments/methods")
async def admin_payments_methods_get(admin: User = Depends(require_admin)):
    """Admin diagnostic view of the payment methods display config."""
    saved = await _pm_load_doc()
    khqr_ready, khqr_reason = _pm_provider_ready_khqr()
    aba_ready, aba_reason = _pm_provider_ready_aba()
    return {
        "aba": {
            "enabled": bool(saved["aba"]["enabled"]),
            "configured": aba_ready,
            "reason": aba_reason,
        },
        "khqr": {
            "enabled": bool(saved["khqr"]["enabled"]),
            "configured": khqr_ready,
            "provider_ready": khqr_ready,
            "reason": khqr_reason,
        },
    }


@api.patch("/admin/payments/methods")
async def admin_payments_methods_patch(
    payload: dict,
    admin: User = Depends(require_admin),
):
    """Update the payment-methods display toggles.

    Only the ``enabled`` boolean of each method is writeable. All other keys
    in the payload are ignored. Missing methods are left untouched.
    """
    current = await _pm_load_doc()
    aba_patch = payload.get("aba") if isinstance(payload, dict) else None
    khqr_patch = payload.get("khqr") if isinstance(payload, dict) else None
    if isinstance(aba_patch, dict) and "enabled" in aba_patch:
        current["aba"]["enabled"] = bool(aba_patch["enabled"])
    if isinstance(khqr_patch, dict) and "enabled" in khqr_patch:
        current["khqr"]["enabled"] = bool(khqr_patch["enabled"])
    saved = await _pm_save_doc(current)
    _PM_LOG.info(
        "payment_methods updated by admin=%s aba=%s khqr=%s",
        getattr(admin, "username", "?"),
        saved["aba"]["enabled"],
        saved["khqr"]["enabled"],
    )
    return await admin_payments_methods_get(admin=admin)  # type: ignore[call-arg]


_PM_LOG.info("payment_methods_config_tools: routes registered")
